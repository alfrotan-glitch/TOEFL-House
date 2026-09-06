<?php

declare(strict_types=1);

namespace App\Modules\Academic\Placement\Domain;

use App\Modules\Academic\Placement\Models\PlacementProfile;
use App\Support\Errors\BusinessRejection;

/**
 * Placement profile lifecycle registry: draft -> scored -> recommended ->
 * reviewed -> approved -> released. A released profile may be superseded
 * by a retake or retired administratively; history is never rewritten.
 */
final class PlacementProfileLifecycle
{
    /** @var array<string, list<string>> */
    private const TRANSITIONS = [
        PlacementProfile::STATE_DRAFT => [PlacementProfile::STATE_SCORED, PlacementProfile::STATE_RETIRED],
        PlacementProfile::STATE_SCORED => [PlacementProfile::STATE_RECOMMENDED, PlacementProfile::STATE_RETIRED],
        PlacementProfile::STATE_RECOMMENDED => [PlacementProfile::STATE_REVIEWED, PlacementProfile::STATE_RETIRED],
        PlacementProfile::STATE_REVIEWED => [PlacementProfile::STATE_APPROVED, PlacementProfile::STATE_RETIRED],
        PlacementProfile::STATE_APPROVED => [PlacementProfile::STATE_RELEASED, PlacementProfile::STATE_RETIRED],
        PlacementProfile::STATE_RELEASED => [PlacementProfile::STATE_SUPERSEDED, PlacementProfile::STATE_RETIRED],
        PlacementProfile::STATE_SUPERSEDED => [],
        PlacementProfile::STATE_RETIRED => [],
    ];

    /** @return list<string> */
    public static function states(): array
    {
        return array_keys(self::TRANSITIONS);
    }

    public static function allowsTransition(string $from, string $to): bool
    {
        return in_array($to, self::TRANSITIONS[$from] ?? [], true);
    }

    public static function requireTransition(string $from, string $to): void
    {
        if (! array_key_exists($from, self::TRANSITIONS)) {
            throw BusinessRejection::forCode('placement.profile_unknown_state', sprintf('unknown placement profile state %s', $from));
        }
        if (! self::allowsTransition($from, $to)) {
            throw BusinessRejection::forCode('placement.profile_transition_forbidden', sprintf('placement profile transition %s -> %s is not allowed', $from, $to));
        }
    }
}
