<?php

declare(strict_types=1);

namespace Tests\Feature\Access;

use App\Modules\Access\AccessResolution;
use App\Modules\Access\Commands\DelegateAuthority;
use App\Modules\Access\Commands\RevokeDelegation;
use App\Modules\Access\Models\Delegation;
use App\Support\Authorization\Actor;
use App\Support\Authorization\StructureScope;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Errors\ValidationError;
use Carbon\CarbonImmutable;
use Tests\Concerns\BuildsActors;
use Tests\Concerns\OperatesStructure;
use Tests\TestCase;

final class DelegationFeatureTest extends TestCase
{
    use BuildsActors;
    use OperatesStructure;

    public function test_delegation_creates_dated_limited_authority_with_audit(): void
    {
        $delegator = $this->actorWithStructureCapabilities('dlg-delegator-1', ['identity.verify']);
        $organization = $this->establishActiveOrganization();
        $this->personWithAuthority('dlg-delegate-1', []);
        $delegate = new Actor('dlg-delegate-1', 'Delegate');

        $result = app(DelegateAuthority::class)->delegate(
            $delegator, 'dlg-delegator-1', 'dlg-delegate-1', 'identity.verify', 'organization', $organization->id,
            new CarbonImmutable('2026-08-25'), new CarbonImmutable('2026-09-25'), 'annual leave coverage', 'dlg-key-1',
        );

        $this->assertDatabaseHas('delegations', ['id' => $result['delegation_id'], 'lifecycle_state' => 'active', 'reason' => 'annual leave coverage']);
        $this->assertDatabaseHas('audit_events', ['operation' => 'access.delegate', 'target_type' => 'delegation', 'target_id' => $result['delegation_id']]);
        $resolution = new AccessResolution;
        $this->assertTrue($resolution->decide($delegate, 'identity.verify', new StructureScope($organization->id))->allowed);
        $this->assertFalse($resolution->decide($delegate, 'access.grant', new StructureScope($organization->id))->allowed);
    }

    public function test_delegator_cannot_delegate_authority_they_do_not_hold(): void
    {
        $delegator = $this->actorWithStructureCapabilities('dlg-delegator-2', ['identity.verify']);
        $organization = $this->establishActiveOrganization();
        $this->personWithAuthority('dlg-delegate-2', []);

        $this->expectException(AuthorizationDenied::class);
        $this->expectExceptionMessage('a delegator may not delegate authority they do not hold');
        app(DelegateAuthority::class)->delegate(
            $delegator, 'dlg-delegator-2', 'dlg-delegate-2', 'access.grant', 'organization', $organization->id,
            new CarbonImmutable('2026-08-25'), new CarbonImmutable('2026-09-25'), 'illegitimate attempt', 'dlg-key-2',
        );

        $this->assertDatabaseHas('audit_events', ['operation' => 'access.delegate.denied', 'actor_id' => 'dlg-delegator-2']);
        $this->assertDatabaseMissing('delegations', ['delegator_person_id' => 'dlg-delegator-2']);
    }

    public function test_delegation_to_self_empty_reason_and_inverted_period_are_rejected(): void
    {
        $delegator = $this->actorWithStructureCapabilities('dlg-delegator-3', ['identity.verify']);
        $organization = $this->establishActiveOrganization();
        $command = app(DelegateAuthority::class);

        try {
            $command->delegate($delegator, 'dlg-delegator-3', 'dlg-delegator-3', 'identity.verify', null, null, new CarbonImmutable('2026-08-25'), new CarbonImmutable('2026-09-25'), 'self', 'dlg-key-3');
            $this->fail('delegation to self must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('access.delegation_to_self', $rejection->errorCode());
        }

        try {
            $command->delegate($delegator, 'dlg-delegator-3', 'dlg-other-9', 'identity.verify', null, null, new CarbonImmutable('2026-08-25'), new CarbonImmutable('2026-08-25'), 'inverted', 'dlg-key-4');
            $this->fail('an inverted period must be rejected');
        } catch (ValidationError $error) {
            $this->assertSame('access.delegation_period', $error->errorCode());
        }

        try {
            $command->delegate($delegator, 'dlg-delegator-3', 'dlg-other-9', 'identity.verify', null, null, new CarbonImmutable('2026-08-25'), new CarbonImmutable('2026-09-25'), '', 'dlg-key-5');
            $this->fail('an empty reason must be rejected');
        } catch (ValidationError $error) {
            $this->assertSame('access.delegation_reason', $error->errorCode());
        }

        $this->assertDatabaseMissing('delegations', ['delegator_person_id' => 'dlg-delegator-3']);
    }

    public function test_revocation_stops_the_delegation_immediately(): void
    {
        $delegator = $this->actorWithStructureCapabilities('dlg-delegator-4', ['identity.verify']);
        $organization = $this->establishActiveOrganization();
        $this->personWithAuthority('dlg-delegate-4', []);
        $created = app(DelegateAuthority::class)->delegate(
            $delegator, 'dlg-delegator-4', 'dlg-delegate-4', 'identity.verify', 'organization', $organization->id,
            new CarbonImmutable('2026-08-25'), new CarbonImmutable('2026-09-25'), 'early return', 'dlg-key-6',
        );
        /** @var Delegation $delegation */
        $delegation = Delegation::query()->findOrFail($created['delegation_id']);
        $delegate = new Actor('dlg-delegate-4', 'Delegate');
        $resolution = new AccessResolution;
        $this->assertTrue($resolution->decide($delegate, 'identity.verify', new StructureScope($organization->id))->allowed);

        $result = app(RevokeDelegation::class)->revoke($delegator, $delegation, 'dlg-key-7');

        $this->assertSame('revoked', $result['lifecycle_state']);
        $this->assertFalse($resolution->decide($delegate, 'identity.verify', new StructureScope($organization->id))->allowed);
        $this->assertDatabaseHas('audit_events', ['operation' => 'access.delegate.revoke', 'target_type' => 'delegation', 'target_id' => $delegation->id]);

        $this->expectException(BusinessRejection::class);
        $this->expectExceptionMessage('transition revoked -> revoked is not allowed');
        app(RevokeDelegation::class)->revoke($delegator, $delegation, 'dlg-key-8');
    }

    public function test_third_party_cannot_revoke_without_the_access_capability(): void
    {
        $delegator = $this->actorWithStructureCapabilities('dlg-delegator-5', ['identity.verify']);
        $organization = $this->establishActiveOrganization();
        $this->personWithAuthority('dlg-delegate-5', []);
        $created = app(DelegateAuthority::class)->delegate(
            $delegator, 'dlg-delegator-5', 'dlg-delegate-5', 'identity.verify', 'organization', $organization->id,
            new CarbonImmutable('2026-08-25'), new CarbonImmutable('2026-09-25'), 'target of revocation attack', 'dlg-key-9',
        );
        /** @var Delegation $delegation */
        $delegation = Delegation::query()->findOrFail($created['delegation_id']);
        $attacker = $this->actorWithoutAnyCapability('dlg-attacker-1');

        $this->expectException(AuthorizationDenied::class);
        $this->expectExceptionMessage('no active authority grants access.delegate');
        app(RevokeDelegation::class)->revoke($attacker, $delegation, 'dlg-key-10');

        $this->assertDatabaseHas('audit_events', ['operation' => 'access.delegate.revoke.denied', 'actor_id' => 'dlg-attacker-1']);
        $this->assertDatabaseHas('delegations', ['id' => $delegation->id, 'lifecycle_state' => 'active']);
    }
}
