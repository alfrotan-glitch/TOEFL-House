<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Modules\Identity\Models\Person;
use App\Modules\Resources\Commands\CirculateBooks;
use App\Modules\Resources\Models\Asset;
use App\Modules\Resources\Models\BookCopy;
use App\Modules\Resources\Models\BookIssuance;
use App\Modules\Resources\Models\WorkOrder;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\View\View;

/**
 * Library &amp; Resources console: assets, book copies, circulation (issue,
 * return, loss), and facilities work orders. Circulation delegates to the
 * resources module command, which enforces one open issuance per copy and
 * retains loss evidence.
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
}
