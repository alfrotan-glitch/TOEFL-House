<?php

declare(strict_types=1);

namespace App\Modules\Academic\Commands;

use App\Modules\Academic\Domain\RoomLifecycle;
use App\Modules\Academic\Models\AcademicRoom;
use App\Modules\Academic\Models\ClassSession;
use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Organization\Models\Branch;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * Room resource control: a branch-owned physical room with capacity and an
 * available|maintenance|retired lifecycle. Retiring or maintaining is refused
 * while future sessions still reference the room (DB guard), and capacity is
 * always positive.
 */
final class MaintainRoom
{
    public const CAPABILITY = 'academic.structure';

    /** @var list<string> */
    private const ROOM_TYPES = ['classroom', 'lab', 'computer', 'hall', 'other'];

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{room_id: string, correlation_id: string} */
    public function defineRoom(Actor $actor, string $branchId, string $name, string $code, int $capacity, string $roomType, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.room.define', $branchId, $name, $code, (string) $capacity, $roomType, $actor->actorId]));

        try {
            return $this->idempotency->execute('academic.room.define', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $branchId, $name, $code, $capacity, $roomType): array {
                    $this->requireCapability($actor);
                    $this->assertRoomDefinition($branchId, $name, $code, $capacity, $roomType);

                    $room = AcademicRoom::query()->create([
                        'id' => RandomIdentifier::new(),
                        'branch_id' => $branchId,
                        'name' => $name,
                        'code' => $code,
                        'capacity' => $capacity,
                        'room_type' => $roomType,
                        'lifecycle_state' => RoomLifecycle::STATE_AVAILABLE,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'academic.room.define', 'academic_room', $room->id, null, [
                        'branch_id' => $branchId, 'name' => $name, 'code' => $code, 'capacity' => $capacity, 'room_type' => $roomType,
                    ]);

                    return ['room_id' => $room->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.room.define', 'academic_room', $branchId);
        }
    }

    /** @return array{room_id: string, lifecycle_state: string, correlation_id: string} */
    public function transition(Actor $actor, AcademicRoom $room, string $toState, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.room.transition', $room->id, $toState, $actor->actorId]));

        try {
            return $this->idempotency->execute('academic.room.transition.'.$toState, $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $room, $toState): array {
                    $this->requireCapability($actor);

                    /** @var AcademicRoom $locked */
                    $locked = AcademicRoom::query()->whereKey($room->id)->lockForUpdate()->firstOrFail();
                    $from = $locked->lifecycle_state;
                    RoomLifecycle::requireTransition($from, $toState);
                    if (in_array($toState, [RoomLifecycle::STATE_MAINTENANCE, RoomLifecycle::STATE_RETIRED], true)) {
                        $future = ClassSession::query()->where('room_id', $locked->id)->where('scheduled_on', '>=', CarbonImmutable::today()->toDateString())->count();
                        if ($future > 0) {
                            throw BusinessRejection::forCode('academic.room_has_future_sessions', 'a room cannot be taken out of service while future sessions reference it');
                        }
                    }

                    $locked->forceFill(['lifecycle_state' => $toState])->save();
                    $event = $this->audit->record($actor->actorId, 'academic.room.transition.'.$toState, 'academic_room', $locked->id, ['lifecycle_state' => $from], ['lifecycle_state' => $toState]);

                    return ['room_id' => $locked->id, 'lifecycle_state' => $toState, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.room.transition', 'academic_room', $room->id);
        }
    }

    /** @return array{room_id: string, capacity: int, correlation_id: string} */
    public function resize(Actor $actor, AcademicRoom $room, int $capacity, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['academic.room.resize', $room->id, (string) $capacity, $actor->actorId]));

        try {
            return $this->idempotency->execute('academic.room.resize', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $room, $capacity): array {
                    $this->requireCapability($actor);
                    if ($capacity < 1) {
                        throw BusinessRejection::forCode('academic.room_capacity_positive', 'a room requires a positive capacity');
                    }

                    /** @var AcademicRoom $locked */
                    $locked = AcademicRoom::query()->whereKey($room->id)->lockForUpdate()->firstOrFail();
                    if ($locked->capacity === $capacity) {
                        throw BusinessRejection::forCode('academic.room_capacity_unchanged', 'room capacity is already set to this value');
                    }

                    $before = ['capacity' => $locked->capacity];
                    $locked->forceFill(['capacity' => $capacity])->save();
                    $event = $this->audit->record($actor->actorId, 'academic.room.resize', 'academic_room', $locked->id, $before, ['capacity' => $capacity]);

                    return ['room_id' => $locked->id, 'capacity' => $capacity, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'academic.room.resize', 'academic_room', $room->id);
        }
    }

    private function assertRoomDefinition(string $branchId, string $name, string $code, int $capacity, string $roomType): void
    {
        if (Branch::query()->whereKey($branchId)->doesntExist()) {
            throw BusinessRejection::forCode('academic.room_branch_unknown', 'a room requires a known branch');
        }
        if ($name === '' || $code === '') {
            throw BusinessRejection::forCode('academic.room_name_code_required', 'a room requires a name and a branch-unique code');
        }
        if ($capacity < 1) {
            throw BusinessRejection::forCode('academic.room_capacity_positive', 'a room requires a positive capacity');
        }
        if (! in_array($roomType, self::ROOM_TYPES, true)) {
            throw BusinessRejection::forCode('academic.room_type_unknown', 'a room requires a known room type');
        }
        if (AcademicRoom::query()->where('branch_id', $branchId)->where('code', $code)->exists()) {
            throw BusinessRejection::forCode('academic.room_code_exists', 'a room code must be unique within its branch');
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
