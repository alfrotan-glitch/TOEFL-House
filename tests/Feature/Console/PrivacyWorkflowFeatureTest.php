<?php

declare(strict_types=1);

namespace Tests\Feature\Console;

use App\Modules\Identity\Models\Person;
use App\Modules\Identity\Models\UserAccount;
use App\Modules\Privacy\Commands\DefineConsentPurpose;
use App\Modules\Privacy\Commands\ExportSubjectData;
use App\Modules\Privacy\Commands\RecordConsent;
use App\Modules\Privacy\Commands\RecordDisclosure;
use App\Modules\Privacy\Models\PrivacyExportRequest;
use App\Support\Errors\BusinessRejection;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

/**
 * PHASE_3 increment E (part two): the privacy surface — consent purposes,
 * the consent lifecycle with its evidence, disclosures as immutable
 * release evidence, and subject-data exports. Organization-wide exports
 * are staged (000114): an exporter session requests, two DISTINCT
 * approver sessions each sign in their own session, and only then may an
 * exporter session execute. The transport has no field for typing a
 * colleague's person id; the boundary re-checks distinctness.
 */
final class PrivacyWorkflowFeatureTest extends TestCase
{
    use BuildsActors;

    private const BOOTSTRAP_ORG = '00000000-0000-4000-8000-00000000b005';

    private string $subjectPersonId;

    protected function setUp(): void
    {
        parent::setUp();

        $this->subjectPersonId = 'prv-subject-1';
        $this->personWithAuthority($this->subjectPersonId, []);
    }

    /** @return array{0: Person, 1: UserAccount} */
    private function makeEmployee(string $personId, array $capabilities, string $username): array
    {
        $person = $this->personWithAuthority($personId, $capabilities);
        $account = UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $person->id,
            'username' => $username,
            'password_hash' => Hash::make('prv-password-1'),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);

        return [$person, $account];
    }

    private function signIn(string $username): void
    {
        $this->post('/login', ['username' => $username, 'password' => 'prv-password-1'])->assertRedirect('/');
        $this->assertAuthenticated();
    }

    private function signOut(): void
    {
        $this->post('/logout')->assertRedirect('/login');
        $this->assertGuest();
    }

    private function purposeId(string $category = 'communication'): string
    {
        $definer = $this->grantedActor('prv-definer-'.substr($category, 0, 8), ['privacy.define_purpose']);
        $defined = app(DefineConsentPurpose::class)->define(
            $definer, 'Purpose '.$category, 'email', $category, 'prv-purpose-'.$category,
        );

        return $defined['purpose_id'];
    }

    public function test_the_consent_lifecycle_over_the_console(): void
    {
        $this->makeEmployee('prv-purpose-1', ['privacy.define_purpose'], 'purpose');
        $this->makeEmployee('prv-consent-1', ['privacy.consent'], 'consent');
        $this->makeEmployee('prv-plain-1', [], 'plain');

        $consents = DB::connection()->getTablePrefix().'consents';

        // An employee without the capability cannot record consent for a
        // subject they are not.
        $this->signIn('plain');
        $this->post('/privacy/consents', [
            'subject_person_id' => $this->subjectPersonId,
            'purpose_id' => 'missing-purpose',
            'evidence_ref' => 'evidence/prv-1',
            'effective_from' => '2026-09-01',
        ], ['referer' => 'http://localhost/privacy'])
            ->assertRedirect('/privacy')
            ->assertSessionHas('error_code', 'privacy.consent_denied');
        $this->assertSame(0, DB::table($consents)->count());

        // The purpose is defined, then the consent is recorded as a draft
        // with its evidence and window.
        $this->signOut();
        $this->signIn('purpose');
        $this->post('/privacy/purposes', [
            'name' => 'Photo consent', 'channel' => 'email', 'category' => 'communication',
        ])->assertRedirect('/privacy');
        $purpose = $this->purposeId('communication');

        $this->signOut();
        $this->signIn('consent');
        $this->post('/privacy/consents', [
            'subject_person_id' => $this->subjectPersonId,
            'purpose_id' => $purpose,
            'evidence_ref' => 'evidence/prv-consent-1',
            'effective_from' => '2026-09-01',
            'effective_to' => '2026-12-31',
        ])->assertRedirect('/privacy');
        $consentId = DB::table($consents)->value('id');
        $this->assertDatabaseHas($consents, ['id' => $consentId, 'lifecycle_state' => 'draft']);

        // An unverified subject cannot consent.
        $unverified = Person::query()->create([
            'id' => 'prv-unverified-1',
            'legal_name' => 'Unverified Subject',
            'date_of_birth' => '1990-01-01',
            'verification_state' => Person::VERIFICATION_UNVERIFIED,
            'identity_key' => 'fixture-prv-unverified-1',
        ]);
        $this->post('/privacy/consents', [
            'subject_person_id' => $unverified->id,
            'purpose_id' => $purpose,
            'evidence_ref' => 'evidence/prv-unverified',
            'effective_from' => '2026-09-01',
        ], ['referer' => 'http://localhost/privacy'])
            ->assertRedirect('/privacy')
            ->assertSessionHas('error_code', 'privacy.consent_subject_unverified');

        // The lifecycle advances one state at a time.
        $this->post('/privacy/consents/'.$consentId.'/submit')->assertRedirect('/privacy');
        $this->assertDatabaseHas($consents, ['id' => $consentId, 'lifecycle_state' => 'submitted']);
        $this->post('/privacy/consents/'.$consentId.'/verify')->assertRedirect('/privacy');
        $this->assertDatabaseHas($consents, ['id' => $consentId, 'lifecycle_state' => 'verified']);
        $this->post('/privacy/consents/'.$consentId.'/activate')->assertRedirect('/privacy');
        $this->assertDatabaseHas($consents, ['id' => $consentId, 'lifecycle_state' => 'active']);

        // A revocation records its scope and effect.
        $this->post('/privacy/consents/'.$consentId.'/revoke', [
            'scope' => 'all-channels', 'effect' => 'immediate-cessation',
        ])->assertRedirect('/privacy');
        $this->assertDatabaseHas($consents, ['id' => $consentId, 'lifecycle_state' => 'revoked']);
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'consent_revocations', [
            'consent_id' => $consentId, 'scope' => 'all-channels', 'effect' => 'immediate-cessation',
        ]);

        $this->post('/privacy/consents/'.$consentId.'/archive')->assertRedirect('/privacy');
        $this->assertDatabaseHas($consents, ['id' => $consentId, 'lifecycle_state' => 'archived']);
    }

    public function test_disclosures_record_minimum_release_evidence(): void
    {
        $this->makeEmployee('prv-disclose-1', ['privacy.disclose'], 'disclose');
        $this->makeEmployee('prv-plain-2', [], 'plain-2');

        $disclosures = DB::connection()->getTablePrefix().'disclosures';

        // A disclosure requires a known subject and its minimum fields.
        $this->signIn('disclose');
        $this->post('/privacy/disclosures', [
            'subject_person_id' => RandomIdentifier::new(),
            'recipient' => 'Guardian', 'purpose' => 'Progress update',
            'authority' => 'privacy.disclose', 'scope_type' => 'subject',
            'scope_id' => $this->subjectPersonId, 'disclosed_category' => 'academic-progress',
        ], ['referer' => 'http://localhost/privacy'])
            ->assertRedirect('/privacy')
            ->assertSessionHas('error_code', 'privacy.disclose_subject_unknown');

        $this->post('/privacy/disclosures', [
            'subject_person_id' => $this->subjectPersonId,
            'recipient' => 'Guardian', 'purpose' => 'Progress update',
            'authority' => 'privacy.disclose', 'scope_type' => 'subject',
            'scope_id' => $this->subjectPersonId, 'disclosed_category' => 'academic-progress',
        ])->assertRedirect('/privacy');
        $this->assertSame(1, DB::table($disclosures)->count());
        $this->assertDatabaseHas($disclosures, [
            'subject_person_id' => $this->subjectPersonId, 'recipient' => 'Guardian', 'disclosed_category' => 'academic-progress',
        ]);

        // An employee without the capability cannot disclose.
        $this->signOut();
        $this->signIn('plain-2');
        $this->post('/privacy/disclosures', [
            'subject_person_id' => $this->subjectPersonId,
            'recipient' => 'Guardian', 'purpose' => 'Progress update',
            'authority' => 'privacy.disclose', 'scope_type' => 'subject',
            'scope_id' => $this->subjectPersonId, 'disclosed_category' => 'academic-progress',
        ], ['referer' => 'http://localhost/privacy'])
            ->assertRedirect('/privacy')
            ->assertSessionHas('error_code', 'privacy.disclose_denied');
        $this->assertSame(1, DB::table($disclosures)->count());
    }

    public function test_the_staged_bulk_export_requires_two_distinct_approvers(): void
    {
        $this->makeEmployee('prv-export-1', ['privacy.export'], 'export');
        $this->makeEmployee('prv-approver-a', ['privacy.approve_bulk_export'], 'approver-a');
        $this->makeEmployee('prv-approver-b', ['privacy.approve_bulk_export'], 'approver-b');

        $requests = DB::connection()->getTablePrefix().'privacy_export_requests';
        $disclosures = DB::connection()->getTablePrefix().'disclosures';

        // A direct export covers one subject under a non-organization scope.
        $this->signIn('export');
        $this->post('/privacy/exports', [
            'subject_person_id' => $this->subjectPersonId,
            'purpose' => 'Parental record request',
            'scope_type' => 'subject', 'scope_id' => $this->subjectPersonId,
        ])->assertRedirect('/privacy');
        $this->assertDatabaseHas($disclosures, [
            'subject_person_id' => $this->subjectPersonId, 'recipient' => 'data-export:prv-export-1', 'scope_type' => 'subject',
        ]);

        // The organization scope is not offered on the direct export form
        // (a 422, not a domain code) — it exists only through the staged
        // chain; the domain refuses it on every other path.
        $this->post('/privacy/exports', [
            'subject_person_id' => $this->subjectPersonId,
            'purpose' => 'Organization-wide audit',
            'scope_type' => 'organization', 'scope_id' => self::BOOTSTRAP_ORG,
        ], ['referer' => 'http://localhost/privacy'])
            ->assertRedirect('/privacy')->assertSessionHasErrors('scope_type');

        // The exporter requests the organization-wide export.
        $this->post('/privacy/exports/bulk', [
            'subject_person_id' => $this->subjectPersonId,
            'purpose' => 'Organization-wide audit',
            'organization_id' => self::BOOTSTRAP_ORG,
        ])->assertRedirect('/privacy');
        $requestId = DB::table($requests)->value('id');
        $this->assertDatabaseHas($requests, ['id' => $requestId, 'lifecycle_state' => 'requested', 'requested_by' => 'prv-export-1']);

        // Executing before any approval is refused.
        $this->post('/privacy/exports/'.$requestId.'/execute', [], ['referer' => 'http://localhost/privacy'])
            ->assertRedirect('/privacy')
            ->assertSessionHas('error_code', 'privacy.export_request_state');

        // The first approver signs; the request is not yet approved.
        $this->signOut();
        $this->signIn('approver-a');
        $this->post('/privacy/exports/'.$requestId.'/approve')->assertRedirect('/privacy');
        $this->assertDatabaseHas($requests, ['id' => $requestId, 'lifecycle_state' => 'requested', 'approver_one_id' => 'prv-approver-a']);

        // The same approver signing twice is refused (SoD).
        $this->post('/privacy/exports/'.$requestId.'/approve', [], ['referer' => 'http://localhost/privacy'])
            ->assertRedirect('/privacy')
            ->assertSessionHas('error_code', 'privacy.bulk_export_single_actor');
        $this->assertDatabaseHas($requests, ['id' => $requestId, 'lifecycle_state' => 'requested']);

        // A distinct approver signs; the request becomes approved.
        $this->signOut();
        $this->signIn('approver-b');
        $this->post('/privacy/exports/'.$requestId.'/approve')->assertRedirect('/privacy');
        $this->assertDatabaseHas($requests, [
            'id' => $requestId, 'lifecycle_state' => 'approved', 'approver_one_id' => 'prv-approver-a', 'approver_two_id' => 'prv-approver-b',
        ]);

        // An approved request cannot be approved again.
        $this->post('/privacy/exports/'.$requestId.'/approve', [], ['referer' => 'http://localhost/privacy'])
            ->assertRedirect('/privacy')
            ->assertSessionHas('error_code', 'privacy.export_request_state');

        // The exporter executes; the disclosure is the evidence of release.
        $this->signOut();
        $this->signIn('export');
        $this->post('/privacy/exports/'.$requestId.'/execute')->assertRedirect('/privacy');
        $this->assertDatabaseHas($requests, ['id' => $requestId, 'lifecycle_state' => 'exported', 'exported_by' => 'prv-export-1']);
        $this->assertDatabaseHas($disclosures, [
            'subject_person_id' => $this->subjectPersonId, 'recipient' => 'data-export:prv-export-1',
            'scope_type' => 'organization', 'scope_id' => self::BOOTSTRAP_ORG,
        ]);

        // An executed request is closed — no re-execution.
        $this->post('/privacy/exports/'.$requestId.'/execute', [], ['referer' => 'http://localhost/privacy'])
            ->assertRedirect('/privacy')
            ->assertSessionHas('error_code', 'privacy.export_request_state');
    }

    public function test_the_validation_gates_of_the_privacy_commands(): void
    {
        $exporter = $this->grantedActor('prv-export-2', ['privacy.export']);
        $recorder = $this->grantedActor('prv-consent-2', ['privacy.consent']);
        $discloser = $this->grantedActor('prv-disclose-2', ['privacy.disclose']);
        $purpose = $this->purposeId('consent');
        $requests = DB::connection()->getTablePrefix().'privacy_export_requests';

        // Export: unknown subject, missing purpose, and the organization
        // scope refusing the direct path.
        foreach ([
            ['privacy.export_subject_unknown', RandomIdentifier::new(), 'a purpose'],
            ['privacy.export_purpose_missing', $this->subjectPersonId, ''],
        ] as [$code, $subject, $purposeValue]) {
            try {
                app(ExportSubjectData::class)->export($exporter, $subject, $purposeValue, 'subject', $subject, 'prv-dom-'.$code);
                $this->fail("expected {$code} to be rejected");
            } catch (BusinessRejection $rejection) {
                $this->assertSame($code, $rejection->errorCode());
            }
        }

        try {
            app(ExportSubjectData::class)->export(
                $exporter, $this->subjectPersonId, 'organization-wide', 'organization', self::BOOTSTRAP_ORG, 'prv-dom-org',
            );
            $this->fail('expected the organization scope to be rejected on the direct path');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('privacy.export_bulk_requires_request', $rejection->errorCode());
        }

        // Consent: missing evidence and an inverted period.
        try {
            app(RecordConsent::class)->record(
                $recorder, $this->subjectPersonId, $purpose, '', CarbonImmutable::parse('2026-09-01'), null, 'prv-dom-consent-1',
            );
            $this->fail('expected the missing evidence to be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('privacy.consent_evidence_missing', $rejection->errorCode());
        }

        try {
            app(RecordConsent::class)->record(
                $recorder, $this->subjectPersonId, $purpose, 'evidence/x',
                CarbonImmutable::parse('2026-09-30'), CarbonImmutable::parse('2026-09-01'), 'prv-dom-consent-2',
            );
            $this->fail('expected the inverted period to be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('privacy.consent_period', $rejection->errorCode());
        }

        // Disclosure: missing minimum fields.
        try {
            app(RecordDisclosure::class)->disclose(
                $discloser, $this->subjectPersonId, '', 'a purpose', 'privacy.disclose', 'subject', $this->subjectPersonId, 'a-category', 'prv-dom-disclose',
            );
            $this->fail('expected the missing recipient to be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('privacy.disclose_minimum_fields', $rejection->errorCode());
        }

        // The 000114 boundary re-checks the staged rules even against
        // direct SQL: SoD on the two approvers, one-time approver slots,
        // and the closed state of an executed request.
        $requested = app(ExportSubjectData::class)->request(
            $exporter, $this->subjectPersonId, 'direct-sql probe', self::BOOTSTRAP_ORG, 'prv-dom-request',
        );
        $requestId = $requested['request_id'];

        // The first approver slot can be written directly.
        DB::table($requests)->where('id', $requestId)->update([
            'approver_one_id' => 'prv-approver-a', 'updated_at' => now(),
        ]);

        // The same person in both slots is refused at the boundary.
        try {
            DB::table($requests)->where('id', $requestId)->update([
                'approver_two_id' => 'prv-approver-a', 'lifecycle_state' => 'approved', 'updated_at' => now(),
            ]);
            $this->fail('expected the boundary to refuse a non-distinct approver');
        } catch (QueryException $exception) {
            $this->assertStringContainsString('two distinct approvers', $exception->getMessage());
        }

        // A distinct second approver closes the request.
        DB::table($requests)->where('id', $requestId)->update([
            'approver_two_id' => 'prv-approver-b', 'lifecycle_state' => 'approved', 'updated_at' => now(),
        ]);
        $this->assertDatabaseHas($requests, ['id' => $requestId, 'lifecycle_state' => 'approved']);

        // Approver slots are written once — even on a legal transition,
        // rewriting a signed slot is refused.
        try {
            DB::table($requests)->where('id', $requestId)->update([
                'approver_one_id' => 'prv-approver-b',
                'lifecycle_state' => 'exported',
                'exported_by' => 'prv-export-2',
                'disclosure_id' => 'prv-disclosure-sql',
                'updated_at' => now(),
            ]);
            $this->fail('expected the boundary to refuse rewriting an approver slot');
        } catch (QueryException $exception) {
            $this->assertStringContainsString('written once', $exception->getMessage());
        }

        // Once executed, the request is closed to every change.
        app(ExportSubjectData::class)->execute($exporter, PrivacyExportRequest::query()->findOrFail($requestId), 'prv-dom-execute');
        $this->assertDatabaseHas($requests, ['id' => $requestId, 'lifecycle_state' => 'exported']);
        try {
            DB::table($requests)->where('id', $requestId)->update(['purpose' => 'rewritten', 'updated_at' => now()]);
            $this->fail('expected the boundary to refuse changing an executed request');
        } catch (QueryException $exception) {
            $this->assertStringContainsString('closed', $exception->getMessage());
        }
    }
}
