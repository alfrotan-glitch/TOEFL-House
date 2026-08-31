<?php

declare(strict_types=1);

namespace Tests\Feature\Console;

use App\Modules\Identity\Models\Person;
use App\Modules\Identity\Models\UserAccount;
use App\Modules\Resources\Commands\MaintainAsset;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

/**
 * PHASE_3 increment E (part three): the resources & facilities console —
 * assets with custody history, staged disposal (000115: a requester
 * session requests, two DISTINCT approver sessions each sign in their own
 * session, and the requesting session executes), and the facilities work
 * order lifecycle. The transport has no field for typing a colleague's
 * identity; the boundary re-checks distinctness.
 */
final class ResourcesWorkflowFeatureTest extends TestCase
{
    use BuildsActors;

    private string $custodianOne;

    private string $custodianTwo;

    protected function setUp(): void
    {
        parent::setUp();

        $this->custodianOne = 'resw-cust-1';
        $this->custodianTwo = 'resw-cust-2';
        $this->personWithAuthority($this->custodianOne, []);
        $this->personWithAuthority($this->custodianTwo, []);
    }

    /** @return array{0: Person, 1: UserAccount} */
    private function makeEmployee(string $personId, array $capabilities, string $username): array
    {
        $person = $this->personWithAuthority($personId, $capabilities);
        $account = UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $person->id,
            'username' => $username,
            'password_hash' => Hash::make('resw-password-1'),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);

        return [$person, $account];
    }

    private function signIn(string $username): void
    {
        $this->post('/login', ['username' => $username, 'password' => 'resw-password-1'])->assertRedirect('/');
        $this->assertAuthenticated();
    }

    private function signOut(): void
    {
        $this->post('/logout')->assertRedirect('/login');
        $this->assertGuest();
    }

    public function test_assets_register_and_custody_moves_over_the_console(): void
    {
        $this->makeEmployee('resw-mgr-1', ['resources.asset'], 'mgr-1');
        $this->makeEmployee('resw-plain-1', [], 'plain-1');

        $assets = DB::connection()->getTablePrefix().'assets';
        $custodies = DB::connection()->getTablePrefix().'custodies';

        // An employee without the capability cannot register assets.
        $this->signIn('plain-1');
        $this->post('/library/assets', [
            'code' => 'RESW-X-1', 'name' => 'Probe', 'category' => 'electronics',
            'location' => 'Campus A', 'acquired_on' => '2026-01-01',
        ], ['referer' => 'http://localhost/library'])
            ->assertRedirect('/library')
            ->assertSessionHas('error_code', 'resources.asset_denied');

        // The manager registers; a duplicate code is refused.
        $this->signOut();
        $this->signIn('mgr-1');
        $this->post('/library/assets', [
            'code' => 'RESW-P-1', 'name' => 'Classroom projector', 'category' => 'electronics',
            'location' => 'Campus A / Room 4', 'acquired_on' => '2026-01-15',
        ])->assertRedirect('/library');
        $assetId = DB::table($assets)->where('code', 'RESW-P-1')->value('id');

        $this->post('/library/assets', [
            'code' => 'RESW-P-1', 'name' => 'Duplicate', 'category' => 'electronics',
            'location' => 'Campus A', 'acquired_on' => '2026-01-15',
        ], ['referer' => 'http://localhost/library'])
            ->assertRedirect('/library')
            ->assertSessionHas('error_code', 'resources.asset_code_exists');

        // Custody moves: the prior row is closed, the history is retained,
        // and one asset has at most one open custody.
        $this->post('/library/assets/'.$assetId.'/custody', [
            'custodian_id' => $this->custodianOne, 'assigned_on' => '2026-02-01',
        ])->assertRedirect('/library');
        $this->post('/library/assets/'.$assetId.'/custody', [
            'custodian_id' => $this->custodianTwo, 'assigned_on' => '2026-03-01',
        ])->assertRedirect('/library');
        $this->assertSame(2, DB::table($custodies)->where('asset_id', $assetId)->count(), 'custody history retained');
        $this->assertSame(1, DB::table($custodies)->where('asset_id', $assetId)->whereNull('released_on')->count(), 'one open custody');
        $this->assertDatabaseHas($custodies, ['asset_id' => $assetId, 'custodian_person_id' => $this->custodianOne, 'released_on' => '2026-03-01']);

        $this->post('/library/assets/'.$assetId.'/custody/release', [
            'released_on' => '2026-03-10',
        ])->assertRedirect('/library');
        $this->assertSame(0, DB::table($custodies)->where('asset_id', $assetId)->whereNull('released_on')->count(), 'release closes the custody');
    }

    public function test_disposal_is_staged_with_two_distinct_approvers_over_the_console(): void
    {
        $this->makeEmployee('resw-mgr-2', ['resources.asset', 'resources.dispose_request', 'resources.dispose_approve'], 'mgr-2');
        $this->makeEmployee('resw-mgr-3', ['resources.dispose_request'], 'mgr-3');
        $this->makeEmployee('resw-appr-a', ['resources.dispose_approve'], 'appr-a');
        $this->makeEmployee('resw-appr-b', ['resources.dispose_approve'], 'appr-b');

        $assets = DB::connection()->getTablePrefix().'assets';
        $requests = DB::connection()->getTablePrefix().'asset_disposal_requests';
        $custodies = DB::connection()->getTablePrefix().'custodies';

        $this->signIn('mgr-2');
        $this->post('/library/assets', [
            'code' => 'RESW-D-1', 'name' => 'Old server', 'category' => 'electronics',
            'location' => 'Campus A / Server room', 'acquired_on' => '2024-06-01',
        ])->assertRedirect('/library');
        $assetId = DB::table($assets)->where('code', 'RESW-D-1')->value('id');
        $this->post('/library/assets/'.$assetId.'/custody', [
            'custodian_id' => $this->custodianOne, 'assigned_on' => '2026-04-01',
        ])->assertRedirect('/library');

        // The requester session requests the disposal.
        $this->post('/library/assets/'.$assetId.'/disposal', [
            'method' => 'scrap', 'reason' => 'End of life, replaced',
        ])->assertRedirect('/library');
        $requestId = DB::table($requests)->value('id');
        $this->assertDatabaseHas($requests, ['id' => $requestId, 'lifecycle_state' => 'requested', 'requested_by' => 'resw-mgr-2']);

        // A second request for the same asset while one is in progress is refused.
        $this->post('/library/assets/'.$assetId.'/disposal', [
            'method' => 'sale', 'reason' => 'Duplicate request',
        ], ['referer' => 'http://localhost/library'])
            ->assertRedirect('/library')
            ->assertSessionHas('error_code', 'resources.disposal_pending');

        // Executing before any approval is refused.
        $this->post('/library/disposals/'.$requestId.'/execute', [
            'disposed_on' => '2026-05-01',
        ], ['referer' => 'http://localhost/library'])
            ->assertRedirect('/library')
            ->assertSessionHas('error_code', 'resources.disposal_request_state');

        // The first approver signs; the request is not yet approved.
        $this->signOut();
        $this->signIn('appr-a');
        $this->post('/library/disposals/'.$requestId.'/approve')->assertRedirect('/library');
        $this->assertDatabaseHas($requests, ['id' => $requestId, 'lifecycle_state' => 'requested', 'approver_one_id' => 'resw-appr-a']);

        // The same approver signing twice is refused (SoD).
        $this->post('/library/disposals/'.$requestId.'/approve', [], ['referer' => 'http://localhost/library'])
            ->assertRedirect('/library')
            ->assertSessionHas('error_code', 'resources.disposal_single_actor');

        // The requester signing is refused, even with the approve capability.
        $this->signOut();
        $this->signIn('mgr-2');
        $this->post('/library/disposals/'.$requestId.'/approve', [], ['referer' => 'http://localhost/library'])
            ->assertRedirect('/library')
            ->assertSessionHas('error_code', 'resources.disposal_not_independent');

        // A distinct approver signs; the request becomes approved.
        $this->signOut();
        $this->signIn('appr-b');
        $this->post('/library/disposals/'.$requestId.'/approve')->assertRedirect('/library');
        $this->assertDatabaseHas($requests, [
            'id' => $requestId, 'lifecycle_state' => 'approved',
            'approver_one_id' => 'resw-appr-a', 'approver_two_id' => 'resw-appr-b',
        ]);

        // An approved request cannot be signed again.
        $this->post('/library/disposals/'.$requestId.'/approve', [], ['referer' => 'http://localhost/library'])
            ->assertRedirect('/library')
            ->assertSessionHas('error_code', 'resources.disposal_request_state');

        // Execution belongs to the requesting session, not any other holder of the capability.
        $this->signOut();
        $this->signIn('mgr-3');
        $this->post('/library/disposals/'.$requestId.'/execute', [
            'disposed_on' => '2026-05-01',
        ], ['referer' => 'http://localhost/library'])
            ->assertRedirect('/library')
            ->assertSessionHas('error_code', 'resources.disposal_executor');

        // The requesting session executes; the asset is disposed and its open custody closed.
        $this->signOut();
        $this->signIn('mgr-2');
        $this->post('/library/disposals/'.$requestId.'/execute', [
            'disposed_on' => '2026-05-01',
        ])->assertRedirect('/library');
        $this->assertDatabaseHas($requests, ['id' => $requestId, 'lifecycle_state' => 'completed', 'executed_by' => 'resw-mgr-2']);
        $this->assertDatabaseHas($assets, ['id' => $assetId, 'lifecycle_state' => 'disposed']);
        $this->assertSame(0, DB::table($custodies)->where('asset_id', $assetId)->whereNull('released_on')->count(), 'disposal closes custody');
        $this->assertSame(1, DB::table(DB::connection()->getTablePrefix().'asset_disposals')->where('asset_id', $assetId)->count());

        // A completed request is closed — no re-execution.
        $this->post('/library/disposals/'.$requestId.'/execute', [
            'disposed_on' => '2026-05-02',
        ], ['referer' => 'http://localhost/library'])
            ->assertRedirect('/library')
            ->assertSessionHas('error_code', 'resources.disposal_request_state');
    }

    public function test_work_orders_flow_over_the_console(): void
    {
        $this->makeEmployee('resw-worker-1', ['facilities.work', 'facilities.work_approve'], 'worker-1');
        $this->makeEmployee('resw-appr-w', ['facilities.work_approve'], 'appr-w');

        $orders = DB::connection()->getTablePrefix().'work_orders';

        $this->signIn('worker-1');
        $this->post('/library/work-orders', [
            'facility_note' => 'Campus B / Lab 2', 'description' => 'Air conditioning failure',
        ])->assertRedirect('/library');
        $orderId = DB::table($orders)->value('id');

        // Work cannot start before approval.
        $this->post('/library/work-orders/'.$orderId.'/start', [], ['referer' => 'http://localhost/library'])
            ->assertRedirect('/library')
            ->assertSessionHas('error_code', 'resources.work_transition_forbidden');

        // The requester may not approve their own order.
        $this->post('/library/work-orders/'.$orderId.'/approve', [], ['referer' => 'http://localhost/library'])
            ->assertRedirect('/library')
            ->assertSessionHas('error_code', 'resources.work_not_independent');

        $this->signOut();
        $this->signIn('appr-w');
        $this->post('/library/work-orders/'.$orderId.'/approve')->assertRedirect('/library');
        $this->assertDatabaseHas($orders, ['id' => $orderId, 'lifecycle_state' => 'approved', 'approved_by' => 'resw-appr-w']);

        $this->signOut();
        $this->signIn('worker-1');
        $this->post('/library/work-orders/'.$orderId.'/start')->assertRedirect('/library');
        $this->assertDatabaseHas($orders, ['id' => $orderId, 'lifecycle_state' => 'in_progress']);

        // Completion requires its evidence (transport-level validation).
        $this->post('/library/work-orders/'.$orderId.'/complete', [], ['referer' => 'http://localhost/library'])
            ->assertRedirect('/library')
            ->assertSessionHasErrors('evidence_ref');

        $this->post('/library/work-orders/'.$orderId.'/complete', [
            'evidence_ref' => 'work-order/RESW-118-photos',
        ])->assertRedirect('/library');
        $this->assertDatabaseHas($orders, [
            'id' => $orderId, 'lifecycle_state' => 'completed', 'evidence_ref' => 'work-order/RESW-118-photos',
        ]);

        // A completed order is closed — no cancellation.
        $this->post('/library/work-orders/'.$orderId.'/cancel', [], ['referer' => 'http://localhost/library'])
            ->assertRedirect('/library')
            ->assertSessionHas('error_code', 'resources.work_transition_forbidden');
    }

    public function test_unprivileged_resource_actions_are_denied_and_audited(): void
    {
        $manager = $this->grantedActor('resw-mgr-4', ['resources.asset']);
        $nobody = $this->makeEmployee('resw-nobody-1', [], 'nobody-1');

        $asset = app(MaintainAsset::class)->register($manager, 'RESW-N-1', 'Probe bench', 'furniture', 'Campus A', '2026-01-01', 'resw-dom-1');
        $assetId = $asset['asset_id'];

        $this->signIn('nobody-1');

        $this->post('/library/assets', [
            'code' => 'RESW-N-2', 'name' => 'Probe', 'category' => 'furniture',
            'location' => 'Campus A', 'acquired_on' => '2026-01-01',
        ], ['referer' => 'http://localhost/library'])
            ->assertRedirect('/library')
            ->assertSessionHas('error_code', 'resources.asset_denied');
        $this->assertDatabaseHas('audit_events', ['operation' => 'resources.asset.register.denied', 'actor_id' => 'resw-nobody-1']);

        $this->post('/library/work-orders', [
            'facility_note' => 'Campus B', 'description' => 'Probe work',
        ], ['referer' => 'http://localhost/library'])
            ->assertRedirect('/library')
            ->assertSessionHas('error_code', 'resources.work_denied');
        $this->assertDatabaseHas('audit_events', ['operation' => 'resources.work.request.denied', 'actor_id' => 'resw-nobody-1']);

        $this->post('/library/assets/'.$assetId.'/disposal', [
            'method' => 'scrap', 'reason' => 'Probe disposal',
        ], ['referer' => 'http://localhost/library'])
            ->assertRedirect('/library')
            ->assertSessionHas('error_code', 'resources.disposal_denied');
        $this->assertDatabaseHas('audit_events', ['operation' => 'resources.disposal.request.denied', 'actor_id' => 'resw-nobody-1']);

        $this->assertSame(1, DB::table(DB::connection()->getTablePrefix().'assets')->count(), 'no rows created by the denied probes');
        $this->assertSame(0, DB::table(DB::connection()->getTablePrefix().'work_orders')->count());
        $this->assertSame(0, DB::table(DB::connection()->getTablePrefix().'asset_disposal_requests')->count());
    }
}
