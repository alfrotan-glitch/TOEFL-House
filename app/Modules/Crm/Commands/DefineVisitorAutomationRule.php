<?php

declare(strict_types=1);

namespace App\Modules\Crm\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Crm\Domain\CrmAccess;
use App\Modules\Crm\Models\VisitorAutomationRule;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Define CRM automation. Rules are deterministic and require an admin-level
 * capability, not ordinary CRM staff. A rule can be activated or deactivated
 * independently; changing a rule's behavior requires a new key so executions
 * remain attributable to a specific definition.
 */
final class DefineVisitorAutomationRule
{
    public const CAPABILITY = 'crm.automation';

    public function __construct(
        private readonly CrmAccess $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /**
     * @param  array<string, mixed>  $actionConfig
     * @return array{rule_id: string, is_active: bool, correlation_id: string}
     */
    public function define(
        Actor $actor,
        string $key,
        string $name,
        string $triggerType,
        string $triggerValue,
        string $actionType,
        array $actionConfig,
        bool $isActive,
        string $idempotencyKey,
    ): array {
        $payload = hash('sha256', implode('|', [
            'crm.automation.define', strtolower(trim($key)), trim($name), $triggerType, $triggerValue,
            $actionType, json_encode($actionConfig), (string) $isActive, $actor->actorId,
        ]));

        try {
            return $this->idempotency->execute('crm.automation.define', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($actor, $key, $name, $triggerType, $triggerValue, $actionType, $actionConfig, $isActive): array {
                    $this->access->require($actor, self::CAPABILITY, null, 'crm.automation_denied');
                    $normalizedKey = strtolower(trim($key));
                    if ($normalizedKey === '' || trim($name) === '') {
                        throw BusinessRejection::forCode('crm.automation_required', 'an automation rule requires a key and a name');
                    }
                    if ($triggerType !== 'interaction_outcome') {
                        throw BusinessRejection::forCode('crm.automation_trigger', 'only interaction_outcome triggers are supported');
                    }
                    if (in_array($triggerValue, ['no_answer', 'connected', 'positive', 'neutral', 'negative', 'unreachable', 'requested_info', 'scheduled_visit', 'followup_required', 'not_interested', 'qualified', 'converted', 'other'], true) === false) {
                        throw BusinessRejection::forCode('crm.automation_value', 'unknown interaction outcome in rule');
                    }
                    if ($actionType !== 'schedule_followup') {
                        throw BusinessRejection::forCode('crm.automation_action', 'only schedule_followup actions are supported');
                    }
                    if (! isset($actionConfig['assignee'], $actionConfig['title'], $actionConfig['due_in_days'])
                        || ! is_string($actionConfig['assignee']) || $actionConfig['assignee'] === ''
                        || ! is_string($actionConfig['title']) || $actionConfig['title'] === ''
                        || ! (is_int($actionConfig['due_in_days']) || ctype_digit((string) $actionConfig['due_in_days']))
                        || (int) $actionConfig['due_in_days'] < 0) {
                        throw BusinessRejection::forCode('crm.automation_config', 'action_config requires valid assignee, title and due_in_days');
                    }
                    if (VisitorAutomationRule::query()->where('key', $normalizedKey)->exists()) {
                        throw BusinessRejection::forCode('crm.automation_key_exists', 'an automation rule with this key already exists');
                    }
                    if (! DB::table('people')->where('id', (string) $actionConfig['assignee'])->exists()) {
                        throw BusinessRejection::forCode('crm.assignee_unknown', 'the rule assignee does not exist');
                    }
                    if (VisitorAutomationRule::query()->where('is_active', true)
                        ->where('trigger_type', $triggerType)->where('trigger_value', $triggerValue)
                        ->where('action_type', $actionType)->exists()) {
                        throw BusinessRejection::forCode('crm.automation_collision', 'an active rule already handles this outcome');
                    }

                    $rule = VisitorAutomationRule::query()->create([
                        'id' => RandomIdentifier::new(),
                        'key' => $normalizedKey,
                        'name' => trim($name),
                        'trigger_type' => $triggerType,
                        'trigger_value' => $triggerValue,
                        'action_type' => $actionType,
                        'action_config' => $actionConfig,
                        'is_active' => $isActive,
                        'created_by' => $actor->actorId,
                    ]);
                    $event = $this->audit->record($actor->actorId, 'crm.automation.define', 'visitor_automation_rule', $rule->id, null, [
                        'key' => $normalizedKey, 'name' => $rule->name, 'trigger_value' => $triggerValue,
                        'action_type' => $actionType, 'is_active' => $isActive,
                    ]);

                    return ['rule_id' => $rule->id, 'is_active' => $rule->is_active, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $actor, 'crm.automation.define', 'visitor_automation_rule', $key);
        }
    }
}
