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
use App\Modules\Crm\Models\Visitor;
use App\Modules\Crm\Models\VisitorAutomationRule;
use App\Modules\Organization\Models\Branch;
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
    public function sources(Request $request): JsonResponse
    {
        $this->requireOrganizationRead('crm.catalog', 'api.crm.sources');
        $sourcesQuery = VisitorSource::query()->orderBy('key');
        if (! $request->boolean('include_retired')) {
            $sourcesQuery->where('lifecycle_state', 'active');
        }
        $sources = $sourcesQuery->get(['id', 'key', 'name', 'category', 'lifecycle_state', 'created_by']);

        return response()->json(['sources' => $sources]);
    }

    public function campaigns(Request $request): JsonResponse
    {
        $this->requireOrganizationRead('crm.catalog', 'api.crm.campaigns');
        $campaignsQuery = VisitorCampaign::query()->orderBy('key');
        if (! $request->boolean('include_retired')) {
            $campaignsQuery->where('lifecycle_state', 'active');
        }
        $campaigns = $campaignsQuery->get(['id', 'key', 'name', 'source_id', 'channel', 'starts_on', 'ends_on', 'lifecycle_state', 'created_by']);

        return response()->json(['campaigns' => $campaigns]);
    }

    public function branches(): JsonResponse
    {
        $actor = $this->actor();
        $organizationScope = app(\App\Support\Authorization\AccessDecision::class)->decide($actor, 'crm.visitor', null)->allowed;
        $branchIds = $this->authorizedBranches('crm.visitor');
        if (! $organizationScope && $branchIds === []) {
            $this->requireOrganizationRead('crm.visitor', 'api.crm.branches');
        }
        // An organization-rooted grant is not a wildcard across every
        // organization. `authorizedBranches()` resolves the concrete active
        // branches covered by this actor's grants; return only that set.
        $branchesQuery = Branch::query()->where('lifecycle_state', 'active')->whereIn('id', $branchIds);
        $branches = $branchesQuery
            ->orderBy('name')
            ->get(['id', 'name', 'lifecycle_state']);

        return response()->json([
            'branches' => $branches,
            // This is an explicit organization-scoped read/capture affordance;
            // the client must never infer it from an empty branch list.
            'allow_unassigned' => $organizationScope,
        ]);
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

    public function retireSource(string $sourceId): JsonResponse
    {
        $result = app(MaintainVisitorCatalog::class)->retireSource(
            $this->actor(),
            VisitorSource::query()->findOrFail($sourceId),
            $this->idempotencyKey('crm.source.retire'),
        );

        return response()->json(['status' => 'retired', ...$result]);
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

    public function retireCampaign(string $campaignId): JsonResponse
    {
        $result = app(MaintainVisitorCatalog::class)->retireCampaign(
            $this->actor(),
            VisitorCampaign::query()->findOrFail($campaignId),
            $this->idempotencyKey('crm.campaign.retire'),
        );

        return response()->json(['status' => 'retired', ...$result]);
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
        $actor = $this->actor();
        $organizationScope = app(\App\Support\Authorization\AccessDecision::class)->decide($actor, 'crm.visitor', null)->allowed;
        $authorizedBranches = $this->authorizedBranches('crm.visitor');
        if (! $organizationScope && $authorizedBranches === []) {
            $this->requireOrganizationRead('crm.visitor', 'api.crm.visitors');
        }

        $input = $request->validate([
            'statuses' => ['nullable', 'array'],
            'statuses.*' => ['string'],
            'term' => ['nullable', 'string', 'max:160'],
            'person_id' => ['nullable', 'string'],
            'source_id' => ['nullable', 'string'],
            'campaign_id' => ['nullable', 'string'],
            'branch_id' => ['nullable', 'string'],
            'include_unassigned' => ['nullable', 'boolean'],
            'assigned_to' => ['nullable', 'string'],
            'rating' => ['nullable', 'string', 'max:20'],
            'visitor_type' => ['nullable', 'string', 'max:40'],
            'limit' => ['nullable', 'integer', 'max:500'],
        ]);

        if (($input['branch_id'] ?? '') !== '') {
            $this->requireBranchCapability('crm.visitor', $input['branch_id'], 'api.crm.visitors', 'visitor_directory', 'branch:'.$input['branch_id']);
        }
        if (($input['include_unassigned'] ?? false) === true) {
            $this->requireOrganizationRead('crm.visitor', 'api.crm.visitors.unassigned', 'visitor_directory', 'unassigned');
        }
        $input['include_unassigned'] = (bool) ($input['include_unassigned'] ?? false);
        $input['branch_ids'] = $authorizedBranches;
        $visitors = app(VisitorListQuery::class)->search($input['statuses'] ?? null, $input, (int) ($input['limit'] ?? 100));

        return response()->json(['visitors' => $visitors]);
    }

    public function show(string $visitorId): JsonResponse
    {
        $visitor = Visitor::query()->findOrFail($visitorId);
        $this->requireVisitorRead($visitor, 'api.crm.visitor.show');
        $detail = app(VisitorListQuery::class)->detail($visitor);

        return response()->json(['visitor' => $detail]);
    }

    public function timeline(string $visitorId): JsonResponse
    {
        $visitor = Visitor::query()->findOrFail($visitorId);
        $this->requireVisitorRead($visitor, 'api.crm.visitor.timeline');

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
            'placement_attempt_id' => ['nullable', 'string'],
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
            $input['placement_attempt_id'] ?? null,
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

    public function automationRules(): JsonResponse
    {
        $this->requireOrganizationRead('crm.automation', 'api.crm.automation.rules');
        $rules = VisitorAutomationRule::query()->orderBy('key')->get();

        return response()->json(['rules' => $rules]);
    }

    public function retireAutomationRule(string $ruleId): JsonResponse
    {
        $result = app(DefineVisitorAutomationRule::class)->retire(
            $this->actor(),
            VisitorAutomationRule::query()->findOrFail($ruleId),
            $this->idempotencyKey('crm.automation.retire'),
        );

        return response()->json(['status' => 'retired', ...$result]);
    }

    private function requireVisitorRead(Visitor $visitor, string $operation): void
    {
        if ($visitor->origin_branch_id === null) {
            $this->requireOrganizationRead('crm.visitor', $operation, 'visitor', $visitor->id);

            return;
        }
        $this->requireBranchCapability('crm.visitor', $visitor->origin_branch_id, $operation, 'visitor', $visitor->id);
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
