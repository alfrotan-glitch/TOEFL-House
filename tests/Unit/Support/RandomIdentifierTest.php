<?php

declare(strict_types=1);

namespace Tests\Unit\Support;

use App\Support\Identifiers\RandomIdentifier;
use PHPUnit\Framework\TestCase;

final class RandomIdentifierTest extends TestCase
{
    public function test_identifiers_are_unique_uuid_version4(): void
    {
        $seen = [];
        for ($i = 0; $i < 200; $i++) {
            $identifier = RandomIdentifier::new();
            $this->assertMatchesRegularExpression('/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/', $identifier);
            $seen[$identifier] = true;
        }

        $this->assertCount(200, $seen);
    }
}
