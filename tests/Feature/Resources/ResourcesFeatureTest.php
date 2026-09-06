<?php

declare(strict_types=1);

namespace Tests\Feature\Resources;

use App\Modules\Resources\Commands\CirculateBooks;
use App\Modules\Resources\Commands\DisposeAsset;
use App\Modules\Resources\Commands\MaintainAsset;
use App\Modules\Resources\Commands\MaintainWorkOrder;
use App\Modules\Resources\Models\Asset;
use App\Modules\Resources\Models\AssetDisposalRequest;
use App\Modules\Resources\Models\BookCopy;
use App\Modules\Resources\Models\BookIssuance;
use App\Modules\Resources\Models\WorkOrder;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

final class ResourcesFeatureTest extends TestCase
{
    use BuildsActors;

    public function test_custody_transfers_close_the_prior_row_and_disposal_needs_two_approvers(): void
    {
        $this->personWithAuthority('res-custodian-1', []);
        $this->personWithAuthority('res-custodian-2', []);
        $manager = $this->grantedActor('res-manager', ['resources.asset', 'resources.dispose_request', 'resources.dispose_approve']);
        $approverOne = $this->grantedActor('res-approver-1', ['resources.dispose_approve']);
        $approverTwo = $this->grantedActor('res-approver-2', ['resources.dispose_approve']);

        $asset = app(MaintainAsset::class)->register($manager, 'PROJ-001', 'Classroom projector', 'electronics', 'Campus A / Room 4', '2026-01-15', 'res-a-1');
        try {
            app(MaintainAsset::class)->register($manager, 'PROJ-001', 'Duplicate', 'electronics', 'x', '2026-01-15', 'res-a-2');
            $this->fail('duplicate asset codes must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('resources.asset_code_exists', $rejection->errorCode());
        }

        $assetModel = Asset::query()->findOrFail($asset['asset_id']);
        app(MaintainAsset::class)->assignCustody($manager, $assetModel, 'res-custodian-1', '2026-02-01', 'res-c-1');
        app(MaintainAsset::class)->assignCustody($manager, $assetModel, 'res-custodian-2', '2026-03-01', 'res-c-2');

        $this->assertSame(2, DB::table('custodies')->where('asset_id', $asset['asset_id'])->count(), 'custody history retained');
        $this->assertSame(1, DB::table('custodies')->where('asset_id', $asset['asset_id'])->whereNull('released_on')->count(), 'one open custody');
        $this->assertDatabaseHas('custodies', ['asset_id' => $asset['asset_id'], 'custodian_person_id' => 'res-custodian-1', 'released_on' => '2026-03-01']);

        // The disposal is staged (000115): the manager session requests,
        // two distinct approver sessions each sign, the manager executes.
        $command = app(DisposeAsset::class);
        $requestResult = $command->request($manager, $assetModel, 'sale', 'replaced by newer model', 'res-d-2');
        $disposalRequest = AssetDisposalRequest::query()->findOrFail($requestResult['request_id']);

        try {
            $command->approve($manager, $disposalRequest, 'res-d-3');
            $this->fail('the requester may not approve their own request');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('resources.disposal_not_independent', $denial->errorCode());
        }

        $this->assertSame('requested', $command->approve($approverOne, $disposalRequest, 'res-d-4')['lifecycle_state']);
        try {
            $command->execute($manager, $disposalRequest, '2026-04-01', 'res-d-5');
            $this->fail('one approver must not suffice');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('resources.disposal_request_state', $rejection->errorCode());
        }

        try {
            $command->approve($approverOne, $disposalRequest, 'res-d-6');
            $this->fail('the same approver twice must not suffice');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('resources.disposal_single_actor', $denial->errorCode());
        }

        $this->assertSame('approved', $command->approve($approverTwo, $disposalRequest, 'res-d-7')['lifecycle_state']);

        $otherManager = $this->grantedActor('res-manager-2', ['resources.dispose_request']);
        try {
            $command->execute($otherManager, $disposalRequest, '2026-04-01', 'res-d-8');
            $this->fail('only the requesting session executes');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('resources.disposal_executor', $denial->errorCode());
        }

        $disposal = $command->execute($manager, $disposalRequest, '2026-04-01', 'res-d-9');
        $this->assertDatabaseHas('assets', ['id' => $asset['asset_id'], 'lifecycle_state' => 'disposed']);
        $this->assertSame(0, DB::table('custodies')->where('asset_id', $asset['asset_id'])->whereNull('released_on')->count(), 'disposal closes custody');
        $this->assertDatabaseHas('asset_disposals', [
            'id' => $disposal['disposal_id'], 'asset_id' => $asset['asset_id'], 'method' => 'sale',
            'approver_one' => 'res-approver-1', 'approver_two' => 'res-approver-2',
        ]);

        try {
            app(MaintainAsset::class)->assignCustody($manager, Asset::query()->findOrFail($asset['asset_id']), 'res-custodian-1', '2026-05-01', 'res-c-3');
            $this->fail('a disposed asset cannot receive custody');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('resources.asset_not_in_service', $rejection->errorCode());
        }

        $this->expectException(QueryException::class);
        DB::statement('UPDATE asset_disposals SET method = ? WHERE id = ?', ['donation', $disposal['disposal_id']]);
    }

    public function test_work_orders_require_independent_approval_and_completion_evidence(): void
    {
        $requester = $this->grantedActor('res-worker', ['facilities.work', 'facilities.work_approve']);
        $approver = $this->grantedActor('res-approver-w', ['facilities.work_approve']);

        $order = app(MaintainWorkOrder::class)->request($requester, 'Campus B / Lab 2', 'air conditioning failure', 'res-w-1');

        try {
            app(MaintainWorkOrder::class)->start($requester, WorkOrder::query()->findOrFail($order['work_order_id']), 'res-w-2');
            $this->fail('work cannot start before approval');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('resources.work_transition_forbidden', $rejection->errorCode());
        }

        try {
            app(MaintainWorkOrder::class)->approve($requester, WorkOrder::query()->findOrFail($order['work_order_id']), 'res-w-3');
            $this->fail('the requester may not approve');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('resources.work_not_independent', $denial->errorCode());
        }

        app(MaintainWorkOrder::class)->approve($approver, WorkOrder::query()->findOrFail($order['work_order_id']), 'res-w-4');
        app(MaintainWorkOrder::class)->start($requester, WorkOrder::query()->findOrFail($order['work_order_id']), 'res-w-5');

        try {
            app(MaintainWorkOrder::class)->complete($requester, WorkOrder::query()->findOrFail($order['work_order_id']), '', 'res-w-6');
            $this->fail('completion requires evidence');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('resources.work_evidence', $rejection->errorCode());
        }

        app(MaintainWorkOrder::class)->complete($requester, WorkOrder::query()->findOrFail($order['work_order_id']), 'work-order/WO-118-photos', 'res-w-7');
        $this->assertDatabaseHas('work_orders', ['id' => $order['work_order_id'], 'lifecycle_state' => 'completed', 'evidence_ref' => 'work-order/WO-118-photos']);

        $this->expectException(QueryException::class);
        DB::statement('DELETE FROM work_orders WHERE id = ?', [$order['work_order_id']]);
    }

    public function test_book_circulation_allows_one_open_issuance_and_requires_loss_evidence(): void
    {
        $librarian = $this->grantedActor('res-librarian', ['resources.books']);
        $this->personWithAuthority('res-borrower', []);

        $copy = app(CirculateBooks::class)->addCopy($librarian, 'BK-0001', 'Academic Writing', '2026-01-10', 'res-b-1');
        $issuance = app(CirculateBooks::class)->issue($librarian, BookCopy::query()->findOrFail($copy['copy_id']), 'res-borrower', '2026-11-01', '2026-11-15', 'res-b-2');

        try {
            app(CirculateBooks::class)->issue($librarian, BookCopy::query()->findOrFail($copy['copy_id']), 'res-borrower', '2026-11-02', '2026-11-16', 'res-b-3');
            $this->fail('a copy with an open issuance cannot be issued again');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('resources.copy_already_issued', $rejection->errorCode());
        }

        try {
            app(CirculateBooks::class)->reportLoss($librarian, BookIssuance::query()->findOrFail($issuance['issuance_id']), '', 'res-b-4');
            $this->fail('a loss report requires evidence');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('resources.loss_evidence', $rejection->errorCode());
        }

        app(CirculateBooks::class)->returned($librarian, BookIssuance::query()->findOrFail($issuance['issuance_id']), '2026-11-12', 'res-b-5');
        $again = app(CirculateBooks::class)->issue($librarian, BookCopy::query()->findOrFail($copy['copy_id']), 'res-borrower', '2026-11-20', '2026-12-04', 'res-b-6');
        app(CirculateBooks::class)->reportLoss($librarian, BookIssuance::query()->findOrFail($again['issuance_id']), 'incident/report-9', 'res-b-7');

        try {
            app(CirculateBooks::class)->issue($librarian, BookCopy::query()->findOrFail($copy['copy_id']), 'res-borrower', '2026-12-05', '2026-12-19', 'res-b-8');
            $this->fail('a lost copy is out of circulation');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('resources.copy_lost', $rejection->errorCode());
        }

        $this->expectException(QueryException::class);
        DB::statement('UPDATE book_issuances SET lifecycle_state = ? WHERE id = ?', ['issued', $again['issuance_id']]);
    }

    public function test_unprivileged_asset_registration_is_denied_and_audited(): void
    {
        $nobody = $this->actorWithoutAnyCapability('res-nobody');

        $this->expectException(AuthorizationDenied::class);
        app(MaintainAsset::class)->register($nobody, 'DENIED-1', 'Probe', 'x', 'y', '2026-01-01', 'res-neg-1');

        $this->assertDatabaseHas('audit_events', ['operation' => 'resources.asset.register.denied', 'actor_id' => 'res-nobody']);
        $this->assertDatabaseMissing('assets', ['code' => 'DENIED-1']);
    }
}
