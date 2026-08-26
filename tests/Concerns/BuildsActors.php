<?php

declare(strict_types=1);

namespace Tests\Concerns;

use App\Support\Authorization\Actor;

/**
 * Actor fixtures of the authority registry roles. Identity only: authority
 * itself is seeded into the canonical access model and resolved by the
 * server policy decision.
 */
trait BuildsActors
{
    use SeedsAuthority;

    private function generalManager(string $actorId = 'gm-1'): Actor
    {
        $this->personWithAuthority($actorId, ['organization.structure.initiate']);

        return new Actor($actorId, 'General Manager');
    }

    private function structureManager(string $scopeKey, string $actorId = 'mgr-1'): Actor
    {
        $this->personWithAuthority($actorId, []);
        $this->grantScopeAuthority($actorId, ['organization.structure.review'], 'organization', $this->organizationIdFromScopeKey($scopeKey));

        return new Actor($actorId, 'Structure Manager');
    }

    private function structureOwner(string $scopeKey, string $actorId): Actor
    {
        $this->personWithAuthority($actorId, []);
        $this->grantScopeAuthority($actorId, ['organization.structure.approve'], 'organization', $this->organizationIdFromScopeKey($scopeKey));

        return new Actor($actorId, 'Owner');
    }

    private function identityVerifier(string $actorId = 'idv-1'): Actor
    {
        $this->personWithAuthority($actorId, ['identity.verify']);

        return new Actor($actorId, 'Identity Verifier');
    }

    private function identityAdministrator(string $actorId = 'ida-1'): Actor
    {
        $this->personWithAuthority($actorId, ['identity.admin']);

        return new Actor($actorId, 'Identity Administrator');
    }

    private function actorWithoutAnyCapability(string $actorId = 'nobody-1'): Actor
    {
        $this->personWithAuthority($actorId, []);

        return new Actor($actorId, 'Unauthorized Actor');
    }

    private function accessAdministrator(string $actorId = 'acc-1'): Actor
    {
        $this->personWithAuthority($actorId, [
            'access.grant', 'access.revoke', 'access.approve_org_wide',
            'access.define_policy', 'access.assign_position', 'access.delegate',
        ]);

        return new Actor($actorId, 'Access Administrator');
    }

    private function actorWithStructureCapabilities(string $actorId, array $capabilities): Actor
    {
        $this->personWithAuthority($actorId, $capabilities);

        return new Actor($actorId, 'Multi-Capability Actor');
    }

    private function privacyOfficer(string $actorId = 'priv-1'): Actor
    {
        $this->personWithAuthority($actorId, [
            'privacy.define_purpose', 'privacy.consent', 'privacy.disclose', 'privacy.export',
        ]);

        return new Actor($actorId, 'Privacy Officer');
    }

    private function documentsOfficer(string $actorId = 'doc-1'): Actor
    {
        $this->personWithAuthority($actorId, [
            'documents.classify', 'documents.register', 'documents.verify', 'documents.retention',
        ]);

        return new Actor($actorId, 'Documents Officer');
    }

    private function admissionsClerk(string $actorId = 'adm-reception-1'): Actor
    {
        $this->personWithAuthority($actorId, ['admissions.register', 'admissions.initiate']);

        return new Actor($actorId, 'Admissions Clerk');
    }

    private function admissionsReviewer(string $actorId = 'adm-review-1'): Actor
    {
        $this->personWithAuthority($actorId, ['admissions.review']);

        return new Actor($actorId, 'Admissions Reviewer');
    }

    private function admissionsApprover(string $actorId = 'adm-approve-1'): Actor
    {
        $this->personWithAuthority($actorId, ['admissions.approve']);

        return new Actor($actorId, 'Admissions Approver');
    }

    private function studentManager(string $actorId = 'stu-mgr-1'): Actor
    {
        $this->personWithAuthority($actorId, ['students.manage', 'students.guardian']);

        return new Actor($actorId, 'Student Manager');
    }

    private function studentReactivator(string $actorId = 'stu-react-1'): Actor
    {
        $this->personWithAuthority($actorId, ['students.reactivate']);

        return new Actor($actorId, 'Reactivation Approver');
    }

    private function academicOfficer(string $actorId = 'acad-officer-1'): Actor
    {
        $this->personWithAuthority($actorId, ['academic.structure', 'academic.schedule', 'academic.enroll_approve', 'academic.attendance']);

        return new Actor($actorId, 'Academic Officer');
    }

    private function enrollmentClerk(string $actorId = 'acad-clerk-1'): Actor
    {
        $this->personWithAuthority($actorId, ['academic.enroll']);

        return new Actor($actorId, 'Enrollment Clerk');
    }

    private function grantedActor(string $actorId, array $capabilities): Actor
    {
        $this->personWithAuthority($actorId, $capabilities);

        return new Actor($actorId, 'Granted Actor');
    }

    private function organizationIdFromScopeKey(string $scopeKey): string
    {
        return str_contains($scopeKey, ':') ? explode(':', $scopeKey, 2)[1] : $this->bootstrapOrganizationId;
    }
}
