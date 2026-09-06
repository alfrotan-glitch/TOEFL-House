<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * WP-2 F1 (WP2-DEC-01): multi-branch operational provenance and scope semantics.
 *
 * Foundations added (all additive / nullable — no fabricated historical backfill):
 *
 *   1. people.home_branch_id           — current home-branch DESIGNATION (identity
 *                                        level). It is a designation and must never
 *                                        be promoted to financial truth.
 *   2. Operational provenance on the branch-originating anchor aggregates:
 *          students.originating_branch_id       (origin of the student record)
 *          enrollments.originating_branch_id    (branch that ran the enrolled class)
 *          obligations.originating_branch_id    (branch that posted the obligation)
 *          certificates.originating_branch_id   (branch that issued the certificate)
 *      A NULL originating branch is a first-class "unassigned / unknown-provenance"
 *      state (reported, never silently mapped to an arbitrary branch). Existing rows
 *      are left NULL; only new writes may populate provenance.
 *   3. branch_scope_links             — typed relational junction (real FKs both
 *                                        ends) recording that one branch is within
 *                                        the same affected scope as another over an
 *                                        effective window, for cross-branch
 *                                        affected-scope authorization/reporting.
 *                                        Exactly one OPEN link per owner branch is
 *                                        enforced by a partial unique index.
 *
 * Invariant guards (schema-level, mirroring the domain):
 *   - originating_branch_id is IMMUTABLE once set (UPDATE trigger on each anchor);
 *     provenance can therefore never be rewritten by a later branch transfer.
 *   - branch_scope_links cannot self-link and require real branches/campus/actors.
 */
return new class extends Migration
{
    public function up(): void
    {
        // 1. Home-branch designation on the identity aggregate.
        Schema::table('people', function (Blueprint $table): void {
            $table->char('home_branch_id', 36)->nullable()->after('verified_by');
            $table->foreign('home_branch_id')->references('id')->on('branches');
        });

        // 2. Operational provenance on the branch-originating anchors.
        Schema::table('students', function (Blueprint $table): void {
            $table->char('originating_branch_id', 36)->nullable()->after('student_code');
            $table->foreign('originating_branch_id')->references('id')->on('branches');
        });
        Schema::table('enrollments', function (Blueprint $table): void {
            $table->char('originating_branch_id', 36)->nullable();
            $table->foreign('originating_branch_id')->references('id')->on('branches');
        });
        Schema::table('obligations', function (Blueprint $table): void {
            $table->char('originating_branch_id', 36)->nullable();
            $table->foreign('originating_branch_id')->references('id')->on('branches');
        });
        Schema::table('certificates', function (Blueprint $table): void {
            $table->char('originating_branch_id', 36)->nullable();
            $table->foreign('originating_branch_id')->references('id')->on('branches');
        });

        // 3. Cross-branch affected-scope junction.
        Schema::create('branch_scope_links', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('owner_branch_id', 36);
            $table->char('affected_branch_id', 36);
            $table->date('effective_from');
            $table->date('effective_to')->nullable();
            $table->string('lifecycle_state');
            $table->char('created_by', 36);
            $table->string('correlation_id');
            $table->timestamp('created_at')->useCurrent();
            $table->foreign('owner_branch_id')->references('id')->on('branches');
            $table->foreign('affected_branch_id')->references('id')->on('branches');
            $table->foreign('created_by')->references('id')->on('people');
        });
        Schema::table('branch_scope_links', function (Blueprint $table): void {
            // One OPEN scope link per owner branch (closed links append history).
            DB::statement('CREATE UNIQUE INDEX branch_scope_links_one_open_owner ON branch_scope_links(owner_branch_id) WHERE lifecycle_state = \'active\'');
        });
        DB::statement('ALTER TABLE branch_scope_links ADD CONSTRAINT branch_scope_links_no_self_link CHECK (owner_branch_id <> affected_branch_id)');

        // Immutability guards for provenance on every anchor aggregate.
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION guard_originating_branch_immutable() RETURNS trigger AS $fn$
            BEGIN
                IF OLD.originating_branch_id IS NOT NULL
                   AND NEW.originating_branch_id IS DISTINCT FROM OLD.originating_branch_id THEN
                    RAISE EXCEPTION 'originating_branch_id is immutable once assigned'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql
        SQL);
        foreach (['students', 'enrollments', 'obligations', 'certificates'] as $tableName) {
            DB::statement(sprintf(
                'CREATE TRIGGER %1$s_originating_immutable BEFORE UPDATE OF originating_branch_id ON %1$s FOR EACH ROW EXECUTE FUNCTION guard_originating_branch_immutable()',
                $tableName,
            ));
        }
    }

    public function down(): void
    {
        foreach (['students', 'enrollments', 'obligations', 'certificates'] as $tableName) {
            DB::statement(sprintf('DROP TRIGGER IF EXISTS %1$s_originating_immutable ON %1$s', $tableName));
        }
        DB::statement('DROP FUNCTION IF EXISTS guard_originating_branch_immutable()');

        Schema::dropIfExists('branch_scope_links');

        Schema::table('certificates', function (Blueprint $table): void {
            $table->dropForeign(['originating_branch_id']);
            $table->dropColumn('originating_branch_id');
        });
        Schema::table('obligations', function (Blueprint $table): void {
            $table->dropForeign(['originating_branch_id']);
            $table->dropColumn('originating_branch_id');
        });
        Schema::table('enrollments', function (Blueprint $table): void {
            $table->dropForeign(['originating_branch_id']);
            $table->dropColumn('originating_branch_id');
        });
        Schema::table('students', function (Blueprint $table): void {
            $table->dropForeign(['originating_branch_id']);
            $table->dropColumn('originating_branch_id');
        });
        Schema::table('people', function (Blueprint $table): void {
            $table->dropForeign(['home_branch_id']);
            $table->dropColumn('home_branch_id');
        });
    }
};
