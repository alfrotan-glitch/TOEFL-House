<?php

declare(strict_types=1);

namespace Tests\Feature\Console;

use App\Modules\Access\Commands\GrantScopePermission;
use App\Modules\Access\Models\OrgWideGrantRequest;
use App\Modules\Access\Models\Position;
use App\Modules\Access\Models\Role;
use App\Modules\Identity\Models\Person;
use App\Modules\Identity\Models\UserAccount;
use App\Support\Authorization\Actor;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Tests\Concerns\BuildsActors;
use Tests\Concerns\OperatesStructure;
use Tests\TestCase;

/**
 * PHASE_3 increment E (part four): the access administration console —
 * position assignments, the versioned policy catalog, named-scope grants,
 * and dated, reasoned delegations. Organization-wide grants are staged
 * (000116): a grantor session requests, two DISTINCT approver sessions
 * each sign in their own session, and the grant is executed only from
 * approved. The transport has no field for typing a colleague's identity;
 * the boundary re-checks distinctness.
 */
final class AccessWorkflowFeatureTest extends TestCase
{
    use BuildsActors;
    use OperatesStructure;

    private const BOOTSTRAP_ORG = '00000000-0000-4000-8000-00000000b005';

    protected function setUp(): void
    {
        parent::setUp();

        $this->personWithAuthority('acw-target-1', []);
        $this->personWithAuthority('acw-grantee-1', []);
        $this->personWithAuthority('acw-delegator', ['identity.verify']);
        $this->personWithAuthority('acw-delegate', []);
    }

    /** @return array{0: Person, 1: UserAccount} */
    private function makeEmployee(string $personId, array $capabilities, string $username): array
    {
        $person = $this->personWithAuthority($personId, $capabilities);
        $account = UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $person->id,
            'username' => $username,
            'password_hash' => Hash::make('acw-password-1'),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);

        return [$person, $account];
    }

    private function signIn(string $username): void
    {
        $this->post('/login', ['username' => $username, 'password' => 'acw-password-1'])->assertRedirect('/');
        $this->assertAuthenticated();
    }

    private function signOut(): void
    {
        $this->post('/logout')->assertRedirect('/login');
        $this->assertGuest();
    }

    public function test_position_assignments_and_policy_versions_over_the_console(): void
    {
        $this->makeEmployee('acw-manager-1', ['access.assign_position', 'access.define_policy'], 'manager-1');

        /** @var Position $position */
        $position = Position::query()->create(['id' => RandomIdentifier::new(), 'organization_id' => self::BOOTSTRAP_ORG, 'name' => 'Console Director']);
        /** @var Role $role */
        $role = Role::query()->create(['id' => RandomIdentifier::new(), 'name' => 'Console Director Role']);

        $assignments = DB::connection()->getTablePrefix().'position_assignments';
        $policies = DB::connection()->getTablePrefix().'access_policies';

        $this->signIn('manager-1');

        // A repeated assignment closes the prior OPEN (active) assignment
        // for the same person and position; history is retained.
        $this->post('/access/assignments', [
            'person_id' => 'acw-target-1', 'position_id' => $position->id, 'effective_from' => '2026-09-01',
        ])->assertRedirect('/access');
        $firstId = DB::table($assignments)->where('person_id', 'acw-target-1')->orderBy('id')->value('id');
        $this->assertDatabaseHas($assignments, ['id' => $firstId, 'lifecycle_state' => 'proposed', 'effective_to' => null]);

        $this->post('/access/assignments/'.$firstId.'/activate')->assertRedirect('/access');
        $this->assertDatabaseHas($assignments, ['id' => $firstId, 'lifecycle_state' => 'active']);

        $this->post('/access/assignments', [
            'person_id' => 'acw-target-1', 'position_id' => $position->id, 'effective_from' => '2026-10-01',
        ])->assertRedirect('/access');
        $secondId = DB::table($assignments)->where('person_id', 'acw-target-1')->where('lifecycle_state', 'proposed')->value('id');
        $this->assertDatabaseHas($assignments, ['id' => $firstId, 'lifecycle_state' => 'active', 'effective_to' => '2026-10-01']);
        $this->assertDatabaseHas($assignments, ['id' => $secondId, 'lifecycle_state' => 'proposed']);

        $this->post('/access/assignments/'.$secondId.'/activate')->assertRedirect('/access');
        $this->post('/access/assignments/'.$secondId.'/revoke')->assertRedirect('/access');
        $this->assertDatabaseHas($assignments, ['id' => $secondId, 'lifecycle_state' => 'revoked']);

        // A revoked assignment is closed to further transitions.
        $this->post('/access/assignments/'.$secondId.'/activate', [], ['referer' => 'http://localhost/access'])
            ->assertRedirect('/access')
            ->assertSessionHas('error_code', 'access.lifecycle_transition_forbidden');

        // The policy catalog publishes versions; a new version of the same
        // binding closes the prior open one.
        $this->post('/access/policies/position-role', [
            'position_id' => $position->id, 'role_id' => $role->id, 'effective_from' => '2026-09-01',
        ])->assertRedirect('/access');
        $this->assertDatabaseHas($policies, [
            'binding_type' => 'position', 'binding_id' => $position->id,
            'grants_type' => 'role', 'grants_id' => $role->id, 'effective_to' => null,
        ]);

        $this->post('/access/policies/role-permission', [
            'role_id' => $role->id, 'permission' => 'identity.verify', 'effective_from' => '2026-09-01',
        ])->assertRedirect('/access');
        $this->assertDatabaseHas($policies, [
            'binding_type' => 'role', 'binding_id' => $role->id,
            'grants_type' => 'permission', 'permission' => 'identity.verify',
        ]);
    }

    public function test_direct_grants_and_delegations_over_the_console(): void
    {
        $grantorPerson = $this->makeEmployee('acw-grantor-1', ['access.grant', 'access.revoke', 'access.delegate'], 'grantor-1');
        $organization = $this->establishActiveOrganization();
        $campus = $this->establishActiveCampus($organization);
        $grants = DB::connection()->getTablePrefix().'scope_grants';
        $delegations = DB::connection()->getTablePrefix().'delegations';

        $this->signIn('grantor-1');

        // A person may not grant authority to themselves.
        $this->post('/access/grants', [
            'person_id' => $grantorPerson[0]->id, 'permission' => 'identity.verify',
            'scope_type' => 'campus', 'scope_id' => $campus->id, 'effective_from' => '2026-09-01',
        ], ['referer' => 'http://localhost/access'])
            ->assertRedirect('/access')
            ->assertSessionHas('error_code', 'access.self_grant_forbidden');

        // The organization scope is not offered on the direct grant form
        // (a 422, not a domain code) — it exists only through the staged
        // chain; the domain refuses it on every other path.
        $this->post('/access/grants', [
            'person_id' => 'acw-grantee-1', 'permission' => 'identity.verify',
            'scope_type' => 'organization', 'scope_id' => $organization->id, 'effective_from' => '2026-09-01',
        ], ['referer' => 'http://localhost/access'])
            ->assertRedirect('/access')->assertSessionHasErrors('scope_type');

        // A named-scope grant becomes active authority immediately.
        $this->post('/access/grants', [
            'person_id' => 'acw-grantee-1', 'permission' => 'identity.verify',
            'scope_type' => 'campus', 'scope_id' => $campus->id, 'effective_from' => '2026-09-01',
        ])->assertRedirect('/access');
        $grantId = DB::table($grants)->where('person_id', 'acw-grantee-1')->value('id');
        $this->assertDatabaseHas($grants, ['id' => $grantId, 'lifecycle_state' => 'active', 'is_emergency' => false]);

        // Emergency grants are dated, limited, and flagged for review.
        $this->post('/access/grants', [
            'person_id' => 'acw-grantee-1', 'permission' => 'identity.verify',
            'scope_type' => 'campus', 'scope_id' => $campus->id, 'effective_from' => '2026-09-01', 'emergency' => '1',
        ], ['referer' => 'http://localhost/access'])
            ->assertRedirect('/access')
            ->assertSessionHas('error_code', 'access.emergency_requires_expiry');

        $this->post('/access/grants', [
            'person_id' => 'acw-grantee-1', 'permission' => 'identity.verify',
            'scope_type' => 'campus', 'scope_id' => $campus->id, 'effective_from' => '2026-09-01',
            'effective_to' => '2026-11-01', 'emergency' => '1',
        ], ['referer' => 'http://localhost/access'])
            ->assertRedirect('/access')
            ->assertSessionHas('error_code', 'access.emergency_exceeds_limit');

        $this->post('/access/grants', [
            'person_id' => 'acw-grantee-1', 'permission' => 'identity.verify',
            'scope_type' => 'campus', 'scope_id' => $campus->id, 'effective_from' => '2026-09-01',
            'effective_to' => '2026-09-20', 'emergency' => '1',
        ])->assertRedirect('/access');
        $this->assertDatabaseHas($grants, [
            'person_id' => 'acw-grantee-1', 'scope_type' => 'campus', 'scope_id' => $campus->id,
            'is_emergency' => true, 'review_required' => true,
        ]);

        // Revocation stops the authority; a revoked grant is closed.
        $this->post('/access/grants/'.$grantId.'/revoke')->assertRedirect('/access');
        $this->assertDatabaseHas($grants, ['id' => $grantId, 'lifecycle_state' => 'revoked']);
        $this->post('/access/grants/'.$grantId.'/revoke', [], ['referer' => 'http://localhost/access'])
            ->assertRedirect('/access')
            ->assertSessionHas('error_code', 'access.lifecycle_transition_forbidden');

        // Delegations are temporary, reasoned, and revocable.
        $this->post('/access/delegations', [
            'delegator_person_id' => 'acw-delegator', 'delegate_person_id' => 'acw-delegator',
            'permission' => 'identity.verify', 'effective_from' => '2026-09-01', 'effective_to' => '2026-10-01',
            'reason' => 'Probe self-delegation',
        ], ['referer' => 'http://localhost/access'])
            ->assertRedirect('/access')
            ->assertSessionHas('error_code', 'access.delegation_to_self');

        $this->post('/access/delegations', [
            'delegator_person_id' => 'acw-delegator', 'delegate_person_id' => 'acw-delegate',
            'permission' => 'identity.verify', 'scope_type' => 'organization', 'scope_id' => self::BOOTSTRAP_ORG,
            'effective_from' => '2026-09-01', 'effective_to' => '2026-10-01', 'reason' => 'Vacation cover',
        ])->assertRedirect('/access');
        $delegationId = DB::table($delegations)->value('id');
        $this->assertDatabaseHas($delegations, ['id' => $delegationId, 'lifecycle_state' => 'active', 'reason' => 'Vacation cover']);

        $this->post('/access/delegations/'.$delegationId.'/revoke')->assertRedirect('/access');
        $this->assertDatabaseHas($delegations, ['id' => $delegationId, 'lifecycle_state' => 'revoked']);
        $this->post('/access/delegations/'.$delegationId.'/revoke', [], ['referer' => 'http://localhost/access'])
            ->assertRedirect('/access')
            ->assertSessionHas('error_code', 'access.lifecycle_transition_forbidden');
    }

    public function test_org_wide_grants_are_staged_over_the_console(): void
    {
        $this->makeEmployee('acw-grantor-2', ['access.grant'], 'grantor-2');
        $this->makeEmployee('acw-owner-a', ['access.approve_org_wide'], 'owner-a');
        $this->makeEmployee('acw-owner-b', ['access.approve_org_wide'], 'owner-b');
        $this->makeEmployee('acw-plain-2', [], 'plain-2');
        $this->personWithAuthority('acw-grantee-2', []);

        $requests = DB::connection()->getTablePrefix().'org_wide_grant_requests';
        $grants = DB::connection()->getTablePrefix().'scope_grants';

        // The grantor session requests the organization-wide grant.
        $this->signIn('grantor-2');
        $this->post('/access/grants/org-wide', [
            'person_id' => 'acw-grantee-2', 'permission' => 'identity.verify',
            'organization_id' => self::BOOTSTRAP_ORG, 'effective_from' => '2026-09-01',
        ])->assertRedirect('/access');
        $requestId = DB::table($requests)->value('id');
        $this->assertDatabaseHas($requests, ['id' => $requestId, 'lifecycle_state' => 'requested', 'requested_by' => 'acw-grantor-2']);

        // Executing before any approval is refused.
        $this->post('/access/grants/org-wide/'.$requestId.'/execute', [], ['referer' => 'http://localhost/access'])
            ->assertRedirect('/access')
            ->assertSessionHas('error_code', 'access.org_wide_grant_state');

        // The first approver signs; the request is not yet approved.
        $this->signOut();
        $this->signIn('owner-a');
        $this->post('/access/grants/org-wide/'.$requestId.'/approve')->assertRedirect('/access');
        $this->assertDatabaseHas($requests, ['id' => $requestId, 'lifecycle_state' => 'requested', 'approver_one_id' => 'acw-owner-a']);

        // The same approver signing twice is refused (SoD).
        $this->post('/access/grants/org-wide/'.$requestId.'/approve', [], ['referer' => 'http://localhost/access'])
            ->assertRedirect('/access')
            ->assertSessionHas('error_code', 'access.org_wide_single_actor');

        // An unprivileged signer is refused and audited.
        $this->signOut();
        $this->signIn('plain-2');
        $this->post('/access/grants/org-wide/'.$requestId.'/approve', [], ['referer' => 'http://localhost/access'])
            ->assertRedirect('/access')
            ->assertSessionHas('error_code', 'access.org_wide_approver_denied');
        $this->assertDatabaseHas('audit_events', ['operation' => 'access.org_wide_grant.approve.denied', 'actor_id' => 'acw-plain-2']);

        // A distinct approver signs; the request becomes approved.
        $this->signOut();
        $this->signIn('owner-b');
        $this->post('/access/grants/org-wide/'.$requestId.'/approve')->assertRedirect('/access');
        $this->assertDatabaseHas($requests, [
            'id' => $requestId, 'lifecycle_state' => 'approved',
            'approver_one_id' => 'acw-owner-a', 'approver_two_id' => 'acw-owner-b',
        ]);

        // An approved request cannot be signed again.
        $this->post('/access/grants/org-wide/'.$requestId.'/approve', [], ['referer' => 'http://localhost/access'])
            ->assertRedirect('/access')
            ->assertSessionHas('error_code', 'access.org_wide_grant_state');

        // The grantor executes; the grant is the authority itself.
        $this->signOut();
        $this->signIn('grantor-2');
        $this->post('/access/grants/org-wide/'.$requestId.'/execute')->assertRedirect('/access');
        $this->assertDatabaseHas($requests, ['id' => $requestId, 'lifecycle_state' => 'granted', 'granted_by' => 'acw-grantor-2']);
        $this->assertDatabaseHas($grants, [
            'person_id' => 'acw-grantee-2', 'permission' => 'identity.verify',
            'scope_type' => 'organization', 'scope_id' => self::BOOTSTRAP_ORG, 'lifecycle_state' => 'active',
        ]);

        // An executed request is closed — no re-execution.
        $this->post('/access/grants/org-wide/'.$requestId.'/execute', [], ['referer' => 'http://localhost/access'])
            ->assertRedirect('/access')
            ->assertSessionHas('error_code', 'access.org_wide_grant_state');
    }

    public function test_the_000116_boundary_rechecks_the_staged_rules_against_direct_sql(): void
    {
        $grantor = $this->makeEmployee('acw-grantor-3', ['access.grant'], 'grantor-3');
        $this->personWithAuthority('acw-grantee-3', []);
        $requests = DB::connection()->getTablePrefix().'org_wide_grant_requests';

        $this->signIn('grantor-3');
        $this->post('/access/grants/org-wide', [
            'person_id' => 'acw-grantee-3', 'permission' => 'identity.verify',
            'organization_id' => self::BOOTSTRAP_ORG, 'effective_from' => '2026-09-01',
        ])->assertRedirect('/access');
        $requestId = DB::table($requests)->value('id');

        // The first approver slot can be written directly.
        DB::table($requests)->where('id', $requestId)->update([
            'approver_one_id' => 'acw-owner-a', 'updated_at' => now(),
        ]);

        // The same person in both slots is refused at the boundary.
        try {
            DB::table($requests)->where('id', $requestId)->update([
                'approver_two_id' => 'acw-owner-a', 'lifecycle_state' => 'approved', 'updated_at' => now(),
            ]);
            $this->fail('expected the boundary to refuse a non-distinct approver');
        } catch (QueryException $exception) {
            $this->assertStringContainsString('two distinct approvers', $exception->getMessage());
        }

        // A distinct second approver closes the request.
        DB::table($requests)->where('id', $requestId)->update([
            'approver_two_id' => 'acw-owner-b', 'lifecycle_state' => 'approved', 'updated_at' => now(),
        ]);
        $this->assertDatabaseHas($requests, ['id' => $requestId, 'lifecycle_state' => 'approved']);

        // Approver slots are written once — even on a legal transition,
        // rewriting a signed slot is refused.
        try {
            DB::table($requests)->where('id', $requestId)->update([
                'approver_one_id' => 'acw-owner-b',
                'lifecycle_state' => 'granted',
                'granted_by' => 'acw-grantor-3',
                'grant_id' => 'acw-grant-sql',
                'updated_at' => now(),
            ]);
            $this->fail('expected the boundary to refuse rewriting an approver slot');
        } catch (QueryException $exception) {
            $this->assertStringContainsString('written once', $exception->getMessage());
        }

        // Executed through the command, the request is closed to every change.
        $orgRequest = OrgWideGrantRequest::query()->findOrFail($requestId);
        app(GrantScopePermission::class)->execute(
            new Actor('acw-grantor-3', 'Grantor'),
            $orgRequest,
            'acw-sql-execute',
        );
        $this->assertDatabaseHas($requests, ['id' => $requestId, 'lifecycle_state' => 'granted']);
        try {
            DB::table($requests)->where('id', $requestId)->update(['permission' => 'rewritten', 'updated_at' => now()]);
            $this->fail('expected the boundary to refuse changing an executed request');
        } catch (QueryException $exception) {
            $this->assertStringContainsString('closed', $exception->getMessage());
        }
    }
}
