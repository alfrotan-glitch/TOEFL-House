<?php

declare(strict_types=1);

namespace App\Modules\WorkManagement\Domain;

use App\Support\Errors\BusinessRejection;
use Illuminate\Support\Facades\DB;

/**
 * Closed coordination registry. A workflow can create an actionable work
 * item, but only the owning domain can approve, post, enroll, or transition
 * the source fact. Each definition also names its canonical source table so
 * coordination cannot be created for an invented source identifier.
 */
final class WorkflowCatalog
{
    /** @var array<string, array{version: int, name: string, work_kind: string, action_key: string, source_type: string, source_table: string}> */
    private const DEFINITIONS = [
        'admissions.decision_review' => [
            'version' => 1, 'name' => 'Admission decision review', 'work_kind' => 'approval', 'action_key' => 'admissions.decision.review',
            'source_type' => 'admission_decision', 'source_table' => 'admission_decisions',
        ],
        'admissions.decision_approval' => [
            'version' => 1, 'name' => 'Admission decision approval', 'work_kind' => 'approval', 'action_key' => 'admissions.decision.approve',
            'source_type' => 'admission_decision', 'source_table' => 'admission_decisions',
        ],
        'academic.appeal_review' => [
            'version' => 1, 'name' => 'Academic appeal review', 'work_kind' => 'approval', 'action_key' => 'academic.appeal.review',
            'source_type' => 'academic_appeal', 'source_table' => 'academic_appeals',
        ],
        'payroll.held_exception' => [
            'version' => 1, 'name' => 'Held payroll calculation resolution', 'work_kind' => 'exception', 'action_key' => 'payroll.calculation.resolve',
            'source_type' => 'payroll_calculation', 'source_table' => 'payroll_calculations',
        ],
        'finance.correction_approval' => [
            'version' => 1, 'name' => 'Financial correction approval', 'work_kind' => 'approval', 'action_key' => 'finance.correction.approve',
            'source_type' => 'financial_correction', 'source_table' => 'financial_corrections',
        ],
    ];

    /** @return array{version: int, name: string, work_kind: string, action_key: string, source_type: string, source_table: string} */
    public static function definition(string $key): array
    {
        if (! isset(self::DEFINITIONS[$key])) {
            throw BusinessRejection::forCode('workflow.definition_unknown', sprintf('workflow %s is not in the governed catalog', $key));
        }

        return self::DEFINITIONS[$key];
    }

    public static function assertSource(string $definitionKey, string $sourceType, string $sourceId): void
    {
        $definition = self::definition($definitionKey);
        if ($sourceType !== $definition['source_type']) {
            throw BusinessRejection::forCode('workflow.source_type_invalid', 'the workflow source type does not match its governed definition');
        }
        if (! DB::table($definition['source_table'])->where('id', $sourceId)->exists()) {
            throw BusinessRejection::forCode('workflow.source_unknown', 'the workflow source record does not exist');
        }
    }
}
