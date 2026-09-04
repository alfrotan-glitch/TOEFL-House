<?php

declare(strict_types=1);

namespace Database\Seeders;

use App\Modules\Access\Domain\AccessLifecycle;
use App\Modules\Access\Models\AccessPolicy;
use App\Modules\Access\Models\Position;
use App\Modules\Access\Models\PositionAssignment;
use App\Modules\Access\Models\Role;
use App\Modules\Identity\Models\Person;
use App\Modules\Identity\Models\UserAccount;
use App\Modules\Organization\Models\Organization;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Database\Seeder;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;

/**
 * First-run bootstrap — the one operation a fresh deployment has no other
 * way to perform: before the first account exists, nobody holds
 * identity.admin, so the console cannot create the first administrator.
 *
 * This seeder writes the same authoritative records the governed access
 * model uses (bootstrap organization, a role with the complete canonical
 * capability set, a position bound to that role, an active assignment, and
 * the owner's verified person + user account). It is a deployment
 * bootstrap, not a parallel workflow:
 *
 *   * It runs ONLY while the system is uninitialized (zero user accounts).
 *     On any live system it is a no-op — it can never touch, overwrite, or
 *     compete with records the console workflows created.
 *   * The owner's capability set is the COMPLETE canonical set: every
 *     capability constant defined by the modules. WindowsOneClickDeployment
 *     ContractTest asserts this list equals the set of CAPABILITY*
 *     constants found in the source, so a new capability can never be
 *     silently missing from the bootstrap.
 *
 * Input (environment variables, set by the one-click launcher — never
 * stored anywhere except the bcrypt hash of the password in user_accounts):
 *   BOOTSTRAP_OWNER_NAME     full legal name
 *   BOOTSTRAP_OWNER_BIRTHDATE  YYYY-MM-DD
 *   BOOTSTRAP_OWNER_USERNAME
 *   BOOTSTRAP_OWNER_PASSWORD
 */
final class FirstRunBootstrapSeeder extends Seeder
{
    /**
     * The complete canonical capability set (one entry per CAPABILITY*
     * constant in app/Modules). Owned by the first-run Owner role.
     *
     * @var list<string>
     */
    public const OWNER_CAPABILITIES = [
        'academic.appeal_manage', 'academic.approve_result', 'academic.assess', 'academic.attendance', 'academic.certify', 'academic.completion', 'academic.completion_approve', 'academic.enroll', 'academic.enroll_approve', 'academic.moderate', 'academic.progression_approve', 'academic.progression_propose', 'academic.progression_review', 'academic.release', 'academic.schedule', 'academic.skill', 'academic.structure',
        'access.approve_org_wide', 'access.assign_position', 'access.define_policy', 'access.delegate', 'access.grant', 'access.revoke',
        'admissions.approve', 'admissions.initiate', 'admissions.register', 'admissions.review',
        'communication.send',
        'crm.automation', 'crm.catalog', 'crm.followup', 'crm.visitor', 'crm.visitor.convert',
        'documents.classify', 'documents.register', 'documents.retention', 'documents.verify',
        'facilities.work', 'facilities.work_approve',
        'finance.chart', 'finance.discount', 'finance.discount_approve', 'finance.fund', 'finance.fund_allocate', 'finance.journal', 'finance.obligation', 'finance.opening.approve', 'finance.opening.prepare', 'finance.payment', 'finance.period', 'finance.reconcile', 'finance.reconcile_approve', 'finance.refund', 'finance.refund_approve',
        'governance.config',
        'hr.contract', 'hr.contract.approve', 'hr.contract.prepare', 'hr.employ', 'hr.leave_approve', 'hr.leave_request', 'hr.scale', 'hr.terminate',
        'identity.admin', 'identity.verify',
        'integrations.dispatch', 'integrations.endpoint', 'integrations.inbound', 'integrations.jobs', 'integrations.process', 'integrations.review',
        'payroll.adjust', 'payroll.approve', 'payroll.calculate', 'payroll.clear_finance', 'payroll.clear_hr', 'payroll.period', 'payroll.settle', 'payroll.settle_approve',
        'placement.approve', 'placement.catalog', 'placement.conduct', 'placement.moderate', 'placement.recommend', 'placement.release', 'placement.score',
        'privacy.approve_bulk_export', 'privacy.consent', 'privacy.define_purpose', 'privacy.disclose', 'privacy.export',
        'reporting.catalog', 'reporting.compute', 'reporting.dashboard', 'reporting.reconcile', 'reporting.run',
        'resources.asset', 'resources.books', 'resources.dispose_approve', 'resources.dispose_request',
        'students.guardian', 'students.manage', 'students.reactivate',
    ];

    public function run(): void
    {
        if (UserAccount::query()->exists()) {
            $this->command?->info('System already initialized (user accounts exist). Bootstrap is a no-op — nothing was changed.');

            return;
        }

        $name = trim((string) env('BOOTSTRAP_OWNER_NAME'));
        $birthdate = trim((string) env('BOOTSTRAP_OWNER_BIRTHDATE'));
        $username = trim((string) env('BOOTSTRAP_OWNER_USERNAME'));
        $password = (string) env('BOOTSTRAP_OWNER_PASSWORD');

        if ($name === '' || $birthdate === '' || $username === '' || $password === '') {
            $this->command?->error('BOOTSTRAP_OWNER_NAME, BOOTSTRAP_OWNER_BIRTHDATE, BOOTSTRAP_OWNER_USERNAME and BOOTSTRAP_OWNER_PASSWORD must all be set (the launcher prompts for them on first run).');

            return;
        }

        $today = CarbonImmutable::now()->toDateString();

        DB::transaction(function () use ($name, $birthdate, $username, $password, $today): void {
            $ownerPerson = Person::query()->create([
                'id' => RandomIdentifier::new(),
                'legal_name' => $name,
                'date_of_birth' => $birthdate,
                'verification_state' => Person::VERIFICATION_VERIFIED,
                'identity_key' => 'owner-'.$username,
                'identity_evidence_ref' => 'first-run-bootstrap/'.$username,
                'verified_by' => 'first-run-bootstrap',
                'verified_at' => now()->toDateTimeString(),
            ]);

            $organization = Organization::query()->create([
                'id' => RandomIdentifier::new(),
                'name' => 'The TOEFL House',
                'lifecycle_state' => 'active',
            ]);

            $role = Role::query()->create([
                'id' => RandomIdentifier::new(),
                'name' => 'Owner',
            ]);
            foreach (self::OWNER_CAPABILITIES as $capability) {
                AccessPolicy::query()->create([
                    'id' => RandomIdentifier::new(),
                    'binding_type' => 'role',
                    'binding_id' => $role->id,
                    'grants_type' => AccessPolicy::GRANTS_PERMISSION,
                    'grants_id' => null,
                    'permission' => $capability,
                    'effective_from' => $today,
                    'effective_to' => null,
                    'published_by' => $ownerPerson->id,
                ]);
            }

            $position = Position::query()->create([
                'id' => RandomIdentifier::new(),
                'organization_id' => $organization->id,
                'name' => 'Owner',
            ]);
            AccessPolicy::query()->create([
                'id' => RandomIdentifier::new(),
                'binding_type' => 'position',
                'binding_id' => $position->id,
                'grants_type' => AccessPolicy::GRANTS_ROLE,
                'grants_id' => $role->id,
                'permission' => '',
                'effective_from' => $today,
                'effective_to' => null,
                'published_by' => $ownerPerson->id,
            ]);

            PositionAssignment::query()->create([
                'id' => RandomIdentifier::new(),
                'person_id' => $ownerPerson->id,
                'position_id' => $position->id,
                'lifecycle_state' => AccessLifecycle::STATE_ACTIVE,
                'effective_from' => $today,
                'effective_to' => null,
                'assigned_by' => $ownerPerson->id,
            ]);

            UserAccount::query()->create([
                'id' => RandomIdentifier::new(),
                'person_id' => $ownerPerson->id,
                'username' => $username,
                'password_hash' => Hash::make($password),
                'account_state' => UserAccount::STATE_ACTIVE,
            ]);
        });

        $this->command?->info('First-run bootstrap complete: organization "The TOEFL House", Owner role ('.count(self::OWNER_CAPABILITIES).' capabilities) and account "'.$username.'" created.');
        $this->command?->info('Sign in with that account to begin. From now on every further account is created through the console access workflow.');
    }
}
