<?php

declare(strict_types=1);

namespace App\Modules\Students\Domain;

use App\Support\Errors\BusinessRejection;

/**
 * Canonical relationship disclosures. These permissions describe what an
 * effective, verified guardian relationship may request; they never bypass
 * the owning module's own privacy, Finance, or document authorization.
 */
final class GuardianPermissionRegistry
{
    public const VIEW_ACADEMIC = 'view-academic';

    public const VIEW_ATTENDANCE = 'view-attendance';

    public const VIEW_DOCUMENTS = 'view-documents';

    public const RECEIVE_COMMUNICATION = 'receive-communication';

    /** Finance remains the monetary authority; this is only a relationship
     * disclosure intent and is not an employee Finance capability. */
    public const VIEW_FINANCE = 'view-finance';

    /** @return list<string> */
    public static function permissions(): array
    {
        return [
            self::VIEW_ACADEMIC,
            self::VIEW_ATTENDANCE,
            self::VIEW_DOCUMENTS,
            self::RECEIVE_COMMUNICATION,
            self::VIEW_FINANCE,
        ];
    }

    /**
     * @param  list<string>  $permissions
     * @return list<string>
     */
    public static function normalize(array $permissions): array
    {
        $normalized = array_values(array_unique(array_map(
            static fn (mixed $permission): string => strtolower(trim((string) $permission)),
            $permissions,
        )));
        if ($normalized === []) {
            throw BusinessRejection::forCode('students.guardian_permissions_missing', 'a guardian relationship requires at least one governed permission');
        }

        foreach ($normalized as $permission) {
            if (! in_array($permission, self::permissions(), true)) {
                throw BusinessRejection::forCode('students.guardian_permission_unknown', sprintf('unknown guardian permission %s', $permission));
            }
        }

        return $normalized;
    }
}
