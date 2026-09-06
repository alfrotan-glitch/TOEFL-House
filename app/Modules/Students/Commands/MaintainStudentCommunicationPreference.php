<?php

declare(strict_types=1);

namespace App\Modules\Students\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Students\Models\Student;
use App\Modules\Students\Models\StudentCommunicationPreference;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Student-owned channel preference. Consent itself remains the Privacy/Communication
 * authority; Student records which channel the learner prefers for messaging.
 */
final class MaintainStudentCommunicationPreference
{
    public const CAPABILITY = 'students.communication';

    private const CHANNELS = ['email', 'sms', 'whatsapp', 'push'];

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{preference_id: string, student_id: string, channel: string, enabled: bool, correlation_id: string} */
    public function setPreference(Actor $actor, Student $student, string $channel, bool $enabled, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['students.communication.set', $student->id, $channel, $enabled ? '1' : '0', $actor->actorId]));

        try {
            return $this->idempotency->execute('students.communication.set', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $student, $channel, $enabled): array {
                    $outcome = $this->access->decide($actor, self::CAPABILITY, null);
                    if (! $outcome->allowed) {
                        throw AuthorizationDenied::forCode('students.communication_denied', $outcome->reason);
                    }
                    if (! in_array($channel, self::CHANNELS, true)) {
                        throw BusinessRejection::forCode('students.communication_channel_unknown', sprintf('unknown communication channel %s', $channel));
                    }

                    /** @var Student $locked */
                    $locked = Student::query()->whereKey($student->id)->lockForUpdate()->firstOrFail();
                    $preference = StudentCommunicationPreference::query()
                        ->where('student_id', $locked->id)
                        ->where('channel', $channel)
                        ->lockForUpdate()
                        ->first();
                    if ($preference === null) {
                        $preference = StudentCommunicationPreference::query()->create([
                            'id' => RandomIdentifier::new(),
                            'student_id' => $locked->id,
                            'channel' => $channel,
                            'enabled' => $enabled,
                            'updated_by' => $actor->actorId,
                        ]);
                    } else {
                        $preference->forceFill(['enabled' => $enabled, 'updated_by' => $actor->actorId])->save();
                    }

                    $event = $this->audit->record($actor->actorId, 'students.communication.set', 'student_communication_preference', $preference->id, null, [
                        'student_id' => $locked->id, 'channel' => $channel, 'enabled' => $enabled,
                    ]);

                    return [
                        'preference_id' => $preference->id,
                        'student_id' => $locked->id,
                        'channel' => $channel,
                        'enabled' => $enabled,
                        'correlation_id' => $event->correlation_id,
                    ];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'students.communication.set', 'student_communication_preference', $student->id);
        }
    }
}
