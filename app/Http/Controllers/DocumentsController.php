<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Modules\Documents\Commands\DecideRetention;
use App\Modules\Documents\Commands\DefineDocumentClassification;
use App\Modules\Documents\Commands\RegisterDocument;
use App\Modules\Documents\Commands\TransitionDocument;
use App\Modules\Documents\Models\Document;
use App\Modules\Documents\Models\DocumentClassification;
use App\Modules\Documents\Models\DocumentVersion;
use App\Modules\Documents\Models\RetentionDecision;
use App\Modules\Documents\Models\RetentionRule;
use App\Modules\Identity\Models\Person;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\View\View;

/**
 * Documents console: the evidence-document registry. Classifications and
 * retention rules are defined by the classifier; documents are registered
 * against a known subject and a defined classification; versions are
 * append-only and immutable; a distinct employee verifies the submitted
 * version; and the retention decision applies the category's rule. Every
 * transition delegates to the documents module commands.
 */
final class DocumentsController extends Controller
{
    public function index(): View
    {
        return view('documents.index', [
            'classifications' => DocumentClassification::query()->orderBy('category')->get(),
            'retentionRules' => RetentionRule::query()->orderBy('category')->get(),
            'documents' => Document::query()->orderByDesc('id')->limit(200)->get(),
            'versions' => DocumentVersion::query()->orderByDesc('created_at')->limit(300)->get(),
            'retentionDecisions' => RetentionDecision::query()->orderByDesc('created_at')->limit(200)->get(),
            'people' => Person::query()->where('verification_state', 'verified')->orderBy('legal_name')->limit(300)->get(),
        ]);
    }

    public function defineClassification(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'category' => ['required', 'string', 'max:120'],
            'owner_module' => ['required', 'string', 'max:120'],
            'access_class' => ['required', 'string', 'max:120'],
        ]);

        app(DefineDocumentClassification::class)->defineClassification(
            $this->actor(),
            $input['category'],
            $input['owner_module'],
            $input['access_class'],
            $this->idempotencyKey('documents.classification.define'),
        );

        return redirect()->route('documents.index')->with('success', 'Classification defined.');
    }

    public function defineRetentionRule(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'category' => ['required', 'string', 'max:120'],
            'retention_days' => ['required', 'integer', 'gt:0'],
            'legal_basis' => ['required', 'string', 'max:500'],
            'operational_basis' => ['nullable', 'string', 'max:500'],
        ]);

        app(DefineDocumentClassification::class)->defineRetentionRule(
            $this->actor(),
            $input['category'],
            (int) $input['retention_days'],
            $input['legal_basis'],
            (($input['operational_basis'] ?? '') !== '') ? $input['operational_basis'] : null,
            $this->idempotencyKey('documents.retention.rule'),
        );

        return redirect()->route('documents.index')->with('success', 'Retention rule defined for the category.');
    }

    public function registerDocument(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'subject_person_id' => ['required', 'string'],
            'classification_id' => ['required', 'string'],
            'title' => ['required', 'string', 'max:255'],
            'content_hash' => ['required', 'string', 'max:255'],
            'storage_ref' => ['required', 'string', 'max:500'],
        ]);

        app(RegisterDocument::class)->register(
            $this->actor(),
            $input['subject_person_id'],
            $input['classification_id'],
            $input['title'],
            $input['content_hash'],
            $input['storage_ref'],
            $this->idempotencyKey('documents.register'),
        );

        return redirect()->route('documents.index')->with('success', 'Document registered; it is draft until a submitted version is verified.');
    }

    public function submitDocument(Request $request, string $documentId): RedirectResponse
    {
        $input = $request->validate([
            'content_hash' => ['required', 'string', 'max:255'],
            'storage_ref' => ['required', 'string', 'max:500'],
        ]);

        app(TransitionDocument::class)->submit(
            $this->actor(),
            Document::query()->findOrFail($documentId),
            $input['content_hash'],
            $input['storage_ref'],
            $this->idempotencyKey('documents.submit'),
        );

        return redirect()->route('documents.index')->with('success', 'New version submitted; a distinct employee can now verify it.');
    }

    public function verifyDocument(Request $request, string $documentId): RedirectResponse
    {
        $input = $request->validate([
            'result' => ['required', 'in:pass,fail'],
            'reason' => ['required', 'string', 'max:1000'],
        ]);

        app(TransitionDocument::class)->verify(
            $this->actor(),
            Document::query()->findOrFail($documentId),
            $input['result'] === 'pass',
            $input['reason'],
            $this->idempotencyKey('documents.verify'),
        );

        return redirect()->route('documents.index')->with('success', 'Verification recorded; the document moves to '.($input['result'] === 'pass' ? 'verified' : 'rejected').' with its evidence.');
    }

    public function activateDocument(Request $request, string $documentId): RedirectResponse
    {
        app(TransitionDocument::class)->activate(
            $this->actor(),
            Document::query()->findOrFail($documentId),
            $this->idempotencyKey('documents.activate'),
        );

        return redirect()->route('documents.index')->with('success', 'Document activated.');
    }

    public function expireDocument(Request $request, string $documentId): RedirectResponse
    {
        app(TransitionDocument::class)->expire(
            $this->actor(),
            Document::query()->findOrFail($documentId),
            $this->idempotencyKey('documents.expire'),
        );

        return redirect()->route('documents.index')->with('success', 'Document expired.');
    }

    public function archiveDocument(Request $request, string $documentId): RedirectResponse
    {
        app(TransitionDocument::class)->archive(
            $this->actor(),
            Document::query()->findOrFail($documentId),
            $this->idempotencyKey('documents.archive'),
        );

        return redirect()->route('documents.index')->with('success', 'Document archived; the history is retained, never rewritten.');
    }

    public function decideRetention(Request $request, string $documentId): RedirectResponse
    {
        app(DecideRetention::class)->decide(
            $this->actor(),
            Document::query()->findOrFail($documentId),
            $this->idempotencyKey('documents.retention.decide'),
        );

        return redirect()->route('documents.index')->with('success', 'Retention decision recorded; a due document is archived under the rule.');
    }
}
