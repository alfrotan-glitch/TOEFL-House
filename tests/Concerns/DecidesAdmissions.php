<?php

declare(strict_types=1);

namespace Tests\Concerns;

use App\Modules\Admissions\Commands\DecideAdmission;
use App\Modules\Admissions\Models\AdmissionDecision;
use App\Modules\Admissions\Models\Applicant;
use App\Support\Authorization\Actor;

/**
 * Drives the staged admission workflow (initiate -> review -> approve)
 * through the same authoritative commands the transport executes, one
 * session actor per stage. Fixture helper only — the admission behavior
 * tests exercise the stages individually.
 */
trait DecidesAdmissions
{
    /**
     * @return array{decision_id: string, outcome: string, lifecycle_state: string, correlation_id: string}
     */
    private function runAdmissionDecision(Actor $initiator, Actor $reviewer, Actor $approver, Applicant $applicant, bool $admit, string $reason, string $evidenceRef, string $keyBase): array
    {
        $initiated = app(DecideAdmission::class)->initiate($initiator, $applicant, $admit, $reason, $evidenceRef, $keyBase.'.initiate');
        $decisionId = (string) $initiated['decision_id'];
        app(DecideAdmission::class)->review($reviewer, AdmissionDecision::query()->findOrFail($decisionId), $keyBase.'.review');
        $finalized = app(DecideAdmission::class)->approve($approver, AdmissionDecision::query()->findOrFail($decisionId), $keyBase.'.approve');

        return $finalized;
    }
}
