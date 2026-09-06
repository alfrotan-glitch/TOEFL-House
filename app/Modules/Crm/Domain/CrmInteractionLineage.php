<?php

declare(strict_types=1);

namespace App\Modules\Crm\Domain;

use App\Modules\Communication\Models\Message;
use App\Modules\Crm\Models\Visitor;
use App\Modules\Documents\Models\Document;
use App\Modules\Identity\Models\Person;
use App\Support\Errors\BusinessRejection;
use Illuminate\Support\Facades\DB;

/**
 * Validates the subject lineage of records attached to a CRM interaction.
 *
 * CRM may retain a timeline pointer, but it cannot turn an unrelated message,
 * document, academic attempt, or payment into evidence for a visitor. The
 * authoritative module owns each linked record; this service only proves the
 * immutable person identity shared by that record and the visitor.
 */
final class CrmInteractionLineage
{
    /**
     * @param  array<string, string|null>  $references
     */
    public function assert(
        Visitor $visitor,
        string $type,
        ?string $messageId = null,
        ?string $documentId = null,
        ?string $assessmentAttemptId = null,
        ?string $paymentId = null,
        ?string $placementAttemptId = null,
    ): void {
        $references = array_filter([
            'message' => $messageId,
            'document' => $documentId,
            'assessment' => $assessmentAttemptId,
            'payment' => $paymentId,
            'placement' => $placementAttemptId,
        ], static fn (?string $id): bool => $id !== null && trim($id) !== '');

        if (count($references) > 1) {
            throw BusinessRejection::forCode('crm.interaction_reference_count', 'an interaction may reference only one authoritative record');
        }
        if ($references === []) {
            if (in_array($type, ['document', 'payment', 'assessment', 'placement'], true)) {
                throw BusinessRejection::forCode('crm.interaction_reference_required', sprintf('%s interactions require their authoritative record reference', $type));
            }

            return;
        }

        $referenceKind = (string) array_key_first($references);
        $this->assertType($type, $referenceKind);

        $visitorPersonId = trim((string) DB::table('visitors')->where('id', $visitor->id)->value('person_id'));
        if ($visitorPersonId === '') {
            throw BusinessRejection::forCode('crm.interaction_person_required', 'a linked authoritative record requires an identity-linked visitor');
        }
        if (Person::query()->whereKey($visitorPersonId)->where('verification_state', Person::VERIFICATION_VERIFIED)->doesntExist()) {
            throw BusinessRejection::forCode('crm.interaction_person_unverified', 'a linked authoritative record requires a verified visitor identity');
        }

        $referenceId = (string) $references[$referenceKind];
        $subjectRecord = match ($referenceKind) {
            'message' => Message::query()->whereKey($referenceId)->first(['subject_person_id']),
            'document' => Document::query()->whereKey($referenceId)->first(['subject_person_id']),
            'assessment' => DB::table('assessment_attempts')
                ->join('enrollments', 'enrollments.id', '=', 'assessment_attempts.enrollment_id')
                ->join('students', 'students.id', '=', 'enrollments.student_id')
                ->where('assessment_attempts.id', $referenceId)
                ->first(['students.person_id', 'enrollments.originating_branch_id']),
            'payment' => DB::table('payments')
                ->join('students', 'students.id', '=', 'payments.student_id')
                ->where('payments.id', $referenceId)
                ->first(['students.person_id', 'payments.originating_branch_id']),
            'placement' => DB::table('placement_attempts')
                ->join('placement_profiles', 'placement_profiles.id', '=', 'placement_attempts.profile_id')
                ->where('placement_attempts.id', $referenceId)
                ->first(['placement_profiles.person_id', 'placement_attempts.originating_branch_id']),
            default => null,
        };
        $subjectPersonId = $subjectRecord?->person_id;
        $subjectBranchId = $subjectRecord?->originating_branch_id;
        $branchProvenanceRequired = in_array($referenceKind, ['assessment', 'payment', 'placement'], true);

        if ($subjectPersonId === null || trim((string) $subjectPersonId) === '') {
            throw BusinessRejection::forCode('crm.interaction_lineage_unknown', 'the linked authoritative record has no resolvable person subject');
        }
        if (trim((string) $subjectPersonId) !== $visitorPersonId) {
            throw BusinessRejection::forCode('crm.interaction_lineage_mismatch', 'the linked authoritative record belongs to a different person');
        }
        $visitorBranchId = trim((string) ($visitor->origin_branch_id ?? ''));
        $subjectBranchId = trim((string) ($subjectBranchId ?? ''));
        if ($branchProvenanceRequired && $visitorBranchId !== '' && ($subjectBranchId === '' || $visitorBranchId !== $subjectBranchId)) {
            throw BusinessRejection::forCode('crm.interaction_branch_mismatch', 'the linked authoritative record does not carry compatible originating branch provenance');
        }
    }

    private function assertType(string $type, string $referenceKind): void
    {
        $allowed = match ($referenceKind) {
            'message' => ['call', 'whatsapp', 'email', 'sms', 'other'],
            'document' => ['document'],
            'assessment' => ['assessment'],
            'payment' => ['payment'],
            'placement' => ['placement'],
            default => [],
        };
        if (! in_array($type, $allowed, true)) {
            throw BusinessRejection::forCode('crm.interaction_reference_type', sprintf('%s references require a compatible interaction type', $referenceKind));
        }
    }
}
