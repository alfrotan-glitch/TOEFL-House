<?php

declare(strict_types=1);

namespace App\Modules\Academic\Queries;

use App\Modules\Academic\Models\Transcript;
use App\Support\Signing\CanonicalJson;

/**
 * Read-only access to issued transcripts. Prints and verification render
 * the stored payload — the row is immutable, so the issued record is the
 * history as of its issue date by construction.
 */
final class TranscriptQuery
{
    /** @return array{transcript: Transcript, payload: array<string, mixed>}|null */
    public function issued(string $transcriptId): ?array
    {
        /** @var Transcript|null $transcript */
        $transcript = Transcript::query()->find($transcriptId);
        if ($transcript === null) {
            return null;
        }

        /** @var array<string, mixed> $payload */
        $payload = $transcript->payload;

        return ['transcript' => $transcript, 'payload' => $payload];
    }

    /** @return list<Transcript> */
    public function issuedForStudent(string $studentId, ?string $programVersionId = null): array
    {
        return Transcript::query()
            ->where('student_id', $studentId)
            ->when($programVersionId !== null && $programVersionId !== '', fn ($query) => $query->where('program_version_id', $programVersionId))
            ->orderByDesc('issued_at')
            ->get()
            ->all();
    }

    /**
     * Recomputes the content hash from the stored payload. Canonical JSON
     * sorts keys, so storage key order cannot affect the digest.
     */
    public function verify(Transcript $transcript): bool
    {
        /** @var array<string, mixed> $payload */
        $payload = $transcript->payload;

        return hash_equals($transcript->content_hash, hash('sha256', CanonicalJson::encode($payload)));
    }
}
