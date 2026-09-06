<?php

declare(strict_types=1);

namespace App\Support\Authorization;

use App\Support\Errors\AuthorizationDenied;

/**
 * Authority chain of a structure decision: initiator (General Manager),
 * reviewer (affected manager), and two distinct Owners approving. A single
 * actor may never hold two roles of the same decision.
 */
final class StructureDecision
{
    public const CAPABILITY_INITIATE = 'organization.structure.initiate';

    public const CAPABILITY_REVIEW = 'organization.structure.review';

    public const CAPABILITY_APPROVE = 'organization.structure.approve';

    /** @param list<Actor> $owners */
    public function __construct(
        public readonly Actor $initiator,
        public readonly Actor $reviewer,
        public readonly array $owners,
    ) {}

    public function authorize(AccessDecision $accessDecision, ?StructureScope $scope): void
    {
        self::requireCapability($accessDecision, $this->initiator, self::CAPABILITY_INITIATE, $scope, 'organization.structure.initiator_denied');

        if ($this->reviewer->actorId === $this->initiator->actorId) {
            throw AuthorizationDenied::forCode('organization.structure.single_actor', 'reviewer must differ from initiator');
        }
        self::requireCapability($accessDecision, $this->reviewer, self::CAPABILITY_REVIEW, $scope, 'organization.structure.reviewer_denied');

        if (count($this->owners) < 2) {
            throw AuthorizationDenied::forCode('organization.structure.owner_count', 'two owner approvals required');
        }
        $seenOwnerIds = [$this->initiator->actorId, $this->reviewer->actorId];
        $approvedBy = [];
        foreach ($this->owners as $owner) {
            if (in_array($owner->actorId, $seenOwnerIds, true)) {
                throw AuthorizationDenied::forCode('organization.structure.single_actor', 'owner approval must come from distinct actors outside the initiator and reviewer');
            }
            $seenOwnerIds[] = $owner->actorId;
            self::requireCapability($accessDecision, $owner, self::CAPABILITY_APPROVE, $scope, 'organization.structure.owner_denied');
            $approvedBy[] = $owner->actorId;
        }
        if (count(array_unique($approvedBy, SORT_STRING)) < 2) {
            throw AuthorizationDenied::forCode('organization.structure.owner_count', 'two distinct owner approvals required');
        }
    }

    /** @return list<string> */
    public function participantIds(): array
    {
        return array_values(array_unique(array_merge(
            [$this->initiator->actorId, $this->reviewer->actorId],
            array_map(static fn (Actor $owner): string => $owner->actorId, $this->owners),
        ), SORT_STRING));
    }

    private static function requireCapability(AccessDecision $accessDecision, Actor $actor, string $capability, ?StructureScope $scope, string $errorCode): void
    {
        $outcome = $accessDecision->decide($actor, $capability, $scope);
        if (! $outcome->allowed) {
            throw AuthorizationDenied::forCode($errorCode, $outcome->reason);
        }
    }
}
