<?php

declare(strict_types=1);

namespace App\Modules\Crm\Queries;

use App\Modules\Crm\Domain\VisitorStatus;
use App\Modules\Crm\Models\Visitor;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Database\Eloquent\Collection;

/**
 * Read model for the visitor pipeline. Filters are pure read-model concerns;
 * authorization is enforced by the controller/command boundary around it.
 */
final class VisitorListQuery
{
    /**
     * @param  list<string>|null  $statuses
     * @param  array<string, mixed>  $filters
     * @return list<array<string, mixed>>
     */
    public function search(?array $statuses, array $filters, int $limit = 100): array
    {
        $query = Visitor::query()->with([
            'source:id,key,name,lifecycle_state',
            'campaign:id,key,name,channel,lifecycle_state',
            'assignee:id,legal_name',
            'originBranch:id,name',
            'conversion:id,visitor_id,conversion_type,authority,converted_by,authority_audit_event_id,converted_at,conversion_time_basis',
            'conversionHandoffs:id,visitor_id,student_id,authority_audit_event_id,converted_at,conversion_time_basis',
        ]);

        if ($statuses !== null && $statuses !== []) {
            $query->whereIn('status', $statuses);
        }
        if (isset($filters['person_id']) && $filters['person_id'] !== '') {
            $query->where('person_id', $filters['person_id']);
        }
        if (isset($filters['source_id']) && $filters['source_id'] !== '') {
            $query->where('source_id', $filters['source_id']);
        }
        if (isset($filters['campaign_id']) && $filters['campaign_id'] !== '') {
            $query->where('campaign_id', $filters['campaign_id']);
        }
        // Null provenance is intentionally never a wildcard. The caller must
        // provide a concrete authorized branch set; an explicit organization
        // read may opt into the reportable unassigned queue, and an explicit
        // branch filter always narrows the result rather than being ignored.
        if (isset($filters['branch_id']) && $filters['branch_id'] !== '') {
            $query->where('origin_branch_id', $filters['branch_id']);
        } elseif (isset($filters['branch_ids']) && is_array($filters['branch_ids'])) {
            if (($filters['include_unassigned'] ?? false) === true) {
                $query->where(fn (Builder $q): Builder => $q
                    ->whereIn('origin_branch_id', $filters['branch_ids'])
                    ->orWhereNull('origin_branch_id'));
            } else {
                $query->whereIn('origin_branch_id', $filters['branch_ids']);
            }
        } else {
            $query->whereNotNull('origin_branch_id');
        }
        if (isset($filters['assigned_to']) && $filters['assigned_to'] !== '') {
            $query->where('assigned_to', $filters['assigned_to']);
        }
        if (isset($filters['rating']) && $filters['rating'] !== '') {
            $query->where('rating', $filters['rating']);
        }
        if (isset($filters['visitor_type']) && $filters['visitor_type'] !== '') {
            $query->where('visitor_type', $filters['visitor_type']);
        }
        $query = $this->applySearchTerm($query, $filters['term'] ?? null);

        /** @var Collection<int, Visitor> $visitors */
        $visitors = $query
            // New rows use the database capture clock. `created_at` is only a
            // deterministic secondary ordering for retained legacy records.
            ->orderByDesc('captured_at')
            ->orderByDesc('created_at')
            ->limit(max(1, min($limit, 500)))
            ->get();

        return array_values($visitors
            ->map(fn (Visitor $visitor): array => $this->present($visitor))
            ->all());
    }

    /** @return array<string, mixed> */
    public function detail(Visitor $visitor): array
    {
        $visitor->loadMissing(['source', 'campaign', 'assignee', 'originBranch:id,name', 'conversion', 'conversionHandoffs']);

        return $this->present($visitor);
    }

    /**
     * @param  Builder<Visitor>  $query
     * @return Builder<Visitor>
     */
    private function applySearchTerm(Builder $query, mixed $term): Builder
    {
        if (! is_string($term) || trim($term) === '') {
            return $query;
        }
        $needle = '%'.addcslashes(trim($term), '%_\\').'%';

        return $query->where(fn (Builder $q): Builder => $q
            ->where('full_name', 'like', $needle)
            ->orWhere('visitor_code', 'like', $needle)
            ->orWhere('email', 'like', $needle)
            ->orWhere('phone', 'like', $needle)
            ->orWhere('interest', 'like', $needle));
    }

    /** @return array<string, mixed> */
    private function present(Visitor $visitor): array
    {
        return [
            'id' => $visitor->id,
            'visitor_code' => $visitor->visitor_code,
            'person_id' => $visitor->person_id,
            'full_name' => $visitor->full_name,
            'phone' => $visitor->phone,
            'email' => $visitor->email,
            'preferred_channel' => $visitor->preferred_channel,
            'visitor_type' => $visitor->visitor_type,
            'status' => $visitor->status,
            // `created_at` remains row metadata. Only captured_at with its
            // database basis is a capture-event clock for CRM reporting.
            'captured_at' => $visitor->capture_time_basis === 'database_insert'
                ? $visitor->captured_at?->toISOString()
                : null,
            'capture_time_basis' => $visitor->capture_time_basis,
            'capture_evidence_status' => $visitor->capture_time_basis === 'database_insert'
                ? 'database_recorded'
                : 'historic_unclassified',
            'available_transitions' => VisitorStatus::nextPipelineStatuses($visitor->status),
            'rating' => $visitor->rating,
            'interest' => $visitor->interest,
            'notes' => $visitor->notes,
            'assigned_to' => $visitor->assigned_to,
            'assignee_name' => $visitor->relationLoaded('assignee') && $visitor->assignee !== null ? $visitor->assignee->legal_name : null,
            'origin_branch_id' => $visitor->origin_branch_id,
            'origin_branch' => $visitor->relationLoaded('originBranch') && $visitor->originBranch !== null ? [
                'id' => $visitor->originBranch->id, 'name' => $visitor->originBranch->name,
            ] : null,
            'source' => $visitor->relationLoaded('source') && $visitor->source !== null ? [
                'id' => $visitor->source->id, 'key' => $visitor->source->key, 'name' => $visitor->source->name, 'lifecycle_state' => $visitor->source->lifecycle_state,
            ] : null,
            'campaign' => $visitor->relationLoaded('campaign') && $visitor->campaign !== null ? [
                'id' => $visitor->campaign->id, 'key' => $visitor->campaign->key, 'name' => $visitor->campaign->name, 'channel' => $visitor->campaign->channel, 'lifecycle_state' => $visitor->campaign->lifecycle_state,
            ] : null,
            'conversion' => $visitor->relationLoaded('conversion') && $visitor->conversion !== null ? [
                'id' => $visitor->conversion->id,
                'conversion_type' => $visitor->conversion->conversion_type,
                'authority' => $visitor->conversion->authority,
                'converted_by' => $visitor->conversion->converted_by,
                'authority_audit_event_id' => $visitor->conversion->authority_audit_event_id,
                'converted_at' => $visitor->conversion->conversion_time_basis === 'authority_audit_event'
                    ? $visitor->conversion->converted_at?->toISOString()
                    : null,
                'conversion_time_basis' => $visitor->conversion->conversion_time_basis,
                'conversion_evidence_status' => $visitor->conversion->conversion_time_basis === 'authority_audit_event'
                    ? 'authority_event_recorded'
                    : 'historic_unclassified',
            ] : null,
            'conversion_handoffs' => $visitor->relationLoaded('conversionHandoffs')
                ? $visitor->conversionHandoffs->map(fn ($handoff): array => [
                    'id' => $handoff->id,
                    'student_id' => $handoff->student_id,
                    'authority_audit_event_id' => $handoff->authority_audit_event_id,
                    'converted_at' => $handoff->conversion_time_basis === 'authority_audit_event'
                        ? $handoff->converted_at?->toISOString()
                        : null,
                    'conversion_time_basis' => $handoff->conversion_time_basis,
                    'conversion_evidence_status' => $handoff->conversion_time_basis === 'authority_audit_event'
                        ? 'authority_event_recorded'
                        : 'historic_unclassified',
                ])->values()->all()
                : [],
            'created_at' => $visitor->created_at?->toISOString(),
            'updated_at' => $visitor->updated_at?->toISOString(),
        ];
    }
}
