<?php

declare(strict_types=1);

namespace App\Support\Idempotency;

use App\Support\Errors\BusinessRejection;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;

/**
 * System-wide idempotency boundary. The key claim, owner command, and
 * original outcome are one transaction. A unique-key loser re-reads the
 * committed winner so concurrent first submissions return the same outcome
 * instead of surfacing a raw duplicate-key error.
 */
final class IdempotentExecution
{
    /**
     * @template T
     *
     * @param  callable(): T  $command  owning transaction body
     * @return T
     */
    public function execute(string $operation, string $idempotencyKey, string $payloadHash, callable $command): mixed
    {
        try {
            return DB::transaction(function () use ($operation, $idempotencyKey, $payloadHash, $command): mixed {
                /** @var \stdClass|null $recorded */
                $recorded = DB::table('idempotency_keys')
                    ->where('operation', $operation)
                    ->where('idempotency_key', $idempotencyKey)
                    ->lockForUpdate()
                    ->first();

                if ($recorded !== null) {
                    return $this->returnRecorded($recorded, $payloadHash);
                }

                $outcome = $command();

                DB::table('idempotency_keys')->insert([
                    'id' => RandomIdentifier::new(),
                    'operation' => $operation,
                    'idempotency_key' => $idempotencyKey,
                    'payload_hash' => $payloadHash,
                    'outcome' => serialize($outcome),
                    'created_at' => now(),
                    'updated_at' => now(),
                ]);

                return $outcome;
            });
        } catch (QueryException $exception) {
            // A concurrent transaction may have inserted the unique key after
            // this transaction read the empty set. Its business transaction is
            // now committed, so the only safe recovery is to return that
            // exact result. Do not swallow unrelated constraint failures.
            /** @var \stdClass|null $recorded */
            $recorded = DB::table('idempotency_keys')
                ->where('operation', $operation)
                ->where('idempotency_key', $idempotencyKey)
                ->first();
            if ($recorded !== null) {
                return $this->returnRecorded($recorded, $payloadHash);
            }

            throw $exception;
        }
    }

    private function returnRecorded(object $recorded, string $payloadHash): mixed
    {
        if ((string) $recorded->payload_hash !== $payloadHash) {
            throw BusinessRejection::forCode('idempotency.conflicting_payload', 'idempotency key reused with a different payload');
        }

        return unserialize((string) $recorded->outcome, ['allowed_classes' => false]);
    }
}
