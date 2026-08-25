<?php

declare(strict_types=1);

namespace Tests\Feature\Privacy;

use App\Modules\Privacy\Commands\ExportSubjectData;
use App\Modules\Privacy\Commands\RecordDisclosure;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

final class DisclosureExportFeatureTest extends TestCase
{
    use BuildsActors;

    public function test_disclosure_records_minimum_fields_with_audit(): void
    {
        $officer = $this->privacyOfficer();
        $this->personWithAuthority('disclose-subject-1', []);

        $result = app(RecordDisclosure::class)->disclose(
            $officer, 'disclose-subject-1', 'Ministry of Education', 'regulatory-reporting', 'privacy.disclose',
            'organization', $this->bootstrapOrganizationId, 'academic-records', 'disclose-key-1',
        );

        $this->assertDatabaseHas('disclosures', ['id' => $result['disclosure_id'], 'recipient' => 'Ministry of Education', 'disclosed_category' => 'academic-records']);
        $this->assertDatabaseHas('audit_events', ['operation' => 'privacy.disclose', 'target_type' => 'disclosure', 'target_id' => $result['disclosure_id']]);
    }

    public function test_disclosure_requires_the_capability_and_is_denied_with_audit(): void
    {
        $this->personWithAuthority('disclose-subject-2', []);
        $nobody = $this->actorWithoutAnyCapability('disclose-nobody');

        $this->expectException(AuthorizationDenied::class);
        $this->expectExceptionMessage('no active authority grants privacy.disclose');
        app(RecordDisclosure::class)->disclose(
            $nobody, 'disclose-subject-2', 'Unknown Party', 'curiosity', 'privacy.disclose',
            'organization', $this->bootstrapOrganizationId, 'academic-records', 'disclose-key-2',
        );

        $this->assertDatabaseHas('audit_events', ['operation' => 'privacy.disclose.denied', 'actor_id' => 'disclose-nobody']);
        $this->assertDatabaseMissing('disclosures', ['recipient' => 'Unknown Party']);
    }

    public function test_disclosure_rejects_missing_minimum_fields(): void
    {
        $officer = $this->privacyOfficer();
        $this->personWithAuthority('disclose-subject-3', []);

        $this->expectException(BusinessRejection::class);
        $this->expectExceptionMessage('disclosure requires recipient, purpose, and disclosed category');
        app(RecordDisclosure::class)->disclose(
            $officer, 'disclose-subject-3', '', 'purposeless', 'privacy.disclose',
            'organization', $this->bootstrapOrganizationId, '', 'disclose-key-3',
        );
    }

    public function test_disclosures_are_append_only_even_against_raw_sql(): void
    {
        $officer = $this->privacyOfficer();
        $this->personWithAuthority('disclose-subject-4', []);
        $result = app(RecordDisclosure::class)->disclose(
            $officer, 'disclose-subject-4', 'Auditor', 'annual-audit', 'privacy.disclose',
            'organization', $this->bootstrapOrganizationId, 'financial-records', 'disclose-key-4',
        );

        $this->expectException(QueryException::class);
        DB::statement('UPDATE disclosures SET recipient = ? WHERE id = ?', ['Someone Else', $result['disclosure_id']]);
    }

    public function test_subject_export_produces_read_only_dataset_and_immutable_evidence(): void
    {
        $officer = $this->privacyOfficer();
        $this->personWithAuthority('export-subject-1', []);

        $before = ['consents' => DB::table('consents')->count(), 'disclosures' => DB::table('disclosures')->count()];
        $result = app(ExportSubjectData::class)->export(
            $officer, 'export-subject-1', 'subject-data-request', 'subject', 'export-subject-1', [], 'export-key-1',
        );
        $replay = app(ExportSubjectData::class)->export(
            $officer, 'export-subject-1', 'subject-data-request', 'subject', 'export-subject-1', [], 'export-key-1',
        );

        $this->assertSame($result['export_id'], $replay['export_id']);
        $this->assertSame('export-subject-1', $result['dataset']['subject']['person_id']);
        $this->assertDatabaseHas('disclosures', ['id' => $result['disclosure_id'], 'purpose' => 'subject-data-request', 'disclosed_category' => 'subject-data-export']);
        $this->assertSame($before['consents'], DB::table('consents')->count(), 'export must not mutate authoritative facts');
    }

    public function test_organization_wide_export_requires_two_distinct_eligible_approvers(): void
    {
        $approvers = [
            $this->actorWithStructureCapabilities('export-owner-1', ['privacy.approve_bulk_export']),
            $this->actorWithStructureCapabilities('export-owner-2', ['privacy.approve_bulk_export']),
        ];
        $officer = $this->privacyOfficer();
        $this->personWithAuthority('export-subject-2', []);
        $command = app(ExportSubjectData::class);

        try {
            $command->export($officer, 'export-subject-2', 'bulk-export', 'organization', $this->bootstrapOrganizationId, [new Actor('export-owner-1', 'Approver One')], 'export-key-2');
            $this->fail('one approver must not suffice');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('privacy.bulk_export_owner_count', $denial->errorCode());
        }

        try {
            $twice = [new Actor('export-owner-1', 'A'), new Actor('export-owner-1', 'A')];
            $command->export($officer, 'export-subject-2', 'bulk-export', 'organization', $this->bootstrapOrganizationId, $twice, 'export-key-3');
            $this->fail('the same actor twice must not suffice');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('privacy.bulk_export_single_actor', $denial->errorCode());
        }

        try {
            $unprivileged = [new Actor('export-owner-1', 'A'), new Actor('export-nobody', 'B')];
            $command->export($officer, 'export-subject-2', 'bulk-export', 'organization', $this->bootstrapOrganizationId, $unprivileged, 'export-key-4');
            $this->fail('an unprivileged approver must not suffice');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('privacy.bulk_export_approver_denied', $denial->errorCode());
        }

        $approved = $command->export($officer, 'export-subject-2', 'bulk-export', 'organization', $this->bootstrapOrganizationId, [
            new Actor('export-owner-1', 'A'), new Actor('export-owner-2', 'B'),
        ], 'export-key-5');
        $this->assertDatabaseHas('disclosures', ['id' => $approved['disclosure_id']]);
    }

    public function test_unprivileged_exporter_is_denied_and_audited(): void
    {
        $this->personWithAuthority('export-subject-3', []);
        $nobody = $this->actorWithoutAnyCapability('export-nobody-2');

        $this->expectException(AuthorizationDenied::class);
        $this->expectExceptionMessage('no active authority grants privacy.export');
        app(ExportSubjectData::class)->export($nobody, 'export-subject-3', 'illicit-export', 'subject', 'export-subject-3', [], 'export-key-6');

        $this->assertDatabaseHas('audit_events', ['operation' => 'privacy.export.denied', 'actor_id' => 'export-nobody-2']);
    }
}
