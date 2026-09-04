<?php

declare(strict_types=1);

namespace App\Modules\Academic\Placement\Commands;

use App\Modules\Academic\Models\ProgramVersion;
use App\Modules\Academic\Placement\Domain\PlacementAccess;
use App\Modules\Academic\Placement\Domain\PlacementAntiTamper;
use App\Modules\Academic\Placement\Domain\PlacementDelivery;
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
use App\Modules\Identity\Models\Person;
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
                    $this->access->require($actor, self::CAPABILITY, $branchId);
                    if (Person::query()->whereKey($personId)->doesntExist()) {
                        throw BusinessRejection::forCode('placement.person_unknown', 'a placement profile requires a known person');
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
                        'lifecycle_state' => PlacementProfile::STATE_DRAFT,
                        'originating_branch_id' => $branchId,
                        'current_home_branch_id' => $branchId,
                        'created_by' => $actor->actorId,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'placement.profile.open', 'placement_profile', $profile->id, null, [
                        'person_id' => $personId, 'visitor_id' => $visitorId,
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
                    $this->requireProfileBranch($actor, $profile);
                    PlacementDelivery::require($deliveryMode);
                    if (! in_array($profile->lifecycle_state, [PlacementProfile::STATE_DRAFT, PlacementProfile::STATE_SCORED], true)) {
                        throw BusinessRejection::forCode('placement.profile_not_open_for_attempt', 'attempts may be opened only on a draft or scored placement profile');
                    }
                    /** @var PlacementTestVersion $version */
                    $version = PlacementTestVersion::query()->lockForUpdate()->findOrFail($testVersionId);
                    $this->requireVersionPublished($version);

                    /** @var PlacementTest $test */
                    $test = PlacementTest::query()->whereKey($version->placement_test_id)->firstOrFail();
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

                    $attemptNo = (int) PlacementAttempt::query()->where('profile_id', $profile->id)->max('attempt_no') + 1;
                    $attempt = PlacementAttempt::query()->create([
                        'id' => RandomIdentifier::new(),
                        'profile_id' => $profile->id,
                        'test_version_id' => $version->id,
                        'delivery_mode' => $deliveryMode,
                        'attempt_no' => $attemptNo,
                        'status' => PlacementAttempt::STATUS_IN_PROGRESS,
                        'started_at' => now(),
                        'proctor_person_id' => $proctorPersonId,
                        'originating_branch_id' => $test->originating_branch_id,
                        'current_home_branch_id' => $test->current_home_branch_id,
                        'correlation_id' => RandomIdentifier::new(),
                    ]);
                    $event = $this->audit->record($actor->actorId, 'placement.attempt.start', 'placement_attempt', $attempt->id, null, [
                        'profile_id' => $profile->id, 'test_version_id' => $version->id, 'delivery' => $deliveryMode,
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
                                'scored_by' => $actor->actorId,
                                'rationale' => sprintf('server auto-score for section %s', $section->code),
                            ]);
                        } else {
                            PlacementSectionResult::query()->create([
                                'id' => RandomIdentifier::new(),
                                'attempt_id' => $locked->id,
                                'section_id' => $section->id,
                                'component' => $section->component,
                                'lifecycle_state' => PlacementSectionResult::STATE_SCORED,
                                'scored_by' => $actor->actorId,
                                'rationale' => 'awaiting professional marking',
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

                    $this->markScoredIfComplete($actor, $locked->profile_id);
                    $event = $this->audit->record($actor->actorId, 'placement.attempt.submit', 'placement_attempt', $locked->id, null, [
                        'delivery' => 'digital', 'duration' => $duration, 'tamper' => $tamper,
                    ]);
                    $this->traceVisitor($actor, $locked->id, $locked->profile_id);

                    return ['attempt_id' => $locked->id, 'tamper_flagged' => $tamper, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'placement.attempt.submit', 'placement_attempt', $attempt->id);
        }
    }

    /** @return array{attempt_id: string, correlation_id: string} */
    public function submitPhysical(Actor $actor, PlacementAttempt $attempt, string $evidenceRef, string $idempotencyKey): array
    {
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

                    $locked->forceFill([
                        'status' => PlacementAttempt::STATUS_SUBMITTED,
                        'ended_at' => $endedAt,
                        'duration_seconds' => $duration,
                        'evidence_ref' => $evidenceRef,
                        'anti_tamper_hmac' => hash('sha256', 'physical:'.$evidenceRef),
                    ])->save();
                    $event = $this->audit->record($actor->actorId, 'placement.attempt.submit', 'placement_attempt', $locked->id, null, [
                        'delivery' => 'physical', 'duration' => $duration,
                    ]);
                    $this->traceVisitor($actor, $locked->id, $locked->profile_id);

                    return ['attempt_id' => $locked->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'placement.attempt.submit', 'placement_attempt', $attempt->id);
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
                    $event = $this->audit->record($actor->actorId, 'placement.attempt.cancel', 'placement_attempt', $locked->id, ['status' => $locked->getOriginal('status')], ['status' => PlacementAttempt::STATUS_CANCELLED]);

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
                    PlacementProfileLifecycle::requireTransition($locked->lifecycle_state, $toState);
                    if ($toState === PlacementProfile::STATE_SCORED && ! $this->hasCompleteScoring($locked->id)) {
                        throw BusinessRejection::forCode('placement.profile_scoring_incomplete', 'every section must carry a score before the profile can be scored');
                    }
                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => $toState])->save();
                    $event = $this->audit->record($actor->actorId, 'placement.profile.transition', 'placement_profile', $locked->id, $before, [
                        'lifecycle_state' => $toState,
                    ]);

                    return ['profile_id' => $locked->id, 'lifecycle_state' => $toState, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'placement.profile.transition', 'placement_profile', $profile->id);
        }
    }

    private function markScoredIfComplete(Actor $actor, string $profileId): void
    {
        /** @var PlacementProfile $profile */
        $profile = PlacementProfile::query()->findOrFail($profileId);
        if ($profile->lifecycle_state === PlacementProfile::STATE_DRAFT && $this->hasCompleteScoring($profileId)) {
            $profile->forceFill(['lifecycle_state' => PlacementProfile::STATE_SCORED])->save();
            $this->audit->record($actor->actorId, 'placement.profile.transition', 'placement_profile', $profileId, ['lifecycle_state' => PlacementProfile::STATE_DRAFT], ['lifecycle_state' => PlacementProfile::STATE_SCORED]);
        }
    }

    private function hasCompleteScoring(string $profileId): bool
    {
        $attempt = PlacementAttempt::query()->where('profile_id', $profileId)->whereIn('status', [PlacementAttempt::STATUS_SUBMITTED])->latest('id')->first();
        if ($attempt === null) {
            return false;
        }
        $sectionIds = PlacementSection::query()->where('test_version_id', $attempt->test_version_id)->where('lifecycle_state', 'published')->pluck('id')->all();
        $resultIds = PlacementSectionResult::query()->where('attempt_id', $attempt->id)->pluck('section_id')->all();
        if (count(array_unique(array_intersect($sectionIds, $resultIds))) !== count($sectionIds)) {
            return false;
        }

        return PlacementSectionResult::query()->where('attempt_id', $attempt->id)->whereNull('raw_score')->doesntExist();
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

    private function traceVisitor(Actor $actor, string $attemptId, string $profileId): void
    {
        $profile = PlacementProfile::query()->find($profileId);
        if ($profile === null || $profile->person_id === null) {
            return;
        }
        $visitorId = $this->crmTrace->visitorIdForPerson($profile->person_id);
        if ($visitorId === null) {
            return;
        }
        $this->crmTrace->record($actor, $visitorId, 'outbound', 'placement', 'other', 'placement attempt submitted for the person linked to this lead.', CarbonImmutable::now(), placementAttemptId: $attemptId);
    }
}
