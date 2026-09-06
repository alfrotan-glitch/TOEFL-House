<?php

declare(strict_types=1);

namespace App\Http\Controllers;

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
use App\Modules\Crm\Models\VisitorCampaign;
use App\Modules\Crm\Models\VisitorFollowup;
use App\Modules\Crm\Models\VisitorSource;
use Carbon\CarbonImmutable;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\View\View;

/**
 * Visitor / Lead / CRM console. Thin transport boundary: every state change
 * delegates to the CRM module commands (authorization, SoD, idempotency,
 * audit owned there).
 */
final class CrmController extends Controller
{
    public function index(): View
    {
        $visitors = Visitor::query()
            ->with(['source:id,key,name', 'campaign:id,key,name,channel', 'assignee:id,legal_name', 'conversion:id,visitor_id,conversion_type,converted_at'])
            ->orderByDesc('created_at')
            ->limit(200)
            ->get();

        return view('crm.index', [
            'visitors' => $visitors,
            'sources' => VisitorSource::query()->where('lifecycle_state', 'active')->orderBy('name')->get(),
            'campaigns' => VisitorCampaign::query()->where('lifecycle_state', 'active')->orderBy('name')->get(),
            'openCount' => Visitor::query()->whereIn('status', Visitor::openStatuses())->count(),
            'convertedCount' => Visitor::query()->where('status', 'converted')->count(),
        ]);
    }

    public function capture(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'person_id' => ['nullable', 'string'],
            'full_name' => ['nullable', 'string', 'max:160'],
            'phone' => ['nullable', 'string', 'max:40'],
            'email' => ['nullable', 'email', 'max:160'],
            'preferred_channel' => ['required', 'string', 'max:40'],
            'visitor_type' => ['required', 'string', 'max:40'],
            'source_id' => ['nullable', 'string'],
            'campaign_id' => ['nullable', 'string'],
            'origin_branch_id' => ['nullable', 'string'],
            'interest' => ['nullable', 'string', 'max:255'],
            'notes' => ['nullable', 'string', 'max:2000'],
        ]);

        app(CaptureVisitor::class)->capture(
            $this->actor(),
            $input['person_id'] ?? null,
            $input['full_name'] ?? '',
            $input['phone'] ?? null,
            $input['email'] ?? null,
            $input['preferred_channel'],
            $input['visitor_type'],
            $input['source_id'] ?? null,
            $input['campaign_id'] ?? null,
            $input['origin_branch_id'] ?? null,
            $input['interest'] ?? null,
            $input['notes'] ?? null,
            $this->idempotencyKey('crm.visitor.capture'),
        );

        return redirect()->route('crm.index')->with('success', 'Visitor captured.');
    }

    public function transition(Request $request, string $visitorId): RedirectResponse
    {
        $input = $request->validate([
            'status' => ['required', 'string', 'max:40'],
            'reason' => ['nullable', 'string', 'max:2000'],
        ]);

        app(MaintainVisitor::class)->transition(
            $this->actor(),
            Visitor::query()->findOrFail($visitorId),
            $input['status'],
            $input['reason'] ?? null,
            $this->idempotencyKey('crm.visitor.transition'),
        );

        return redirect()->route('crm.index')->with('success', 'Visitor stage updated.');
    }

    public function interaction(Request $request, string $visitorId): RedirectResponse
    {
        $input = $request->validate([
            'direction' => ['required', 'string', 'max:20'],
            'type' => ['required', 'string', 'max:40'],
            'outcome' => ['required', 'string', 'max:40'],
            'summary' => ['required', 'string', 'max:2000'],
            'occurred_on' => ['required', 'date'],
            'message_id' => ['nullable', 'string'],
            'document_id' => ['nullable', 'string'],
            'assessment_attempt_id' => ['nullable', 'string'],
            'payment_id' => ['nullable', 'string'],
        ]);

        app(CaptureVisitorInteraction::class)->capture(
            $this->actor(),
            Visitor::query()->findOrFail($visitorId),
            $input['direction'],
            $input['type'],
            $input['outcome'],
            $input['summary'],
            CarbonImmutable::parse($input['occurred_on']),
            $input['message_id'] ?? null,
            $input['document_id'] ?? null,
            $input['assessment_attempt_id'] ?? null,
            $input['payment_id'] ?? null,
            $this->idempotencyKey('crm.interaction.capture'),
        );

        return redirect()->route('crm.index')->with('success', 'Interaction recorded.');
    }

    public function followup(Request $request, string $visitorId): RedirectResponse
    {
        $input = $request->validate([
            'assigned_to' => ['required', 'string'],
            'scheduled_for' => ['required', 'date'],
            'title' => ['required', 'string', 'max:160'],
            'notes' => ['nullable', 'string', 'max:2000'],
        ]);

        app(CreateVisitorFollowup::class)->create(
            $this->actor(),
            Visitor::query()->findOrFail($visitorId),
            $input['assigned_to'],
            CarbonImmutable::parse($input['scheduled_for']),
            $input['title'],
            $input['notes'] ?? null,
            $this->idempotencyKey('crm.followup.create'),
        );

        return redirect()->route('crm.index')->with('success', 'Follow-up scheduled.');
    }

    public function completeFollowup(string $followupId): RedirectResponse
    {
        app(ManageVisitorFollowup::class)->complete(
            $this->actor(),
            VisitorFollowup::query()->findOrFail($followupId),
            $this->idempotencyKey('crm.followup.complete'),
        );

        return redirect()->route('crm.index')->with('success', 'Follow-up completed.');
    }

    public function cancelFollowup(string $followupId): RedirectResponse
    {
        app(ManageVisitorFollowup::class)->cancel(
            $this->actor(),
            VisitorFollowup::query()->findOrFail($followupId),
            $this->idempotencyKey('crm.followup.cancel'),
        );

        return redirect()->route('crm.index')->with('success', 'Follow-up cancelled.');
    }

    public function linkPerson(Request $request, string $visitorId): RedirectResponse
    {
        $input = $request->validate([
            'person_id' => ['required', 'string'],
        ]);

        app(LinkVisitorPerson::class)->link(
            $this->actor(),
            Visitor::query()->findOrFail($visitorId),
            $input['person_id'],
            $this->idempotencyKey('crm.visitor.link'),
        );

        return redirect()->route('crm.index')->with('success', 'Visitor linked to a person.');
    }

    public function convert(Request $request, string $visitorId): RedirectResponse
    {
        $input = $request->validate([
            'conversion_type' => ['required', 'string', 'max:40'],
            'downstream_entity' => ['required', 'string', 'max:40'],
            'downstream_id' => ['required', 'string'],
        ]);

        app(RecordVisitorConversion::class)->record(
            $this->actor(),
            Visitor::query()->findOrFail($visitorId),
            $input['conversion_type'],
            $input['downstream_entity'],
            $input['downstream_id'],
            $this->idempotencyKey('crm.conversion.record'),
        );

        return redirect()->route('crm.index')->with('success', 'Visitor conversion recorded.');
    }

    public function defineSource(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'key' => ['required', 'string', 'max:80'],
            'name' => ['required', 'string', 'max:160'],
            'category' => ['nullable', 'string', 'max:80'],
        ]);

        app(MaintainVisitorCatalog::class)->defineSource(
            $this->actor(),
            $input['key'],
            $input['name'],
            $input['category'] ?? null,
            $this->idempotencyKey('crm.source.define'),
        );

        return redirect()->route('crm.index')->with('success', 'Source defined.');
    }

    public function defineCampaign(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'key' => ['required', 'string', 'max:80'],
            'name' => ['required', 'string', 'max:160'],
            'source_id' => ['nullable', 'string'],
            'channel' => ['required', 'string', 'max:40'],
            'starts_on' => ['required', 'date'],
            'ends_on' => ['nullable', 'date', 'after_or_equal:starts_on'],
        ]);

        app(MaintainVisitorCatalog::class)->defineCampaign(
            $this->actor(),
            $input['key'],
            $input['name'],
            $input['source_id'] ?? null,
            $input['channel'],
            CarbonImmutable::parse($input['starts_on']),
            isset($input['ends_on']) ? CarbonImmutable::parse($input['ends_on']) : null,
            $this->idempotencyKey('crm.campaign.define'),
        );

        return redirect()->route('crm.index')->with('success', 'Campaign defined.');
    }

    public function defineAutomationRule(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'key' => ['required', 'string', 'max:80'],
            'name' => ['required', 'string', 'max:160'],
            'trigger_value' => ['required', 'string', 'max:40'],
            'assignee' => ['required', 'string'],
            'title' => ['required', 'string', 'max:160'],
            'due_in_days' => ['required', 'integer', 'min:0', 'max:365'],
        ]);

        app(DefineVisitorAutomationRule::class)->define(
            $this->actor(),
            $input['key'],
            $input['name'],
            'interaction_outcome',
            $input['trigger_value'],
            'schedule_followup',
            ['assignee' => $input['assignee'], 'title' => $input['title'], 'due_in_days' => (int) $input['due_in_days']],
            true,
            $this->idempotencyKey('crm.automation.define'),
        );

        return redirect()->route('crm.index')->with('success', 'Automation rule defined.');
    }
}
