<?php

declare(strict_types=1);

namespace Tests\Feature\Access;

use App\Modules\Access\AccessResolution;
use App\Modules\Access\Commands\GrantScopePermission;
use App\Modules\Access\Commands\RevokeScopePermission;
use App\Modules\Access\Models\OrgWideGrantRequest;
use App\Modules\Access\Models\ScopeGrant;
use App\Support\Authorization\Actor;
use App\Support\Authorization\StructureScope;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use Carbon\CarbonImmutable;
use Tests\Concerns\BuildsActors;
use Tests\Concerns\OperatesStructure;
use Tests\TestCase;

final class GrantCommandFeatureTest extends TestCase
{
    use BuildsActors;
    use OperatesStructure;

    public function test_scope_grant_creates_active_grant_with_audit_and_idempotent_replay(): void
    {
        $grantor = $this->accessAdministrator();
        $organization = $this->establishActiveOrganization();
        $campus = $this->establishActiveCampus($organization);
        $this->personWithAuthority('grantee-1', []);
        $command = app(GrantScopePermission::class);

        $result = $command->grant($grantor, 'grantee-1', 'identity.verify', 'campus', $campus->id, new CarbonImmutable('2026-08-25'), null, false, 'grant-key-1');
        $replay = $command->grant($grantor, 'grantee-1', 'identity.verify', 'campus', $campus->id, new CarbonImmutable('2026-08-25'), null, false, 'grant-key-1');

        $this->assertSame($result, $replay);
        $this->assertDatabaseHas('scope_grants', [
            'person_id' => 'grantee-1',
            'permission' => 'identity.verify',
            'scope_type' => 'campus',
            'scope_id' => $campus->id,
            'lifecycle_state' => 'active',
            'is_emergency' => false,
        ]);
        $this->assertDatabaseHas('audit_events', ['operation' => 'access.grant', 'target_type' => 'scope_grant', 'target_id' => $result['grant_id']]);
    }

    public function test_same_idempotency_key_with_different_payload_is_rejected(): void
    {
        $grantor = $this->accessAdministrator();
        $organization = $this->establishActiveOrganization();
        $campus = $this->establishActiveCampus($organization);
        $this->personWithAuthority('grantee-2', []);

        $this->expectException(BusinessRejection::class);
        $this->expectExceptionMessage('idempotency key reused with a different payload');
        app(GrantScopePermission::class)->grant($grantor, 'grantee-2', 'identity.verify', 'campus', $campus->id, new CarbonImmutable('2026-08-25'), null, false, 'grant-key-2');
        app(GrantScopePermission::class)->grant($grantor, 'grantee-2', 'identity.admin', 'campus', $campus->id, new CarbonImmutable('2026-08-25'), null, false, 'grant-key-2');
    }

    public function test_self_grant_is_denied_and_audited(): void
    {
        $grantor = $this->accessAdministrator();
        $organization = $this->establishActiveOrganization();

        $campus = $this->establishActiveCampus($organization);
        try {
            app(GrantScopePermission::class)->grant($grantor, 'acc-1', 'identity.verify', 'campus', $campus->id, new CarbonImmutable('2026-08-25'), null, false, 'grant-key-3');
            $this->fail('self grant must be denied');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('access.self_grant_forbidden', $denial->errorCode());
        }

        $this->assertDatabaseHas('audit_events', ['operation' => 'access.grant.denied', 'actor_id' => 'acc-1']);
        $this->assertDatabaseMissing('scope_grants', ['person_id' => 'acc-1', 'permission' => 'identity.verify']);
    }

    public function test_unprivileged_grantor_is_denied_and_audited(): void
    {
        $organization = $this->establishActiveOrganization();
        $unprivileged = $this->actorWithoutAnyCapability('unpriv-grantor');
        $this->personWithAuthority('grantee-3', []);

        $this->expectException(AuthorizationDenied::class);
        $campus = $this->establishActiveCampus($organization);
        $this->expectExceptionMessage('no active authority grants access.grant');
        app(GrantScopePermission::class)->grant($unprivileged, 'grantee-3', 'identity.verify', 'campus', $campus->id, new CarbonImmutable('2026-08-25'), null, false, 'grant-key-4');

        $this->assertDatabaseHas('audit_events', ['operation' => 'access.grant.denied', 'actor_id' => 'unpriv-grantor']);
    }

    public function test_organization_wide_grant_is_staged_with_two_distinct_eligible_approvers(): void
    {
        // Staged (000116): the grantor session requests, two distinct
        // approver sessions each sign in their own session, and the grant
        // is executed only from approved.
        $approverOne = $this->actorWithStructureCapabilities('org-owner-1', ['access.approve_org_wide']);
        $approverTwo = $this->actorWithStructureCapabilities('org-owner-3', ['access.approve_org_wide']);
        $unprivileged = $this->actorWithoutAnyCapability('org-owner-4');
        $grantor = $this->accessAdministrator();
        $organization = $this->establishActiveOrganization();
        $this->personWithAuthority('grantee-4', []);
        $command = app(GrantScopePermission::class);
        $from = new CarbonImmutable('2026-08-25');

        try {
            $command->grant($grantor, 'grantee-4', 'identity.verify', 'organization', $organization->id, $from, null, false, 'org-wide-1');
            $this->fail('a direct organization-wide grant must require the staged chain');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('access.grant_org_wide_requires_request', $rejection->errorCode());
        }

        $request = $command->request($grantor, 'grantee-4', 'identity.verify', $organization->id, $from, null, false, 'org-wide-2');
        $orgRequest = OrgWideGrantRequest::query()->findOrFail($request['request_id']);

        // One approver (however eligible) is not enough to execute.
        $this->assertSame('requested', $command->approve($approverOne, $orgRequest, 'org-wide-a1')['lifecycle_state']);
        try {
            $command->execute($grantor, $orgRequest, 'org-wide-3');
            $this->fail('one approver must not suffice');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('access.org_wide_grant_state', $rejection->errorCode());
        }

        try {
            $command->approve($approverOne, $orgRequest, 'org-wide-a2');
            $this->fail('the same actor twice must not suffice');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('access.org_wide_single_actor', $denial->errorCode());
        }

        try {
            $command->approve($unprivileged, $orgRequest, 'org-wide-a3');
            $this->fail('an unprivileged approver must not suffice');
        } catch (AuthorizationDenied $denial) {
            $this->assertSame('access.org_wide_approver_denied', $denial->errorCode());
        }

        $this->assertSame('approved', $command->approve($approverTwo, $orgRequest, 'org-wide-a4')['lifecycle_state']);
        try {
            $command->approve($approverTwo, $orgRequest, 'org-wide-a5');
            $this->fail('an approved request cannot be signed again');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('access.org_wide_grant_state', $rejection->errorCode());
        }

        $this->assertDatabaseMissing('scope_grants', ['person_id' => 'grantee-4']);

        // Execution records the grant — the authority itself.
        $granted = $command->execute($grantor, $orgRequest, 'org-wide-6');
        $this->assertDatabaseHas('scope_grants', [
            'id' => $granted['grant_id'],
            'person_id' => 'grantee-4',
            'permission' => 'identity.verify',
            'scope_type' => 'organization',
            'scope_id' => $organization->id,
            'lifecycle_state' => 'active',
        ]);
    }

    public function test_emergency_grant_requires_expiry_within_the_limit_and_is_flagged_for_review(): void
    {
        $grantor = $this->accessAdministrator();
        $organization = $this->establishActiveOrganization();
        $campus = $this->establishActiveCampus($organization);
        $this->personWithAuthority('grantee-6', []);
        $command = app(GrantScopePermission::class);

        try {
            $command->grant($grantor, 'grantee-6', 'identity.verify', 'campus', $campus->id, new CarbonImmutable('2026-08-25'), null, true, 'emerg-1');
            $this->fail('emergency without expiry must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('access.emergency_requires_expiry', $rejection->errorCode());
        }

        try {
            $command->grant($grantor, 'grantee-6', 'identity.verify', 'campus', $campus->id, new CarbonImmutable('2026-08-25'), new CarbonImmutable('2026-12-25'), true, 'emerg-2');
            $this->fail('emergency beyond the limit must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('access.emergency_exceeds_limit', $rejection->errorCode());
        }

        $result = $command->grant($grantor, 'grantee-6', 'identity.verify', 'campus', $campus->id, new CarbonImmutable('2026-08-25'), new CarbonImmutable('2026-09-15'), true, 'emerg-3');

        $this->assertDatabaseHas('scope_grants', ['id' => $result['grant_id'], 'is_emergency' => true, 'review_required' => true]);
    }

    public function test_revocation_stops_authority_immediately_and_is_audited(): void
    {
        $grantor = $this->accessAdministrator();
        $organization = $this->establishActiveOrganization();
        $this->personWithAuthority('grantee-7', []);
        $campus = $this->establishActiveCampus($organization);
        $created = app(GrantScopePermission::class)->grant($grantor, 'grantee-7', 'identity.verify', 'campus', $campus->id, new CarbonImmutable('2026-08-25'), null, false, 'revoke-key-1');
        /** @var ScopeGrant $grant */
        $grant = ScopeGrant::query()->findOrFail($created['grant_id']);

        $result = app(RevokeScopePermission::class)->revoke($grantor, $grant, 'revoke-key-2');

        $this->assertSame('revoked', $result['lifecycle_state']);
        $this->assertDatabaseHas('scope_grants', ['id' => $grant->id, 'lifecycle_state' => 'revoked']);
        $this->assertDatabaseHas('audit_events', ['operation' => 'access.revoke', 'target_type' => 'scope_grant', 'target_id' => $grant->id]);
        $denied = (new AccessResolution)->decide(new Actor('grantee-7', 'Grantee'), 'identity.verify', new StructureScope($campus->organization_id, $campus->id));
        $this->assertFalse($denied->allowed);

        $this->expectException(BusinessRejection::class);
        $this->expectExceptionMessage('transition revoked -> revoked is not allowed');
        app(RevokeScopePermission::class)->revoke($grantor, $grant, 'revoke-key-3');
    }

    public function test_unprivileged_revoker_is_denied_and_audited(): void
    {
        $grantor = $this->accessAdministrator();
        $organization = $this->establishActiveOrganization();
        $this->personWithAuthority('grantee-8', []);
        $campus = $this->establishActiveCampus($organization);
        $created = app(GrantScopePermission::class)->grant($grantor, 'grantee-8', 'identity.verify', 'campus', $campus->id, new CarbonImmutable('2026-08-25'), null, false, 'revoke-key-4');
        /** @var ScopeGrant $grant */
        $grant = ScopeGrant::query()->findOrFail($created['grant_id']);
        $unprivileged = $this->actorWithoutAnyCapability('unpriv-revoker');

        $this->expectException(AuthorizationDenied::class);
        app(RevokeScopePermission::class)->revoke($unprivileged, $grant, 'revoke-key-5');

        $this->assertDatabaseHas('audit_events', ['operation' => 'access.revoke.denied', 'actor_id' => 'unpriv-revoker']);
        $this->assertDatabaseHas('scope_grants', ['id' => $grant->id, 'lifecycle_state' => 'active']);
    }
}
