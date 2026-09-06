<?php

declare(strict_types=1);

namespace App\Modules\Academic\Commands;

use App\Modules\Academic\Domain\AcademicAccess;
use App\Modules\Academic\Models\Skill;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Teaching skill catalog: registration and controlled retirement. Skills
 * are first-class identities referenced by teaching assignments, sessions
 * and compensation rules — never free text — and are never deleted.
 */
final class MaintainSkill
{
    public const CAPABILITY = 'academic.skill';

    public function __construct(
        private readonly AcademicAccess $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{skill_id: string, correlation_id: string} */
    public function register(Actor $actor, string $key, string $name, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.skill.register', $key, $name, $actor->actorId]));

        try {
            return $this->idempotency->execute('academic.skill.register', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $key, $name): array {
                    $this->require($actor);
                    if ($key === '' || $name === '') {
                        throw BusinessRejection::forCode('academic.skill_fields', 'a skill requires its catalog key and name');
                    }
                    if (Skill::query()->where('key', $key)->exists()) {
                        throw BusinessRejection::forCode('academic.skill_duplicate', 'this skill key already exists in the catalog');
                    }

                    $skill = Skill::query()->create([
                        'id' => RandomIdentifier::new(),
                        'key' => $key,
                        'name' => $name,
                        'lifecycle_state' => Skill::STATE_ACTIVE,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'academic.skill.register', 'skill', $skill->id, null, ['key' => $key, 'name' => $name]);

                    return ['skill_id' => $skill->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.skill.register', 'skill', $key);
        }
    }

    /** @return array{skill_id: string, lifecycle_state: string, correlation_id: string} */
    public function retire(Actor $actor, Skill $skill, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.skill.retire', $skill->id, $actor->actorId]));

        try {
            return $this->idempotency->execute('academic.skill.retire', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $skill): array {
                    $this->require($actor);

                    /** @var Skill $locked */
                    $locked = Skill::query()->where('id', $skill->id)->lockForUpdate()->firstOrFail();
                    if ($locked->lifecycle_state !== Skill::STATE_ACTIVE) {
                        throw BusinessRejection::forCode('academic.skill_not_active', 'only an active skill can be retired');
                    }

                    $before = ['lifecycle_state' => $locked->lifecycle_state];
                    $locked->forceFill(['lifecycle_state' => Skill::STATE_RETIRED]);
                    $locked->save();
                    $event = $this->audit->record($actor->actorId, 'academic.skill.retire', 'skill', $locked->id, $before, ['lifecycle_state' => Skill::STATE_RETIRED]);

                    return ['skill_id' => $locked->id, 'lifecycle_state' => Skill::STATE_RETIRED, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.skill.retire', 'skill', $skill->id);
        }
    }

    /**
     * Skills are organization-global curriculum records (WP-ACAD-SCOPE), so
     * the capability is checked globally. No default: call sites stay
     * explicit.
     */
    private function require(Actor $actor): void
    {
        $this->access->require($actor, self::CAPABILITY, null, 'academic.skill_denied');
    }
}
