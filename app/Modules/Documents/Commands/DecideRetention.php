<?php

declare(strict_types=1);

namespace App\Modules\Documents\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Documents\Domain\DocumentLifecycle;
use App\Modules\Documents\Models\Document;
use App\Modules\Documents\Models\DocumentClassification;
use App\Modules\Documents\Models\RetentionDecision;
use App\Modules\Documents\Models\RetentionRule;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * Records the retention outcome for a document under the rule of its
 * category: retain or archive, with basis and deciding actor. Deletion is
 * replaced by archive; the decision is append-only evidence.
 */
final class DecideRetention
{
    public const CAPABILITY = 'documents.retention';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{decision_id: string, action: string, correlation_id: string} */
    public function decide(Actor $decider, Document $document, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['documents.retention.decide', $document->id, $decider->actorId]));

        try {
            return $this->idempotency->execute('documents.retention.decide', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($decider, $document): array {
                    $outcome = $this->access->decide($decider, self::CAPABILITY, null);
                    if (! $outcome->allowed) {
                        throw AuthorizationDenied::forCode('documents.retention_denied', $outcome->reason);
                    }

                    /** @var Document $locked */
                    $locked = Document::query()->whereKey($document->id)->lockForUpdate()->firstOrFail();
                    /** @var DocumentClassification $classification */
                    $classification = DocumentClassification::query()->findOrFail($locked->classification_id);
                    /** @var RetentionRule|null $rule */
                    $rule = RetentionRule::query()->where('category', $classification->category)->first();
                    if ($rule === null) {
                        throw BusinessRejection::forCode('documents.retention_rule_missing', sprintf('no retention rule is defined for category %s', $classification->category));
                    }

                    $created = CarbonImmutable::parse($locked->created_at)->startOfDay();
                    $dueAt = $created->addDays((int) $rule->retention_days)->startOfDay();
                    $action = (new CarbonImmutable)->startOfDay()->greaterThanOrEqualTo($dueAt) ? 'archive' : 'retain';

                    $decision = RetentionDecision::query()->create([
                        'id' => RandomIdentifier::new(),
                        'document_id' => $locked->id,
                        'rule_id' => $rule->id,
                        'action' => $action,
                        'basis' => $rule->legal_basis,
                        'decided_by' => $decider->actorId,
                    ]);

                    if ($action === 'archive' && $locked->lifecycle_state !== 'archived') {
                        DocumentLifecycle::requireTransition($locked->lifecycle_state, 'archived');
                        $locked->forceFill(['lifecycle_state' => 'archived']);
                        $locked->save();
                    }

                    $event = $this->audit->record($decider->actorId, 'documents.retention.decide', 'retention_decision', $decision->id, null, [
                        'document_id' => $locked->id,
                        'rule_id' => $rule->id,
                        'action' => $action,
                        'basis' => $rule->legal_basis,
                    ]);

                    return ['decision_id' => $decision->id, 'action' => $action, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $decider, 'documents.retention.decide', 'document', $document->id);
        }
    }
}
