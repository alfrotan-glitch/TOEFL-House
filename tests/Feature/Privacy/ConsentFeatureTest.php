<?php

declare(strict_types=1);

namespace Tests\Feature\Privacy;

use App\Modules\Identity\Models\Person;
use App\Modules\Privacy\Commands\DefineConsentPurpose;
use App\Modules\Privacy\Commands\RecordConsent;
use App\Modules\Privacy\Commands\TransitionConsent;
use App\Modules\Privacy\Models\Consent;
use App\Modules\Privacy\Queries\SubjectPrivacyQuery;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

final class ConsentFeatureTest extends TestCase
{
    use BuildsActors;

    private string $marketingPurposeId;

    private string $communicationPurposeId;

    private string $subjectId;

    protected function setUp(): void
    {
        parent::setUp();
        $officer = $this->privacyOfficer();
        $this->marketingPurposeId = app(DefineConsentPurpose::class)->define($officer, 'enrollment-updates', 'marketing', 'prospect-outreach', 'purpose-key-1')['purpose_id'];
        $this->communicationPurposeId = app(DefineConsentPurpose::class)->define($officer, 'enrollment-updates', 'communication', 'prospect-outreach', 'purpose-key-2')['purpose_id'];
        $this->subjectId = 'consent-subject-1';
        $this->personWithAuthority($this->subjectId, []);
    }

    public function test_consent_moves_through_the_full_chain_with_audit_and_idempotent_replay(): void
    {
        $officer = $this->privacyOfficer();
        $command = app(RecordConsent::class);
        $transition = app(TransitionConsent::class);

        $recorded = $command->record($officer, $this->subjectId, $this->marketingPurposeId, 'signed-form/abc', new CarbonImmutable('2026-08-01'), new CarbonImmutable('2027-08-01'), 'consent-key-1');
        $replay = $command->record($officer, $this->subjectId, $this->marketingPurposeId, 'signed-form/abc', new CarbonImmutable('2026-08-01'), new CarbonImmutable('2027-08-01'), 'consent-key-1');
        $this->assertSame($recorded, $replay);

        /** @var Consent $consent */
        $consent = Consent::query()->findOrFail($recorded['consent_id']);
        $this->assertSame('draft', $consent->lifecycle_state);

        $transition->submit($officer, $consent, 'consent-key-2');
        $transition->verify($officer, $consent, 'consent-key-3');
        $transition->activate($officer, $consent, 'consent-key-4');

        $this->assertDatabaseHas('consents', ['id' => $consent->id, 'lifecycle_state' => 'active']);
        $this->assertDatabaseHas('audit_events', ['operation' => 'privacy.consent.record', 'target_type' => 'consent', 'target_id' => $consent->id]);
        $this->assertDatabaseHas('audit_events', ['operation' => 'privacy.consent.activate', 'target_type' => 'consent', 'target_id' => $consent->id]);

        $profile = (new SubjectPrivacyQuery)->subjectProfile($this->subjectId, new CarbonImmutable('2026-09-01'));
        $this->assertCount(1, $profile['consents']);
    }

    public function test_subject_may_record_submit_and_revoke_their_own_consent_without_capability(): void
    {
        $subject = new Actor($this->subjectId, 'Subject');
        $recorded = app(RecordConsent::class)->record($subject, $this->subjectId, $this->communicationPurposeId, 'signed-form/self', new CarbonImmutable('2026-08-01'), null, 'consent-key-5');
        /** @var Consent $consent */
        $consent = Consent::query()->findOrFail($recorded['consent_id']);

        app(TransitionConsent::class)->submit($subject, $consent, 'consent-key-6');
        app(TransitionConsent::class)->verify($this->privacyOfficer(), $consent, 'consent-key-7');
        app(TransitionConsent::class)->activate($this->privacyOfficer(), $consent, 'consent-key-8');
        app(TransitionConsent::class)->revoke($subject, $consent, 'purpose:enrollment-updates', 'stop-future-use', 'consent-key-9');

        $this->assertDatabaseHas('consents', ['id' => $consent->id, 'lifecycle_state' => 'revoked']);
        $this->assertDatabaseHas('consent_revocations', ['consent_id' => $consent->id, 'revoked_by' => $this->subjectId, 'effect' => 'stop-future-use']);
        $profile = (new SubjectPrivacyQuery)->subjectProfile($this->subjectId, new CarbonImmutable('2026-09-01'));
        $this->assertSame([], $profile['consents'], 'a revoked consent never counts as current use authority');
    }

    public function test_second_subject_consent_requires_staff_capability(): void
    {
        $other = 'consent-subject-2';
        $this->personWithAuthority($other, []);
        $recorder = new Actor($other, 'Other Subject');

        $this->expectException(AuthorizationDenied::class);
        $this->expectExceptionMessage('no active authority grants privacy.consent');
        app(RecordConsent::class)->record($recorder, $this->subjectId, $this->marketingPurposeId, 'signed-form/other', new CarbonImmutable('2026-08-01'), null, 'consent-key-10');

        $this->assertDatabaseHas('audit_events', ['operation' => 'privacy.consent.record.denied', 'actor_id' => $other]);
    }

    public function test_duplicate_open_consent_for_the_same_purpose_is_rejected_by_the_schema(): void
    {
        $officer = $this->privacyOfficer();
        $first = app(RecordConsent::class)->record($officer, $this->subjectId, $this->marketingPurposeId, 'signed-form/1', new CarbonImmutable('2026-08-01'), null, 'consent-key-11');
        /** @var Consent $consent */
        $consent = Consent::query()->findOrFail($first['consent_id']);
        app(TransitionConsent::class)->submit($officer, $consent, 'consent-key-12');
        app(TransitionConsent::class)->verify($officer, $consent, 'consent-key-13');
        app(TransitionConsent::class)->activate($officer, $consent, 'consent-key-14');

        $this->expectException(QueryException::class);
        app(RecordConsent::class)->record($officer, $this->subjectId, $this->marketingPurposeId, 'signed-form/2', new CarbonImmutable('2026-09-01'), null, 'consent-key-15');
    }

    public function test_expired_by_date_consent_is_not_current_without_any_rewrite(): void
    {
        $officer = $this->privacyOfficer();
        $recorded = app(RecordConsent::class)->record($officer, $this->subjectId, $this->communicationPurposeId, 'signed-form/window', new CarbonImmutable('2026-01-01'), new CarbonImmutable('2026-06-01'), 'consent-key-16');
        /** @var Consent $consent */
        $consent = Consent::query()->findOrFail($recorded['consent_id']);
        app(TransitionConsent::class)->submit($officer, $consent, 'consent-key-17');
        app(TransitionConsent::class)->verify($officer, $consent, 'consent-key-18');
        app(TransitionConsent::class)->activate($officer, $consent, 'consent-key-19');

        $within = (new SubjectPrivacyQuery)->subjectProfile($this->subjectId, new CarbonImmutable('2026-03-01'));
        $after = (new SubjectPrivacyQuery)->subjectProfile($this->subjectId, new CarbonImmutable('2026-09-01'));

        $this->assertCount(1, $within['consents']);
        $this->assertSame([], $after['consents']);
        $this->assertSame('active', $consent->refresh()->lifecycle_state, 'expiry is by date, the record is never rewritten');
    }

    public function test_marketing_and_communication_purposes_stay_separate(): void
    {
        $this->assertNotSame($this->marketingPurposeId, $this->communicationPurposeId);
        $this->assertDatabaseHas('consent_purposes', ['id' => $this->marketingPurposeId, 'channel' => 'marketing']);
        $this->assertDatabaseHas('consent_purposes', ['id' => $this->communicationPurposeId, 'channel' => 'communication']);

        $this->expectException(QueryException::class);
        app(DefineConsentPurpose::class)->define($this->privacyOfficer(), 'enrollment-updates', 'marketing', 'duplicate-purpose', 'purpose-key-3');
    }

    public function test_unverified_subject_is_rejected(): void
    {
        $officer = $this->privacyOfficer();
        $unverified = Person::query()->create([
            'id' => RandomIdentifier::new(),
            'legal_name' => 'Unverified Subject',
            'date_of_birth' => '1999-01-01',
            'verification_state' => 'unverified',
        ]);

        $this->expectException(BusinessRejection::class);
        $this->expectExceptionMessage('consent requires a verified subject identity');
        app(RecordConsent::class)->record($officer, $unverified->id, $this->marketingPurposeId, 'signed-form/x', new CarbonImmutable('2026-08-01'), null, 'consent-key-20');
    }

    public function test_revocation_evidence_is_append_only(): void
    {
        $officer = $this->privacyOfficer();
        $recorded = app(RecordConsent::class)->record($officer, $this->subjectId, $this->marketingPurposeId, 'signed-form/a', new CarbonImmutable('2026-08-01'), null, 'consent-key-21');
        /** @var Consent $consent */
        $consent = Consent::query()->findOrFail($recorded['consent_id']);
        app(TransitionConsent::class)->submit($officer, $consent, 'consent-key-22');
        app(TransitionConsent::class)->verify($officer, $consent, 'consent-key-25');
        app(TransitionConsent::class)->activate($officer, $consent, 'consent-key-26');
        app(TransitionConsent::class)->revoke(new Actor($this->subjectId, 'Subject'), $consent, 'all', 'stop-future-use', 'consent-key-23');

        $this->expectException(QueryException::class);
        DB::statement('UPDATE consent_revocations SET effect = ? WHERE consent_id = ?', ['erased-history', $consent->id]);
    }

    public function test_idempotency_conflict_is_rejected(): void
    {
        $officer = $this->privacyOfficer();

        $this->expectException(BusinessRejection::class);
        $this->expectExceptionMessage('idempotency key reused with a different payload');
        app(RecordConsent::class)->record($officer, $this->subjectId, $this->marketingPurposeId, 'signed-form/a', new CarbonImmutable('2026-08-01'), null, 'consent-key-24');
        app(RecordConsent::class)->record($officer, $this->subjectId, $this->communicationPurposeId, 'signed-form/a', new CarbonImmutable('2026-08-01'), null, 'consent-key-24');
    }
}
