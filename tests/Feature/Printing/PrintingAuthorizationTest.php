<?php

declare(strict_types=1);

namespace Tests\Feature\Printing;

use App\Modules\Finance\Models\FinancialPeriod;
use App\Modules\Finance\Models\Payment;
use App\Modules\Identity\Models\UserAccount;
use App\Modules\Organization\Models\Branch;
use App\Modules\Students\Models\Student;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\Hash;
use Tests\Concerns\BuildsStudents;
use Tests\TestCase;

/**
 * Printing authorization (WP-ACAD-SCOPE): documents render only when the
 * owning branch is visible to the signed-in actor. Cross-branch production
 * attempts are refused with 403 and denial-audited; every production is
 * audit-logged. Null-provenance documents render for any authorized actor
 * but never for a bare session.
 */
final class PrintingAuthorizationTest extends TestCase
{
    use BuildsStudents;

    private string $branchA;

    private string $branchB;

    private string $studentA;

    private string $studentB;

    private string $studentNull;

    private string $payA;

    private string $payB;

    private string $payNull;

    protected function setUp(): void
    {
        parent::setUp();

        $this->branchA = $this->newBranch('Print Branch A');
        $this->branchB = $this->newBranch('Print Branch B');

        $this->studentA = $this->makeStudent()['student']->id;
        $this->studentB = $this->makeStudent()['student']->id;
        $this->studentNull = $this->makeStudent()['student']->id;
        // Provenance seeding: these students belong to their branches; the
        // third stays branchless (legacy/backfill shape).
        Student::query()->whereKey($this->studentA)->update(['current_home_branch_id' => $this->branchA]);
        Student::query()->whereKey($this->studentB)->update(['current_home_branch_id' => $this->branchB]);

        $period = FinancialPeriod::query()->create([
            'id' => RandomIdentifier::new(),
            'period_key' => '2026-10',
            'date_from' => '2026-10-01',
            'date_to' => '2026-10-31',
            'lifecycle_state' => 'open',
        ]);

        // Payments carry no branch of their own: the receipt gate falls back
        // to the owning student's branch.
        $this->payA = $this->newPayment($period->id, $this->studentA, 'PAY-PA-001');
        $this->payB = $this->newPayment($period->id, $this->studentB, 'PAY-PB-001');
        $this->payNull = $this->newPayment($period->id, $this->studentNull, 'PAY-PN-001');

        $this->makeLogin('officer.a', 'prt-officer-a', ['academic.enroll'], $this->branchA);
        $this->makeLogin('officer.bare', 'prt-officer-bare', [], null);
    }

    private function newBranch(string $name): string
    {
        $id = Branch::query()->create([
            'id' => RandomIdentifier::new(),
            'name' => $name.' '.substr(md5(RandomIdentifier::new()), 0, 8),
            'lifecycle_state' => 'active',
        ])->id;
        $this->attachBranchToBootstrapOrganization($id);

        return $id;
    }

    private function newPayment(string $periodId, string $studentId, string $payerRef): string
    {
        return Payment::query()->create([
            'id' => RandomIdentifier::new(),
            'period_id' => $periodId,
            'student_id' => $studentId,
            'amount' => '250.00',
            'method' => 'cash',
            'payer_ref' => $payerRef,
            'received_on' => '2026-10-10',
            'recorded_by' => 'prt-fixture-1',
        ])->id;
    }

    private function makeLogin(string $username, string $personId, array $capabilities, ?string $branchId): void
    {
        if ($branchId === null) {
            $this->personWithAuthority($personId, $capabilities);
        } else {
            $this->personWithAuthority($personId, []);
            $this->grantScopeAuthority($personId, $capabilities, 'branch', $branchId);
        }
        UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $personId,
            'username' => $username,
            'password_hash' => Hash::make('prt-password-1'),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);
    }

    private function signIn(string $username): void
    {
        $this->post('/login', ['username' => $username, 'password' => 'prt-password-1'])->assertRedirect('/');
    }

    public function test_cross_branch_receipt_production_is_refused_and_denial_audited(): void
    {
        $this->signIn('officer.a');

        // Direct-URL bypass attempt: guessing the branch-B receipt URL.
        // Over the web the denial returns the employee with a flash error;
        // JSON clients get the 403 — both refuse, both denial-audit.
        $this->get('/print/receipt/'.$this->payB)
            ->assertRedirect()
            ->assertSessionHas('error_code', 'print.denied');
        $this->getJson('/print/receipt/'.$this->payB)
            ->assertForbidden()
            ->assertJsonPath('error', 'print.denied');
        $this->assertDatabaseHas('audit_events', [
            'operation' => 'print.receipt.denied',
            'actor_id' => 'prt-officer-a',
        ]);

        // The ID-card gate derives the same way from the student row.
        $this->get('/print/id-card/'.$this->studentB)
            ->assertRedirect()
            ->assertSessionHas('error_code', 'print.denied');
        $this->assertDatabaseHas('audit_events', [
            'operation' => 'print.id_card.denied',
            'actor_id' => 'prt-officer-a',
        ]);
    }

    public function test_home_branch_documents_render_and_production_is_audited(): void
    {
        $this->signIn('officer.a');

        $this->get('/print/receipt/'.$this->payA)
            ->assertOk()
            ->assertSee('PAY-PA-001');
        $this->assertDatabaseHas('audit_events', [
            'operation' => 'print.receipt',
            'actor_id' => 'prt-officer-a',
        ]);

        $this->get('/print/id-card/'.$this->studentA)->assertOk();
        $this->assertDatabaseHas('audit_events', [
            'operation' => 'print.id_card',
            'actor_id' => 'prt-officer-a',
        ]);
    }

    public function test_null_provenance_documents_render_for_authorized_actors_only(): void
    {
        // The branch-A officer holds effective authority, so the
        // branchless receipt renders (backfill doctrine).
        $this->signIn('officer.a');
        $this->get('/print/receipt/'.$this->payNull)->assertOk()->assertSee('PAY-PN-001');

        // A bare session with no authority grant renders nothing.
        $this->post('/logout')->assertRedirect('/login');
        $this->signIn('officer.bare');
        $this->getJson('/print/receipt/'.$this->payNull)->assertForbidden();
        $this->getJson('/print/id-card/'.$this->studentNull)->assertForbidden();
    }
}
