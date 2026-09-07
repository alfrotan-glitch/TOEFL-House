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
            $authorityTimed = $visitor->conversion->conversion_time_basis === 'authority_audit_event'
                && $visitor->conversion->converted_at !== null;
            $rows->push([
                'kind' => 'conversion',
                'id' => $visitor->conversion->id,
                // A CRM mirror-row created_at is not the downstream
                // conversion occurrence and must never substitute for it.
                'at' => $authorityTimed ? $visitor->conversion->converted_at?->toDateTimeString() : null,
                'time_basis' => $visitor->conversion->conversion_time_basis,
                'time_evidence_status' => $authorityTimed ? 'authority_event_recorded' : 'historic_unclassified',
                'type' => $visitor->conversion->conversion_type,
                'authority' => $visitor->conversion->authority,
                'summary' => $authorityTimed
                    ? 'Authoritative conversion trace recorded; CRM does not own the downstream record.'
                    : 'Authoritative conversion trace retained, but its historic downstream event time is unclassified.',
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
            $authorityTimed = $handoff->conversion_time_basis === 'authority_audit_event'
                && $handoff->converted_at !== null;
            $rows->push([
                'kind' => 'conversion_handoff',
                'id' => $handoff->id,
                'at' => $authorityTimed ? $handoff->converted_at?->toDateTimeString() : null,
                'time_basis' => $handoff->conversion_time_basis,
                'time_evidence_status' => $authorityTimed ? 'authority_event_recorded' : 'historic_unclassified',
                'type' => 'student',
                'authority' => 'students',
                'summary' => $authorityTimed
                    ? 'Applicant-to-Student handoff evidence recorded; CRM does not own the Student.'
                    : 'Applicant-to-Student handoff evidence retained, but its historic authority-event time is unclassified.',
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
                $databaseTimed = $audit->occurred_time_basis === 'database_insert'
                    && $audit->occurred_at !== null;
                $rows->push([
                    'kind' => 'followup_lifecycle',
                    'id' => $audit->id,
                    'at' => $databaseTimed ? $audit->occurred_at?->toDateTimeString() : null,
                    'time_basis' => $audit->occurred_time_basis,
                    'time_evidence_status' => $databaseTimed ? 'database_recorded' : 'historic_unclassified',
                    'type' => $audit->operation,
                    'status' => isset($after['status']) ? (string) $after['status'] : null,
                    'summary' => isset($after['reason'])
                        ? (string) $after['reason']
                        : ($databaseTimed ? 'Follow-up lifecycle evidence recorded.' : 'Follow-up lifecycle evidence retained, but its historic event time is unclassified.'),
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
            $databaseTimed = $audit->occurred_time_basis === 'database_insert'
                && $audit->occurred_at !== null;
            $rows->push([
                'kind' => 'lifecycle',
                'id' => $audit->id,
                'at' => $databaseTimed ? $audit->occurred_at?->toDateTimeString() : null,
                'time_basis' => $audit->occurred_time_basis,
                'time_evidence_status' => $databaseTimed ? 'database_recorded' : 'historic_unclassified',
                'type' => $audit->operation,
                'status' => isset($after['status']) ? (string) $after['status'] : null,
                'summary' => isset($after['reason']) && is_string($after['reason']) && trim($after['reason']) !== ''
                    ? $after['reason']
                    : ($databaseTimed ? 'Immutable CRM lifecycle evidence recorded.' : 'Immutable CRM lifecycle evidence retained, but its historic event time is unclassified.'),
                'agent_id' => $audit->actor_id,
                'correlation_id' => $audit->correlation_id,
            ]);
        }

        foreach (DB::table('visitor_status_history')
            ->where('visitor_id', $visitor->id)
            ->orderByDesc('changed_at')
            ->limit($limit)
            ->get() as $statusChange) {
            $databaseTimed = ($statusChange->change_time_basis ?? null) === 'database_transition'
                && ($statusChange->changed_at ?? null) !== null;
            $rows->push([
                'kind' => 'status_change',
                'id' => (string) $statusChange->id,
                'at' => $databaseTimed ? (string) $statusChange->changed_at : null,
                'time_basis' => $statusChange->change_time_basis ?? null,
                'time_evidence_status' => $databaseTimed ? 'database_transition' : 'historic_unclassified',
                'type' => 'crm.visitor.status_history',
                'status' => (string) $statusChange->to_status,
                'summary' => $databaseTimed
                    ? sprintf('Lifecycle changed from %s to %s.', $statusChange->from_status ?? 'none', $statusChange->to_status)
                    : sprintf('Lifecycle changed from %s to %s; historic transition time is unclassified.', $statusChange->from_status ?? 'none', $statusChange->to_status),
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
