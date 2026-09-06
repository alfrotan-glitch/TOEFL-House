<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
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
use App\Modules\Crm\Models\VisitorAutomationRule;
use App\Modules\Crm\Models\VisitorCampaign;
use App\Modules\Crm\Models\VisitorFollowup;
use App\Modules\Crm\Models\VisitorSource;
use App\Modules\Crm\Queries\VisitorListQuery;
use App\Modules\Crm\Queries\VisitorTimelineQuery;
use Carbon\CarbonImmutable;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/** JSON interface for the Visitor/Lead/CRM domain (delegates to module commands). */
final class CrmApiController extends Controller
{
    public function sources(): JsonResponse
    {
        $sources = VisitorSource::query()->orderBy('key')->get(['id', 'key', 'name', 'category', 'lifecycle_state']);

        return response()->json(['sources' => $sources]);
    }

    public function campaigns(): JsonResponse
    {
        $campaigns = VisitorCampaign::query()->orderBy('key')->get(['id', 'key', 'name', 'source_id', 'channel', 'starts_on', 'ends_on', 'lifecycle_state']);

        return response()->json(['campaigns' => $campaigns]);
    }

    public function defineSource(Request $request): JsonResponse
    {
        $input = $request->validate([
            'key' => ['required', 'string', 'max:80'],
            'name' => ['required', 'string', 'max:160'],
            'category' => ['nullable', 'string', 'max:80'],
        ]);

        $result = app(MaintainVisitorCatalog::class)->defineSource(
            $this->actor(),
            $input['key'],
            $input['name'],
            $input['category'] ?? null,
            $this->idempotencyKey('crm.source.define'),
        );

        return response()->json(['status' => 'defined', 'source_id' => $result['source_id']], 201);
    }

    public function defineCampaign(Request $request): JsonResponse
    {
        $input = $request->validate([
            'key' => ['required', 'string', 'max:80'],
            'name' => ['required', 'string', 'max:160'],
            'source_id' => ['nullable', 'string'],
            'channel' => ['required', 'string', 'max:40'],
            'starts_on' => ['required', 'date'],
            'ends_on' => ['nullable', 'date', 'after_or_equal:starts_on'],
        ]);

        $startsOn = CarbonImmutable::parse($input['starts_on']);
        $endsOn = isset($input['ends_on']) ? CarbonImmutable::parse($input['ends_on']) : null;

        $result = app(MaintainVisitorCatalog::class)->defineCampaign(
            $this->actor(),
            $input['key'],
            $input['name'],
            $input['source_id'] ?? null,
            $input['channel'],
            $startsOn,
            $endsOn,
            $this->idempotencyKey('crm.campaign.define'),
        );

        return response()->json(['status' => 'defined', 'campaign_id' => $result['campaign_id']], 201);
    }

    public function captures(Request $request): JsonResponse
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

        $result = app(CaptureVisitor::class)->capture(
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

        return response()->json(['status' => 'captured', ...$result], 201);
    }

    public function index(Request $request): JsonResponse
    {
        $input = $request->validate([
            'statuses' => ['nullable', 'array'],
            'statuses.*' => ['string'],
            'term' => ['nullable', 'string', 'max:160'],
            'person_id' => ['nullable', 'string'],
            'source_id' => ['nullable', 'string'],
            'campaign_id' => ['nullable', 'string'],
            'branch_id' => ['nullable', 'string'],
            'assigned_to' => ['nullable', 'string'],
            'rating' => ['nullable', 'string', 'max:20'],
            'visitor_type' => ['nullable', 'string', 'max:40'],
            'limit' => ['nullable', 'integer', 'max:500'],
        ]);

        $visitors = app(VisitorListQuery::class)->search($input['statuses'] ?? null, $input, (int) ($input['limit'] ?? 100));

        return response()->json(['visitors' => $visitors]);
    }

    public function show(string $visitorId): JsonResponse
    {
        $visitor = Visitor::query()->findOrFail($visitorId);
        $detail = app(VisitorListQuery::class)->detail($visitor);

        return response()->json(['visitor' => $detail]);
    }

    public function timeline(string $visitorId): JsonResponse
    {
        $visitor = Visitor::query()->findOrFail($visitorId);

        return response()->json(['timeline' => app(VisitorTimelineQuery::class)->for($visitor)]);
    }

    public function linkPerson(Request $request, string $visitorId): JsonResponse
    {
        $input = $request->validate([
            'person_id' => ['required', 'string'],
        ]);

        $result = app(LinkVisitorPerson::class)->link(
            $this->actor(),
            Visitor::query()->findOrFail($visitorId),
            $input['person_id'],
            $this->idempotencyKey('crm.visitor.link'),
        );

        return response()->json(['status' => 'linked', ...$result]);
    }

    public function transition(Request $request, string $visitorId): JsonResponse
    {
        $input = $request->validate([
            'status' => ['required', 'string', 'max:40'],
            'reason' => ['nullable', 'string', 'max:2000'],
        ]);

        $result = app(MaintainVisitor::class)->transition(
            $this->actor(),
            Visitor::query()->findOrFail($visitorId),
            $input['status'],
            $input['reason'] ?? null,
            $this->idempotencyKey('crm.visitor.transition'),
        );

        return response()->json(['status' => 'updated', ...$result]);
    }

    public function update(Request $request, string $visitorId): JsonResponse
    {
        $input = $request->validate([
            'full_name' => ['nullable', 'string', 'max:160'],
            'phone' => ['nullable', 'string', 'max:40'],
            'email' => ['nullable', 'email', 'max:160'],
            'preferred_channel' => ['nullable', 'string', 'max:40'],
            'rating' => ['nullable', 'string', 'max:20'],
            'interest' => ['nullable', 'string', 'max:255'],
            'notes' => ['nullable', 'string', 'max:2000'],
            'assigned_to' => ['nullable', 'string'],
        ]);

        $result = app(MaintainVisitor::class)->update(
            $this->actor(),
            Visitor::query()->findOrFail($visitorId),
            $input['full_name'] ?? null,
            $input['phone'] ?? null,
            $input['email'] ?? null,
            $input['preferred_channel'] ?? null,
            $input['rating'] ?? null,
            $input['interest'] ?? null,
            $input['notes'] ?? null,
            $input['assigned_to'] ?? null,
            $this->idempotencyKey('crm.visitor.update'),
        );

        return response()->json(['status' => 'updated', ...$result]);
    }

    public function interactions(Request $request, string $visitorId): JsonResponse
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

        $occurred = CarbonImmutable::parse($input['occurred_on']);
        $result = app(CaptureVisitorInteraction::class)->capture(
            $this->actor(),
            Visitor::query()->findOrFail($visitorId),
            $input['direction'],
            $input['type'],
            $input['outcome'],
            $input['summary'],
            $occurred,
            $input['message_id'] ?? null,
            $input['document_id'] ?? null,
            $input['assessment_attempt_id'] ?? null,
            $input['payment_id'] ?? null,
            $this->idempotencyKey('crm.interaction.capture'),
        );

        return response()->json(['status' => 'captured', ...$result], 201);
    }

    public function followups(Request $request, string $visitorId): JsonResponse
    {
        $input = $request->validate([
            'assigned_to' => ['required', 'string'],
            'scheduled_for' => ['required', 'date'],
            'title' => ['required', 'string', 'max:160'],
            'notes' => ['nullable', 'string', 'max:2000'],
        ]);

        $result = app(CreateVisitorFollowup::class)->create(
            $this->actor(),
            Visitor::query()->findOrFail($visitorId),
            $input['assigned_to'],
            CarbonImmutable::parse($input['scheduled_for']),
            $input['title'],
            $input['notes'] ?? null,
            $this->idempotencyKey('crm.followup.create'),
        );

        return response()->json(['status' => 'scheduled', ...$result], 201);
    }

    public function completeFollowup(string $followupId): JsonResponse
    {
        $result = app(ManageVisitorFollowup::class)->complete(
            $this->actor(),
            VisitorFollowup::query()->findOrFail($followupId),
            $this->idempotencyKey('crm.followup.complete'),
        );

        return response()->json(['status' => 'completed', ...$result]);
    }

    public function cancelFollowup(string $followupId): JsonResponse
    {
        $result = app(ManageVisitorFollowup::class)->cancel(
            $this->actor(),
            VisitorFollowup::query()->findOrFail($followupId),
            $this->idempotencyKey('crm.followup.cancel'),
        );

        return response()->json(['status' => 'cancelled', ...$result]);
    }

    public function convert(Request $request, string $visitorId): JsonResponse
    {
        $input = $request->validate([
            'conversion_type' => ['required', 'string', 'max:40'],
            'downstream_entity' => ['required', 'string', 'max:40'],
            'downstream_id' => ['required', 'string'],
        ]);

        $result = app(RecordVisitorConversion::class)->record(
            $this->actor(),
            Visitor::query()->findOrFail($visitorId),
            $input['conversion_type'],
            $input['downstream_entity'],
            $input['downstream_id'],
            $this->idempotencyKey('crm.conversion.record'),
        );

        return response()->json(['status' => 'recorded', ...$result], 201);
    }

    public function automationRules(): JsonResponse
    {
        $rules = VisitorAutomationRule::query()->orderBy('key')->get();

        return response()->json(['rules' => $rules]);
    }

    public function defineAutomationRule(Request $request): JsonResponse
    {
        $input = $request->validate([
            'key' => ['required', 'string', 'max:80'],
            'name' => ['required', 'string', 'max:160'],
            'trigger_type' => ['required', 'string', 'max:40'],
            'trigger_value' => ['required', 'string', 'max:40'],
            'action_type' => ['required', 'string', 'max:40'],
            'action_config' => ['required', 'array'],
            'action_config.assignee' => ['required', 'string'],
            'action_config.title' => ['required', 'string', 'max:160'],
            'action_config.due_in_days' => ['required', 'integer', 'min:0', 'max:365'],
            'is_active' => ['nullable', 'boolean'],
        ]);

        $result = app(DefineVisitorAutomationRule::class)->define(
            $this->actor(),
            $input['key'],
            $input['name'],
            $input['trigger_type'],
            $input['trigger_value'],
            $input['action_type'],
            $input['action_config'],
            (bool) ($input['is_active'] ?? true),
            $this->idempotencyKey('crm.automation.define'),
        );

        return response()->json(['status' => 'defined', ...$result], 201);
    }
}
