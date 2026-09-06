<?php

declare(strict_types=1);

namespace App\Modules\Documents\Queries;

use App\Modules\Documents\Models\Document;
use App\Modules\Documents\Models\DocumentVerification;
use App\Modules\Documents\Models\DocumentVersion;
use Illuminate\Support\Collection;

/**
 * Read-only evidence history of a document: immutable versions in order
 * with their verifications. No query result is an authority to mutate.
 */
final class DocumentHistoryQuery
{
    /**
     * @return array{document_id: string, lifecycle_state: string, versions: list<array<string, mixed>>}
     */
    public function documentHistory(string $documentId): array
    {
        /** @var Document $document */
        $document = Document::query()->findOrFail($documentId);

        /** @var Collection<int, DocumentVersion> $versions */
        $versions = DocumentVersion::query()->where('document_id', $documentId)->orderBy('version_no')->get();
        $history = [];
        foreach ($versions as $version) {
            $verifications = DocumentVerification::query()
                ->where('document_id', $documentId)
                ->where('version_no', $version->version_no)
                ->orderBy('created_at')
                ->get(['verifier_person_id', 'result', 'reason', 'created_at'])
                ->map(static fn (DocumentVerification $verification): array => [
                    'verifier' => $verification->verifier_person_id,
                    'result' => $verification->result,
                    'reason' => $verification->reason,
                    'at' => $verification->created_at?->toDateTimeString(),
                ])
                ->all();
            $history[] = [
                'version_no' => (int) $version->version_no,
                'content_hash' => $version->content_hash,
                'uploaded_by' => $version->uploaded_by,
                'verifications' => $verifications,
            ];
        }

        return [
            'document_id' => $documentId,
            'lifecycle_state' => $document->lifecycle_state,
            'versions' => $history,
        ];
    }
}
