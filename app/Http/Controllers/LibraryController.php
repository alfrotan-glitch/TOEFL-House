<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Modules\Identity\Models\Person;
use App\Modules\Organization\Models\Branch;
use App\Modules\Resources\Commands\CirculateBooks;
use App\Modules\Resources\Commands\DisposeAsset;
use App\Modules\Resources\Commands\MaintainAsset;
use App\Modules\Resources\Commands\MaintainWorkOrder;
use App\Modules\Resources\Models\Asset;
use App\Modules\Resources\Models\AssetDisposal;
use App\Modules\Resources\Models\AssetDisposalRequest;
use App\Modules\Resources\Models\BookCopy;
use App\Modules\Resources\Models\BookIssuance;
use App\Modules\Resources\Models\Custody;
use App\Modules\Resources\Models\WorkOrder;
use Carbon\CarbonImmutable;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\View\View;

/**
 * Library &amp; Resources console: assets, book copies, circulation (issue,
 * return, loss), and facilities work orders. Circulation delegates to the
 * resources module command, which enforces one open issuance per copy and
 * retains loss evidence.
 *
 * Assets delegate to the MaintainAsset/DisposeAsset commands: custody
 * moves retain history and one open custody per asset, and disposal is
 * staged (000115) — a requester session requests, two distinct approver
 * sessions each sign, and the requesting session executes. Work orders
 * delegate to MaintainWorkOrder (request -> independent approval ->
 * in progress -> completed with evidence, or cancelled).
 */
final class LibraryController extends Controller
{
    public function index(): View
    {
        $this->requireOrganizationRead('resources.books', 'library.console.index');
        $bookBranches = $this->authorizedBranches('resources.books');
        $assetBranches = array_values(array_unique(array_merge(
            $this->authorizedBranches('resources.asset'),
            $this->authorizedBranches('resources.dispose_request'),
            $this->authorizedBranches('resources.dispose_approve'),
        ), SORT_STRING));
        $workBranches = array_values(array_unique(array_merge(
            $this->authorizedBranches('facilities.work'),
            $this->authorizedBranches('facilities.work_approve'),
        ), SORT_STRING));
        // Resource roots now carry an immutable branch and organization
        // snapshot. Legacy rows with null or topology-inconsistent provenance
        // remain fail-closed rather than becoming a wildcard.
        $assetIds = Asset::query();
        $this->applyRootScope($assetIds, 'assets', $assetBranches);
        $copyIds = BookCopy::query();
        $this->applyRootScope($copyIds, 'book_copies', $bookBranches);
        $workOrderIds = WorkOrder::query();
        $this->applyRootScope($workOrderIds, 'work_orders', $workBranches);
        $visibleAssetIds = $assetIds->select('id');
        $visibleCopyIds = $copyIds->select('id');
        $visibleWorkOrderIds = $workOrderIds->select('id');
        $visibleIssuanceIds = BookIssuance::query()->whereIn('copy_id', $visibleCopyIds)->select('id');

        return view('library.index', [
            'assets' => Asset::query()->whereIn('id', $visibleAssetIds)->orderBy('code')->limit(200)->get(),
            'copies' => BookCopy::query()->whereIn('id', $visibleCopyIds)->orderBy('code')->limit(200)->get(),
            'bookBranches' => Branch::query()->whereIn('id', $bookBranches)->where('lifecycle_state', 'active')->orderBy('name')->get(),
            'issuances' => BookIssuance::query()->whereIn('id', $visibleIssuanceIds)->orderByDesc('issued_on')->limit(200)->get(),
            'workOrders' => WorkOrder::query()->whereIn('id', $visibleWorkOrderIds)->orderByDesc('id')->limit(200)->get(),
            'borrowers' => Person::query()->where('verification_state', 'verified')->whereIn('home_branch_id', $bookBranches)->orderBy('legal_name')->limit(300)->get(),
            'custodians' => Person::query()->where('verification_state', 'verified')->whereIn('home_branch_id', $assetBranches)->orderBy('legal_name')->limit(300)->get(),
            'assetBranches' => Branch::query()->whereIn('id', $assetBranches)->where('lifecycle_state', 'active')->orderBy('name')->get(),
            'workBranches' => Branch::query()->whereIn('id', $workBranches)->where('lifecycle_state', 'active')->orderBy('name')->get(),
            'openCustodies' => Custody::query()->whereNull('released_on')->whereIn('asset_id', $visibleAssetIds)->orderBy('asset_id')->limit(200)->get(),
            'disposalRequests' => AssetDisposalRequest::query()->whereIn('asset_id', $visibleAssetIds)->orderByDesc('id')->limit(200)->get(),
            'disposals' => AssetDisposal::query()->whereIn('asset_id', $visibleAssetIds)->orderByDesc('id')->limit(200)->get(),
        ]);
    }

    public function addBookCopy(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'code' => ['required', 'string', 'max:64'],
            'title' => ['required', 'string', 'max:255'],
            'acquired_on' => ['required', 'date'],
            'branch_id' => ['required', 'string'],
        ]);

        app(CirculateBooks::class)->addCopy(
            $this->actor(),
            $input['code'],
            $input['title'],
            $input['acquired_on'],
            $input['branch_id'],
            $this->idempotencyKey('resources.books.add'),
        );

        return redirect()->route('library.index')->with('success', 'Book copy registered.');
    }

    public function issueBook(Request $request, string $copyId): RedirectResponse
    {
        $input = $request->validate([
            'borrower_id' => ['required', 'string'],
            'issued_on' => ['required', 'date'],
            'due_on' => ['required', 'date', 'after_or_equal:issued_on'],
        ]);

        app(CirculateBooks::class)->issue(
            $this->actor(),
            BookCopy::query()->findOrFail($copyId),
            $input['borrower_id'],
            $input['issued_on'],
            $input['due_on'],
            $this->idempotencyKey('resources.issue'),
        );

        return redirect()->route('library.index')->with('success', 'Book issued.');
    }

    public function returnBook(Request $request, string $issuanceId): RedirectResponse
    {
        $input = $request->validate([
            'returned_on' => ['required', 'date'],
        ]);

        app(CirculateBooks::class)->returned(
            $this->actor(),
            BookIssuance::query()->findOrFail($issuanceId),
            $input['returned_on'],
            $this->idempotencyKey('resources.return'),
        );

        return redirect()->route('library.index')->with('success', 'Book returned.');
    }

    public function reportLoss(Request $request, string $issuanceId): RedirectResponse
    {
        $input = $request->validate([
            'loss_evidence' => ['required', 'string', 'max:255'],
        ]);

        app(CirculateBooks::class)->reportLoss(
            $this->actor(),
            BookIssuance::query()->findOrFail($issuanceId),
            $input['loss_evidence'],
            $this->idempotencyKey('resources.loss'),
        );

        return redirect()->route('library.index')->with('success', 'Loss reported and evidenced.');
    }

    public function registerAsset(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'code' => ['required', 'string', 'max:64'],
            'name' => ['required', 'string', 'max:255'],
            'category' => ['required', 'string', 'max:64'],
            'location' => ['required', 'string', 'max:255'],
            'acquired_on' => ['required', 'date'],
            'branch_id' => ['required', 'string'],
        ]);

        app(MaintainAsset::class)->register(
            $this->actor(),
            $input['code'],
            $input['name'],
            $input['category'],
            $input['location'],
            $input['acquired_on'],
            $input['branch_id'],
            $this->idempotencyKey('resources.asset.register'),
        );

        return redirect()->route('library.index')->with('success', 'Asset registered.');
    }

    public function assignCustody(Request $request, string $assetId): RedirectResponse
    {
        $input = $request->validate([
            'custodian_id' => ['required', 'string'],
            'assigned_on' => ['required', 'date'],
        ]);

        app(MaintainAsset::class)->assignCustody(
            $this->actor(),
            $this->scopedAsset($assetId),
            $input['custodian_id'],
            $input['assigned_on'],
            $this->idempotencyKey('resources.custody.assign'),
        );

        return redirect()->route('library.index')->with('success', 'Custody assigned.');
    }

    public function releaseCustody(Request $request, string $assetId): RedirectResponse
    {
        $input = $request->validate([
            'released_on' => ['required', 'date'],
        ]);

        app(MaintainAsset::class)->releaseCustody(
            $this->actor(),
            $this->scopedAsset($assetId),
            $input['released_on'],
            $this->idempotencyKey('resources.custody.release'),
        );

        return redirect()->route('library.index')->with('success', 'Custody released.');
    }

    public function requestDisposal(Request $request, string $assetId): RedirectResponse
    {
        $input = $request->validate([
            'method' => ['required', 'string', 'in:sale,scrap,donation'],
            'reason' => ['required', 'string', 'max:255'],
        ]);

        app(DisposeAsset::class)->request(
            $this->actor(),
            $this->scopedAsset($assetId),
            $input['method'],
            $input['reason'],
            $this->idempotencyKey('resources.disposal.request'),
        );

        return redirect()->route('library.index')->with('success', 'Disposal requested.');
    }

    public function approveDisposal(Request $request, string $requestId): RedirectResponse
    {
        app(DisposeAsset::class)->approve(
            $this->actor(),
            $this->scopedDisposalRequest($requestId),
            $this->idempotencyKey('resources.disposal.approve'),
        );

        return redirect()->route('library.index')->with('success', 'Disposal signature recorded.');
    }

    public function executeDisposal(Request $request, string $requestId): RedirectResponse
    {
        $input = $request->validate([
            'disposed_on' => ['required', 'date'],
        ]);

        app(DisposeAsset::class)->execute(
            $this->actor(),
            $this->scopedDisposalRequest($requestId),
            $input['disposed_on'],
            $this->idempotencyKey('resources.asset.dispose'),
        );

        return redirect()->route('library.index')->with('success', 'Disposal executed and recorded.');
    }

    public function requestWork(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'facility_note' => ['required', 'string', 'max:255'],
            'description' => ['required', 'string', 'max:1000'],
            'branch_id' => ['required', 'string'],
        ]);

        app(MaintainWorkOrder::class)->request(
            $this->actor(),
            $input['facility_note'],
            $input['description'],
            $input['branch_id'],
            $this->idempotencyKey('resources.work.request'),
        );

        return redirect()->route('library.index')->with('success', 'Work order requested.');
    }

    public function approveWork(Request $request, string $orderId): RedirectResponse
    {
        app(MaintainWorkOrder::class)->approve(
            $this->actor(),
            $this->scopedWorkOrder($orderId),
            $this->idempotencyKey('resources.work.approve'),
        );

        return redirect()->route('library.index')->with('success', 'Work order approved.');
    }

    public function startWork(Request $request, string $orderId): RedirectResponse
    {
        app(MaintainWorkOrder::class)->start(
            $this->actor(),
            $this->scopedWorkOrder($orderId),
            $this->idempotencyKey('resources.work.start'),
        );

        return redirect()->route('library.index')->with('success', 'Work order started.');
    }

    public function completeWork(Request $request, string $orderId): RedirectResponse
    {
        $input = $request->validate([
            'evidence_ref' => ['required', 'string', 'max:255'],
        ]);

        app(MaintainWorkOrder::class)->complete(
            $this->actor(),
            $this->scopedWorkOrder($orderId),
            $input['evidence_ref'],
            $this->idempotencyKey('resources.work.complete'),
        );

        return redirect()->route('library.index')->with('success', 'Work order completed with evidence.');
    }

    public function cancelWork(Request $request, string $orderId): RedirectResponse
    {
        app(MaintainWorkOrder::class)->cancel(
            $this->actor(),
            $this->scopedWorkOrder($orderId),
            $this->idempotencyKey('resources.work.cancel'),
        );

        return redirect()->route('library.index')->with('success', 'Work order cancelled.');
    }

    /**
     * @param \Illuminate\Database\Eloquent\Builder<*> $query
     * @param list<string> $branchIds
     */
    private function applyRootScope($query, string $table, array $branchIds): void
    {
        $today = CarbonImmutable::today()->toDateString();
        $query->whereIn($table.'.originating_branch_id', $branchIds)
            ->whereNotNull($table.'.organization_id')
            ->whereNotNull($table.'.originating_branch_id')
            ->whereExists(function ($topology) use ($table, $today): void {
                $topology->selectRaw('1')
                    ->from('campus_assignments as resource_ca')
                    ->join('branches as resource_b', 'resource_b.id', '=', 'resource_ca.branch_id')
                    ->join('campuses as resource_c', 'resource_c.id', '=', 'resource_ca.campus_id')
                    ->join('organizations as resource_o', 'resource_o.id', '=', 'resource_c.organization_id')
                    ->whereColumn('resource_ca.branch_id', $table.'.originating_branch_id')
                    ->whereColumn('resource_c.organization_id', $table.'.organization_id')
                    ->where('resource_ca.effective_from', '<=', $today)
                    ->where(function ($active) use ($today): void {
                        $active->whereNull('resource_ca.effective_to')->orWhere('resource_ca.effective_to', '>', $today);
                    })
                    ->where('resource_b.lifecycle_state', 'active')
                    ->where('resource_c.lifecycle_state', 'active')
                    ->where('resource_o.lifecycle_state', 'active');
            });
    }

    private function scopedAsset(string $assetId): Asset
    {
        $query = Asset::query();
        $this->applyRootScope($query, 'assets', array_values(array_unique(array_merge(
            $this->authorizedBranches('resources.asset'),
            $this->authorizedBranches('resources.dispose_request'),
            $this->authorizedBranches('resources.dispose_approve'),
        ), SORT_STRING)));

        return $query->findOrFail($assetId);
    }

    private function scopedDisposalRequest(string $requestId): AssetDisposalRequest
    {
        $assetIds = Asset::query();
        $this->applyRootScope($assetIds, 'assets', array_values(array_unique(array_merge(
            $this->authorizedBranches('resources.asset'),
            $this->authorizedBranches('resources.dispose_request'),
            $this->authorizedBranches('resources.dispose_approve'),
        ), SORT_STRING)));

        return AssetDisposalRequest::query()->whereIn('asset_id', $assetIds->select('id'))->findOrFail($requestId);
    }

    private function scopedWorkOrder(string $orderId): WorkOrder
    {
        $query = WorkOrder::query();
        $this->applyRootScope($query, 'work_orders', array_values(array_unique(array_merge(
            $this->authorizedBranches('facilities.work'),
            $this->authorizedBranches('facilities.work_approve'),
        ), SORT_STRING)));

        return $query->findOrFail($orderId);
    }
}
