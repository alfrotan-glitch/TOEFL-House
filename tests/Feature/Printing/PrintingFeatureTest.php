<?php

declare(strict_types=1);

namespace Tests\Feature\Printing;

use App\Modules\Finance\Models\FinancialPeriod;
use App\Modules\Finance\Models\Payment;
use App\Modules\Identity\Models\UserAccount;
use App\Modules\Organization\Models\Branch;
use App\Modules\Organization\Models\Organization;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\Hash;
use Tests\Concerns\BuildsStudents;
use Tests\TestCase;

/**
 * Printing is a first-class capability: documents carry the organization and
 * branch identity, a reproducible document number, the issue date, and the
 * responsible user, and they render the SAME authoritative records the
 * console and API read. These tests prove the render path over HTTP.
 */
final class PrintingFeatureTest extends TestCase
{
    use BuildsStudents;

    private function seedIdentity(): void
    {
        // The bootstrap organization id is the single institution; naming it
        // the official name keeps exactly one organization and the fixture's
        // access model and the document header agree.
        Organization::query()->updateOrCreate(
            ['id' => '00000000-0000-4000-8000-00000000b005'],
            ['name' => 'The TOEFL House', 'lifecycle_state' => 'active'],
        );
        Branch::query()->create([
            'id' => RandomIdentifier::new(),
            'name' => 'Kabul Main Branch',
            'lifecycle_state' => 'active',
        ]);
    }

    private function signIn(): void
    {
        // The print operator holds a position under the bootstrap
        // organization: authorized staff (read-authority), without any
        // branch grant — null-provenance documents render, branched ones do
        // not (see the authorization tests).
        $person = $this->personWithAuthority('print-emp-1', ['academic.enroll']);
        UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $person->id,
            'username' => 'print.employee',
            'password_hash' => Hash::make('print-password-1'),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);
        $this->post('/login', ['username' => 'print.employee', 'password' => 'print-password-1'])->assertRedirect('/');
    }

    public function test_payment_receipt_renders_with_org_identity_and_amount(): void
    {
        $this->seedIdentity();
        $this->signIn();
        $student = $this->makeStudent()['student'];

        $period = FinancialPeriod::query()->create([
            'id' => RandomIdentifier::new(),
            'period_key' => '2026-08',
            'date_from' => '2026-08-01',
            'date_to' => '2026-08-31',
            'lifecycle_state' => 'open',
        ]);
        $payment = Payment::query()->create([
            'id' => RandomIdentifier::new(),
            'period_id' => $period->id,
            'student_id' => $student->id,
            'amount' => '250.00',
            'method' => 'cash',
            'payer_ref' => 'PAY-2026-08-001',
            'received_on' => '2026-08-10',
            'recorded_by' => 'print-emp-1',
        ]);

        $this->get('/print/receipt/'.$payment->id)
            ->assertOk()
            ->assertSee('The TOEFL House')
            ->assertSee('Kabul Main Branch')
            ->assertSee('Payment Receipt')
            ->assertSee('PAY-2026-08-001')
            ->assertSee('250.00');
    }

    public function test_student_id_card_renders_with_org_identity_and_code(): void
    {
        $this->seedIdentity();
        $this->signIn();
        $student = $this->makeStudent()['student'];

        $this->get('/print/id-card/'.$student->id)
            ->assertOk()
            ->assertSee('The TOEFL House')
            ->assertSee('STUDENT')
            ->assertSee($student->student_code);
    }

    public function test_print_routes_require_authentication(): void
    {
        $this->seedIdentity();
        $this->get('/print/invoice/some-id')->assertRedirect('/login');
    }

    /** @return array{0: Payment} */
    private function makeReceipt(string $orgName, array $branchNames, ?string $secondOrgName = null): Payment
    {
        Organization::query()->updateOrCreate(
            ['id' => '00000000-0000-4000-8000-00000000b005'],
            ['name' => $orgName, 'lifecycle_state' => 'active'],
        );
        if ($secondOrgName !== null) {
            Organization::query()->create([
                'id' => RandomIdentifier::new(), 'name' => $secondOrgName, 'lifecycle_state' => 'active',
            ]);
        }
        foreach ($branchNames as $branchName) {
            Branch::query()->create([
                'id' => RandomIdentifier::new(), 'name' => $branchName, 'lifecycle_state' => 'active',
            ]);
        }

        $this->signIn();
        $student = $this->makeStudent()['student'];
        $period = FinancialPeriod::query()->create([
            'id' => RandomIdentifier::new(),
            'period_key' => '2026-08',
            'date_from' => '2026-08-01',
            'date_to' => '2026-08-31',
            'lifecycle_state' => 'open',
        ]);

        return Payment::query()->create([
            'id' => RandomIdentifier::new(),
            'period_id' => $period->id,
            'student_id' => $student->id,
            'amount' => '250.00',
            'method' => 'cash',
            'payer_ref' => 'PAY-2026-08-IDENT',
            'received_on' => '2026-08-10',
            'recorded_by' => 'print-emp-1',
        ]);
    }

    public function test_document_identity_is_the_institution_brand_when_the_structure_is_ambiguous(): void
    {
        // Two active organizations AND two active branches: no single
        // organization or branch is uniquely determined, so the document must
        // carry the institution brand (config app.name) and no branch line —
        // never an arbitrary candidate.
        $payment = $this->makeReceipt('Beta Institute', ['Zeta Branch', 'Eta Branch'], 'Alpha Institute');

        $this->get('/print/receipt/'.$payment->id)
            ->assertOk()
            ->assertSee('The TOEFL House')          // the institution brand (app.name)
            ->assertDontSee('Alpha Institute')
            ->assertDontSee('Beta Institute')
            ->assertDontSee('Zeta Branch')
            ->assertDontSee('Eta Branch');
    }

    public function test_document_identity_shows_the_org_and_omits_the_branch_with_multiple_branches(): void
    {
        // One active organization: the header states it. Two active branches:
        // no branch is uniquely the issuing location (records are not
        // branch-scoped), so the branch line is omitted rather than guessed.
        $payment = $this->makeReceipt('TOEFL House Academy', ['Zeta Branch', 'Eta Branch']);

        $this->get('/print/receipt/'.$payment->id)
            ->assertOk()
            ->assertSee('TOEFL House Academy')
            ->assertDontSee('Zeta Branch')
            ->assertDontSee('Eta Branch');
    }
}
