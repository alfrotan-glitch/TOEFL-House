<?php

declare(strict_types=1);

namespace Tests\Feature\Reliability;

use App\Modules\Identity\Models\Person;
use App\Modules\Identity\Models\UserAccount;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use PDO;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

/**
 * PHASE_4 reliability: the staged SoD guard holds under a REAL concurrent
 * race, not just sequential replay. Two independent PostgreSQL sessions
 * (the test process + a separate PHP child with its own connection) both
 * open transactions and both try to claim the same approver slots on the
 * same organization-wide grant request. The row lock serializes the
 * writers; the schema guard rejects the stale claimant and the winner's
 * write is intact.
 */
final class ConcurrencyRaceTest extends TestCase
{
    use BuildsActors;

    private const BOOTSTRAP_ORG = '00000000-0000-4000-8000-00000000b005';

    protected function setUp(): void
    {
        parent::setUp();

        $this->personWithAuthority('race-grantor', ['access.grant']);
        $this->personWithAuthority('race-grantee', []);

        /** @var Person $person */
        $person = Person::query()->whereKey('race-grantor')->firstOrFail();
        UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $person->id,
            'username' => 'race-grantor',
            'password_hash' => Hash::make('race-password-1'),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);
    }

    public function test_the_schema_guard_rejects_the_stale_writer_in_a_concurrent_slot_claim(): void
    {
        // A legitimate request over the real transport (the fixture must be
        // exactly what the domain produces).
        $this->post('/login', ['username' => 'race-grantor', 'password' => 'race-password-1'])->assertRedirect('/');
        $this->post('/access/grants/org-wide', [
            'person_id' => 'race-grantee', 'permission' => 'identity.verify',
            'organization_id' => self::BOOTSTRAP_ORG, 'effective_from' => '2026-09-01',
        ])->assertRedirect('/access');

        $requests = DB::connection()->getTablePrefix().'org_wide_grant_requests';
        $requestId = (string) DB::table($requests)->value('id');
        $this->assertDatabaseHas($requests, ['id' => $requestId, 'lifecycle_state' => 'requested']);

        $grantsBefore = (int) DB::table(DB::connection()->getTablePrefix().'scope_grants')->count();

        // The child opens its own PostgreSQL connection and its own
        // transaction, then signals readiness.
        $tmp = sys_get_temp_dir().'/race-'.getmypid();
        $readyFile = $tmp.'.ready';
        $resultFile = $tmp.'.result';
        $cfg = config('database.connections.'.config('database.default'));

        $cmd = [
            PHP_BINARY,
            base_path('tests/Stubs/concurrency_race_child.php'),
            (string) $cfg['database'], (string) $cfg['host'], (string) $cfg['port'],
            (string) $cfg['username'], (string) $cfg['password'],
            $requestId, 'race-child',
            $readyFile, $resultFile,
        ];
        $proc = proc_open($cmd, [1 => ['file', '/dev/null', 'w'], 2 => ['file', '/dev/null', 'w']], $pipes);
        $this->assertIsResource($proc);

        // Wait for the child's transaction to be open.
        $deadline = time() + 10;
        while (! file_exists($readyFile) && time() < $deadline) {
            usleep(50_000);
        }
        $this->assertFileExists($readyFile, 'the race child never opened its transaction');

        // The parent claims the same slots: its write takes the row lock.
        $pdo = DB::connection()->getPdo();
        $this->assertInstanceOf(PDO::class, $pdo);
        $pdo->beginTransaction();
        $pdo->exec(sprintf(
            "UPDATE %s SET approver_one_id = 'race-parent', approver_two_id = 'race-parent-2', lifecycle_state = 'approved' WHERE id = '%s'",
            $requests,
            $requestId,
        ));
        usleep(500_000);
        $pdo->commit();

        // The child's claim now lands against the committed row.
        $status = proc_close($proc);
        $this->assertSame(0, $status, 'the race child crashed');

        $outcome = (string) file_get_contents($resultFile);
        $this->assertStringStartsWith(
            'REJECTED: SQLSTATE[23514]',
            $outcome,
            'the stale concurrent claimant must be rejected by the schema guard (check violation)',
        );
        // Depending on the interleaving the guard fires its state-transition
        // branch (the stale writer read 'requested' before the winner
        // committed) or its written-once slot branch. Either way the stale
        // claimant cannot win.
        $this->assertTrue(
            str_contains($outcome, 'moves only requested -> approved -> granted')
            || str_contains($outcome, 'written once'),
            'unexpected guard message: '.$outcome,
        );

        // The winner's write is intact; no authority materialized.
        $this->assertDatabaseHas($requests, [
            'id' => $requestId,
            'lifecycle_state' => 'approved',
            'approver_one_id' => 'race-parent',
            'approver_two_id' => 'race-parent-2',
        ]);
        $this->assertSame($grantsBefore, (int) DB::table(DB::connection()->getTablePrefix().'scope_grants')->count());

        foreach ([$readyFile, $resultFile] as $file) {
            @unlink($file);
        }
    }
}
