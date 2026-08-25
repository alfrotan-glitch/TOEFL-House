<?php

declare(strict_types=1);

namespace App\Modules\Documents\Commands;

use App\Modules\Audit\AttemptedOperation;
use App\Modules\Audit\AuditRecorder;
use App\Modules\Documents\Models\DocumentClassification;
use App\Modules\Documents\Models\RetentionRule;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Idempotency\IdempotentExecution;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;

/**
 * Defines the sensitivity registry: classifications with owner module and
 * access class, and retention rules per category with legal basis.
 */
final class DefineDocumentClassification
{
    public const CAPABILITY = 'documents.classify';

    public function __construct(
        private readonly AccessDecision $access,
        private readonly IdempotentExecution $idempotency,
        private readonly AuditRecorder $audit,
        private readonly AttemptedOperation $attemptedOperation,
    ) {}

    /** @return array{classification_id: string, correlation_id: string} */
    public function defineClassification(Actor $definer, string $category, string $ownerModule, string $accessClass, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['documents.classification.define', $category, $ownerModule, $accessClass, $definer->actorId]));

        try {
            return $this->idempotency->execute('documents.classification.define', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($definer, $category, $ownerModule, $accessClass): array {
                    $this->requireDefiner($definer);

                    /** @var DocumentClassification $classification */
                    $classification = DocumentClassification::query()->create([
                        'id' => RandomIdentifier::new(),
                        'category' => $category,
                        'owner_module' => $ownerModule,
                        'access_class' => $accessClass,
                    ]);

                    $event = $this->audit->record($definer->actorId, 'documents.classification.define', 'document_classification', $classification->id, null, [
                        'category' => $category, 'owner_module' => $ownerModule, 'access_class' => $accessClass,
                    ]);

                    return ['classification_id' => $classification->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $definer, 'documents.classification.define', 'document_classification', $category);
        }
    }

    /** @return array{rule_id: string, correlation_id: string} */
    public function defineRetentionRule(Actor $definer, string $category, int $retentionDays, string $legalBasis, ?string $operationalBasis, string $idempotencyKey): array
    {
        $payload = hash('sha256', implode('|', ['documents.retention_rule.define', $category, $retentionDays, $legalBasis, $operationalBasis ?? '', $definer->actorId]));

        try {
            return $this->idempotency->execute('documents.retention_rule.define', $idempotencyKey, $payload,
                fn (): array => DB::transaction(function () use ($definer, $category, $retentionDays, $legalBasis, $operationalBasis): array {
                    $this->requireDefiner($definer);
                    if ($retentionDays <= 0) {
                        throw BusinessRejection::forCode('documents.retention_period_invalid', 'retention period must be positive');
                    }

                    /** @var RetentionRule $rule */
                    $rule = RetentionRule::query()->create([
                        'id' => RandomIdentifier::new(),
                        'category' => $category,
                        'retention_days' => $retentionDays,
                        'legal_basis' => $legalBasis,
                        'operational_basis' => $operationalBasis,
                    ]);

                    $event = $this->audit->record($definer->actorId, 'documents.retention_rule.define', 'retention_rule', $rule->id, null, [
                        'category' => $category, 'retention_days' => $retentionDays, 'legal_basis' => $legalBasis,
                    ]);

                    return ['rule_id' => $rule->id, 'correlation_id' => $event->correlation_id];
                }),
            );
        } catch (AuthorizationDenied $denial) {
            $this->attemptedOperation->deniedByActor($denial, $definer, 'documents.retention_rule.define', 'retention_rule', $category);
        }
    }

    private function requireDefiner(Actor $definer): void
    {
        $outcome = $this->access->decide($definer, self::CAPABILITY, null);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode('documents.classify_denied', $outcome->reason);
        }
    }
}
