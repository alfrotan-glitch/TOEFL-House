<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Modules\Access\Commands\AssignPosition;
use App\Modules\Access\Commands\DefineAccessPolicy;
use App\Modules\Access\Commands\DelegateAuthority;
use App\Modules\Access\Commands\GrantScopePermission;
use App\Modules\Access\Commands\RevokeDelegation;
use App\Modules\Access\Commands\RevokeScopePermission;
use App\Modules\Access\Commands\TransitionPositionAssignment;
use App\Modules\Access\Models\AccessPolicy;
use App\Modules\Access\Models\Delegation;
use App\Modules\Access\Models\OrgWideGrantRequest;
use App\Modules\Access\Models\Position;
use App\Modules\Access\Models\PositionAssignment;
use App\Modules\Access\Models\Role;
use App\Modules\Access\Models\ScopeGrant;
use App\Modules\Identity\Models\Person;
use App\Modules\Organization\Models\Campus;
use App\Modules\Organization\Models\Department;
use App\Modules\Organization\Models\Organization;
use Carbon\CarbonImmutable;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\View\View;

/**
 * Access administration console: position assignments, the versioned
 * policy catalog (position->role, role->permission), named-scope grants,
 * organization-wide grant requests (staged, 000116: a grantor session
 * requests, two distinct approver sessions each sign, the grant is
 * executed only from approved), and dated, reasoned delegations. All rules
 * remain owned by the access module commands; this controller only
 * validates transport input and delegates.
 */
final class AccessController extends Controller
{
    public function index(): View
    {
        $this->requireOrganizationRead('access.define_policy', 'access.console.index');
        $authorizedOrganizationIds = $this->authorizedOrganizations('access.define_policy');
        $visibleBranches = $this->authorizedBranches('access.assign_position');
        $people = Person::query()->where('verification_state', 'verified')->whereIn('home_branch_id', $visibleBranches)->orderBy('legal_name')->limit(300)->get();
        $personIds = $people->pluck('id')->all();
        $campusIds = Campus::query()->whereIn('organization_id', $authorizedOrganizationIds)->pluck('id');
        $departmentIds = Department::query()->where(function ($scope) use ($visibleBranches, $campusIds): void {
            $scope->where(function ($branch) use ($visibleBranches): void {
                $branch->where('scope_type', 'branch')->whereIn('scope_id', $visibleBranches);
            })->orWhere(function ($campus) use ($campusIds): void {
                $campus->where('scope_type', 'campus')->whereIn('scope_id', $campusIds);
            });
        })->pluck('id');
        $positionIds = Position::query()->whereIn('organization_id', $authorizedOrganizationIds)->pluck('id');

        return view('access.index', [
            'people' => $people,
            'organizations' => Organization::query()->whereIn('id', $authorizedOrganizationIds)->where('lifecycle_state', 'active')->orderBy('name')->limit(100)->get(),
            'campuses' => Campus::query()->whereIn('id', $campusIds)->where('lifecycle_state', 'active')->limit(100)->get(),
            'positions' => Position::query()->whereIn('id', $positionIds)->orderBy('name')->limit(200)->get(),
            'roles' => Role::query()->orderBy('name')->limit(200)->get(),
            'assignments' => PositionAssignment::query()->whereIn('person_id', $personIds)->whereIn('position_id', $positionIds)->orderByDesc('effective_from')->orderBy('id')->limit(200)->get(),
            'policies' => AccessPolicy::query()->where(function ($scope) use ($positionIds): void {
                $scope->where('binding_type', 'role')
                    ->orWhere(function ($position) use ($positionIds): void {
                        $position->where('binding_type', 'position')->whereIn('binding_id', $positionIds);
                    });
            })->orderByDesc('effective_from')->orderBy('id')->limit(200)->get(),
            'grants' => ScopeGrant::query()->where(function ($scope) use ($authorizedOrganizationIds, $visibleBranches, $campusIds, $departmentIds): void {
                $scope->where(function ($organization) use ($authorizedOrganizationIds): void {
                    $organization->where('scope_type', 'organization')->whereIn('scope_id', $authorizedOrganizationIds);
                })->orWhere(function ($branch) use ($visibleBranches): void {
                    $branch->where('scope_type', 'branch')->whereIn('scope_id', $visibleBranches);
                })->orWhere(function ($campus) use ($campusIds): void {
                    $campus->where('scope_type', 'campus')->whereIn('scope_id', $campusIds);
                })->orWhere(function ($department) use ($departmentIds): void {
                    $department->where('scope_type', 'department')->whereIn('scope_id', $departmentIds);
                });
            })->orderByDesc('id')->limit(200)->get(),
            'grantRequests' => OrgWideGrantRequest::query()->whereIn('organization_id', $authorizedOrganizationIds)->orderByDesc('id')->limit(200)->get(),
            'delegations' => Delegation::query()->where(function ($scope) use ($personIds): void {
                $scope->whereIn('delegator_person_id', $personIds)->orWhereIn('delegate_person_id', $personIds);
            })->orderByDesc('id')->limit(200)->get(),
        ]);
    }

    public function assignPosition(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'person_id' => ['required', 'string'],
            'position_id' => ['required', 'string'],
            'effective_from' => ['required', 'date'],
        ]);

        app(AssignPosition::class)->assign(
            $this->actor(),
            $input['person_id'],
            $input['position_id'],
            CarbonImmutable::parse($input['effective_from']),
            $this->idempotencyKey('access.position.assign'),
        );

        return redirect()->route('access.index')->with('success', 'Position assignment proposed.');
    }

    public function activateAssignment(Request $request, string $assignmentId): RedirectResponse
    {
        app(TransitionPositionAssignment::class)->activate(
            $this->actor(),
            PositionAssignment::query()->findOrFail($assignmentId),
            $this->idempotencyKey('access.position.activate'),
        );

        return redirect()->route('access.index')->with('success', 'Position assignment activated.');
    }

    public function revokeAssignment(Request $request, string $assignmentId): RedirectResponse
    {
        app(TransitionPositionAssignment::class)->revoke(
            $this->actor(),
            PositionAssignment::query()->findOrFail($assignmentId),
            $this->idempotencyKey('access.position.revoke'),
        );

        return redirect()->route('access.index')->with('success', 'Position assignment revoked.');
    }

    public function bindPositionRole(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'position_id' => ['required', 'string'],
            'role_id' => ['required', 'string'],
            'effective_from' => ['required', 'date'],
        ]);

        app(DefineAccessPolicy::class)->bindPositionRole(
            $this->actor(),
            $input['position_id'],
            $input['role_id'],
            CarbonImmutable::parse($input['effective_from']),
            $this->idempotencyKey('access.policy.bind'),
        );

        return redirect()->route('access.index')->with('success', 'Position bound to its role.');
    }

    public function grantRolePermission(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'role_id' => ['required', 'string'],
            'permission' => ['required', 'string', 'max:120'],
            'effective_from' => ['required', 'date'],
        ]);

        app(DefineAccessPolicy::class)->grantRolePermission(
            $this->actor(),
            $input['role_id'],
            $input['permission'],
            CarbonImmutable::parse($input['effective_from']),
            $this->idempotencyKey('access.policy.permission'),
        );

        return redirect()->route('access.index')->with('success', 'Role permission published.');
    }

    public function grantPermission(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'person_id' => ['required', 'string'],
            'permission' => ['required', 'string', 'max:120'],
            'scope_type' => ['required', 'string', 'in:campus,branch,department'],
            'scope_id' => ['required', 'string'],
            'effective_from' => ['required', 'date'],
            'effective_to' => ['nullable', 'date', 'after_or_equal:effective_from'],
            'emergency' => ['sometimes', 'boolean'],
        ]);

        app(GrantScopePermission::class)->grant(
            $this->actor(),
            $input['person_id'],
            $input['permission'],
            $input['scope_type'],
            $input['scope_id'],
            CarbonImmutable::parse($input['effective_from']),
            isset($input['effective_to']) && $input['effective_to'] !== ''
                ? CarbonImmutable::parse($input['effective_to'])
                : null,
            (bool) ($input['emergency'] ?? false),
            $this->idempotencyKey('access.grant'),
        );

        return redirect()->route('access.index')->with('success', 'Scope permission granted.');
    }

    public function requestOrgWideGrant(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'person_id' => ['required', 'string'],
            'permission' => ['required', 'string', 'max:120'],
            'organization_id' => ['required', 'string'],
            'effective_from' => ['required', 'date'],
            'effective_to' => ['nullable', 'date', 'after_or_equal:effective_from'],
            'emergency' => ['sometimes', 'boolean'],
        ]);

        app(GrantScopePermission::class)->request(
            $this->actor(),
            $input['person_id'],
            $input['permission'],
            $input['organization_id'],
            CarbonImmutable::parse($input['effective_from']),
            isset($input['effective_to']) && $input['effective_to'] !== ''
                ? CarbonImmutable::parse($input['effective_to'])
                : null,
            (bool) ($input['emergency'] ?? false),
            $this->idempotencyKey('access.org_wide_grant.request'),
        );

        return redirect()->route('access.index')->with('success', 'Organization-wide grant requested.');
    }

    public function approveOrgWideGrant(Request $request, string $requestId): RedirectResponse
    {
        app(GrantScopePermission::class)->approve(
            $this->actor(),
            OrgWideGrantRequest::query()->findOrFail($requestId),
            $this->idempotencyKey('access.org_wide_grant.approve'),
        );

        return redirect()->route('access.index')->with('success', 'Organization-wide grant signature recorded.');
    }

    public function executeOrgWideGrant(Request $request, string $requestId): RedirectResponse
    {
        app(GrantScopePermission::class)->execute(
            $this->actor(),
            OrgWideGrantRequest::query()->findOrFail($requestId),
            $this->idempotencyKey('access.org_wide_grant.execute'),
        );

        return redirect()->route('access.index')->with('success', 'Organization-wide grant executed.');
    }

    public function revokeGrant(Request $request, string $grantId): RedirectResponse
    {
        app(RevokeScopePermission::class)->revoke(
            $this->actor(),
            ScopeGrant::query()->findOrFail($grantId),
            $this->idempotencyKey('access.revoke'),
        );

        return redirect()->route('access.index')->with('success', 'Scope permission revoked.');
    }

    public function delegate(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'delegator_person_id' => ['required', 'string'],
            'delegate_person_id' => ['required', 'string'],
            'permission' => ['required', 'string', 'max:120'],
            'scope_type' => ['required', 'string', 'in:campus,branch,department,organization'],
            'scope_id' => ['required', 'string'],
            'effective_from' => ['required', 'date'],
            'effective_to' => ['required', 'date', 'after:effective_from'],
            'reason' => ['required', 'string', 'max:1000'],
        ]);

        app(DelegateAuthority::class)->delegate(
            $this->actor(),
            $input['delegator_person_id'],
            $input['delegate_person_id'],
            isset($input['permission']) && $input['permission'] !== '' ? $input['permission'] : null,
            isset($input['scope_type']) && $input['scope_type'] !== '' ? $input['scope_type'] : null,
            isset($input['scope_id']) && $input['scope_id'] !== '' ? $input['scope_id'] : null,
            CarbonImmutable::parse($input['effective_from']),
            CarbonImmutable::parse($input['effective_to']),
            $input['reason'],
            $this->idempotencyKey('access.delegate'),
        );

        return redirect()->route('access.index')->with('success', 'Delegation recorded.');
    }

    public function revokeDelegation(Request $request, string $delegationId): RedirectResponse
    {
        app(RevokeDelegation::class)->revoke(
            $this->actor(),
            Delegation::query()->findOrFail($delegationId),
            $this->idempotencyKey('access.delegate.revoke'),
        );

        return redirect()->route('access.index')->with('success', 'Delegation revoked.');
    }
}
