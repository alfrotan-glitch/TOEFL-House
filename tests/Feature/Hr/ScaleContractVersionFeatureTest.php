<?php

declare(strict_types=1);

namespace Tests\Feature\Hr;

use App\Modules\Academic\Commands\MaintainSkill;
use App\Modules\Audit\Models\AuditEvent;
use App\Modules\Hr\Commands\MaintainContractVersion;
use App\Modules\Hr\Commands\MaintainEmployment;
use App\Modules\Hr\Commands\MaintainScale;
use App\Modules\Hr\Models\CompensationRule;
use App\Modules\Hr\Models\ContractVersion;
use App\Modules\Hr\Models\Employment;
use App\Modules\Hr\Models\Scale;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

/**
 * Compensation scales and versioned contracts: FM preparation/submission,
 * GM approval with preparer/beneficiary separation enforced in the command
 * and in the schema, immutability of approved versions and frozen rules,
 * amendment supersession and withdrawal before approval.
 */
final class ScaleContractVersionFeatureTest extends TestCase
{
    use BuildsActors;

    private string $employmentId;

    private string $teacherPersonId = 'p16-teacher-10';

    private string $scaleId = '';

    private string $skillAId = '';

    private string $skillBId = '';

    protected function setUp(): void
    {
        parent::setUp();
        $this->personWithAuthority($this->teacherPersonId, []);

        $manager = $this->grantedActor('p16-hr-1', ['hr.employ']);
        $employment = app(MaintainEmployment::class)->employ($manager, $this->teacherPersonId, 'p16-emp-1');
        $this->employmentId = $employment['employment_id'];

        $scaleRegistrar = $this->grantedActor('p16-scale-1', ['hr.scale']);
        $this->scaleId = app(MaintainScale::class)->register($scaleRegistrar, 'S3', 'Senior instructor', 3, 'p16-scale-reg-1')['scale_id'];

        $skillRegistrar = $this->grantedActor('p16-skillreg-1', ['academic.skill']);
        $skills = app(MaintainSkill::class);
        $this->skillAId = $skills->register($skillRegistrar, 'speaking_listening', 'Speaking & Listening', 'p16-sk-1')['skill_id'];
        $this->skillBId = $skills->register($skillRegistrar, 'writing_grammar', 'Writing & Grammar', 'p16-sk-2')['skill_id'];

        // The employment stays a candidate here: a versioned contract is
        // prepared for it and activates the chain at approval; employment
        // activation (hire) is exercised in the payroll suite where an
        // in-force contract exists first.
    }

    private function financeManager(): Actor
    {
        return $this->grantedActor('p16-fm-1', ['hr.contract.prepare']);
    }

    private function generalManager(): Actor
    {
        return $this->grantedActor('p16-gm-1', ['hr.contract.approve']);
    }

    /**
     * @return array{version_id: string, contract_id: string}
     */
    private function preparedVersion(array $rules, ?string $scaleId, string $effectiveFrom, string $keyPrefix): array
    {
        $fm = $this->financeManager();
        $commands = app(MaintainContractVersion::class);
        $prepared = $commands->prepare($fm, Employment::query()->findOrFail($this->employmentId), 'contract/terms.pdf', $scaleId, $effectiveFrom, null, $keyPrefix.'-prep');
        $version = ContractVersion::query()->findOrFail($prepared['version_id']);
        foreach ($rules as $index => $rule) {
            $commands->addRule($fm, $version, $rule['method'], $rule['rate'], $rule['skill_id'] ?? null, $rule['scale_id'] ?? null, $rule['label'] ?? null, $keyPrefix.'-rule-'.$index);
        }

        return ['version_id' => $prepared['version_id'], 'contract_id' => $prepared['contract_id']];
    }

    public function test_scale_catalog_registration_rank_uniqueness_and_retirement(): void
    {
        $registrar = $this->grantedActor('p16-scale-1', ['hr.scale']);
        $command = app(MaintainScale::class);

        $command->register($registrar, 'S4', 'Lead instructor', 4, 'p16-scale-reg-2');
        $this->assertDatabaseHas('scales', ['key' => 'S4', 'rank_order' => 4]);

        try {
            $command->register($registrar, 'S3', 'Duplicate key', 5, 'p16-scale-reg-3');
            $this->fail('a duplicate scale key must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('hr.scale_duplicate', $rejection->errorCode());
        }

        try {
            $command->register($registrar, 'S5', 'Duplicate rank', 3, 'p16-scale-reg-4');
            $this->fail('a duplicate rank order must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('hr.scale_rank_duplicate', $rejection->errorCode());
        }

        $command->retire($registrar, Scale::query()->where('key', 'S4')->firstOrFail(), 'p16-scale-ret-1');
        try {
            DB::statement('UPDATE scales SET rank_order = 9 WHERE key = ?', ['S3']);
            $this->fail('scale rank is immutable');
        } catch (QueryException) {
            $this->addToAssertionCount(1);
        }
        try {
            DB::statement('DELETE FROM scales WHERE key = ?', ['S4']);
            $this->fail('scales are never deleted');
        } catch (QueryException) {
            $this->addToAssertionCount(1);
        }
    }

    public function test_fm_gm_lifecycle_with_sod_and_approval_evidence(): void
    {
        $commands = app(MaintainContractVersion::class);
        $prepared = $this->preparedVersion([
            ['method' => 'fixed_monthly', 'rate' => '20000.00'],
            ['method' => 'session_rate', 'rate' => '500.00', 'skill_id' => $this->skillAId],
            ['method' => 'session_rate', 'rate' => '600.00', 'skill_id' => $this->skillBId],
            ['method' => 'allowance', 'rate' => '1500.00', 'label' => 'transport'],
        ], $this->scaleId, '2026-08-01', 'p16-l1');
        $version = ContractVersion::query()->findOrFail($prepared['version_id']);

        $this->assertSame('draft', $version->lifecycle_state);
        $this->assertSame(1, $version->version_no);
        $this->assertDatabaseHas('contracts', ['id' => $prepared['contract_id'], 'lifecycle_state' => 'draft']);

        try {
            $commands->approve($this->financeManager(), $version, 'p16-l1-appr-early');
            $this->fail('the Finance Manager cannot approve');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('hr.contract_version_denied', $denial->errorCode());
        }

        $commands->submit($this->financeManager(), $version, 'p16-l1-sub');
        $this->assertDatabaseHas('contract_versions', ['id' => $version->id, 'lifecycle_state' => 'submitted']);

        $selfApprover = $this->grantedActor('p16-fm-1', ['hr.contract.prepare', 'hr.contract.approve']);
        try {
            $commands->approve($selfApprover, $version, 'p16-l1-appr-self');
            $this->fail('the preparer may never approve their own contract version');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('hr.contract_version_not_independent', $denial->errorCode());
        }

        $beneficiary = $this->grantedActor($this->teacherPersonId, ['hr.contract.approve']);
        try {
            $commands->approve($beneficiary, $version, 'p16-l1-appr-bene');
            $this->fail('the beneficiary may never approve their own contract');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('hr.contract_version_beneficiary', $denial->errorCode());
        }
        $this->assertSame(1, AuditEvent::query()->where('operation', 'hr.contract_version.approve.denied')->where('actor_id', $this->teacherPersonId)->count());

        $approval = $commands->approve($this->generalManager(), $version, 'p16-l1-appr');
        $this->assertSame('active', $approval['lifecycle_state']);
        $this->assertNotSame('', $approval['approval_digest']);
        $this->assertDatabaseHas('contract_versions', ['id' => $version->id, 'lifecycle_state' => 'active', 'approved_by' => 'p16-gm-1']);
        $this->assertDatabaseHas('contracts', ['id' => $prepared['contract_id'], 'lifecycle_state' => 'active', 'signed_by' => 'p16-gm-1']);

        try {
            DB::statement('UPDATE contract_versions SET terms_ref = ? WHERE id = ?', ['forged', $version->id]);
            $this->fail('approved versions are immutable');
        } catch (QueryException) {
            $this->addToAssertionCount(1);
        }
        try {
            DB::statement('UPDATE contract_versions SET approved_by = ? WHERE id = ?', ['p16-gm-1', $version->id]);
            $this->fail('approval identity is immutable');
        } catch (QueryException) {
            $this->addToAssertionCount(1);
        }
        try {
            DB::statement('DELETE FROM contract_versions WHERE id = ?', [$version->id]);
            $this->fail('contract versions are never deleted');
        } catch (QueryException) {
            $this->addToAssertionCount(1);
        }
        try {
            DB::statement('UPDATE compensation_rules SET rate = ? WHERE contract_version_id = ?', ['1.00', $version->id]);
            $this->fail('approved rules are frozen');
        } catch (QueryException) {
            $this->addToAssertionCount(1);
        }
        try {
            $ruleRow = ['id' => '00000000-0000-4000-8000-00000000f001', 'contract_version_id' => $version->id, 'method' => 'session_rate', 'skill_id' => null, 'scale_id' => null, 'label' => null, 'rate' => 100];
            DB::table('compensation_rules')->insert($ruleRow);
            $this->fail('the schema must reject rule inserts on an approved version');
        } catch (QueryException) {
            $this->addToAssertionCount(1);
        }
    }

    public function test_forged_approval_row_is_rejected_by_the_schema(): void
    {
        $prepared = $this->preparedVersion([['method' => 'fixed_monthly', 'rate' => '10000.00']], null, '2026-08-01', 'p16-l2');

        try {
            DB::table('contract_versions')->insert([
                'id' => '00000000-0000-4000-8000-00000000f101',
                'contract_id' => $prepared['contract_id'],
                'version_no' => 99,
                'lifecycle_state' => 'active',
                'terms_ref' => 'forged.pdf',
                'scale_id' => null,
                'effective_from' => '2026-08-01',
                'effective_to' => null,
                'prepared_by' => 'p16-fm-1',
                'submitted_at' => now(),
                'approved_by' => 'p16-fm-1',
                'approved_at' => now(),
                'approval_digest' => 'x',
            ]);
            $this->fail('the schema must reject a preparer approving their own version');
        } catch (QueryException) {
            $this->addToAssertionCount(1);
        }

        try {
            DB::table('contract_versions')->insert([
                'id' => '00000000-0000-4000-8000-00000000f102',
                'contract_id' => $prepared['contract_id'],
                'version_no' => 98,
                'lifecycle_state' => 'active',
                'terms_ref' => 'forged.pdf',
                'scale_id' => null,
                'effective_from' => '2026-08-01',
                'effective_to' => null,
                'prepared_by' => 'p16-fm-1',
                'submitted_at' => now(),
            ]);
            $this->fail('the schema must reject approval state without approval evidence');
        } catch (QueryException) {
            $this->addToAssertionCount(1);
        }
    }

    public function test_amendment_supersedes_prior_version_and_backdating_is_rejected(): void
    {
        $commands = app(MaintainContractVersion::class);
        $first = $this->preparedVersion([['method' => 'fixed_monthly', 'rate' => '20000.00']], null, '2026-08-01', 'p16-l3a');
        $commands->submit($this->financeManager(), ContractVersion::query()->findOrFail($first['version_id']), 'p16-l3a-sub');
        $commands->approve($this->generalManager(), ContractVersion::query()->findOrFail($first['version_id']), 'p16-l3a-appr');

        $second = $this->preparedVersion([['method' => 'fixed_monthly', 'rate' => '22000.00']], null, '2026-09-01', 'p16-l3b');
        $commands->submit($this->financeManager(), ContractVersion::query()->findOrFail($second['version_id']), 'p16-l3b-sub');
        $approval = $commands->approve($this->generalManager(), ContractVersion::query()->findOrFail($second['version_id']), 'p16-l3b-appr');
        $this->assertSame('approved', $approval['lifecycle_state']);

        $this->assertDatabaseHas('contract_versions', ['id' => $first['version_id'], 'lifecycle_state' => 'superseded', 'effective_to' => '2026-08-31']);
        $this->assertSame(2, ContractVersion::query()->findOrFail($second['version_id'])->version_no);

        $backdated = $this->preparedVersion([['method' => 'fixed_monthly', 'rate' => '9000.00']], null, '2026-08-15', 'p16-l3c');
        $commands->submit($this->financeManager(), ContractVersion::query()->findOrFail($backdated['version_id']), 'p16-l3c-sub');
        try {
            $commands->approve($this->generalManager(), ContractVersion::query()->findOrFail($backdated['version_id']), 'p16-l3c-appr');
            $this->fail('a backdated version overlapping an in-force version must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('hr.contract_version_backdated', $rejection->errorCode());
        }
    }

    public function test_rules_freeze_at_submission_and_withdrawal_is_pre_approval_only(): void
    {
        $commands = app(MaintainContractVersion::class);
        $prepared = $this->preparedVersion([['method' => 'fixed_monthly', 'rate' => '20000.00']], null, '2026-08-01', 'p16-l4');
        $version = ContractVersion::query()->findOrFail($prepared['version_id']);

        $commands->submit($this->financeManager(), $version, 'p16-l4-sub');
        try {
            $commands->addRule($this->financeManager(), $version, 'allowance', '500.00', null, null, 'late', 'p16-l4-rule-x');
            $this->fail('rules cannot be added after submission');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('hr.compensation_rule_version_frozen', $rejection->errorCode());
        }

        $commands->withdraw($this->financeManager(), $version, 'p16-l4-wd');
        $this->assertDatabaseHas('contract_versions', ['id' => $version->id, 'lifecycle_state' => 'withdrawn']);

        $replacement = $this->preparedVersion([['method' => 'fixed_monthly', 'rate' => '21000.00']], null, '2026-08-01', 'p16-l4b');
        $commands->submit($this->financeManager(), ContractVersion::query()->findOrFail($replacement['version_id']), 'p16-l4b-sub');
        $commands->approve($this->generalManager(), ContractVersion::query()->findOrFail($replacement['version_id']), 'p16-l4b-appr');
        $active = ContractVersion::query()->findOrFail($replacement['version_id']);

        try {
            $commands->withdraw($this->financeManager(), $active, 'p16-l4b-wd');
            $this->fail('an approved version cannot be withdrawn');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('hr.contract_version_transition_forbidden', $rejection->errorCode());
        }

        try {
            $commands->addRule($this->financeManager(), $active, 'allowance', '500.00', null, null, 'late', 'p16-l4b-rule-x');
            $this->fail('rules cannot be added after approval');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('hr.compensation_rule_version_frozen', $rejection->errorCode());
        }
    }

    public function test_rule_dimensions_overlap_and_deterministic_keying(): void
    {
        $fm = $this->financeManager();
        $commands = app(MaintainContractVersion::class);
        $prepared = $commands->prepare($fm, Employment::query()->findOrFail($this->employmentId), 'contract/terms.pdf', $this->scaleId, '2026-08-01', null, 'p16-l5-prep');
        $version = ContractVersion::query()->findOrFail($prepared['version_id']);

        $commands->addRule($fm, $version, 'session_rate', '500.00', $this->skillAId, null, null, 'p16-l5-r1');
        $commands->addRule($fm, $version, 'session_rate', '600.00', $this->skillBId, null, null, 'p16-l5-r2');
        $commands->addRule($fm, $version, 'session_rate', '550.00', $this->skillAId, $this->scaleId, null, 'p16-l5-r3');

        try {
            $commands->addRule($fm, $version, 'hourly_rate', '300.00', $this->skillAId, null, null, 'p16-l5-r4');
            $this->fail('a second per-unit rule for the same skill must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('hr.compensation_rule_overlap', $rejection->errorCode());
        }

        try {
            $commands->addRule($fm, $version, 'session_rate', '700.00', $this->skillAId, $this->scaleId, null, 'p16-l5-r5');
            $this->fail('a duplicate skill x scale key must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('hr.compensation_rule_overlap', $rejection->errorCode());
        }

        try {
            DB::table('compensation_rules')->insert([
                'id' => '00000000-0000-4000-8000-00000000f201', 'contract_version_id' => $version->id,
                'method' => 'session_rate', 'skill_id' => $this->skillAId, 'scale_id' => null, 'label' => null, 'rate' => 999,
            ]);
            $this->fail('the schema must reject duplicate per-unit keys');
        } catch (QueryException) {
            $this->addToAssertionCount(1);
        }

        try {
            $commands->addRule($fm, $version, 'fixed_monthly', '100.00', $this->skillAId, null, null, 'p16-l5-r6');
            $this->fail('a fixed line carries no skill dimension');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('hr.compensation_rule_dimension', $rejection->errorCode());
        }

        $scaleS4Id = app(MaintainScale::class)->register($this->grantedActor('p16-scale-1', ['hr.scale']), 'S4', 'Lead instructor', 4, 'p16-l5-scale-4')['scale_id'];
        try {
            $commands->addRule($fm, $version, 'session_rate', '100.00', null, $scaleS4Id, null, 'p16-l5-r7');
            $this->fail('a scale-keyed rate must match the version scale');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('hr.compensation_rule_scale_mismatch', $rejection->errorCode());
        }

        $commands->withdraw($fm, $version, 'p16-l5-wd');

        $noScalePrepared = $commands->prepare($fm, Employment::query()->findOrFail($this->employmentId), 'contract/terms-2.pdf', null, '2026-08-01', null, 'p16-l5b-prep');
        try {
            $commands->addRule($fm, ContractVersion::query()->findOrFail($noScalePrepared['version_id']), 'session_rate', '100.00', null, $this->scaleId, null, 'p16-l5b-r1');
            $this->fail('a version without a pinned scale cannot carry scale-keyed rates');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('hr.compensation_rule_scale_mismatch', $rejection->errorCode());
        }

        $this->assertSame(3, CompensationRule::query()->where('contract_version_id', $version->id)->count());
        $this->assertSame(1, ContractVersion::query()->where('contract_id', $prepared['contract_id'])->whereIn('lifecycle_state', ['draft', 'submitted'])->count());
    }
}
