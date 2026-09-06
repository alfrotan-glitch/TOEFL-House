<?php

declare(strict_types=1);

namespace App\Modules\Crm\Models;

use App\Modules\Academic\Models\AssessmentAttempt;
use App\Modules\Academic\Placement\Models\PlacementAttempt;
use App\Modules\Audit\Models\AuditEvent;
use App\Modules\Communication\Models\Message;
use App\Modules\Documents\Models\Document;
use App\Modules\Crm\Domain\VisitorInteractionCatalog;
use App\Modules\Finance\Models\Payment;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * One contact/attempt/engagement fact in the visitor timeline. Immutable
 * evidence: a correction is a new interaction, never a rewrite.
 *
 * @property string $id
 * @property string $visitor_id
 * @property string $direction
 * @property string $type
 * @property string $outcome
 * @property string $summary
 * @property string $occurred_on
 * @property string|null $occurred_at
 * @property string $agent_id
 * @property string $trace_origin
 * @property string|null $authority_audit_event_id
 * @property string|null $message_id
 * @property string|null $document_id
 * @property string|null $assessment_attempt_id
 * @property string|null $payment_id
 * @property string|null $placement_attempt_id
 * @property string $correlation_id
 */
final class VisitorInteraction extends Model
{
    public $incrementing = false;

    protected $keyType = 'string';

    protected $fillable = [
        'id', 'visitor_id', 'direction', 'type', 'outcome', 'summary', 'occurred_on',
        'occurred_at', 'agent_id', 'trace_origin', 'authority_audit_event_id', 'message_id', 'document_id', 'assessment_attempt_id', 'payment_id', 'placement_attempt_id', 'correlation_id',
    ];

    /** @return BelongsTo<AuditEvent, $this> */
    public function authorityEvent(): BelongsTo
    {
        return $this->belongsTo(AuditEvent::class, 'authority_audit_event_id');
    }

    /** @return list<string> */
    public static function directions(): array
    {
        return VisitorInteractionCatalog::directions();
    }

    /** @return list<string> */
    public static function types(): array
    {
        return VisitorInteractionCatalog::types();
    }

    /** @return list<string> */
    public static function outcomes(): array
    {
        return VisitorInteractionCatalog::outcomes();
    }

    /** @return BelongsTo<Visitor, $this> */
    public function visitor(): BelongsTo
    {
        return $this->belongsTo(Visitor::class);
    }

    /** @return BelongsTo<Message, $this> */
    public function message(): BelongsTo
    {
        return $this->belongsTo(Message::class);
    }

    /** @return BelongsTo<Document, $this> */
    public function document(): BelongsTo
    {
        return $this->belongsTo(Document::class);
    }

    /** @return BelongsTo<AssessmentAttempt, $this> */
    public function assessmentAttempt(): BelongsTo
    {
        return $this->belongsTo(AssessmentAttempt::class);
    }

    /** @return BelongsTo<Payment, $this> */
    public function payment(): BelongsTo
    {
        return $this->belongsTo(Payment::class);
    }

    /** @return BelongsTo<PlacementAttempt, $this> */
    public function placementAttempt(): BelongsTo
    {
        return $this->belongsTo(PlacementAttempt::class);
    }
}
