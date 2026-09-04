<?php

declare(strict_types=1);

namespace App\Modules\Academic\Queries;

use App\Modules\Academic\Models\Certificate;
use App\Modules\Academic\Models\GraduationDecision;

/**
 * Read-only graduation truth for cross-module validation (Students alumni
 * gating, Documents/Reporting lineage). Returns the latest approved eligible
 * graduation decision for a student together with its issued certificate, if
 * any. It never decides status and never becomes financial truth.
 */
final class GraduationCertificationQuery
{
    /**
     * @return array{decision_id: string, program_version_id: string, certificate_id: string|null, document_id: string|null}|null
     */
    public function certificationForStudent(string $studentId): ?array
    {
        /** @var GraduationDecision|null $decision */
        $decision = GraduationDecision::query()
            ->where('student_id', $studentId)
            ->where('lifecycle_state', 'approved')
            ->where('outcome', 'eligible')
            ->orderByDesc('created_at')
            ->first();

        if ($decision === null) {
            return null;
        }

        /** @var Certificate|null $certificate */
        $certificate = Certificate::query()
            ->where('graduation_decision_id', $decision->id)
            ->first();

        return [
            'decision_id' => $decision->id,
            'program_version_id' => (string) $decision->program_version_id,
            'certificate_id' => $certificate?->id,
            'document_id' => $certificate?->document_id,
        ];
    }
}
