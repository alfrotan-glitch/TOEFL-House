<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Modules\Audit\Models\AuditEvent;
use App\Modules\Identity\Commands\VerifyPerson;
use App\Modules\Identity\Models\Person;
use App\Support\Errors\BusinessRejection;
use App\Support\Identifiers\RandomIdentifier;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

final class IdempotencyFeatureTest extends TestCase
{
    use BuildsActors;

    private function newPerson(): Person
    {
        /** @var Person $person */
        $person = Person::query()->create([
            'id' => RandomIdentifier::new(),
            'legal_name' => 'Idempotent Person',
            'date_of_birth' => '1985-06-15',
            'verification_state' => Person::VERIFICATION_UNVERIFIED,
        ]);

        return $person;
    }

    public function test_repeated_command_returns_the_original_outcome_without_a_second_effect(): void
    {
        $person = $this->newPerson();
        $key = 'idem-'.RandomIdentifier::new();

        $first = app(VerifyPerson::class)->verify($this->identityVerifier(), $person, 'national-id-7007', 'documents/national-id-7007', $key);
        $second = app(VerifyPerson::class)->verify($this->identityVerifier(), $person, 'national-id-7007', 'documents/national-id-7007', $key);

        $this->assertSame($first['correlation_id'], $second['correlation_id']);
        $this->assertSame(1, AuditEvent::query()->where('target_id', $person->id)->where('operation', 'identity.verify')->count());
        $this->assertSame(1, Person::query()->where('identity_key', 'national-id-7007')->count());
    }

    public function test_same_key_with_a_different_payload_is_rejected(): void
    {
        $person = $this->newPerson();
        $key = 'idem-'.RandomIdentifier::new();
        app(VerifyPerson::class)->verify($this->identityVerifier(), $person, 'national-id-8008', 'documents/national-id-8008', $key);

        $this->expectException(BusinessRejection::class);
        $this->expectExceptionMessage('idempotency key reused with a different payload');
        app(VerifyPerson::class)->verify($this->identityVerifier(), $person, 'national-id-9999', 'documents/national-id-9999', $key);
    }
}
