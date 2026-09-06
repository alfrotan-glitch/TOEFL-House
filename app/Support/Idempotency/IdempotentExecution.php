<?php

declare(strict_types=1);

namespace App\Support\Idempotency;

use App\Support\Errors\BusinessRejection;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Idempotency of the implementation contract: an idempotency key scoped to
 * operation and source returns the original outcome for a repeated identical
 * command and rejects the same key carrying a different payload.
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
        /** @var \stdClass|null $recorded */
        $recorded = DB::table('idempotency_keys')
            ->where('operation', $operation)
            ->where('idempotency_key', $idempotencyKey)
            ->lockForUpdate()
            ->first();

        if ($recorded !== null) {
            if ($recorded->payload_hash !== $payloadHash) {
                throw BusinessRejection::forCode('idempotency.conflicting_payload', 'idempotency key reused with a different payload');
            }

            /** @var T $outcome */
            $outcome = unserialize($recorded->outcome, ['allowed_classes' => false]);

            return $outcome;
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
    }
}
