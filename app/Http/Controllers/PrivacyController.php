<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Modules\Identity\Models\Person;
use App\Modules\Organization\Models\Organization;
use App\Modules\Privacy\Commands\DefineConsentPurpose;
use App\Modules\Privacy\Commands\ExportSubjectData;
use App\Modules\Privacy\Commands\RecordConsent;
use App\Modules\Privacy\Commands\RecordDisclosure;
use App\Modules\Privacy\Commands\TransitionConsent;
use App\Modules\Privacy\Models\Consent;
use App\Modules\Privacy\Models\ConsentPurpose;
use App\Modules\Privacy\Models\ConsentRevocation;
use App\Modules\Privacy\Models\Disclosure;
use App\Modules\Privacy\Models\PrivacyExportRequest;
use Carbon\CarbonImmutable;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\View\View;

/**
 * Privacy console: consent purposes, the consent lifecycle with its
 * evidence, disclosures as immutable release evidence, and subject-data
 * exports. Direct exports cover a single subject under one scope;
 * organization-wide exports are staged — an exporter requests, two
 * distinct approver sessions sign, and an exporter executes. Every
 * signature is captured in its own session; the transport has no field
 * for typing a colleague's person id.
 */
final class PrivacyController extends Controller
{
    public function index(): View
    {
        return view('privacy.index', [
            'purposes' => ConsentPurpose::query()->orderBy('name')->get(),
            'consents' => Consent::query()->orderByDesc('id')->limit(200)->get(),
            'revocations' => ConsentRevocation::query()->orderByDesc('id')->limit(200)->get(),
            'disclosures' => Disclosure::query()->orderByDesc('id')->limit(200)->get(),
            'exportRequests' => PrivacyExportRequest::query()->orderByDesc('id')->limit(200)->get(),
            'people' => Person::query()->where('verification_state', 'verified')->orderBy('legal_name')->limit(300)->get(),
            'organizations' => Organization::query()->orderBy('name')->limit(100)->get(),
        ]);
    }

    public function definePurpose(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'name' => ['required', 'string', 'max:200'],
            'channel' => ['required', 'string', 'max:120'],
            'category' => ['required', 'string', 'max:120'],
        ]);

        app(DefineConsentPurpose::class)->define(
            $this->actor(),
            $input['name'],
            $input['channel'],
            $input['category'],
            $this->idempotencyKey('privacy.purpose.define'),
        );

        return redirect()->route('privacy.index')->with('success', 'Consent purpose defined.');
    }

    public function recordConsent(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'subject_person_id' => ['required', 'string'],
            'purpose_id' => ['required', 'string'],
            'evidence_ref' => ['required', 'string', 'max:500'],
            'effective_from' => ['required', 'date'],
            'effective_to' => ['nullable', 'date', 'after_or_equal:effective_from'],
        ]);

        app(RecordConsent::class)->record(
            $this->actor(),
            $input['subject_person_id'],
            $input['purpose_id'],
            $input['evidence_ref'],
            CarbonImmutable::parse($input['effective_from']),
            (($input['effective_to'] ?? '') !== '') ? CarbonImmutable::parse($input['effective_to']) : null,
            $this->idempotencyKey('privacy.consent.record'),
        );

        return redirect()->route('privacy.index')->with('success', 'Consent recorded as a draft with its evidence; it takes effect once verified and activated.');
    }

    public function submitConsent(Request $request, string $consentId): RedirectResponse
    {
        app(TransitionConsent::class)->submit(
            $this->actor(),
            Consent::query()->findOrFail($consentId),
            $this->idempotencyKey('privacy.consent.submit'),
        );

        return redirect()->route('privacy.index')->with('success', 'Consent submitted for verification.');
    }

    public function verifyConsent(Request $request, string $consentId): RedirectResponse
    {
        app(TransitionConsent::class)->verify(
            $this->actor(),
            Consent::query()->findOrFail($consentId),
            $this->idempotencyKey('privacy.consent.verify'),
        );

        return redirect()->route('privacy.index')->with('success', 'Consent verified against its evidence.');
    }

    public function activateConsent(Request $request, string $consentId): RedirectResponse
    {
        app(TransitionConsent::class)->activate(
            $this->actor(),
            Consent::query()->findOrFail($consentId),
            $this->idempotencyKey('privacy.consent.activate'),
        );

        return redirect()->route('privacy.index')->with('success', 'Consent active.');
    }

    public function revokeConsent(Request $request, string $consentId): RedirectResponse
    {
        $input = $request->validate([
            'scope' => ['required', 'string', 'max:200'],
            'effect' => ['required', 'string', 'max:200'],
        ]);

        app(TransitionConsent::class)->revoke(
            $this->actor(),
            Consent::query()->findOrFail($consentId),
            $input['scope'],
            $input['effect'],
            $this->idempotencyKey('privacy.consent.revoke'),
        );

        return redirect()->route('privacy.index')->with('success', 'Consent revoked with its scope and effect recorded.');
    }

    public function archiveConsent(Request $request, string $consentId): RedirectResponse
    {
        app(TransitionConsent::class)->archive(
            $this->actor(),
            Consent::query()->findOrFail($consentId),
            $this->idempotencyKey('privacy.consent.archive'),
        );

        return redirect()->route('privacy.index')->with('success', 'Consent archived; the history is retained.');
    }

    public function recordDisclosure(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'subject_person_id' => ['required', 'string'],
            'recipient' => ['required', 'string', 'max:200'],
            'purpose' => ['required', 'string', 'max:500'],
            'authority' => ['required', 'string', 'max:120'],
            'scope_type' => ['required', 'in:organization,campus,branch,department,subject'],
            'scope_id' => ['required', 'string'],
            'disclosed_category' => ['required', 'string', 'max:200'],
        ]);

        app(RecordDisclosure::class)->disclose(
            $this->actor(),
            $input['subject_person_id'],
            $input['recipient'],
            $input['purpose'],
            $input['authority'],
            $input['scope_type'],
            $input['scope_id'],
            $input['disclosed_category'],
            $this->idempotencyKey('privacy.disclose'),
        );

        return redirect()->route('privacy.index')->with('success', 'Disclosure recorded as immutable release evidence.');
    }

    public function directExport(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'subject_person_id' => ['required', 'string'],
            'purpose' => ['required', 'string', 'max:500'],
            'scope_type' => ['required', 'in:campus,branch,department,subject'],
            'scope_id' => ['required', 'string'],
        ]);

        app(ExportSubjectData::class)->export(
            $this->actor(),
            $input['subject_person_id'],
            $input['purpose'],
            $input['scope_type'],
            $input['scope_id'],
            $this->idempotencyKey('privacy.export'),
        );

        return redirect()->route('privacy.index')->with('success', 'Subject data exported; the disclosure is recorded as the evidence of the release.');
    }

    public function requestExport(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'subject_person_id' => ['required', 'string'],
            'purpose' => ['required', 'string', 'max:500'],
            'organization_id' => ['required', 'string'],
        ]);

        app(ExportSubjectData::class)->request(
            $this->actor(),
            $input['subject_person_id'],
            $input['purpose'],
            $input['organization_id'],
            $this->idempotencyKey('privacy.export.request'),
        );

        return redirect()->route('privacy.index')->with('success', 'Organization-wide export requested; it executes only after two distinct approvers sign in their own sessions.');
    }

    public function approveExport(Request $request, string $requestId): RedirectResponse
    {
        app(ExportSubjectData::class)->approve(
            $this->actor(),
            PrivacyExportRequest::query()->findOrFail($requestId),
            $this->idempotencyKey('privacy.export.approve'),
        );

        return redirect()->route('privacy.index')->with('success', 'Approval signed; the export executes once a distinct second approver signs.');
    }

    public function executeExport(Request $request, string $requestId): RedirectResponse
    {
        app(ExportSubjectData::class)->execute(
            $this->actor(),
            PrivacyExportRequest::query()->findOrFail($requestId),
            $this->idempotencyKey('privacy.export.execute'),
        );

        return redirect()->route('privacy.index')->with('success', 'Export executed; the disclosure is recorded as the evidence of the release.');
    }
}
