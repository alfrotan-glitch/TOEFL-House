<?php

declare(strict_types=1);

namespace App\Modules\Academic\Placement\Commands;

use App\Modules\Academic\Models\ProgramVersion;
use App\Modules\Academic\Placement\Domain\PlacementAccess;
use App\Modules\Academic\Placement\Domain\PlacementAntiTamper;
use App\Modules\Academic\Placement\Domain\PlacementDelivery;
use App\Modules\Academic\Placement\Domain\PlacementEvidenceVerifier;
use App\Modules\Academic\Placement\Domain\PlacementProfileLifecycle;
use App\Modules\Academic\Placement\Domain\PlacementScoring;
use App\Modules\Academic\Placement\Models\PlacementAttempt;
use App\Modules\Academic\Placement\Models\PlacementProfile;
use App\Modules\Academic\Placement\Models\PlacementQuestion;
use App\Modules\Academic\Placement\Models\PlacementResponse;
use App\Modules\Academic\Placement\Models\PlacementSection;
use App\Modules\Academic\Placement\Models\PlacementSectionResult;
use App\Modules\Academic\Placement\Models\PlacementTest;
use App\Modules\Academic\Placement\Models\PlacementTestVersion;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Crm\Domain\CrmInteractionTraceRecorder;
use App\Modules\Crm\Models\Visitor;
use App\Modules\Identity\Models\Person;
use App\Modules\Organization\Models\Branch;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;

/**
 * Placement profiles and server-authoritative attempts.
 *
 * A profile is person-centric (pre-enrollment allowed) and at most one is
 * live; retakes supersede the live profile and reopen a new one. Submitted
 * attempts/responses are immutable evidence; timing is server-side and the
 * evidence set is HMAC-protected.
 */
final class ManagePlacementProfile
{
    public const CAPABILITY = 'placement.conduct';

    public function __construct(
        private readonly PlacementAccess $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
        private readonly CrmInteractionTraceRecorder $crmTrace,
        private readonly PlacementEvidenceVerifier $evidenceVerifier,
    ) {}

    /** @return array{profile_id: string, correlation_id: string} */
    public function openProfile(Actor $actor, string $personId, ?string $programVersionId, string $idempotencyKey, ?string $visitorId = null, ?string $branchId = null): array
    {
        $payload = hash('sha256', implode('|', [
            'placement.profile.open', $personId, $programVersionId ?? '', $visitorId ?? '', $branchId ?? '', $actor->actorId,
        ]));

        try {
            return $this->idempotency->execute('placement.profile.open', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $personId, $programVersionId, $visitorId, $branchId): array {
                    $visitorId = $visitorId === null ? null : trim($visitorId);
                    $branchId = $branchId === null ? null : trim($branchId);
                    $this->access->require($actor, self::CAPABILITY, $branchId);
                    if (Person::query()->whereKey($personId)->doesntExist()) {
                        throw BusinessRejection::forCode('placement.person_unknown', 'a placement profile requires a known person');
                    }
                    if ($visitorId !== null && $visitorId !== '') {
                        /** @var Visitor|null $visitor */
                        $visitor = Visitor::query()->whereKey($visitorId)->first();
                        if ($visitor === null) {
                            throw BusinessRejection::forCode('placement.visitor_unknown', 'the referenced CRM visitor does not exist');
                        }
                        if ($visitor->person_id === null || $visitor->person_id !== $personId) {
                            throw BusinessRejection::forCode('placement.visitor_person_mismatch', 'the placement profile visitor must belong to the profile person');
                        }
                        if ($visitor->origin_branch_id !== null && $visitor->origin_branch_id !== $branchId) {
                            throw BusinessRejection::forCode('placement.visitor_branch_mismatch', 'the placement profile branch must match the visitor provenance');
                        }
                    }
                    if ($programVersionId !== null && ProgramVersion::query()->whereKey($programVersionId)->doesntExist()) {
                        throw BusinessRejection::forCode('placement.program_version_unknown', 'referenced program version does not exist');
                    }
                    if (PlacementProfile::query()->where('person_id', $personId)->where('lifecycle_state', '<>', 'superseded')->where('lifecycle_state', '<>', 'retired')->exists()) {
                        throw BusinessRejection::forCode('placement.profile_open_exists', 'this person already has an open placement profile');
                    }

                    $profile = PlacementProfile::query()->create([
                        'id' => RandomIdentifier::new(),
                        'person_id' => $personId,
                        'visitor_id' => $visitorId,
                        'program_version_id' => $programVersionId,
                        'lineage_version' => PlacementProfile::LINEAGE_VERSION,
                        'lifecycle_state' => PlacementProfile::STATE_DRAFT,
                        'originating_branch_id' => $branchId,
                        'current_home_branch_id' => $branchId,
                        'created_by' => $actor->actorId,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'placement.profile.open', 'placement_profile', $profile->id, null, [
                        'person_id' => $personId, 'visitor_id' => $visitorId,
                        ...$this->branchProvenance($profile->originating_branch_id),
                    ]);

                    return ['profile_id' => $profile->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'placement.profile.open', 'placement_profile', $personId);
        }
    }

    /** @return array{attempt_id: string, correlation_id: string} */
    public function startAttempt(Actor $actor, PlacementProfile $profile, string $testVersionId, string $deliveryMode, string $idempotencyKey, ?string $proctorPersonId = null): array
    {
        $payload = hash('sha256', implode('|', [
            'placement.attempt.start', $profile->id, $testVersionId, $deliveryMode, $proctorPersonId ?? '', $actor->actorId,
        ]));

        try {
            return $this->idempotency->execute('placement.attempt.start', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $profile, $testVersionId, $deliveryMode, $proctorPersonId): array {
                    /** @var PlacementProfile $lockedProfile */
                    $lockedProfile = PlacementProfile::query()->whereKey($profile->id)->lockForUpdate()->firstOrFail();
                    $this->requireProfileBranch($actor, $lockedProfile);
                    PlacementDelivery::require($deliveryMode);
                    if ($lockedProfile->lifecycle_state !== PlacementProfile::STATE_DRAFT) {
                        throw BusinessRejection::forCode('placement.profile_not_open_for_attempt', 'a retake must supersede the released profile and open a new draft placement profile');
                    }
                    if ($lockedProfile->lineage_version !== PlacementProfile::LINEAGE_VERSION) {
                        throw BusinessRejection::forCode('placement.profile_lineage_remediation_required', 'a pre-lineage placement profile cannot accept a new attempt without governed remediation');
                    }
                    if (PlacementAttempt::query()
                        ->where('profile_id', $lockedProfile->id)
                        ->whereIn('status', [
                            PlacementAttempt::STATUS_SCHEDULED,
                            PlacementAttempt::STATUS_IN_PROGRESS,
                            PlacementAttempt::STATUS_SUBMITTED,
                            PlacementAttempt::STATUS_TIMED_OUT,
                        ])
                        ->exists()) {
                        throw BusinessRejection::forCode('placement.profile_attempt_exists', 'a profile may have only one live or submitted decision attempt; cancel before retrying or open a governed retake');
                    }
                    /** @var PlacementTestVersion $version */
                    $version = PlacementTestVersion::query()->whereKey($testVersionId)->lockForUpdate()->firstOrFail();
                    $this->requireVersionPublished($version);

                    /** @var PlacementTest $test */
                    $test = PlacementTest::query()->whereKey($version->placement_test_id)->lockForUpdate()->firstOrFail();
                    if (trim((string) $test->originating_branch_id) !== trim((string) $lockedProfile->originating_branch_id)
                        || trim((string) $test->current_home_branch_id) !== trim((string) $lockedProfile->current_home_branch_id)) {
                        throw BusinessRejection::forCode('placement.profile_test_branch_mismatch', 'a placement test must belong to the profile operational branch');
                    }
                    // A generic test may serve a profile-selected program and
                    // an untargeted profile may inherit a test program, but
                    // two explicit program authorities must never disagree.
                    if ($lockedProfile->program_version_id !== null
                        && $test->program_version_id !== null
                        && trim((string) $lockedProfile->program_version_id) !== trim((string) $test->program_version_id)) {
                        throw BusinessRejection::forCode('placement.profile_test_program_mismatch', 'a program-targeted placement test must match the profile target program version');
                    }
                    if ($deliveryMode === PlacementDelivery::PHYSICAL && ($proctorPersonId === null || trim($proctorPersonId) === '')) {
                        throw BusinessRejection::forCode('placement.physical_proctor_required', 'a physically delivered placement attempt requires the accountable proctor person');
                    }
                    if ($proctorPersonId !== null && Person::query()->whereKey($proctorPersonId)->doesntExist()) {
                        throw BusinessRejection::forCode('placement.proctor_unknown', 'referenced proctor does not exist');
                    }
                    $sections = PlacementSection::query()->where('test_version_id', $version->id)->where('lifecycle_state', 'published')->get();
                    if ($sections->isEmpty()) {
                        throw BusinessRejection::forCode('placement.version_empty', 'a placement attempt requires published sections');
                    }
                    foreach ($sections as $section) {
                        if ($section->delivery_mode !== $deliveryMode) {
                            throw BusinessRejection::forCode('placement.section_delivery_mismatch', sprintf('section %s is %s, not %s', $section->code, $section->delivery_mode, $deliveryMode));
                        }
                    }

                    $attemptNo = (int) PlacementAttempt::query()->where('profile_id', $lockedProfile->id)->max('attempt_no') + 1;
                    $attempt = PlacementAttempt::query()->create([
                        'id' => RandomIdentifier::new(),
                        'profile_id' => $lockedProfile->id,
                        'test_version_id' => $version->id,
                        'delivery_mode' => $deliveryMode,
                        'attempt_no' => $attemptNo,
                        'status' => PlacementAttempt::STATUS_IN_PROGRESS,
                        'lineage_version' => PlacementAttempt::LINEAGE_VERSION,
                        'started_at' => now(),
                        'proctor_person_id' => $proctorPersonId,
                        'originating_branch_id' => $test->originating_branch_id,
                        'current_home_branch_id' => $test->current_home_branch_id,
                        'correlation_id' => RandomIdentifier::new(),
                    ]);
                    $event = $this->audit->record($actor->actorId, 'placement.attempt.start', 'placement_attempt', $attempt->id, null, [
                        'profile_id' => $profile->id, 'test_version_id' => $version->id, 'delivery' => $deliveryMode,
                        ...$this->branchProvenance($attempt->originating_branch_id),
                    ]);

                    return ['attempt_id' => $attempt->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'placement.attempt.start', 'placement_attempt', $profile->id);
        }
    }

    /**
     * @param  array<string, string>  $answers  question_id => response_value
     * @return array{attempt_id: string, tamper_flagged: bool, correlation_id: string}
     */
    public function submitDigital(Actor $actor, PlacementAttempt $attempt, array $answers, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', [
            'placement.attempt.submit', $attempt->id, json_encode($answers), $actor->actorId,
        ]));

        try {
            return $this->idempotency->execute('placement.attempt.submit.digital', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $attempt, $answers): array {
                    /** @var PlacementAttempt $locked */
                    $locked = PlacementAttempt::query()->whereKey($attempt->id)->lockForUpdate()->firstOrFail();
                    $this->requireAttemptBranch($actor, $locked);
                    if ($locked->delivery_mode !== PlacementDelivery::DIGITAL || $locked->status !== PlacementAttempt::STATUS_IN_PROGRESS) {
                        throw BusinessRejection::forCode('placement.attempt_not_digital_progress', 'only an in-progress digital attempt can submit answers');
                    }

                    $version = PlacementTestVersion::query()->findOrFail($locked->test_version_id);
                    $questions = $this->publishedQuestions($version->id);
                    $this->assertAllQuestionsAnswered($questions, $answers);

                    $endedAt = CarbonImmutable::now();
                    $startedAt = $locked->started_at !== null ? CarbonImmutable::parse($locked->started_at) : $endedAt;
                    $duration = max(0, (int) $startedAt->diffInSeconds($endedAt));
                    $test = PlacementTest::query()->whereKey($version->placement_test_id)->firstOrFail();
                    $tamper = $duration > ($test->total_time_minutes * 60);

                    foreach ($questions as $question) {
                        PlacementResponse::query()->create([
                            'id' => RandomIdentifier::new(),
                            'attempt_id' => $locked->id,
                            'question_id' => $question->id,
                            'response_value' => (string) ($answers[$question->id] ?? ''),
                            'tamper_flagged' => $tamper,
                            'evidence_sha256' => hash('sha256', (string) ($answers[$question->id] ?? '')),
                        ]);
                    }

                    foreach (PlacementSection::query()->where('test_version_id', $version->id)->where('lifecycle_state', 'published')->get() as $section) {
                        if ($section->can_auto_score) {
                            $scored = PlacementScoring::autoScoreSection($section, $answers);
                            PlacementSectionResult::query()->create([
                                'id' => RandomIdentifier::new(),
                                'attempt_id' => $locked->id,
                                'section_id' => $section->id,
                                'component' => $section->component,
                                'raw_score' => $scored['earned'],
                                'weighted_score' => $scored['percentage'],
                                'lifecycle_state' => PlacementSectionResult::STATE_SCORED,
                                'scoring_method' => PlacementSectionResult::SCORING_METHOD_AUTOMATIC,
                                // A server calculation has no human scorer; the
                                // submitting proctor/candidate is preserved in
                                // the audit event, not misrepresented here.
                                'scored_by' => null,
                                'rationale' => sprintf('server auto-score for section %s', $section->code),
                            ]);
                        }
                    }

                    $hmac = PlacementAntiTamper::hmac($locked, $answers, null, $duration);
                    $locked->forceFill([
                        'status' => PlacementAttempt::STATUS_SUBMITTED,
                        'ended_at' => $endedAt,
                        'duration_seconds' => $duration,
                        'anti_tamper_hmac' => $hmac,
                        'tamper_flagged' => $tamper,
                        'tamper_reason' => $tamper ? 'duration exceeded the allowed test window' : null,
                    ])->save();
                    // The v2 result guard permits automatic facts only while
                    // an attempt is in progress, but deliberately permits an
                    // unscored professional stub only after its immutable
                    // submission envelope exists. Preserve both authorities.
                    $this->createProfessionalResultStubs($locked, $version);

                    $this->markScoredIfComplete($actor, $locked->profile_id);
                    $event = $this->audit->record($actor->actorId, 'placement.attempt.submit', 'placement_attempt', $locked->id, null, [
                        'delivery' => 'digital', 'duration' => $duration, 'tamper' => $tamper,
                        ...$this->branchProvenance($locked->originating_branch_id),
                    ]);
                    $this->traceVisitor($actor, $locked->id, $locked->profile_id, $event->id);

                    return ['attempt_id' => $locked->id, 'tamper_flagged' => $tamper, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'placement.attempt.submit', 'placement_attempt', $attempt->id);
        }
    }

    /** @return array{attempt_id: string, tamper_flagged: bool, correlation_id: string} */
    public function submitPhysical(Actor $actor, PlacementAttempt $attempt, string $evidenceRef, string $idempotencyKey): array
    {
        $evidenceRef = trim($evidenceRef);
        $payload = hash('sha256', implode('|', ['placement.attempt.submit.physical', $attempt->id, $evidenceRef, $actor->actorId]));

        try {
            return $this->idempotency->execute('placement.attempt.submit.physical', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $attempt, $evidenceRef): array {
                    /** @var PlacementAttempt $locked */
                    $locked = PlacementAttempt::query()->whereKey($attempt->id)->lockForUpdate()->firstOrFail();
                    $this->requireAttemptBranch($actor, $locked);
                    if ($locked->delivery_mode !== PlacementDelivery::PHYSICAL || $locked->status !== PlacementAttempt::STATUS_IN_PROGRESS) {
                        throw BusinessRejection::forCode('placement.attempt_not_physical_progress', 'only an in-progress physical attempt can submit evidence');
                    }
                    if ($evidenceRef === '') {
                        throw BusinessRejection::forCode('placement.attempt_evidence_missing', 'a physical attempt requires an evidence reference');
                    }
                    $endedAt = CarbonImmutable::now();
                    $startedAt = $locked->started_at !== null ? CarbonImmutable::parse($locked->started_at) : $endedAt;
                    $duration = max(0, (int) $startedAt->diffInSeconds($endedAt));
                    /** @var PlacementTestVersion $version */
                    $version = PlacementTestVersion::query()->findOrFail($locked->test_version_id);
                    if (PlacementSection::query()
                        ->where('test_version_id', $version->id)
                        ->where('lifecycle_state', 'published')
                        ->where('can_auto_score', true)
                        ->exists()) {
                        throw BusinessRejection::forCode('placement.physical_answers_required', 'physical delivery of an auto-scored section requires normalized answer-sheet ingestion; evidence-only submission cannot fabricate a score');
                    }
                    $test = PlacementTest::query()->whereKey($version->placement_test_id)->firstOrFail();
                    $tamper = $duration > ($test->total_time_minutes * 60);

                    $locked->forceFill([
                        'status' => PlacementAttempt::STATUS_SUBMITTED,
                        'ended_at' => $endedAt,
                        'duration_seconds' => $duration,
                        'evidence_ref' => $evidenceRef,
                        // Physical evidence is server-HMACed by the exact same
                        // secret-backed canonical scheme as digital answers.
                        'anti_tamper_hmac' => PlacementAntiTamper::hmac($locked, [], $evidenceRef, $duration),
                        'tamper_flagged' => $tamper,
                        'tamper_reason' => $tamper ? 'duration exceeded the allowed test window' : null,
                    ])->save();
                    // Evidence-only physical delivery has no automatic
                    // sections (validated above), so create the professional
                    // work queue only after the submitted HMAC exists.
                    $this->createProfessionalResultStubs($locked, $version);
                    $event = $this->audit->record($actor->actorId, 'placement.attempt.submit', 'placement_attempt', $locked->id, null, [
                        'delivery' => 'physical', 'duration' => $duration, 'tamper' => $tamper,
                        ...$this->branchProvenance($locked->originating_branch_id),
                    ]);
                    $this->traceVisitor($actor, $locked->id, $locked->profile_id, $event->id);

                    return ['attempt_id' => $locked->id, 'tamper_flagged' => $tamper, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'placement.attempt.submit', 'placement_attempt', $attempt->id);
        }
    }

    /**
     * Offline/physical answer-sheet ingestion: the proctor records the
     * candidate's answers server-side so the physical paper evidence is
     * normalised, checked and auto-scored exactly like digital delivery.
     *
     * @param  array<string, string>  $answers  question_id => response_value
     * @return array{attempt_id: string, tamper_flagged: bool, correlation_id: string}
     */
    public function ingestPhysicalAnswers(Actor $actor, PlacementAttempt $attempt, array $answers, string $evidenceRef, string $idempotencyKey): array
    {
        $evidenceRef = trim($evidenceRef);
        $payload = hash('sha256', implode('|', [
            'placement.attempt.submit.physical.answers', $attempt->id, json_encode($answers), $evidenceRef, $actor->actorId,
        ]));

        try {
            return $this->idempotency->execute('placement.attempt.submit.physical.answers', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $attempt, $answers, $evidenceRef): array {
                    /** @var PlacementAttempt $locked */
                    $locked = PlacementAttempt::query()->whereKey($attempt->id)->lockForUpdate()->firstOrFail();
                    $this->requireAttemptBranch($actor, $locked);
                    if ($locked->delivery_mode !== PlacementDelivery::PHYSICAL || $locked->status !== PlacementAttempt::STATUS_IN_PROGRESS) {
                        throw BusinessRejection::forCode('placement.attempt_not_physical_progress', 'only an in-progress physical attempt can ingest answers');
                    }
                    if ($evidenceRef === '') {
                        throw BusinessRejection::forCode('placement.attempt_evidence_missing', 'a physical attempt requires an evidence reference');
                    }

                    $version = PlacementTestVersion::query()->findOrFail($locked->test_version_id);
                    $questions = $this->publishedQuestions($version->id);
                    $this->assertAllQuestionsAnswered($questions, $answers);

                    $endedAt = CarbonImmutable::now();
                    $startedAt = $locked->started_at !== null ? CarbonImmutable::parse($locked->started_at) : $endedAt;
                    $duration = max(0, (int) $startedAt->diffInSeconds($endedAt));
                    $test = PlacementTest::query()->whereKey($version->placement_test_id)->firstOrFail();
                    $tamper = $duration > ($test->total_time_minutes * 60);

                    foreach ($questions as $question) {
                        PlacementResponse::query()->create([
                            'id' => RandomIdentifier::new(),
                            'attempt_id' => $locked->id,
                            'question_id' => $question->id,
                            'response_value' => (string) ($answers[$question->id] ?? ''),
                            'tamper_flagged' => $tamper,
                            'evidence_sha256' => hash('sha256', (string) ($answers[$question->id] ?? '')),
                        ]);
                    }
                    foreach (PlacementSection::query()->where('test_version_id', $version->id)->where('lifecycle_state', 'published')->get() as $section) {
                        if ($section->can_auto_score) {
                            $scored = PlacementScoring::autoScoreSection($section, $answers);
                            PlacementSectionResult::query()->create([
                                'id' => RandomIdentifier::new(),
                                'attempt_id' => $locked->id,
                                'section_id' => $section->id,
                                'component' => $section->component,
                                'raw_score' => $scored['earned'],
                                'weighted_score' => $scored['percentage'],
                                'lifecycle_state' => PlacementSectionResult::STATE_SCORED,
                                'scoring_method' => PlacementSectionResult::SCORING_METHOD_AUTOMATIC,
                                'scored_by' => null,
                                'rationale' => sprintf('offline answer-sheet auto-score for section %s', $section->code),
                            ]);
                        }
                    }

                    $hmac = PlacementAntiTamper::hmac($locked, $answers, $evidenceRef, $duration);
                    $locked->forceFill([
                        'status' => PlacementAttempt::STATUS_SUBMITTED,
                        'ended_at' => $endedAt,
                        'duration_seconds' => $duration,
                        'evidence_ref' => $evidenceRef,
                        'anti_tamper_hmac' => $hmac,
                        'tamper_flagged' => $tamper,
                        'tamper_reason' => $tamper ? 'duration exceeded the allowed test window' : null,
                    ])->save();
                    $this->createProfessionalResultStubs($locked, $version);

                    $this->markScoredIfComplete($actor, $locked->profile_id);
                    $event = $this->audit->record($actor->actorId, 'placement.attempt.submit.physical.answers', 'placement_attempt', $locked->id, null, [
                        'delivery' => 'physical', 'duration' => $duration, 'tamper' => $tamper,
                        ...$this->branchProvenance($locked->originating_branch_id),
                    ]);
                    $this->traceVisitor($actor, $locked->id, $locked->profile_id, $event->id);

                    return ['attempt_id' => $locked->id, 'tamper_flagged' => $tamper, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'placement.attempt.submit.physical.answers', 'placement_attempt', $attempt->id);
        }
    }

    /** @return array{attempt_id: string, lifecycle_state: string, correlation_id: string} */
    public function cancelAttempt(Actor $actor, PlacementAttempt $attempt, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['placement.attempt.cancel', $attempt->id, $actor->actorId]));

        try {
            return $this->idempotency->execute('placement.attempt.cancel', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $attempt): array {
                    /** @var PlacementAttempt $locked */
                    $locked = PlacementAttempt::query()->whereKey($attempt->id)->lockForUpdate()->firstOrFail();
                    $this->requireAttemptBranch($actor, $locked);
                    if ($locked->status !== PlacementAttempt::STATUS_IN_PROGRESS && $locked->status !== PlacementAttempt::STATUS_SCHEDULED) {
                        throw BusinessRejection::forCode('placement.attempt_not_open', 'only an unsent attempt can be cancelled');
                    }
                    $locked->forceFill(['status' => PlacementAttempt::STATUS_CANCELLED])->save();
                    $event = $this->audit->record($actor->actorId, 'placement.attempt.cancel', 'placement_attempt', $locked->id, ['status' => $locked->getOriginal('status')], [
                        'status' => PlacementAttempt::STATUS_CANCELLED,
                        ...$this->branchProvenance($locked->originating_branch_id),
                    ]);

                    return ['attempt_id' => $locked->id, 'lifecycle_state' => PlacementAttempt::STATUS_CANCELLED, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'placement.attempt.cancel', 'placement_attempt', $attempt->id);
        }
    }

    /** @return array{profile_id: string, lifecycle_state: string, correlation_id: string} */
    public function markScored(Actor $actor, PlacementProfile $profile, string $idempotencyKey): array
    {
        return $this->transitionProfile($actor, $profile, PlacementProfile::STATE_SCORED, $idempotencyKey);
    }

    /** @return array{profile_id: string, lifecycle_state: string, correlation_id: string} */
    public function transitionProfile(Actor $actor, PlacementProfile $profile, string $toState, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['placement.profile.transition', $profile->id, $toState, $actor->actorId]));

        try {
            return $this->idempotency->execute('placement.profile.transition', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $profile, $toState): array {
                    /** @var PlacementProfile $locked */
                    $locked = PlacementProfile::query()->whereKey($profile->id)->lockForUpdate()->firstOrFail();
                    $this->requireProfileBranch($actor, $locked);
                    if ($locked->lineage_version !== PlacementProfile::LINEAGE_VERSION) {
                        throw BusinessRejection::forCode('placement.profile_lineage_remediation_required', 'a pre-lineage placement profile requires governed remediation before a new decision transition');
                    }
                    PlacementProfileLifecycle::requireTransition($locked->lifecycle_state, $toState);
                    if ($toState === PlacementProfile::STATE_SCORED && ! $this->hasCompleteScoring($locked->id)) {
                        throw BusinessRejection::forCode('placement.profile_scoring_incomplete', 'every section must carry a score before the profile can be scored');
                    }
                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => $toState])->save();
                    $event = $this->audit->record($actor->actorId, 'placement.profile.transition', 'placement_profile', $locked->id, $before, [
                        'lifecycle_state' => $toState,
                        ...$this->branchProvenance($locked->originating_branch_id),
                    ]);

                    return ['profile_id' => $locked->id, 'lifecycle_state' => $toState, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'placement.profile.transition', 'placement_profile', $profile->id);
        }
    }

    /**
     * Materialize the human-marking work queue only after submission. A
     * professional result starts as an immutable-attempt-bound blank stub;
     * ScorePlacement fills it exactly once with the accountable scorer and
     * published rubric. Automatic results are intentionally created earlier
     * while the attempt is in progress.
     */
    private function createProfessionalResultStubs(PlacementAttempt $attempt, PlacementTestVersion $version): void
    {
        if ($attempt->status !== PlacementAttempt::STATUS_SUBMITTED) {
            throw new \LogicException('professional placement result stubs require a submitted attempt');
        }
        foreach (PlacementSection::query()
            ->where('test_version_id', $version->id)
            ->where('lifecycle_state', 'published')
            ->where('can_auto_score', false)
            ->get() as $section) {
            if (PlacementSectionResult::query()
                ->where('attempt_id', $attempt->id)
                ->where('section_id', $section->id)
                ->exists()) {
                throw BusinessRejection::forCode('placement.section_result_exists', 'a submitted placement section already has an authoritative result record');
            }
            PlacementSectionResult::query()->create([
                'id' => RandomIdentifier::new(),
                'attempt_id' => $attempt->id,
                'section_id' => $section->id,
                'component' => $section->component,
                'lifecycle_state' => PlacementSectionResult::STATE_SCORED,
                'scoring_method' => PlacementSectionResult::SCORING_METHOD_PROFESSIONAL,
                'scored_by' => null,
                'rationale' => 'awaiting professional marking',
            ]);
        }
    }

    private function markScoredIfComplete(Actor $actor, string $profileId): void
    {
        /** @var PlacementProfile $profile */
        $profile = PlacementProfile::query()->findOrFail($profileId);
        if ($profile->lifecycle_state === PlacementProfile::STATE_DRAFT && $this->hasCompleteScoring($profileId)) {
            $profile->forceFill(['lifecycle_state' => PlacementProfile::STATE_SCORED])->save();
            $profile = PlacementProfile::query()->whereKey($profileId)->first();
            $this->audit->record($actor->actorId, 'placement.profile.transition', 'placement_profile', $profileId, ['lifecycle_state' => PlacementProfile::STATE_DRAFT], [
                'lifecycle_state' => PlacementProfile::STATE_SCORED,
                ...$this->branchProvenance($profile?->originating_branch_id),
            ]);
        }
    }

    private function hasCompleteScoring(string $profileId): bool
    {
        $attempts = PlacementAttempt::query()
            ->where('profile_id', $profileId)
            ->where('lineage_version', PlacementAttempt::LINEAGE_VERSION)
            ->where('status', PlacementAttempt::STATUS_SUBMITTED)
            ->orderByDesc('attempt_no')
            ->get();
        if ($attempts->count() !== 1) {
            return false;
        }

        /** @var PlacementAttempt $attempt */
        $attempt = $attempts->first();

        // A complete score set is not enough to advance the profile: it must
        // be bound to the exact persisted evidence/HMAC before the scored
        // lifecycle fact is recorded. Recommendation and review make the
        // same check, but delaying it would leave a misleading scored state.
        $this->evidenceVerifier->requireDecisionEligible($attempt);

        return $this->evidenceVerifier->scoringIsComplete($attempt);
    }

    /** @return Collection<int, PlacementQuestion> */
    private function publishedQuestions(string $versionId): Collection
    {
        $sectionIds = PlacementSection::query()->where('test_version_id', $versionId)->where('lifecycle_state', 'published')->pluck('id');

        return PlacementQuestion::query()->whereIn('section_id', $sectionIds)->where('lifecycle_state', 'published')->get();
    }

    /**
     * @param  Collection<int, PlacementQuestion>  $questions
     * @param  array<string, string>  $answers
     */
    private function assertAllQuestionsAnswered(Collection $questions, array $answers): void
    {
        $known = $questions->pluck('id')->all();
        $unknown = array_diff(array_keys($answers), $known);
        if ($unknown !== []) {
            throw BusinessRejection::forCode('placement.answer_question_unknown', sprintf('answer references a question not in the published version: %s', (string) reset($unknown)));
        }
        foreach ($questions as $question) {
            if (! array_key_exists($question->id, $answers)) {
                throw BusinessRejection::forCode('placement.answer_missing', sprintf('question %s was not answered', $question->code));
            }
        }
    }

    /** @return array{branch_id: string, campus_id: string, organization_id: string} */
    private function branchProvenance(?string $branchId): array
    {
        $id = trim((string) ($branchId ?? ''));
        if ($id === '') {
            throw BusinessRejection::forCode('placement.profile_provenance_required', 'a placement event requires an operational branch provenance');
        }
        $branch = Branch::query()->whereKey($id)->first();
        if ($branch === null || $branch->lifecycle_state !== 'active') {
            throw BusinessRejection::forCode('placement.profile_provenance_required', 'a placement event requires an active branch provenance');
        }
        $scope = $branch->structureScope();
        if ($scope->organizationId === '' || $scope->campusId === null) {
            throw BusinessRejection::forCode('placement.profile_provenance_required', 'a placement event requires active campus organization provenance');
        }

        return ['branch_id' => (string) $branch->id, 'campus_id' => (string) $scope->campusId, 'organization_id' => $scope->organizationId];
    }

    private function requireVersionPublished(PlacementTestVersion $version): void
    {
        if ($version->lifecycle_state !== 'published') {
            throw BusinessRejection::forCode('placement.version_not_published', 'only a published placement version can be attempted');
        }
        /** @var PlacementTest $test */
        $test = PlacementTest::query()->whereKey($version->placement_test_id)->firstOrFail();
        if ($test->lifecycle_state !== 'published') {
            throw BusinessRejection::forCode('placement.test_not_published', 'only a published placement test can be attempted');
        }
    }

    private function requireProfileBranch(Actor $actor, PlacementProfile $profile): void
    {
        $this->access->require($actor, self::CAPABILITY, $profile->originating_branch_id);
    }

    private function requireAttemptBranch(Actor $actor, PlacementAttempt $attempt): void
    {
        $this->access->require($actor, self::CAPABILITY, $attempt->originating_branch_id);
    }

    private function traceVisitor(Actor $actor, string $attemptId, string $profileId, string $authorityAuditEventId): void
    {
        $profile = PlacementProfile::query()->find($profileId);
        if ($profile === null || $profile->person_id === null) {
            return;
        }
        $visitorId = $this->crmTrace->visitorIdForPerson($profile->person_id);
        if ($visitorId === null) {
            return;
        }
        $this->crmTrace->record($actor, $visitorId, 'outbound', 'placement', 'other', 'placement attempt submitted for the person linked to this lead.', CarbonImmutable::now(), placementAttemptId: $attemptId, authorityAuditEventId: $authorityAuditEventId);
    }
}
