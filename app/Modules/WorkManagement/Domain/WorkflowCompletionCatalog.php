<?php

declare(strict_types=1);

namespace App\Modules\WorkManagement\Domain;

use App\Modules\Outbox\Models\DomainEvent;

/**
 * Explicit source-to-coordination completion adapters. These rules only
 * advance rebuildable Work Management state after the owning domain has
 * already committed a terminal or decision-completing transition; they
 * never mutate the source aggregate or replace its command authority.
 */
final class WorkflowCompletionCatalog
{
    /** @var array<string, array{source_type: string, action_key: string, event_types: list<string>, terminal_states: list<string>}> */
    private const RULES = [
        'admissions.decision_review' => [
            'source_type' => 'admission_decision',
            'action_key' => 'admissions.decision.review',
            'event_types' => ['admissions.review'],
            'terminal_states' => ['reviewed'],
        ],
        'admissions.decision_approval' => [
            'source_type' => 'admission_decision',
            'action_key' => 'admissions.decision.approve',
            'event_types' => ['admissions.approve'],
            'terminal_states' => ['final'],
        ],
        'academic.appeal_review' => [
            'source_type' => 'academic_appeal',
            'action_key' => 'academic.appeal.review',
            'event_types' => ['academic.appeal.resolve', 'academic.appeal.reject', 'academic.appeal.close'],
            'terminal_states' => ['resolved', 'rejected', 'closed'],
        ],
        'finance.correction_approval' => [
            'source_type' => 'financial_correction',
            'action_key' => 'finance.correction.approve',
            'event_types' => ['finance.correction.approve'],
            'terminal_states' => ['recorded'],
        ],
        'payroll.held_exception' => [
            'source_type' => 'payroll_calculation',
            'action_key' => 'payroll.calculation.resolve',
            'event_types' => ['payroll.calculation.resolve_held'],
            'terminal_states' => ['superseded'],
        ],
    ];

    public static function isCandidate(DomainEvent $event): bool
    {
        $sourceType = trim((string) $event->aggregate_type);
        $eventType = trim((string) $event->event_type);

        foreach (self::RULES as $rule) {
            if ($rule['source_type'] === $sourceType && in_array($eventType, $rule['event_types'], true)) {
                return true;
            }
        }

        return false;
    }

    /** @return array{source_type: string, action_key: string, event_types: list<string>, terminal_states: list<string>}|null */
    public static function ruleFor(DomainEvent $event): ?array
    {
        $sourceType = trim((string) $event->aggregate_type);
        $eventType = trim((string) $event->event_type);
        $after = $event->payload['after'] ?? null;
        $state = is_array($after) ? trim((string) ($after['lifecycle_state'] ?? $after['status'] ?? '')) : '';

        foreach (self::RULES as $rule) {
            if ($rule['source_type'] === $sourceType
                && in_array($eventType, $rule['event_types'], true)
                && in_array($state, $rule['terminal_states'], true)) {
                return $rule;
            }
        }

        return null;
    }

    /** @return list<array{definition_key: string, source_type: string, action_key: string, event_types: list<string>, terminal_states: list<string>}> */
    public static function rules(): array
    {
        return array_map(
            static fn (string $definitionKey, array $rule): array => ['definition_key' => $definitionKey, ...$rule],
            array_keys(self::RULES),
            array_values(self::RULES),
        );
    }
}
