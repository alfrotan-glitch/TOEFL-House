<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Placement release is an immutable decision event. `updated_at` is merely
 * transport metadata: linking the signed eligibility snapshot and later
 * superseding a profile both change it. A current lifecycle state is likewise
 * not release history. New releases therefore receive their event time from
 * the database transition itself; earlier rows with no exact transition time
 * deliberately remain temporally unresolved instead of being guessed from a
 * snapshot, audit-write, or last-update timestamp.
 */
return new class extends Migration
{
    public function up(): void
    {
        // `stale` means an older definition needs rebuilding; `incomplete`
        // means the fresh computation cannot truthfully cover unresolved
        // historical evidence. Both must be withheld from dashboards.
        DB::statement('ALTER TABLE metric_projections DROP CONSTRAINT IF EXISTS metric_projections_completeness_check');
        DB::statement("ALTER TABLE metric_projections ADD CONSTRAINT metric_projections_completeness_check CHECK (completeness IN ('complete','stale','incomplete'))");

        Schema::table('placement_profiles', function (Blueprint $table): void {
            $table->timestamp('released_at')->nullable();
            $table->string('release_time_basis')->nullable();
            $table->index('released_at', 'placement_profiles_released_at_index');
        });

        // Both columns are null for legacy history with no authoritative
        // release-event clock. Do not backfill from updated_at, the later
        // eligibility snapshot signature, or a later audit write: each can be
        // after the actual transition and can cross a reporting-period edge.
        DB::statement(<<<'SQL'
            ALTER TABLE placement_profiles
                ADD CONSTRAINT placement_profiles_release_time_shape_check
                CHECK (
                    (released_at IS NULL AND release_time_basis IS NULL)
                    OR (
                        released_at IS NOT NULL
                        AND release_time_basis = 'database_transition'
                    )
                ) NOT VALID
            SQL);

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION placement_profile_temporal_facts_guard() RETURNS trigger AS $fn$
            BEGIN
                IF TG_OP = 'INSERT' THEN
                    IF NEW.released_at IS NOT NULL OR NEW.release_time_basis IS NOT NULL THEN
                        RAISE EXCEPTION 'a placement profile release time is assigned only by the approved-to-released database transition'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    RETURN NEW;
                END IF;

                IF OLD.created_at IS DISTINCT FROM NEW.created_at THEN
                    RAISE EXCEPTION 'placement profile creation time is immutable reporting evidence'
                        USING ERRCODE = 'check_violation';
                END IF;

                // Pre-convergence profile history has no trustworthy event
                // timestamp. It may not be relabeled by a direct update.
                IF OLD.lineage_version IS DISTINCT FROM 'placement-evidence-v2' THEN
                    IF OLD.released_at IS DISTINCT FROM NEW.released_at
                       OR OLD.release_time_basis IS DISTINCT FROM NEW.release_time_basis THEN
                        RAISE EXCEPTION 'legacy placement release timing is unresolved historical evidence and cannot be reconstructed in place'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    RETURN NEW;
                END IF;

                // Once recorded, a release event clock and its provenance are
                // immutable even after the profile is superseded or retired.
                IF OLD.released_at IS NOT NULL OR OLD.release_time_basis IS NOT NULL THEN
                    IF OLD.released_at IS DISTINCT FROM NEW.released_at
                       OR OLD.release_time_basis IS DISTINCT FROM NEW.release_time_basis THEN
                        RAISE EXCEPTION 'placement release time is immutable historical evidence'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    RETURN NEW;
                END IF;

                IF OLD.lifecycle_state = 'approved' AND NEW.lifecycle_state = 'released' THEN
                    // Ignore a caller-supplied clock. The database records the
                    // moment it accepts the legal release transition, so raw
                    // SQL cannot fabricate an earlier reporting cohort.
                    NEW.released_at := timezone('UTC', clock_timestamp());
                    NEW.release_time_basis := 'database_transition';
                    RETURN NEW;
                END IF;

                IF NEW.released_at IS NOT NULL OR NEW.release_time_basis IS NOT NULL THEN
                    RAISE EXCEPTION 'placement release time may only be assigned on the approved-to-released transition'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS placement_profile_temporal_facts_guard_trigger ON placement_profiles');
        DB::statement('CREATE TRIGGER placement_profile_temporal_facts_guard_trigger BEFORE INSERT OR UPDATE ON placement_profiles FOR EACH ROW EXECUTE FUNCTION placement_profile_temporal_facts_guard()');
    }

    public function down(): void
    {
        // Existing release cohorts would become irreproducible if this event
        // clock were removed. Use forward remediation, never a downgrade that
        // reopens updated_at/current-state reporting.
        throw new \RuntimeException('Placement release temporal authority is one-way; do not erase immutable release-event timing.');
    }
};
