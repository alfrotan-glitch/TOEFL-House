<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * AC1 signed, versioned, immutable academic eligibility snapshot.
 *
 * - Created atomically with a Placement profile's `released` transition.
 * - Stores the exact signed canonical payload plus its SHA-256 digest and a
 *   server-side HMAC-SHA256 signature using a key outside domain data.
 * - Append-only: no UPDATE/DELETE after insertion; one snapshot per released
 *   placement profile.
 * - Downstream references: profile -> latest snapshot; applicant/student ->
 *   the snapshot consumed at registration/conversion; enrollment -> the
 *   current snapshot on the student's record.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('academic_eligibility_snapshots', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('placement_profile_id', 36);
            $table->char('placement_recommendation_id', 36);
            $table->char('person_id', 36);
            $table->char('visitor_id', 36)->nullable();
            $table->string('snapshot_schema_version');
            $table->unsignedInteger('version_no')->default(1);
            $table->char('program_version_id', 36)->nullable();
            $table->char('recommended_level_id', 36)->nullable();
            $table->char('recommended_class_id', 36)->nullable();
            $table->char('recommended_offering_id', 36)->nullable();
            $table->char('academic_period_id', 36)->nullable();
            $table->char('originating_branch_id', 36)->nullable();
            $table->char('current_home_branch_id', 36)->nullable();
            $table->jsonb('payload');
            $table->text('payload_canonical_json');
            $table->char('payload_sha256', 64);
            $table->string('signature_algorithm')->default('hmac-sha256');
            $table->char('signature', 64);
            $table->string('signing_key_version');
            $table->char('signed_by', 36);
            $table->timestamp('signed_at');
            $table->char('supersedes_snapshot_id', 36)->nullable();
            $table->timestamps();

            $table->foreign('placement_profile_id')->references('id')->on('placement_profiles');
            $table->foreign('placement_recommendation_id')->references('id')->on('placement_recommendations');
            $table->foreign('person_id')->references('id')->on('people');
            $table->foreign('visitor_id')->references('id')->on('visitors');
            $table->foreign('program_version_id')->references('id')->on('program_versions');
            $table->foreign('recommended_level_id')->references('id')->on('program_version_levels');
            $table->foreign('recommended_class_id')->references('id')->on('classes');
            $table->foreign('recommended_offering_id')->references('id')->on('offerings');
            $table->foreign('academic_period_id')->references('id')->on('academic_periods');
            $table->foreign('originating_branch_id')->references('id')->on('branches');
            $table->foreign('current_home_branch_id')->references('id')->on('branches');
            $table->foreign('signed_by')->references('id')->on('people');
        });

        // Self-reference is added outside the CREATE TABLE statement; keeping it
        // separate avoids Postgres temporarily rejecting a unique-match lookup
        // against the same table while Laravel is still wiring the primary key.
        Schema::table('academic_eligibility_snapshots', function (Blueprint $table): void {
            $table->foreign('supersedes_snapshot_id')->references('id')->on('academic_eligibility_snapshots');
        });

        DB::statement('CREATE UNIQUE INDEX academic_eligibility_snapshots_profile_version_unique ON academic_eligibility_snapshots (placement_profile_id, version_no)');
        DB::statement('ALTER TABLE academic_eligibility_snapshots ADD CONSTRAINT academic_eligibility_snapshots_version_check CHECK (version_no > 0)');
        DB::statement("ALTER TABLE academic_eligibility_snapshots ADD CONSTRAINT academic_eligibility_snapshots_schema_check CHECK (snapshot_schema_version <> '')");
        DB::statement('ALTER TABLE academic_eligibility_snapshots ADD CONSTRAINT academic_eligibility_snapshots_sha_check CHECK (payload_sha256 ~ \'^[0-9a-f]{64}$\')');
        DB::statement("ALTER TABLE academic_eligibility_snapshots ADD CONSTRAINT academic_eligibility_snapshots_signature_check CHECK (signature ~ '^[0-9a-f]{64}$')");
        DB::statement("ALTER TABLE academic_eligibility_snapshots ADD CONSTRAINT academic_eligibility_snapshots_algorithm_check CHECK (signature_algorithm = 'hmac-sha256')");
        DB::statement("ALTER TABLE academic_eligibility_snapshots ADD CONSTRAINT academic_eligibility_snapshots_key_version_check CHECK (signing_key_version <> '')");

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION academic_eligibility_snapshots_append_only() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'academic eligibility snapshots are signed immutable history; a retake publishes a new snapshot'
                    USING ERRCODE = 'check_violation';
            END;
            $fn$ LANGUAGE plpgsql
        SQL);
        DB::statement('CREATE TRIGGER academic_eligibility_snapshots_append_only BEFORE UPDATE OR DELETE ON academic_eligibility_snapshots FOR EACH ROW EXECUTE FUNCTION academic_eligibility_snapshots_append_only()');

        Schema::table('placement_profiles', function (Blueprint $table): void {
            $table->char('academic_eligibility_snapshot_id', 36)->nullable()->after('released_by');
            $table->foreign('academic_eligibility_snapshot_id')->references('id')->on('academic_eligibility_snapshots');
        });

        Schema::table('applicants', function (Blueprint $table): void {
            $table->char('academic_eligibility_snapshot_id', 36)->nullable()->after('placement_profile_id');
            $table->foreign('academic_eligibility_snapshot_id')->references('id')->on('academic_eligibility_snapshots');
        });

        Schema::table('students', function (Blueprint $table): void {
            $table->char('academic_eligibility_snapshot_id', 36)->nullable()->after('placement_profile_id');
            $table->foreign('academic_eligibility_snapshot_id')->references('id')->on('academic_eligibility_snapshots');
        });

        Schema::table('enrollments', function (Blueprint $table): void {
            $table->char('academic_eligibility_snapshot_id', 36)->nullable()->after('offering_id');
            $table->foreign('academic_eligibility_snapshot_id')->references('id')->on('academic_eligibility_snapshots');
        });
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS academic_eligibility_snapshots_append_only ON academic_eligibility_snapshots');
        DB::statement('DROP FUNCTION IF EXISTS academic_eligibility_snapshots_append_only()');

        Schema::table('enrollments', function (Blueprint $table): void {
            $table->dropForeign(['academic_eligibility_snapshot_id']);
            $table->dropColumn('academic_eligibility_snapshot_id');
        });
        Schema::table('students', function (Blueprint $table): void {
            $table->dropForeign(['academic_eligibility_snapshot_id']);
            $table->dropColumn('academic_eligibility_snapshot_id');
        });
        Schema::table('applicants', function (Blueprint $table): void {
            $table->dropForeign(['academic_eligibility_snapshot_id']);
            $table->dropColumn('academic_eligibility_snapshot_id');
        });
        Schema::table('placement_profiles', function (Blueprint $table): void {
            $table->dropForeign(['academic_eligibility_snapshot_id']);
            $table->dropColumn('academic_eligibility_snapshot_id');
        });

        Schema::dropIfExists('academic_eligibility_snapshots');
    }
};
