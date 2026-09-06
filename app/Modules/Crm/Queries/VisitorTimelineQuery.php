<?php

declare(strict_types=1);

namespace App\Modules\Crm\Queries;

use App\Modules\Audit\Models\AuditEvent;
use App\Modules\Crm\Models\Visitor;
use App\Modules\Crm\Models\VisitorConversionHandoff;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\DB;

/**
 * Read model of a visitor's immutable timeline: interactions and follow-ups
 * unified chronologically. Evidence-first, never rewritten, always attributable.
 */
final class VisitorTimelineQuery
{
    /** @return list<array<string, mixed>> */
    public function for(Visitor $visitor, int $limit = 100): array
    {
        $limit = max(1, min($limit, 500));
        $visitor->loadMissing(['conversion']);
        $interactions = $visitor->interactions()->limit($limit)->get();
        $followups = $visitor->followups()->limit($limit)->get();

        /** @var Collection<int, array<string, mixed>> $rows */
        $rows = collect();

        if ($visitor->conversion !== null) {
            $rows->push([
                'kind' => 'conversion',
                'id' => $visitor->conversion->id,
                'at' => $visitor->conversion->converted_at?->toDateTimeString() ?? $visitor->conversion->created_at?->toDateTimeString() ?? '',
                'type' => $visitor->conversion->conversion_type,
                'authority' => $visitor->conversion->authority,
                'summary' => 'Authoritative conversion trace recorded; CRM does not own the downstream record.',
                'converted_by' => $visitor->conversion->converted_by,
                'authority_audit_event_id' => $visitor->conversion->authority_audit_event_id,
                'correlation_id' => $visitor->conversion->correlation_id,
            ]);
        }

        foreach (VisitorConversionHandoff::query()
            ->where('visitor_id', $visitor->id)
            ->orderByDesc('converted_at')
            ->limit($limit)
            ->get() as $handoff) {
            $rows->push([
                'kind' => 'conversion_handoff',
                'id' => $handoff->id,
                'at' => (string) $handoff->converted_at,
                'type' => 'student',
                'authority' => 'students',
                'summary' => 'Applicant-to-Student handoff evidence recorded; CRM does not own the Student.',
                'student_id' => $handoff->student_id,
                'authority_audit_event_id' => $handoff->authority_audit_event_id,
                'correlation_id' => $handoff->correlation_id,
            ]);
        }

        foreach ($interactions as $interaction) {
            $rows->push([
                'kind' => 'interaction',
                'id' => $interaction->id,
                'at' => $interaction->occurred_at ?? $interaction->occurred_on.' 00:00:00',
                'direction' => $interaction->direction,
                'type' => $interaction->type,
                'outcome' => $interaction->outcome,
                'summary' => $interaction->summary,
                'agent_id' => $interaction->agent_id,
                'trace_origin' => $interaction->trace_origin,
                'authority_audit_event_id' => $interaction->authority_audit_event_id,
                'message_id' => $interaction->message_id,
                'document_id' => $interaction->document_id,
                'assessment_attempt_id' => $interaction->assessment_attempt_id,
                'payment_id' => $interaction->payment_id,
                'placement_attempt_id' => $interaction->placement_attempt_id,
                'correlation_id' => $interaction->correlation_id,
            ]);
        }

        foreach ($followups as $followup) {
            $rows->push([
                'kind' => 'followup',
                'id' => $followup->id,
                'at' => $followup->created_at->toDateTimeString(),
                'scheduled_for' => $followup->scheduled_for,
                'title' => $followup->title,
                'status' => $followup->status,
                'assigned_to' => $followup->assigned_to,
                'completed_by' => $followup->completed_by,
                'completed_at' => $followup->completed_at,
                'correlation_id' => $followup->correlation_id,
            ]);
        }

        $followupIds = $followups->pluck('id')->all();
        if ($followupIds !== []) {
            foreach (AuditEvent::query()
                ->where('target_type', 'visitor_followup')
                ->whereIn('target_id', $followupIds)
                ->where('operation', 'crm.followup.transition')
                ->orderByDesc('occurred_at')
                ->limit($limit)
                ->get() as $audit) {
                $after = is_array($audit->after_state) ? $audit->after_state : [];
                $rows->push([
                    'kind' => 'followup_lifecycle',
                    'id' => $audit->id,
                    'at' => (string) $audit->occurred_at,
                    'type' => $audit->operation,
                    'status' => isset($after['status']) ? (string) $after['status'] : null,
                    'summary' => isset($after['reason']) ? (string) $after['reason'] : 'Follow-up lifecycle evidence recorded.',
                    'agent_id' => $audit->actor_id,
                    'correlation_id' => $audit->correlation_id,
                ]);
            }
        }

        foreach (AuditEvent::query()
            ->where('target_type', 'visitor')
            ->where('target_id', $visitor->id)
            ->whereIn('operation', ['crm.visitor.capture', 'crm.visitor.transition', 'crm.visitor.update', 'crm.visitor.link_person'])
            ->orderByDesc('occurred_at')
            ->limit($limit)
            ->get() as $audit) {
            $after = is_array($audit->after_state) ? $audit->after_state : [];
            $rows->push([
                'kind' => 'lifecycle',
                'id' => $audit->id,
                'at' => (string) $audit->occurred_at,
                'type' => $audit->operation,
                'status' => isset($after['status']) ? (string) $after['status'] : null,
                'summary' => isset($after['reason']) && is_string($after['reason']) && trim($after['reason']) !== ''
                    ? $after['reason']
                    : 'Immutable CRM lifecycle evidence recorded.',
                'agent_id' => $audit->actor_id,
                'correlation_id' => $audit->correlation_id,
            ]);
        }

        foreach (DB::table('visitor_status_history')
            ->where('visitor_id', $visitor->id)
            ->orderByDesc('changed_at')
            ->limit($limit)
            ->get() as $statusChange) {
            $rows->push([
                'kind' => 'status_change',
                'id' => (string) $statusChange->id,
                'at' => (string) $statusChange->changed_at,
                'type' => 'crm.visitor.status_history',
                'status' => (string) $statusChange->to_status,
                'summary' => sprintf('Lifecycle changed from %s to %s.', $statusChange->from_status ?? 'none', $statusChange->to_status),
                'agent_id' => (string) $statusChange->changed_by,
                'correlation_id' => (string) $statusChange->correlation_id,
            ]);
        }

        return array_values($rows
            ->sortByDesc('at')
            ->take(max(1, min($limit, 500)))
            ->values()
            ->all());
    }
}
