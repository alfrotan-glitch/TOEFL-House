<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Modules\Identity\Models\Person;
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
        return view('library.index', [
            'assets' => Asset::query()->orderBy('code')->limit(200)->get(),
            'copies' => BookCopy::query()->orderBy('code')->limit(200)->get(),
            'issuances' => BookIssuance::query()->orderByDesc('issued_on')->limit(200)->get(),
            'workOrders' => WorkOrder::query()->orderByDesc('id')->limit(200)->get(),
            'borrowers' => Person::query()->where('verification_state', 'verified')->orderBy('legal_name')->limit(300)->get(),
            'openCustodies' => Custody::query()->whereNull('released_on')->orderBy('asset_id')->limit(200)->get(),
            'disposalRequests' => AssetDisposalRequest::query()->orderByDesc('id')->limit(200)->get(),
            'disposals' => AssetDisposal::query()->orderByDesc('id')->limit(200)->get(),
        ]);
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
        ]);

        app(MaintainAsset::class)->register(
            $this->actor(),
            $input['code'],
            $input['name'],
            $input['category'],
            $input['location'],
            $input['acquired_on'],
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
            Asset::query()->findOrFail($assetId),
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
            Asset::query()->findOrFail($assetId),
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
            Asset::query()->findOrFail($assetId),
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
            AssetDisposalRequest::query()->findOrFail($requestId),
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
            AssetDisposalRequest::query()->findOrFail($requestId),
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
        ]);

        app(MaintainWorkOrder::class)->request(
            $this->actor(),
            $input['facility_note'],
            $input['description'],
            $this->idempotencyKey('resources.work.request'),
        );

        return redirect()->route('library.index')->with('success', 'Work order requested.');
    }

    public function approveWork(Request $request, string $orderId): RedirectResponse
    {
        app(MaintainWorkOrder::class)->approve(
            $this->actor(),
            WorkOrder::query()->findOrFail($orderId),
            $this->idempotencyKey('resources.work.approve'),
        );

        return redirect()->route('library.index')->with('success', 'Work order approved.');
    }

    public function startWork(Request $request, string $orderId): RedirectResponse
    {
        app(MaintainWorkOrder::class)->start(
            $this->actor(),
            WorkOrder::query()->findOrFail($orderId),
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
            WorkOrder::query()->findOrFail($orderId),
            $input['evidence_ref'],
            $this->idempotencyKey('resources.work.complete'),
        );

        return redirect()->route('library.index')->with('success', 'Work order completed with evidence.');
    }

    public function cancelWork(Request $request, string $orderId): RedirectResponse
    {
        app(MaintainWorkOrder::class)->cancel(
            $this->actor(),
            WorkOrder::query()->findOrFail($orderId),
            $this->idempotencyKey('resources.work.cancel'),
        );

        return redirect()->route('library.index')->with('success', 'Work order cancelled.');
    }
}
