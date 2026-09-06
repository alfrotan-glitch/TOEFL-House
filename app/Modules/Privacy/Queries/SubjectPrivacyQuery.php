<?php

declare(strict_types=1);

namespace App\Modules\Privacy\Queries;

use App\Modules\Privacy\Models\Consent;
use App\Modules\Privacy\Models\Disclosure;
use Carbon\CarbonImmutable;

/**
 * Read-only privacy view of one subject as of a day: effective consents
 * (revoked and expired consent never counts as current use authority) and
 * the disclosure history. No query result is an authority to mutate.
 */
final class SubjectPrivacyQuery
{
    /**
     * @return array{subject_person_id: string, consents: list<array<string, mixed>>, disclosures: list<array<string, mixed>>}
     */
    public function subjectProfile(string $subjectPersonId, ?CarbonImmutable $asOf = null): array
    {
        $day = ($asOf ?? CarbonImmutable::now())->startOfDay()->toDateString();

        $consents = Consent::query()
            ->where('subject_person_id', $subjectPersonId)
            ->where('lifecycle_state', 'active')
            ->where('effective_from', '<=', $day)
            ->where(fn ($query) => $query->whereNull('effective_to')->orWhere('effective_to', '>', $day))
            ->orderBy('effective_from')
            ->get(['id', 'purpose_id', 'effective_from', 'effective_to'])
            ->map(static fn (Consent $consent): array => [
                'consent_id' => $consent->id,
                'purpose_id' => $consent->purpose_id,
                'effective_from' => $consent->effective_from,
                'effective_to' => $consent->effective_to,
            ])
            ->all();

        $disclosures = Disclosure::query()
            ->where('subject_person_id', $subjectPersonId)
            ->orderBy('created_at')
            ->get(['id', 'recipient', 'purpose', 'disclosed_category', 'created_at'])
            ->map(static fn (Disclosure $disclosure): array => [
                'disclosure_id' => $disclosure->id,
                'recipient' => $disclosure->recipient,
                'purpose' => $disclosure->purpose,
                'disclosed_category' => $disclosure->disclosed_category,
                'at' => $disclosure->created_at?->toDateTimeString(),
            ])
            ->all();

        return [
            'subject_person_id' => $subjectPersonId,
            'consents' => $consents,
            'disclosures' => $disclosures,
        ];
    }
}
