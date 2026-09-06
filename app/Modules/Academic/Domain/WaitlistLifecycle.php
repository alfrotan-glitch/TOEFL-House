<?php

declare(strict_types=1);

namespace App\Modules\Academic\Domain;

use App\Support\Errors\BusinessRejection;

/**
 * Class waitlist registry. A student joins (waiting), a staff member offers a
 * freed seat (offered), and the offer is converted into a normal requested
 * enrollment (enrolled). The student can withdraw (withdrawn) and stale
 * offers can expire (expired).
 */
final class WaitlistLifecycle
{
    public const STATE_WAITING = 'waiting';

    public const STATE_OFFERED = 'offered';

    public const STATE_ENROLLED = 'enrolled';

    public const STATE_WITHDRAWN = 'withdrawn';

    public const STATE_EXPIRED = 'expired';

    private const TRANSITIONS = [
        self::STATE_WAITING => [self::STATE_OFFERED, self::STATE_WITHDRAWN, self::STATE_EXPIRED, self::STATE_ENROLLED],
        self::STATE_OFFERED => [self::STATE_ENROLLED, self::STATE_EXPIRED],
        self::STATE_ENROLLED => [],
        self::STATE_WITHDRAWN => [],
        self::STATE_EXPIRED => [],
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
            throw BusinessRejection::forCode('academic.waitlist_unknown_state', sprintf('unknown waitlist lifecycle state %s', $from));
        }
        if (! self::allowsTransition($from, $to)) {
            throw BusinessRejection::forCode('academic.waitlist_transition_forbidden', sprintf('transition %s -> %s is not allowed', $from, $to));
        }
    }
}
