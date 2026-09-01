<?php

declare(strict_types=1);

namespace Tests\Feature\Console;

use App\Modules\Finance\Models\FinancialPeriod;
use App\Modules\Identity\Models\UserAccount;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\Hash;
use Tests\Concerns\BuildsActors;
use Tests\Concerns\BuildsStudents;
use Tests\TestCase;

/**
 * E2E business-journey finding N3: a governed domain rejection raised on a
 * state-changing console request must never eject an authenticated employee
 * to the login page. When no Referer is present (programmatic / same-origin
 * API-style clients, which the console explicitly supports), redirect()->back()
 * resolves to the framework's "previous URL" stored in the session — for a
 * freshly signed-in employee that is /login — so an AuthorizationDenied /
 * BusinessRejection bounced the user to the login screen and discarded the
 * flash error_code. The exception handler now returns an authenticated user to
 * the console home and keeps the flash; JSON/API clients already received the
 * structured 403/409 payload (unchanged, asserted here).
 */
final class DomainRejectionTransportFeatureTest extends TestCase
{
    use BuildsActors;
    use BuildsStudents;

    private function signIn(string $personId, string $username): void
    {
        UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $personId,
            'username' => $username,
            'password_hash' => Hash::make('transport-pw-1'),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);
        $this->post('/login', ['username' => $username, 'password' => 'transport-pw-1'])->assertRedirect('/');
    }

    public function test_a_domain_rejection_without_referer_returns_an_authenticated_user_to_console_home_not_login(): void
    {
        $student = $this->makeStudent()['student'];
        // A person with NO finance.payment authority.
        $nobody = $this->personWithAuthority('drt-nobody-1', []);
        $this->signIn($nobody->id, 'drt.nobody');

        $period = FinancialPeriod::query()->create([
            'id' => RandomIdentifier::new(),
            'period_key' => '2026-10',
            'date_from' => '2026-10-01',
            'date_to' => '2026-10-31',
            'lifecycle_state' => 'open',
        ]);

        // No Referer header: the denial must redirect to the console home ('/'),
        // never to /login, and must carry the governed error code in the flash.
        $response = $this->post('/finance/payments', [
            'period_id' => $period->id,
            'student_id' => $student->id,
            'amount' => '10.00',
            'method' => 'cash',
            'payer_ref' => 'DRT-DENIED-1',
            'received_on' => '2026-10-01',
        ]);

        $response->assertRedirect('/');
        $response->assertSessionHas('error_code', 'finance.payment_denied');
        $this->assertAuthenticated();
    }

    public function test_a_domain_rejection_with_a_referer_bounces_back_to_that_page(): void
    {
        $student = $this->makeStudent()['student'];
        $nobody = $this->personWithAuthority('drt-nobody-2', []);
        $this->signIn($nobody->id, 'drt.nobody2');

        $period = FinancialPeriod::query()->create([
            'id' => RandomIdentifier::new(),
            'period_key' => '2026-11',
            'date_from' => '2026-11-01',
            'date_to' => '2026-11-30',
            'lifecycle_state' => 'open',
        ]);

        $this->post('/finance/payments', [
            'period_id' => $period->id,
            'student_id' => $student->id,
            'amount' => '10.00',
            'method' => 'cash',
            'payer_ref' => 'DRT-DENIED-2',
            'received_on' => '2026-11-01',
        ], ['referer' => 'http://localhost/finance'])
            ->assertRedirect('/finance')
            ->assertSessionHas('error_code', 'finance.payment_denied');
    }
}
