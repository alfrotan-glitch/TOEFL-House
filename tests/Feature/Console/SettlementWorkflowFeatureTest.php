<?php

declare(strict_types=1);

namespace Tests\Feature\Console;

use App\Modules\Hr\Commands\MaintainContractVersion;
use App\Modules\Hr\Commands\MaintainEmployment;
use App\Modules\Hr\Models\ContractVersion;
use App\Modules\Hr\Models\Employment;
use App\Modules\Identity\Models\Person;
use App\Modules\Identity\Models\UserAccount;
use App\Modules\Payroll\Models\FinalSettlement;
use App\Modules\Payroll\Models\SettlementProposal;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

/**
 * PHASE_3 transport completion: the termination settlement workflow —
 * the last two-signature workflow — is staged (000112) and exercised over
 * the real HTTP surface: HR and Finance clear in their own sessions, a
 * preparer proposes, and a distinct approver records the immutable
 * settlement. The transport carries one signature per session; every
 * domain rejection surfaces as a redirect with the error code.
 */
final class SettlementWorkflowFeatureTest extends TestCase
{
    use BuildsActors;

    private string $employmentId;

    private string $personId = 'swf-teacher-1';

    protected function setUp(): void
    {
        parent::setUp();
        $this->personWithAuthority($this->personId, []);

        $manager = $this->grantedActor('swf-manager-1', ['hr.employ', 'hr.terminate', 'access.assign_position']);
        $employment = app(MaintainEmployment::class)->employ($manager, $this->personId, 'swf-emp-1');
        $this->employmentId = $employment['employment_id'];

        $fm = $this->grantedActor('swf-fm-1', ['hr.contract.prepare']);
        $commands = app(MaintainContractVersion::class);
        $prepared = $commands->prepare($fm, Employment::query()->findOrFail($this->employmentId), 'contract/swf-2026-09.pdf', null, '2026-09-01', '2026-09-30', 'swf-con-1');
        $version = ContractVersion::query()->findOrFail($prepared['version_id']);
        $commands->addRule($fm, $version, 'fixed_monthly', '40000.00', null, null, null, 'swf-r-fix');
        $commands->submit($fm, $version, 'swf-con-2');
        $commands->approve($this->grantedActor('swf-gm-1', ['hr.contract.approve']), $version, 'swf-con-3');

        app(MaintainEmployment::class)->hire($manager, Employment::query()->findOrFail($this->employmentId), '2026-09-01', 'swf-emp-2');

        // The settlement under test targets this terminated employment.
        app(MaintainEmployment::class)->terminate($manager, Employment::query()->findOrFail($this->employmentId), '2026-10-01', 'contract ended', 'swf-emp-3');
    }

    /** @return array{0: Person, 1: UserAccount} */
    private function makeEmployee(string $personId, array $capabilities, string $username): array
    {
        $person = $this->personWithAuthority($personId, $capabilities);
        $account = UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $person->id,
            'username' => $username,
            'password_hash' => Hash::make('swf-password-1'),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);

        return [$person, $account];
    }

    private function signIn(string $username): void
    {
        $this->post('/login', ['username' => $username, 'password' => 'swf-password-1'])->assertRedirect('/');
        $this->assertAuthenticated();
    }

    private function signOut(): void
    {
        $this->post('/logout')->assertRedirect('/login');
        $this->assertGuest();
    }

    public function test_settlement_workflow_end_to_end_through_the_console(): void
    {
        $this->makeEmployee('swf-hr-1', ['payroll.clear_hr'], 'hr-clearer');
        $this->makeEmployee('swf-fin-1', ['payroll.clear_finance'], 'finance-clearer');
        $this->makeEmployee('swf-prep-1', ['payroll.settle'], 'settlement-preparer');
        $this->makeEmployee('swf-appr-1', ['payroll.settle_approve'], 'settlement-approver');

        // A proposal before both clearances exist is rejected by the domain.
        $this->signIn('settlement-preparer');
        $this->post('/payroll/employments/'.$this->employmentId.'/settlements', [
            'amount' => '5000',
            'basis' => 'remaining balance per ledger review',
        ], ['referer' => 'http://localhost/payroll'])
            ->assertRedirect('/payroll')
            ->assertSessionHas('error_code', 'payroll.settlement_requires_clearance');

        // HR and Finance clear in their own sessions.
        $this->signOut();
        $this->signIn('hr-clearer');
        $this->post('/payroll/employments/'.$this->employmentId.'/clearance', [
            'domain' => 'hr',
            'note' => 'no outstanding HR items',
        ])->assertRedirect('/payroll');

        $this->signOut();
        $this->signIn('finance-clearer');
        $this->post('/payroll/employments/'.$this->employmentId.'/clearance', [
            'domain' => 'finance',
            'note' => 'accounts reconciled',
        ])->assertRedirect('/payroll');

        // The preparer proposes in her own session.
        $this->signOut();
        $this->signIn('settlement-preparer');
        $this->post('/payroll/employments/'.$this->employmentId.'/settlements', [
            'amount' => '5000',
            'basis' => 'remaining balance per ledger review',
        ])->assertRedirect('/payroll');
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'settlement_proposals', [
            'employment_id' => $this->employmentId,
            'amount' => 5000,
            'lifecycle_state' => 'proposed',
        ]);

        // The preparer cannot approve her own proposal.
        $proposalId = DB::table(DB::connection()->getTablePrefix().'settlement_proposals')->where('employment_id', $this->employmentId)->value('id');
        $this->post('/payroll/settlements/'.$proposalId.'/approve', [], ['referer' => 'http://localhost/payroll'])
            ->assertRedirect('/payroll')
            ->assertSessionHas('error_code', 'payroll.settle_denied');

        // A different session signed in as the approver records the settlement.
        $this->signOut();
        $this->signIn('settlement-approver');
        $this->post('/payroll/settlements/'.$proposalId.'/approve')->assertRedirect('/payroll');
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'settlement_proposals', [
            'id' => $proposalId, 'lifecycle_state' => 'approved',
        ]);
        $this->assertSame(1, FinalSettlement::query()->where('employment_id', $this->employmentId)->count());
        $this->assertSame(1, SettlementProposal::query()->where('employment_id', $this->employmentId)->where('lifecycle_state', 'approved')->count());
    }

    public function test_settlement_proposal_is_still_rejected_without_clearances_after_http_clearance_denial(): void
    {
        // An employee without the clearance capability cannot record one
        // through the console; the domain rejects and the domain rule
        // keeps blocking the proposal.
        $this->makeEmployee('swf-nobody-1', ['payroll.settle'], 'lone-preparer');
        $this->signIn('lone-preparer');

        $this->post('/payroll/employments/'.$this->employmentId.'/clearance', [
            'domain' => 'hr',
            'note' => 'should be denied',
        ], ['referer' => 'http://localhost/payroll'])
            ->assertRedirect('/payroll')
            ->assertSessionHas('error_code', 'payroll.settle_denied');

        $this->post('/payroll/employments/'.$this->employmentId.'/settlements', [
            'amount' => '5000',
            'basis' => 'remaining balance',
        ], ['referer' => 'http://localhost/payroll'])
            ->assertRedirect('/payroll')
            ->assertSessionHas('error_code', 'payroll.settlement_requires_clearance');
        $this->assertSame(0, SettlementProposal::query()->count());
    }
}
