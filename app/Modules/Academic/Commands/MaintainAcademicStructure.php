<?php

declare(strict_types=1);

namespace App\Modules\Academic\Commands;

use App\Modules\Academic\Models\AcademicPeriod;
use App\Modules\Academic\Models\Program;
use App\Modules\Academic\Models\ProgramVersion;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Support\Authorization\AccessDecision;
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
 */
final class MaintainAcademicStructure
{
    public const CAPABILITY = 'academic.structure';

    public function __construct(
        private readonly AccessDecision $access,
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
                    $this->requireCapability($actor);
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
                    $this->requireCapability($actor);

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

    /** @return array{period_id: string, correlation_id: string} */
    public function definePeriod(Actor $actor, string $name, CarbonImmutable $startsOn, CarbonImmutable $endsOn, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.period.define', $name, $startsOn->toDateString(), $endsOn->toDateString(), $actor->actorId]));

        try {
            return $this->idempotency->execute('academic.period.define', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $name, $startsOn, $endsOn): array {
                    $this->requireCapability($actor);
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
                    $this->requireCapability($actor);

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

    private function requireCapability(Actor $actor): void
    {
        $outcome = $this->access->decide($actor, self::CAPABILITY, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('academic.structure_denied', $outcome->reason);
        }
    }
}
