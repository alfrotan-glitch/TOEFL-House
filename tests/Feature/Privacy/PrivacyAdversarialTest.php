<?php

declare(strict_types=1);

namespace Tests\Feature\Privacy;

use App\Modules\Documents\Commands\DefineDocumentClassification;
use App\Modules\Documents\Commands\RegisterDocument;
use App\Modules\Documents\Commands\TransitionDocument;
use App\Modules\Documents\Models\Document;
use App\Modules\Privacy\Commands\DefineConsentPurpose;
use App\Modules\Privacy\Commands\RecordConsent;
use App\Modules\Privacy\Commands\RecordDisclosure;
use App\Modules\Privacy\Commands\TransitionConsent;
use App\Modules\Privacy\Models\Consent;
use App\Modules\Privacy\Queries\SubjectPrivacyQuery;
use App\Support\Authorization\Actor;
use App\Support\Errors\BusinessRejection;
use Carbon\CarbonImmutable;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

/**
 * Adversarial vectors against the privacy and documents controls: forged
 * consent states, silent revocation erasure, disclosure of unknown
 * subjects, evidence tampering, and URL-as-authority all fail closed.
 */
final class PrivacyAdversarialTest extends TestCase
{
    use BuildsActors;

    public function test_a_url_or_storage_reference_is_never_authority(): void
    {
        $registrar = $this->documentsOfficer('adv-doc-registrar');
        $verifier = $this->documentsOfficer('adv-doc-verifier');
        $classification = app(DefineDocumentClassification::class)->defineClassification(
            $this->documentsOfficer('adv-doc-admin'), 'passport', 'Identity', 'restricted', 'adv-class-1')['classification_id'];
        $this->personWithAuthority('adv-doc-subject', []);

        // a document registered with any storage reference but never verified/active
        $result = app(RegisterDocument::class)->register($registrar, 'adv-doc-subject', $classification, 'Passport', 'hash-p', 'https://cdn.example/passport.pdf', 'adv-doc-1');
        /** @var Document $document */
        $document = Document::query()->findOrFail($result['document_id']);
        app(TransitionDocument::class)->submit($registrar, $document, 'hash-p2', 'https://cdn.example/passport-v2.pdf', 'adv-doc-2');

        // possession of the URL must not activate evidence: only verification by another officer can
        $this->assertSame('submitted', $document->refresh()->lifecycle_state);
        try {
            app(TransitionDocument::class)->activate($registrar, $document, 'adv-doc-3');
            $this->fail('activating unverified evidence must fail');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('documents.transition_forbidden', $rejection->errorCode());
        }

        app(TransitionDocument::class)->verify($verifier, $document, true, 'valid passport', 'adv-doc-4');
        $this->assertSame('verified', $document->refresh()->lifecycle_state);
    }

    public function test_revoked_consent_cannot_be_activated_back_or_erased(): void
    {
        $officer = $this->privacyOfficer('adv-priv');
        $subjectId = 'adv-consent-subject';
        $this->personWithAuthority($subjectId, []);
        $purposeId = app(DefineConsentPurpose::class)->define($officer, 'adv-purpose', 'communication', 'outreach', 'adv-purpose-1')['purpose_id'];

        $recorded = app(RecordConsent::class)->record($officer, $subjectId, $purposeId, 'adv-evidence', new CarbonImmutable('2026-08-01'), null, 'adv-consent-1');
        /** @var Consent $consent */
        $consent = Consent::query()->findOrFail($recorded['consent_id']);
        app(TransitionConsent::class)->submit($officer, $consent, 'adv-consent-2');
        app(TransitionConsent::class)->verify($officer, $consent, 'adv-consent-3');
        app(TransitionConsent::class)->activate($officer, $consent, 'adv-consent-4');
        app(TransitionConsent::class)->revoke(new Actor($subjectId, 'Subject'), $consent, 'all', 'withdrawn', 'adv-consent-5');

        try {
            app(TransitionConsent::class)->activate($officer, $consent, 'adv-consent-6');
            $this->fail('revoked consent must not reactivate');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('privacy.consent_transition_forbidden', $rejection->errorCode());
        }

        $profile = (new SubjectPrivacyQuery)->subjectProfile($subjectId);
        $this->assertSame([], $profile['consents']);
        $this->assertDatabaseHas('consents', ['id' => $consent->id, 'lifecycle_state' => 'revoked']);
    }

    public function test_disclosure_of_an_unknown_subject_is_rejected(): void
    {
        $officer = $this->privacyOfficer('adv-priv-2');

        $this->expectException(BusinessRejection::class);
        $this->expectExceptionMessage('disclosure requires a known subject');
        app(RecordDisclosure::class)->disclose($officer, 'adv-nonexistent-person', 'Curious Party', 'no purpose', 'privacy.disclose', 'organization', $this->bootstrapOrganizationId, 'identity', 'adv-disc-1');
    }

    public function test_consent_evidence_reference_cannot_be_empty(): void
    {
        $officer = $this->privacyOfficer('adv-priv-3');
        $subjectId = 'adv-consent-subject-2';
        $this->personWithAuthority($subjectId, []);
        $purposeId = app(DefineConsentPurpose::class)->define($officer, 'adv-purpose-2', 'marketing', 'outreach', 'adv-purpose-2')['purpose_id'];

        $this->expectException(BusinessRejection::class);
        $this->expectExceptionMessage('consent requires evidence');
        app(RecordConsent::class)->record($officer, $subjectId, $purposeId, '', new CarbonImmutable('2026-08-01'), null, 'adv-consent-7');
    }

    public function test_inverted_consent_period_is_rejected_by_the_schema(): void
    {
        $officer = $this->privacyOfficer('adv-priv-4');
        $subjectId = 'adv-consent-subject-3';
        $this->personWithAuthority($subjectId, []);
        $purposeId = app(DefineConsentPurpose::class)->define($officer, 'adv-purpose-3', 'communication', 'outreach', 'adv-purpose-3')['purpose_id'];

        $this->expectException(BusinessRejection::class);
        $this->expectExceptionMessage('consent period must end after it starts');
        app(RecordConsent::class)->record($officer, $subjectId, $purposeId, 'adv-evidence', new CarbonImmutable('2026-08-01'), new CarbonImmutable('2026-01-01'), 'adv-consent-8');
    }
}
