<?php

declare(strict_types=1);

namespace App\Modules\Outbox\Domain;

use App\Modules\Audit\Models\AuditEvent;

/**
 * Stable event-envelope context. Missing operational provenance is explicit
 * `unknown`; it is never interpreted as organization-wide visibility.
 *
 * Producers must declare `branch_id` only for a single-branch fact. A
 * multi-branch fact may declare `organization_id` when every participating
 * branch belongs to that one active organization; otherwise it remains
 * unknown. The envelope never chooses the first branch from a relationship.
 * An explicit null/empty base declaration also blocks an intent from
 * widening or repairing provenance after the audited change was recorded.
 */
final class DomainEventContext
{
    /** @param array<string, mixed> $payload @return array<string, string|null> */
    public static function from(AuditEvent $auditEvent, array $payload): array
    {
        $baseFields = [];
        $intentFields = [];
        foreach (['before', 'after'] as $part) {
            if (! is_array($payload[$part] ?? null)) {
                continue;
            }
            // The audited change is authoritative. `after` intentionally
            // overlays `before` for lifecycle/provenance transitions.
            $baseFields = array_merge($baseFields, $payload[$part]);
            foreach (['workflow', 'notification'] as $intentKey) {
                if (is_array($payload[$part][$intentKey] ?? null)) {
                    $intentFields = array_merge($intentFields, $payload[$part][$intentKey]);
                }
            }
        }
        foreach (['workflow', 'notification'] as $intentKey) {
            if (is_array($payload[$intentKey] ?? null)) {
                $intentFields = array_merge($intentFields, $payload[$intentKey]);
            }
        }

        $provenanceKeys = ['branch_id', 'originating_branch_id', 'current_home_branch_id', 'origin_branch_id'];
        $organizationDeclared = array_key_exists('organization_id', $baseFields);
        $branchDeclared = self::hasAny($baseFields, $provenanceKeys);
        $branchId = self::first($baseFields, $provenanceKeys);
        $organizationId = self::first($baseFields, ['organization_id']);
        // Once any audited provenance field is explicitly declared, intent
        // metadata cannot fill in a missing sibling field. This prevents an
        // intent from converting a partially scoped audited change into a
        // broader or differently scoped event envelope.
        if (! $branchDeclared && ! $organizationDeclared) {
            $branchId = self::first($intentFields, $provenanceKeys);
            $organizationId = self::first($intentFields, ['organization_id']);
        }

        $hasProvenance = $branchId !== null || $organizationId !== null;

        return [
            'scope_type' => $branchId !== null ? 'branch' : ($organizationId !== null ? 'organization' : 'unknown'),
            'scope_provenance' => $hasProvenance ? 'declared_on_audited_change' : 'not_available',
            'organization_id' => $organizationId,
            'branch_id' => $branchId,
            'actor_id' => $auditEvent->actor_id,
            'target_type' => $auditEvent->target_type,
            'target_id' => $auditEvent->target_id,
        ];
    }

    /** @param array<string, mixed> $fields @param list<string> $keys */
    private static function first(array $fields, array $keys): ?string
    {
        foreach ($keys as $key) {
            $value = trim((string) ($fields[$key] ?? ''));
            if ($value !== '') {
                return $value;
            }
        }

        return null;
    }

    /** @param array<string, mixed> $fields @param list<string> $keys */
    private static function hasAny(array $fields, array $keys): bool
    {
        foreach ($keys as $key) {
            if (array_key_exists($key, $fields)) {
                return true;
            }
        }

        return false;
    }
}
