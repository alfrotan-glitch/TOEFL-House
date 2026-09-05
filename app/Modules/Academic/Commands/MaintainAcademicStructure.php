<?php

declare(strict_types=1);

namespace App\Modules\Academic\Commands;

use App\Modules\Academic\Domain\AcademicAccess;
use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\BranchAvailability;
use App\Modules\Academic\Models\LevelPrerequisite;
use App\Modules\Academic\Models\LevelProgressionRule;
use App\Modules\Academic\Models\Offering;
use App\Modules\Academic\Models\Program;
use App\Modules\Academic\Models\ProgramVersion;
use App\Modules\Academic\Models\ProgramVersionLevel;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Organization\Models\Branch;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * Academic structure control: programs publish immutable versions, periods
 * publish and close. Published history is never silently rewritten — a
 * change is a new version.
 *
 * Scope boundary (WP-ACAD-SCOPE): curriculum governance (programs, levels,
 * periods, rules) is organization-global by design — its records carry no
 * branch — so those verbs check the capability globally (explicit null).
 * Branch-bound verbs (availability, offerings) check it in the target
 * branch's scope.
 */
final class MaintainAcademicStructure
{
    public const CAPABILITY = 'academic.structure';

    public function __construct(
        private readonly AcademicAccess $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{program_id: string, correlation_id: string} */
    public function defineProgram(Actor $actor, string $name, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.program.define', $name, $actor->actorId]));

        try {
            return $this->idempotency->execute('academic.program.define', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $name): array {
                    $this->requireCapability($actor, null);
                    if ($name === '') {
                        throw BusinessRejection::forCode('academic.program_name_missing', 'a program requires a name');
                    }

                    $program = Program::query()->create([
                        'id' => RandomIdentifier::new(), 'name' => $name, 'lifecycle_state' => 'draft',
                    ]);
                    $event = $this->audit->record($actor->actorId, 'academic.program.define', 'program', $program->id, null, ['name' => $name]);

                    return ['program_id' => $program->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.program.define', 'program', $name);
        }
    }

    /** @return array{version_id: string, version_no: int, correlation_id: string} */
    public function publishVersion(Actor $actor, Program $program, string $summary, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.program.publish', $program->id, $summary, $actor->actorId]));

        try {
            return $this->idempotency->execute('academic.program.publish', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $program, $summary): array {
                    $this->requireCapability($actor, null);

                    /** @var Program $locked */
                    $locked = Program::query()->whereKey($program->id)->lockForUpdate()->firstOrFail();
                    if ($locked->lifecycle_state === 'archived') {
                        throw BusinessRejection::forCode('academic.program_archived', 'an archived program cannot publish versions');
                    }
                    if ($summary === '') {
                        throw BusinessRejection::forCode('academic.version_summary_missing', 'a program version requires a summary');
                    }

                    /** @var int $maxVersion */
                    $maxVersion = (int) ProgramVersion::query()->where('program_id', $locked->id)->max('version_no');
                    $version = ProgramVersion::query()->create([
                        'id' => RandomIdentifier::new(),
                        'program_id' => $locked->id,
                        'version_no' => $maxVersion + 1,
                        'summary' => $summary,
                    ]);
                    if ($locked->lifecycle_state === 'draft') {
                        $locked->forceFill(['lifecycle_state' => 'published']);
                        $locked->save();
                    }

                    $event = $this->audit->record($actor->actorId, 'academic.program.publish', 'program_version', $version->id, null, [
                        'program_id' => $locked->id, 'version_no' => $version->version_no,
                    ]);

                    return ['version_id' => $version->id, 'version_no' => (int) $version->version_no, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.program.publish', 'program', $program->id);
        }
    }

    /**
     * @return array{level_id: string, correlation_id: string}
     */
    public function defineLevel(Actor $actor, string $programVersionId, string $levelKey, int $ordinal, string $title, ?string $cefrRef, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', [
            'academic.program.level.define', $programVersionId, $levelKey, (string) $ordinal, $title, $cefrRef ?? '', $actor->actorId,
        ]));

        try {
            return $this->idempotency->execute('academic.program.level.define', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $programVersionId, $levelKey, $ordinal, $title, $cefrRef): array {
                    $this->requireCapability($actor, null);

                    /** @var ProgramVersion $version */
                    $version = ProgramVersion::query()->whereKey($programVersionId)->lockForUpdate()->firstOrFail();
                    if ($levelKey === '' || $title === '') {
                        throw BusinessRejection::forCode('academic.level_required_fields', 'a level requires a key and a title');
                    }
                    if ($ordinal < 1) {
                        throw BusinessRejection::forCode('academic.level_ordinal_positive', 'a level ordinal must be at least 1');
                    }
                    if (ProgramVersionLevel::query()->where('program_version_id', $version->id)->where('level_key', $levelKey)->exists()) {
                        throw BusinessRejection::forCode('academic.level_key_exists', 'a level with this key already exists on the program version');
                    }
                    if (ProgramVersionLevel::query()->where('program_version_id', $version->id)->where('ordinal', $ordinal)->exists()) {
                        throw BusinessRejection::forCode('academic.level_ordinal_exists', 'a level with this ordinal already exists on the program version');
                    }
                    /** @var Program $program */
                    $program = Program::query()->whereKey($version->program_id)->firstOrFail();
                    if ($program->lifecycle_state === 'archived') {
                        throw BusinessRejection::forCode('academic.program_archived', 'an archived program cannot gain levels');
                    }

                    $level = ProgramVersionLevel::query()->create([
                        'id' => RandomIdentifier::new(),
                        'program_version_id' => $version->id,
                        'level_key' => $levelKey,
                        'ordinal' => $ordinal,
                        'title' => $title,
                        'cefr_ref' => $cefrRef,
                        'lifecycle_state' => 'active',
                    ]);
                    $event = $this->audit->record($actor->actorId, 'academic.program.level.define', 'program_version_level', $level->id, null, [
                        'program_version_id' => $version->id, 'level_key' => $levelKey, 'ordinal' => $ordinal, 'cefr_ref' => $cefrRef,
                    ]);

                    return ['level_id' => $level->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.program.level.define', 'program_version_level', $programVersionId);
        }
    }

    /** @return array{availability_id: string, correlation_id: string} */
    public function declareBranchAvailability(Actor $actor, string $branchId, string $programVersionLevelId, string $academicPeriodId, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', [
            'academic.branch_availability.declare', $branchId, $programVersionLevelId, $academicPeriodId, $actor->actorId,
        ]));

        try {
            return $this->idempotency->execute('academic.branch_availability.declare', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $branchId, $programVersionLevelId, $academicPeriodId): array {
                    $this->requireCapability($actor, $branchId);
                    $this->requireOpenTerm($academicPeriodId);
                    $this->requireActiveLevel($programVersionLevelId);
                    /** @var Branch $branch */
                    $branch = Branch::query()->whereKey($branchId)->firstOrFail();
                    if ($branch->lifecycle_state !== 'active') {
                        throw BusinessRejection::forCode('academic.branch_not_active', 'availability can only be declared for an active branch');
                    }
                    if (BranchAvailability::query()
                        ->where('branch_id', $branchId)
                        ->where('program_version_level_id', $programVersionLevelId)
                        ->where('academic_period_id', $academicPeriodId)
                        ->exists()) {
                        throw BusinessRejection::forCode('academic.availability_exists', 'this branch-level-term availability is already declared');
                    }

                    $availability = BranchAvailability::query()->create([
                        'id' => RandomIdentifier::new(),
                        'branch_id' => $branchId,
                        'program_version_level_id' => $programVersionLevelId,
                        'academic_period_id' => $academicPeriodId,
                        'lifecycle_state' => BranchAvailability::STATE_ACTIVE,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'academic.branch_availability.declare', 'branch_availability', $availability->id, null, [
                        'branch_id' => $branchId, 'program_version_level_id' => $programVersionLevelId, 'academic_period_id' => $academicPeriodId,
                    ]);

                    return ['availability_id' => $availability->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.branch_availability.declare', 'branch_availability', $branchId);
        }
    }

    /** @return array{offering_id: string, correlation_id: string} */
    public function openOffering(Actor $actor, string $branchId, string $programVersionLevelId, string $academicPeriodId, int $capacity, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', [
            'academic.offering.open', $branchId, $programVersionLevelId, $academicPeriodId, (string) $capacity, $actor->actorId,
        ]));

        try {
            return $this->idempotency->execute('academic.offering.open', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $branchId, $programVersionLevelId, $academicPeriodId, $capacity): array {
                    $this->requireCapability($actor, $branchId);
                    if ($capacity < 1) {
                        throw BusinessRejection::forCode('academic.offering_capacity_positive', 'an offering requires a positive capacity');
                    }
                    $this->requireOpenTerm($academicPeriodId);
                    $this->requireActiveLevel($programVersionLevelId);
                    if (! BranchAvailability::query()
                        ->where('branch_id', $branchId)
                        ->where('program_version_level_id', $programVersionLevelId)
                        ->where('academic_period_id', $academicPeriodId)
                        ->where('lifecycle_state', BranchAvailability::STATE_ACTIVE)
                        ->exists()) {
                        throw BusinessRejection::forCode('academic.offering_without_availability', 'an offering requires an active branch availability for the branch, level and term');
                    }
                    if (Offering::query()
                        ->where('branch_id', $branchId)
                        ->where('program_version_level_id', $programVersionLevelId)
                        ->where('academic_period_id', $academicPeriodId)
                        ->exists()) {
                        throw BusinessRejection::forCode('academic.offering_exists', 'this offering already exists');
                    }

                    $offering = Offering::query()->create([
                        'id' => RandomIdentifier::new(),
                        'branch_id' => $branchId,
                        'program_version_level_id' => $programVersionLevelId,
                        'academic_period_id' => $academicPeriodId,
                        'capacity' => $capacity,
                        'lifecycle_state' => 'open',
                    ]);
                    $event = $this->audit->record($actor->actorId, 'academic.offering.open', 'offering', $offering->id, null, [
                        'branch_id' => $branchId, 'program_version_level_id' => $programVersionLevelId, 'academic_period_id' => $academicPeriodId, 'capacity' => $capacity,
                    ]);

                    return ['offering_id' => $offering->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.offering.open', 'offering', $branchId);
        }
    }

    /** @return array{prerequisite_id: string, correlation_id: string} */
    public function definePrerequisite(Actor $actor, string $targetLevelId, string $requiredLevelId, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', [
            'academic.prerequisite.define', $targetLevelId, $requiredLevelId, $actor->actorId,
        ]));

        try {
            return $this->idempotency->execute('academic.prerequisite.define', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $targetLevelId, $requiredLevelId): array {
                    $this->requireCapability($actor, null);
                    $this->requireSameProgramVersion($targetLevelId, $requiredLevelId);
                    if ($targetLevelId === $requiredLevelId) {
                        throw BusinessRejection::forCode('academic.prerequisite_self', 'a level cannot require itself');
                    }
                    if (LevelPrerequisite::query()
                        ->where('target_level_id', $targetLevelId)
                        ->where('required_level_id', $requiredLevelId)
                        ->where('lifecycle_state', LevelPrerequisite::STATE_ACTIVE)
                        ->exists()) {
                        throw BusinessRejection::forCode('academic.prerequisite_exists', 'this active prerequisite already exists');
                    }
                    $this->assertNoActivePrerequisiteCycle($targetLevelId, $requiredLevelId);

                    $prerequisite = LevelPrerequisite::query()->create([
                        'id' => RandomIdentifier::new(),
                        'target_level_id' => $targetLevelId,
                        'required_level_id' => $requiredLevelId,
                        'lifecycle_state' => LevelPrerequisite::STATE_ACTIVE,
                        'defined_by' => $actor->actorId,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'academic.prerequisite.define', 'level_prerequisite', $prerequisite->id, null, [
                        'target_level_id' => $targetLevelId, 'required_level_id' => $requiredLevelId,
                    ]);

                    return ['prerequisite_id' => $prerequisite->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.prerequisite.define', 'level_prerequisite', $requiredLevelId);
        }
    }

    /** @return array{prerequisite_id: string, lifecycle_state: string, correlation_id: string} */
    public function retirePrerequisite(Actor $actor, LevelPrerequisite $prerequisite, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', [
            'academic.prerequisite.retire', $prerequisite->id, $actor->actorId,
        ]));

        try {
            return $this->idempotency->execute('academic.prerequisite.retire', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $prerequisite): array {
                    $this->requireCapability($actor, null);

                    /** @var LevelPrerequisite $locked */
                    $locked = LevelPrerequisite::query()->whereKey($prerequisite->id)->lockForUpdate()->firstOrFail();
                    if ($locked->lifecycle_state !== LevelPrerequisite::STATE_ACTIVE) {
                        throw BusinessRejection::forCode('academic.prerequisite_not_active', 'only an active prerequisite can be retired');
                    }
                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => LevelPrerequisite::STATE_RETIRED]);
                    $locked->save();
                    $event = $this->audit->record($actor->actorId, 'academic.prerequisite.retire', 'level_prerequisite', $locked->id, $before, ['lifecycle_state' => LevelPrerequisite::STATE_RETIRED]);

                    return ['prerequisite_id' => $locked->id, 'lifecycle_state' => LevelPrerequisite::STATE_RETIRED, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.prerequisite.retire', 'level_prerequisite', $prerequisite->id);
        }
    }

    /** @return array{rule_id: string, correlation_id: string} */
    public function defineProgressionRule(Actor $actor, string $levelId, ?string $minimumPassingScore, ?int $maxRepeats, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', [
            'academic.progression_rule.define', $levelId, $minimumPassingScore ?? '', (string) ($maxRepeats ?? ''), $actor->actorId,
        ]));

        try {
            return $this->idempotency->execute('academic.progression_rule.define', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $levelId, $minimumPassingScore, $maxRepeats): array {
                    $this->requireCapability($actor, null);
                    $this->requireActiveLevel($levelId);
                    if ($minimumPassingScore !== null && $minimumPassingScore !== '' && (! is_numeric($minimumPassingScore) || (float) $minimumPassingScore < 0 || (float) $minimumPassingScore > 100)) {
                        throw BusinessRejection::forCode('academic.progression_rule_score', 'a minimum passing score must be between 0 and 100');
                    }
                    if ($maxRepeats !== null && $maxRepeats < 1) {
                        throw BusinessRejection::forCode('academic.progression_rule_repeats', 'maximum repeats must be at least 1');
                    }
                    if (LevelProgressionRule::query()
                        ->where('program_version_level_id', $levelId)
                        ->where('lifecycle_state', LevelProgressionRule::STATE_ACTIVE)
                        ->exists()) {
                        throw BusinessRejection::forCode('academic.progression_rule_exists', 'this level already has an active progression rule');
                    }

                    $rule = LevelProgressionRule::query()->create([
                        'id' => RandomIdentifier::new(),
                        'program_version_level_id' => $levelId,
                        'minimum_passing_score' => $minimumPassingScore !== '' ? $minimumPassingScore : null,
                        'max_repeats' => $maxRepeats,
                        'lifecycle_state' => LevelProgressionRule::STATE_ACTIVE,
                        'defined_by' => $actor->actorId,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'academic.progression_rule.define', 'level_progression_rule', $rule->id, null, [
                        'program_version_level_id' => $levelId,
                        'minimum_passing_score' => $rule->minimum_passing_score,
                        'max_repeats' => $rule->max_repeats,
                    ]);

                    return ['rule_id' => $rule->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.progression_rule.define', 'level_progression_rule', $levelId);
        }
    }

    /** @return array{rule_id: string, lifecycle_state: string, correlation_id: string} */
    public function retireProgressionRule(Actor $actor, LevelProgressionRule $rule, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', [
            'academic.progression_rule.retire', $rule->id, $actor->actorId,
        ]));

        try {
            return $this->idempotency->execute('academic.progression_rule.retire', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $rule): array {
                    $this->requireCapability($actor, null);

                    /** @var LevelProgressionRule $locked */
                    $locked = LevelProgressionRule::query()->whereKey($rule->id)->lockForUpdate()->firstOrFail();
                    if ($locked->lifecycle_state !== LevelProgressionRule::STATE_ACTIVE) {
                        throw BusinessRejection::forCode('academic.progression_rule_not_active', 'only an active rule can be retired');
                    }
                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => LevelProgressionRule::STATE_RETIRED]);
                    $locked->save();
                    $event = $this->audit->record($actor->actorId, 'academic.progression_rule.retire', 'level_progression_rule', $locked->id, $before, ['lifecycle_state' => LevelProgressionRule::STATE_RETIRED]);

                    return ['rule_id' => $locked->id, 'lifecycle_state' => LevelProgressionRule::STATE_RETIRED, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.progression_rule.retire', 'level_progression_rule', $rule->id);
        }
    }

    private function requireSameProgramVersion(string $targetLevelId, string $requiredLevelId): void
    {
        /** @var ProgramVersionLevel $target */
        $target = ProgramVersionLevel::query()->whereKey($targetLevelId)->firstOrFail();
        /** @var ProgramVersionLevel $required */
        $required = ProgramVersionLevel::query()->whereKey($requiredLevelId)->firstOrFail();
        if (trim((string) $target->program_version_id) !== trim((string) $required->program_version_id)) {
            throw BusinessRejection::forCode('academic.prerequisite_cross_version', 'a prerequisite must belong to the same program version');
        }
    }

    private function assertNoActivePrerequisiteCycle(string $targetLevelId, string $requiredLevelId): void
    {
        $cycle = DB::select(<<<'SQL'
            WITH RECURSIVE chain AS (
                SELECT required_level_id AS node
                  FROM level_prerequisites
                 WHERE target_level_id = ?
                   AND lifecycle_state = 'active'
                UNION
                SELECT lp.required_level_id AS node
                  FROM level_prerequisites lp
                  JOIN chain ON lp.target_level_id = chain.node
                 WHERE lp.lifecycle_state = 'active'
            )
            SELECT 1 AS found FROM chain WHERE node = ? LIMIT 1
            SQL, [$requiredLevelId, $targetLevelId]);

        if ($cycle !== []) {
            throw BusinessRejection::forCode('academic.prerequisite_cycle', 'level prerequisite cycles are not allowed');
        }
    }

    private function requireOpenTerm(string $academicPeriodId): void
    {
        /** @var AcademicPeriod $period */
        $period = AcademicPeriod::query()->whereKey($academicPeriodId)->lockForUpdate()->firstOrFail();
        if ($period->lifecycle_state !== 'published') {
            throw BusinessRejection::forCode('academic.period_not_open', 'the academic term must be published/open');
        }
    }

    private function requireActiveLevel(string $programVersionLevelId): void
    {
        /** @var ProgramVersionLevel $level */
        $level = ProgramVersionLevel::query()->whereKey($programVersionLevelId)->firstOrFail();
        if ($level->lifecycle_state !== 'active') {
            throw BusinessRejection::forCode('academic.level_not_active', 'the program-version level must be active');
        }
    }

    /** @return array{period_id: string, correlation_id: string} */
    public function definePeriod(Actor $actor, string $name, CarbonImmutable $startsOn, CarbonImmutable $endsOn, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.period.define', $name, $startsOn->toDateString(), $endsOn->toDateString(), $actor->actorId]));

        try {
            return $this->idempotency->execute('academic.period.define', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $name, $startsOn, $endsOn): array {
                    $this->requireCapability($actor, null);
                    if ($endsOn->startOfDay()->lessThanOrEqualTo($startsOn->startOfDay())) {
                        throw BusinessRejection::forCode('academic.period_window', 'a period must end after it starts');
                    }

                    $period = AcademicPeriod::query()->create([
                        'id' => RandomIdentifier::new(),
                        'name' => $name,
                        'starts_on' => $startsOn->startOfDay()->toDateString(),
                        'ends_on' => $endsOn->startOfDay()->toDateString(),
                        'lifecycle_state' => 'draft',
                    ]);
                    $event = $this->audit->record($actor->actorId, 'academic.period.define', 'academic_period', $period->id, null, ['name' => $name]);

                    return ['period_id' => $period->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.period.define', 'academic_period', $name);
        }
    }

    /** @return array{period_id: string, lifecycle_state: string, correlation_id: string} */
    public function transitionPeriod(Actor $actor, AcademicPeriod $period, string $toState, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.period.transition', $period->id, $toState, $actor->actorId]));

        try {
            return $this->idempotency->execute('academic.period.transition', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $period, $toState): array {
                    $this->requireCapability($actor, null);

                    $from = $period->lifecycle_state;
                    $allowed = ['draft' => ['published'], 'published' => ['closed'], 'closed' => []][$from] ?? null;
                    if ($allowed === null || ! in_array($toState, $allowed, true)) {
                        throw BusinessRejection::forCode('academic.period_transition_forbidden', sprintf('transition %s -> %s is not allowed', $from, $toState));
                    }

                    $period->forceFill(['lifecycle_state' => $toState]);
                    $period->save();
                    $event = $this->audit->record($actor->actorId, 'academic.period.transition', 'academic_period', $period->id, ['lifecycle_state' => $from], ['lifecycle_state' => $toState]);

                    return ['period_id' => $period->id, 'lifecycle_state' => $toState, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.period.transition', 'academic_period', $period->id);
        }
    }

    /**
     * Branch-bound verbs pass the target branch; governance verbs pass an
     * explicit null (global check, WP-ACAD-SCOPE). No default: every call
     * site must state its scope choice.
     */
    private function requireCapability(Actor $actor, ?string $branchId): void
    {
        $this->access->require($actor, self::CAPABILITY, $branchId, 'academic.structure_denied');
    }
}
