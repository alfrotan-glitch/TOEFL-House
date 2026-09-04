<?php

declare(strict_types=1);

namespace Tests\Feature\Crm;

use App\Modules\Admissions\Commands\RegisterApplicant;
use App\Modules\Communication\Commands\SendMessage;
use App\Modules\Crm\Commands\CaptureVisitor;
use App\Modules\Crm\Commands\CaptureVisitorInteraction;
use App\Modules\Crm\Commands\CreateVisitorFollowup;
use App\Modules\Crm\Commands\DefineVisitorAutomationRule;
use App\Modules\Crm\Commands\LinkVisitorPerson;
use App\Modules\Crm\Commands\MaintainVisitor;
use App\Modules\Crm\Commands\MaintainVisitorCatalog;
use App\Modules\Crm\Commands\ManageVisitorFollowup;
use App\Modules\Crm\Commands\RecordVisitorConversion;
use App\Modules\Crm\Models\Visitor;
use App\Modules\Crm\Models\VisitorFollowup;
use App\Modules\Crm\Models\VisitorSource;
use App\Modules\Documents\Commands\RegisterDocument;
use App\Modules\Documents\Models\DocumentClassification;
use App\Modules\Finance\Commands\RecordPayment;
use App\Modules\Finance\Models\FinancialPeriod;
use App\Modules\Organization\Models\Branch;
use App\Modules\Privacy\Models\Consent;
use App\Modules\Privacy\Models\ConsentPurpose;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Tests\Concerns\BuildsActors;
use Tests\Concerns\BuildsStudents;
use Tests\TestCase;

final class VisitorCrmFeatureTest extends TestCase
{
    use BuildsActors;
    use BuildsStudents;

    public function test_captures_anonymous_visitor_with_contact_dedupe_and_normalized_key(): void
    {
        $reception = $this->actorWithStructureCapabilities('crm-reception-1', ['crm.visitor']);

        $first = app(CaptureVisitor::class)->capture(
            $reception,
            null,
            'Anonymous Walk-In',
            '+93 700 123 456',
            null,
            'phone',
            'walk_in',
            null,
            null,
            null,
            'TOEFL preparation',
            'walked in before lunch',
            'capture-1',
        );

        $visitor = Visitor::query()->findOrFail($first['visitor_id']);
        $this->assertSame('new', $visitor->status);
        $this->assertSame('phone', $visitor->preferred_channel);
        $this->assertSame('93700123456', $visitor->contact_key);
        $this->assertDatabaseHas('audit_events', ['operation' => 'crm.visitor.capture', 'target_type' => 'visitor', 'target_id' => $visitor->id]);

        // Same phone as a second open lead is rejected (partial unique index + command guard).
        try {
            app(CaptureVisitor::class)->capture($reception, null, 'Duplicate', '93 700 123 456', null, 'phone', 'walk_in', null, null, null, null, null, 'capture-2');
            $this->fail('duplicate primary contact must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('crm.duplicate_contact', $rejection->errorCode());
        }

        // The same identity email de-duplicates even when the phone differs.
        $emailLead = app(CaptureVisitor::class)->capture($reception, null, 'Email Lead', '0799 555 222', 'LEAD@Example.COM', 'email', 'online', null, null, null, null, null, 'capture-3');
        $this->assertSame('lead@example.com', Visitor::query()->findOrFail($emailLead['visitor_id'])->contact_key);
    }

    public function test_captures_one_open_lead_per_verified_person(): void
    {
        $reception = $this->actorWithStructureCapabilities('crm-reception-2', ['crm.visitor']);
        $person = $this->personWithAuthority('crm-person-1', []);

        app(CaptureVisitor::class)->capture($reception, $person->id, '', null, 'p1@example.com', 'email', 'online', null, null, null, 'IELTS', null, 'capture-p1');
        try {
            app(CaptureVisitor::class)->capture($reception, $person->id, 'Other Name', null, 'p1-other@example.com', 'email', 'online', null, null, null, null, null, 'capture-p2');
            $this->fail('one open visitor per person must be enforced');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('crm.duplicate_person', $rejection->errorCode());
        }
    }

    public function test_visitor_transition_is_state_machined_and_loss_requires_reason(): void
    {
        $reception = $this->actorWithStructureCapabilities('crm-reception-3', ['crm.visitor']);
        $capture = app(CaptureVisitor::class)->capture($reception, null, 'Pipeline Lead', null, 'pipeline@example.com', 'email', 'online', null, null, null, null, null, 'capture-3');

        $id = $capture['visitor_id'];
        app(MaintainVisitor::class)->transition($reception, Visitor::query()->findOrFail($id), Visitor::STATUS_CONTACTED, null, 'trans-1');
        app(MaintainVisitor::class)->transition($reception, Visitor::query()->findOrFail($id), Visitor::STATUS_ENGAGED, null, 'trans-2');
        app(MaintainVisitor::class)->transition($reception, Visitor::query()->findOrFail($id), Visitor::STATUS_QUALIFIED, null, 'trans-3');

        // Closing as lost without a reason is a business rejection.
        try {
            app(MaintainVisitor::class)->transition($reception, Visitor::query()->findOrFail($id), Visitor::STATUS_LOST, null, 'trans-4');
            $this->fail('loss requires a documented reason');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('crm.visitor_loss_reason', $rejection->errorCode());
        }

        app(MaintainVisitor::class)->transition($reception, Visitor::query()->findOrFail($id), Visitor::STATUS_LOST, 'no response in 30 days', 'trans-5');
        // A lost lead may be deliberately revived.
        app(MaintainVisitor::class)->transition($reception, Visitor::query()->findOrFail($id), Visitor::STATUS_CONTACTED, null, 'trans-6');

        try {
            app(MaintainVisitor::class)->transition($reception, Visitor::query()->findOrFail($id), Visitor::STATUS_ARCHIVED, null, 'trans-7');
            $this->fail('a contacted lead cannot jump to archived');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('crm.visitor_transition_forbidden', $rejection->errorCode());
        }
    }

    public function test_interactions_are_immutable_and_automation_schedules_followup(): void
    {
        $crmStaff = $this->actorWithStructureCapabilities('crm-staff-1', ['crm.visitor', 'crm.followup', 'crm.automation']);
        $capture = app(CaptureVisitor::class)->capture($crmStaff, null, 'Automation Lead', null, 'auto@example.com', 'email', 'online', null, null, null, null, null, 'capture-auto');

        app(DefineVisitorAutomationRule::class)->define(
            $crmStaff,
            'auto-followup-requested-info',
            'Follow up after info request',
            'interaction_outcome',
            'requested_info',
            'schedule_followup',
            ['assignee' => $crmStaff->actorId, 'title' => 'Call back with fee info', 'due_in_days' => 2],
            true,
            'rule-1',
        );

        $interaction = app(CaptureVisitorInteraction::class)->capture(
            $crmStaff,
            Visitor::query()->findOrFail($capture['visitor_id']),
            'inbound',
            'email',
            'requested_info',
            'asked for fee schedule',
            CarbonImmutable::now(),
            null,
            null,
            null,
            null,
            'interaction-1',
        );

        $this->assertNotNull($interaction['scheduled_followup_id']);
        $followup = VisitorFollowup::query()->findOrFail($interaction['scheduled_followup_id']);
        $this->assertSame(VisitorFollowup::STATUS_OPEN, $followup->status);
        $this->assertSame('Call back with fee info', $followup->title);

        // Interactions are evidence: an UPDATE is impossible at the DB boundary.
        try {
            DB::table('visitor_interactions')->where('id', $interaction['interaction_id'])->update(['summary' => 'rewritten']);
            $this->fail('interactions must be append-only');
        } catch (QueryException $exception) {
            $this->assertStringContainsString('immutable', $exception->getMessage());
        }
    }

    public function test_followups_complete_and_cancel_lifecycle(): void
    {
        $crmStaff = $this->actorWithStructureCapabilities('crm-staff-2', ['crm.visitor', 'crm.followup']);
        $capture = app(CaptureVisitor::class)->capture($crmStaff, null, 'Followup Lead', null, 'followup@example.com', 'email', 'online', null, null, null, null, null, 'capture-f');

        $followup = app(CreateVisitorFollowup::class)->create(
            $crmStaff,
            Visitor::query()->findOrFail($capture['visitor_id']),
            $crmStaff->actorId,
            CarbonImmutable::now()->addDay(),
            'Call the lead',
            'request placement info',
            'followup-1',
        );

        $done = app(ManageVisitorFollowup::class)->complete($crmStaff, VisitorFollowup::query()->findOrFail($followup['followup_id']), 'followup-1.done');
        $this->assertSame(VisitorFollowup::STATUS_DONE, $done['status']);
        $this->assertDatabaseHas('visitor_followups', ['id' => $followup['followup_id'], 'status' => 'done', 'completed_by' => $crmStaff->actorId]);

        try {
            app(ManageVisitorFollowup::class)->cancel($crmStaff, VisitorFollowup::query()->findOrFail($followup['followup_id']), 'followup-1.cancel');
            $this->fail('a completed follow-up cannot be cancelled');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('crm.followup_invalid_transition', $rejection->errorCode());
        }
    }

    public function test_registering_an_applicant_from_a_lead_records_the_crm_conversion(): void
    {
        $crmStaff = $this->actorWithStructureCapabilities('crm-register-1', ['crm.visitor']);
        $person = $this->personWithAuthority('crm-register-person-1', []);
        $capture = app(CaptureVisitor::class)->capture($crmStaff, $person->id, '', null, 'register@example.com', 'email', 'online', null, null, null, 'IELTS', null, 'capture-register');

        $registrar = $this->admissionsClerk('crm-adm-clerk-1');
        app(RegisterApplicant::class)->register($registrar, $person->id, 'IELTS Preparation', 'reg-crm-1');

        $visitor = Visitor::query()->findOrFail($capture['visitor_id']);
        $this->assertSame(Visitor::STATUS_CONVERTED, $visitor->status);
        $this->assertSame($person->id, trim((string) $visitor->person_id));
        $this->assertDatabaseHas('visitor_conversions', [
            'visitor_id' => $visitor->id,
            'conversion_type' => 'applicant',
            'person_id' => str_pad($person->id, 36),
        ]);
    }

    public function test_manual_conversion_requires_capability_and_is_single_shot(): void
    {
        $crmStaff = $this->actorWithStructureCapabilities('crm-convert-1', ['crm.visitor']);
        $capture = app(CaptureVisitor::class)->capture($crmStaff, null, 'Convert Lead', null, 'convert@example.com', 'email', 'online', null, null, null, null, null, 'capture-convert');
        $visitor = Visitor::query()->findOrFail($capture['visitor_id']);

        try {
            app(RecordVisitorConversion::class)->record(
                $this->actorWithoutAnyCapability('crm-nobody-1'),
                $visitor,
                'enquiry',
                'enquiry',
                'ENQ-1',
                'convert-denied',
            );
            $this->fail('conversion without CRM capability must be denied');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('crm.conversion_denied', $denial->errorCode());
        }

        $converter = $this->actorWithStructureCapabilities('crm-converter-1', ['crm.visitor.convert']);
        app(RecordVisitorConversion::class)->record($converter, $visitor, 'enquiry', 'enquiry', 'ENQ-2', 'convert-1');
        $this->assertDatabaseHas('visitor_conversions', ['visitor_id' => $visitor->id, 'conversion_type' => 'enquiry']);
        $this->assertSame(Visitor::STATUS_CONVERTED, $visitor->fresh()->status);

        try {
            app(RecordVisitorConversion::class)->record($converter, $visitor, 'enquiry', 'enquiry', 'ENQ-3', 'convert-2');
            $this->fail('a visitor cannot be converted twice');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('crm.conversion_exists', $rejection->errorCode());
        }
    }

    public function test_catalog_lifecycle_and_campaign_window(): void
    {
        $admin = $this->actorWithStructureCapabilities('crm-admin-1', ['crm.catalog']);

        $source = app(MaintainVisitorCatalog::class)->defineSource($admin, 'social-media', 'Social Media', 'digital', 'source-1');
        $this->assertDatabaseHas('visitor_sources', ['id' => $source['source_id'], 'key' => 'social-media', 'lifecycle_state' => 'active']);

        try {
            app(MaintainVisitorCatalog::class)->defineSource($admin, 'SOCIAL-MEDIA', 'Duplicate', 'digital', 'source-2');
            $this->fail('a source key must be unique');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('crm.source_key_exists', $rejection->errorCode());
        }

        try {
            app(MaintainVisitorCatalog::class)->defineCampaign(
                $admin,
                'bad-window',
                'Bad Window',
                $source['source_id'],
                'social',
                CarbonImmutable::parse('2026-09-10'),
                CarbonImmutable::parse('2026-09-01'),
                'campaign-bad',
            );
            $this->fail('a campaign cannot end before it starts');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('crm.campaign_window', $rejection->errorCode());
        }

        $campaign = app(MaintainVisitorCatalog::class)->defineCampaign(
            $admin,
            'spring-launch',
            'Spring Launch',
            $source['source_id'],
            'social',
            CarbonImmutable::parse('2026-09-01'),
            CarbonImmutable::parse('2026-09-30'),
            'campaign-1',
        );
        $this->assertDatabaseHas('visitor_campaigns', ['id' => $campaign['campaign_id'], 'key' => 'spring-launch']);

        app(MaintainVisitorCatalog::class)->retireSource($admin, VisitorSource::query()->findOrFail($source['source_id']), 'source-retire-1');
        $this->assertDatabaseHas('visitor_sources', ['id' => $source['source_id'], 'lifecycle_state' => 'retired']);
    }

    public function test_branch_provenance_scopes_access_and_is_immutable(): void
    {
        $branch = Branch::query()->create([
            'id' => RandomIdentifier::new(),
            'name' => 'CRM Branch '.substr(md5((string) random_int(1, PHP_INT_MAX)), 0, 8),
            'lifecycle_state' => 'active',
        ]);
        $branchStaff = $this->personWithAuthority('crm-branch-staff-1', []);
        $this->grantScopeAuthority($branchStaff->id, ['crm.visitor'], 'branch', $branch->id);
        $branchActor = new Actor($branchStaff->id, 'Branch CRM Staff');

        $capture = app(CaptureVisitor::class)->capture($branchActor, null, 'Branch Lead', null, 'branch@example.com', 'email', 'online', null, null, $branch->id, null, null, 'capture-branch');
        $visitor = Visitor::query()->findOrFail($capture['visitor_id']);
        $this->assertSame($branch->id, $visitor->origin_branch_id);

        app(MaintainVisitor::class)->update($branchActor, $visitor, null, null, null, null, 'hot', 'IELTS', null, null, 'branch-update-1');
        $this->assertSame('hot', $visitor->fresh()->rating);

        // Branch provenance is immutable once assigned.
        try {
            DB::table('visitors')->where('id', $visitor->id)->update(['origin_branch_id' => RandomIdentifier::new()]);
            $this->fail('branch provenance must be immutable');
        } catch (QueryException $exception) {
            $this->assertStringContainsString('immutable', $exception->getMessage());
        }

        // An actor with the capability only in a different branch is denied.
        $other = $this->actorWithStructureCapabilities('crm-branch-other-1', ['crm.visitor']);
        try {
            app(MaintainVisitor::class)->update($other, $visitor->fresh(), null, null, null, null, 'cold', null, null, null, 'branch-update-2');
            $this->fail('cross-branch visitor access must be denied');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('crm.visitor_denied', $denial->errorCode());
        }
    }

    public function test_finance_communication_and_document_steps_trace_back_to_the_lead(): void
    {
        $studentBundle = $this->makeStudent([
            'initiator' => 'crm-int-init',
            'reviewer' => 'crm-int-rev',
            'approver' => 'crm-int-appr',
            'applicant' => 'crm-int-person',
        ]);
        $student = $studentBundle['student'];
        $person = $studentBundle['person'];

        $crmStaff = $this->actorWithStructureCapabilities('crm-int-staff', ['crm.visitor']);
        $capture = app(CaptureVisitor::class)->capture($crmStaff, $person->id, '', null, 'integration@example.com', 'email', 'online', null, null, null, null, null, 'capture-integration');

        $converter = $this->actorWithStructureCapabilities('crm-int-convert', ['crm.visitor.convert']);
        app(RecordVisitorConversion::class)->record($converter, Visitor::query()->findOrFail($capture['visitor_id']), 'student', 'student', $student->id, 'convert-integration');
        $this->assertDatabaseHas('visitor_conversions', ['visitor_id' => $capture['visitor_id'], 'student_id' => $student->id]);

        // Finance: a payment against the student appends a payment interaction.
        $financier = $this->personWithAuthority('crm-int-fin', ['finance.payment']);
        $period = FinancialPeriod::query()->create([
            'id' => RandomIdentifier::new(),
            'period_key' => '2026-09',
            'date_from' => '2026-09-01',
            'date_to' => '2026-09-30',
            'lifecycle_state' => 'open',
        ]);
        $payment = app(RecordPayment::class)->record(
            new Actor($financier->id, 'Finance Officer'),
            $period,
            $student->id,
            '100.00',
            'cash',
            'CASH-INT-1',
            '2026-09-05',
            'payment-integration',
        );
        $this->assertDatabaseHas('visitor_interactions', ['visitor_id' => $capture['visitor_id'], 'type' => 'payment', 'payment_id' => $payment['payment_id']]);

        // Communication: a consent-gated message appends a message interaction.
        $communicator = $this->personWithAuthority('crm-int-comm', ['communication.send']);
        $purpose = ConsentPurpose::query()->create([
            'id' => RandomIdentifier::new(),
            'name' => 'CRM Test Updates',
            'channel' => 'email',
            'category' => 'communication',
        ]);
        Consent::query()->create([
            'id' => RandomIdentifier::new(),
            'subject_person_id' => $person->id,
            'purpose_id' => $purpose->id,
            'lifecycle_state' => 'active',
            'effective_from' => '2026-01-01',
            'effective_to' => null,
            'evidence_ref' => 'consent/integration',
            'recorded_by' => $person->id,
        ]);
        $message = app(SendMessage::class)->queue(
            new Actor($communicator->id, 'Communication Officer'),
            $person->id,
            $purpose->id,
            'email',
            'content/integration',
            'message-integration',
        );
        $this->assertDatabaseHas('visitor_interactions', ['visitor_id' => $capture['visitor_id'], 'type' => 'email', 'message_id' => $message['message_id']]);

        // Documents: a registered document appends a document interaction.
        $documentsOfficer = $this->personWithAuthority('crm-int-doc', ['documents.register']);
        $classification = DocumentClassification::query()->create([
            'id' => RandomIdentifier::new(),
            'category' => 'Admissions',
            'owner_module' => 'admissions',
            'access_class' => 'confidential',
        ]);
        $document = app(RegisterDocument::class)->register(
            new Actor($documentsOfficer->id, 'Documents Officer'),
            $person->id,
            $classification->id,
            'Enrolment pack',
            hash('sha256', 'enrolment-pack'),
            'storage/enrolment-pack.pdf',
            'document-integration',
        );
        $this->assertDatabaseHas('visitor_interactions', ['visitor_id' => $capture['visitor_id'], 'type' => 'document', 'document_id' => $document['document_id']]);
    }

    public function test_anonymous_visitor_can_be_linked_to_a_person_then_convert_via_admissions(): void
    {
        $reception = $this->actorWithStructureCapabilities('crm-link-1', ['crm.visitor']);
        $person = $this->personWithAuthority('crm-link-person-1', []);
        $capture = app(CaptureVisitor::class)->capture($reception, null, 'Anonymous To Link', null, 'link@example.com', 'email', 'online', null, null, null, null, null, 'capture-link');

        $visitor = Visitor::query()->findOrFail($capture['visitor_id']);
        app(LinkVisitorPerson::class)->link($reception, $visitor, $person->id, 'link-person-1');
        $this->assertSame($person->id, trim((string) $visitor->fresh()->person_id));

        $registrar = $this->admissionsClerk('crm-link-clerk-1');
        app(RegisterApplicant::class)->register($registrar, $person->id, 'IELTS Preparation', 'reg-crm-link');
        $this->assertSame(Visitor::STATUS_CONVERTED, $visitor->fresh()->status);
        $this->assertDatabaseHas('visitor_conversions', ['visitor_id' => $visitor->id, 'conversion_type' => 'applicant']);
    }
}
