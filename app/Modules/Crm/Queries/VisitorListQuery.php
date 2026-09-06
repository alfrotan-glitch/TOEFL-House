<?php

declare(strict_types=1);

namespace App\Modules\Crm\Queries;

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
        $query = Visitor::query()->with(['source:id,key,name,lifecycle_state', 'campaign:id,key,name,channel,lifecycle_state', 'assignee:id,legal_name', 'conversion:id,visitor_id,conversion_type,converted_at']);

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
        if (isset($filters['branch_id']) && $filters['branch_id'] !== '') {
            $query->where('origin_branch_id', $filters['branch_id']);
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
            ->orderByDesc('created_at')
            ->limit(max(1, min($limit, 500)))
            ->get();

        return $visitors
            ->map(fn (Visitor $visitor): array => $this->present($visitor))
            ->all();
    }

    /** @return array<string, mixed> */
    public function detail(Visitor $visitor): array
    {
        $visitor->loadMissing(['source', 'campaign', 'assignee', 'originBranch:id,name', 'conversion']);

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
            'rating' => $visitor->rating,
            'interest' => $visitor->interest,
            'notes' => $visitor->notes,
            'assigned_to' => $visitor->assigned_to,
            'assignee_name' => $visitor->relationLoaded('assignee') && $visitor->assignee !== null ? $visitor->assignee->legal_name : null,
            'origin_branch_id' => $visitor->origin_branch_id,
            'source' => $visitor->relationLoaded('source') && $visitor->source !== null ? [
                'id' => $visitor->source->id, 'key' => $visitor->source->key, 'name' => $visitor->source->name, 'lifecycle_state' => $visitor->source->lifecycle_state,
            ] : null,
            'campaign' => $visitor->relationLoaded('campaign') && $visitor->campaign !== null ? [
                'id' => $visitor->campaign->id, 'key' => $visitor->campaign->key, 'name' => $visitor->campaign->name, 'channel' => $visitor->campaign->channel, 'lifecycle_state' => $visitor->campaign->lifecycle_state,
            ] : null,
            'conversion' => $visitor->relationLoaded('conversion') && $visitor->conversion !== null ? [
                'id' => $visitor->conversion->id, 'conversion_type' => $visitor->conversion->conversion_type, 'converted_at' => $visitor->conversion->converted_at,
            ] : null,
            'created_at' => $visitor->created_at?->toISOString(),
            'updated_at' => $visitor->updated_at?->toISOString(),
        ];
    }
}
