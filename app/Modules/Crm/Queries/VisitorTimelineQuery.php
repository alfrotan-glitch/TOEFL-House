<?php

declare(strict_types=1);

namespace App\Modules\Crm\Queries;

use App\Modules\Crm\Models\Visitor;
use Illuminate\Support\Collection;

/**
 * Read model of a visitor's immutable timeline: interactions and follow-ups
 * unified chronologically. Evidence-first, never rewritten, always attributable.
 */
final class VisitorTimelineQuery
{
    /** @return list<array<string, mixed>> */
    public function for(Visitor $visitor, int $limit = 100): array
    {
        $visitor->loadMissing(['interactions', 'followups']);

        /** @var Collection<int, array<string, mixed>> $rows */
        $rows = collect();

        foreach ($visitor->interactions as $interaction) {
            $rows->push([
                'kind' => 'interaction',
                'id' => $interaction->id,
                'at' => $interaction->occurred_at ?? $interaction->occurred_on.' 00:00:00',
                'direction' => $interaction->direction,
                'type' => $interaction->type,
                'outcome' => $interaction->outcome,
                'summary' => $interaction->summary,
                'agent_id' => $interaction->agent_id,
                'correlation_id' => $interaction->correlation_id,
            ]);
        }

        foreach ($visitor->followups as $followup) {
            $rows->push([
                'kind' => 'followup',
                'id' => $followup->id,
                'at' => $followup->created_at->toDateTimeString(),
                'scheduled_for' => $followup->scheduled_for,
                'title' => $followup->title,
                'status' => $followup->status,
                'assigned_to' => $followup->assigned_to,
                'correlation_id' => $followup->correlation_id,
            ]);
        }

        return $rows
            ->sortByDesc('at')
            ->take(max(1, min($limit, 500)))
            ->values()
            ->all();
    }
}
