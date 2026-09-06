<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Consolidated pre-production Teacher/Faculty authority convergence.
 * Identity and HR employment remain separate authorities; this migration
 * creates the canonical Teacher capability, provenance, assignment guards,
 * payroll evidence guard, and append-only lifecycle history in one target
 * schema step.
 */
return new class extends Migration
{
    public function up(): void
    {

        Schema::create('teacher_profiles', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('person_id', 36);
            $table->char('employment_id', 36);
            $table->char('originating_branch_id', 36);
            $table->char('current_home_branch_id', 36);
            $table->string('lifecycle_state');
            $table->string('professional_title')->nullable();
            $table->text('profile_summary')->nullable();
            $table->char('approved_by', 36)->nullable();
            $table->timestamp('approved_at')->nullable();
            $table->timestamps();
            $table->foreign('person_id')->references('id')->on('people');
            $table->foreign('employment_id')->references('id')->on('employments');
            $table->foreign('originating_branch_id')->references('id')->on('branches');
            $table->foreign('current_home_branch_id')->references('id')->on('branches');
            $table->unique('person_id', 'teacher_profiles_one_per_person');
            $table->unique('employment_id', 'teacher_profiles_one_per_employment');
        });
        DB::statement("ALTER TABLE teacher_profiles ADD CONSTRAINT teacher_profiles_state_check CHECK (lifecycle_state IN ('pending','active','suspended','retired'))");

        Schema::create('teacher_profile_branches', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('teacher_profile_id', 36);
            $table->char('branch_id', 36);
            $table->date('effective_from');
            $table->date('effective_to')->nullable();
            $table->string('lifecycle_state');
            $table->string('provenance_reason');
            $table->char('approved_by', 36);
            $table->timestamps();
            $table->foreign('teacher_profile_id')->references('id')->on('teacher_profiles');
            $table->foreign('branch_id')->references('id')->on('branches');
            $table->unique(['teacher_profile_id', 'branch_id', 'effective_from'], 'teacher_profile_branches_identity');
        });
        DB::statement("ALTER TABLE teacher_profile_branches ADD CONSTRAINT teacher_profile_branches_state_check CHECK (lifecycle_state IN ('planned','active','ended','revoked'))");
        DB::statement("ALTER TABLE teacher_profile_branches ADD CONSTRAINT teacher_profile_branches_period_check CHECK (effective_to IS NULL OR effective_to > effective_from)");

        Schema::create('teacher_qualifications', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('teacher_profile_id', 36);
            $table->string('qualification_type');
            $table->string('title');
            $table->string('issuer');
            $table->string('evidence_ref');
            $table->char('submitted_by', 36)->nullable();
            $table->date('valid_from')->nullable();
            $table->date('valid_to')->nullable();
            $table->string('lifecycle_state');
            $table->char('verified_by', 36)->nullable();
            $table->timestamp('verified_at')->nullable();
            $table->timestamps();
            $table->foreign('teacher_profile_id')->references('id')->on('teacher_profiles');
        });
        DB::statement("ALTER TABLE teacher_qualifications ADD CONSTRAINT teacher_qualifications_state_check CHECK (lifecycle_state IN ('pending','verified','expired','revoked'))");
        DB::statement("ALTER TABLE teacher_qualifications ADD CONSTRAINT teacher_qualifications_period_check CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)");

        Schema::create('teacher_skill_authorities', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('teacher_profile_id', 36);
            $table->char('skill_id', 36);
            $table->char('branch_id', 36);
            $table->string('authority_kind');
            $table->date('effective_from');
            $table->date('effective_to')->nullable();
            $table->string('lifecycle_state');
            $table->char('approved_by', 36);
            $table->string('evidence_ref');
            $table->timestamps();
            $table->foreign('teacher_profile_id')->references('id')->on('teacher_profiles');
            $table->foreign('skill_id')->references('id')->on('skills');
            $table->foreign('branch_id')->references('id')->on('branches');
            $table->unique(['teacher_profile_id', 'skill_id', 'branch_id', 'authority_kind', 'effective_from'], 'teacher_skill_authorities_identity');
        });
        DB::statement("ALTER TABLE teacher_skill_authorities ADD CONSTRAINT teacher_skill_authorities_kind_check CHECK (authority_kind IN ('teach','assess','moderate'))");
        DB::statement("ALTER TABLE teacher_skill_authorities ADD CONSTRAINT teacher_skill_authorities_state_check CHECK (lifecycle_state IN ('planned','active','ended','revoked'))");
        DB::statement("ALTER TABLE teacher_skill_authorities ADD CONSTRAINT teacher_skill_authorities_period_check CHECK (effective_to IS NULL OR effective_to > effective_from)");

        Schema::create('teacher_availabilities', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('teacher_profile_id', 36);
            $table->unsignedSmallInteger('weekday');
            $table->time('starts_at');
            $table->time('ends_at');
            $table->date('effective_from');
            $table->date('effective_to')->nullable();
            $table->string('lifecycle_state');
            $table->string('availability_kind');
            $table->char('branch_id', 36);
            $table->timestamps();
            $table->foreign('teacher_profile_id')->references('id')->on('teacher_profiles');
            $table->foreign('branch_id')->references('id')->on('branches');
            $table->unique(['teacher_profile_id', 'weekday', 'starts_at', 'effective_from'], 'teacher_availabilities_identity');
        });
        DB::statement("ALTER TABLE teacher_availabilities ADD CONSTRAINT teacher_availabilities_weekday_check CHECK (weekday BETWEEN 1 AND 7)");
        DB::statement("ALTER TABLE teacher_availabilities ADD CONSTRAINT teacher_availabilities_time_check CHECK (ends_at > starts_at)");
        DB::statement("ALTER TABLE teacher_availabilities ADD CONSTRAINT teacher_availabilities_period_check CHECK (effective_to IS NULL OR effective_to > effective_from)");
        DB::statement("ALTER TABLE teacher_availabilities ADD CONSTRAINT teacher_availabilities_state_check CHECK (lifecycle_state IN ('planned','active','ended','revoked'))");
        DB::statement("ALTER TABLE teacher_availabilities ADD CONSTRAINT teacher_availabilities_kind_check CHECK (availability_kind IN ('available','unavailable'))");

        Schema::create('teacher_workload_limits', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('teacher_profile_id', 36);
            $table->char('branch_id', 36);
            $table->decimal('max_hours_per_week', 6, 2);
            $table->date('effective_from');
            $table->date('effective_to')->nullable();
            $table->string('lifecycle_state');
            $table->char('approved_by', 36);
            $table->string('evidence_ref');
            $table->timestamps();
            $table->foreign('teacher_profile_id')->references('id')->on('teacher_profiles');
            $table->foreign('branch_id')->references('id')->on('branches');
            $table->unique(['teacher_profile_id', 'branch_id', 'effective_from'], 'teacher_workload_limits_identity');
        });
        DB::statement("ALTER TABLE teacher_workload_limits ADD CONSTRAINT teacher_workload_limits_hours_check CHECK (max_hours_per_week > 0)");
        DB::statement("ALTER TABLE teacher_workload_limits ADD CONSTRAINT teacher_workload_limits_period_check CHECK (effective_to IS NULL OR effective_to > effective_from)");
        DB::statement("ALTER TABLE teacher_workload_limits ADD CONSTRAINT teacher_workload_limits_state_check CHECK (lifecycle_state IN ('planned','active','ended','revoked'))");

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION teacher_authority_reference_guard() RETURNS trigger AS $fn$
            DECLARE
                profile_state text;
                employment_state text;
                person_id char(36);
                profile_person char(36);
                branch_state text;
                profile_branch char(36);
            BEGIN
                SELECT tp.lifecycle_state, tp.person_id, e.lifecycle_state
                  INTO profile_state, profile_person, employment_state
                  FROM teacher_profiles tp
                  JOIN employments e ON e.id = tp.employment_id
                 WHERE tp.id = NEW.teacher_profile_id;
                IF profile_state IS NULL OR profile_person IS NULL THEN
                    RAISE EXCEPTION 'teacher authority requires an existing profile'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'teacher_qualifications'
                   AND OLD.lifecycle_state IS DISTINCT FROM NEW.lifecycle_state THEN
                    IF OLD.lifecycle_state = 'pending' AND NEW.lifecycle_state NOT IN ('pending', 'verified', 'expired', 'revoked') THEN
                        RAISE EXCEPTION 'pending teacher qualification cannot move to %', NEW.lifecycle_state USING ERRCODE = 'check_violation';
                    ELSIF OLD.lifecycle_state = 'verified' AND NEW.lifecycle_state NOT IN ('verified', 'expired', 'revoked') THEN
                        RAISE EXCEPTION 'verified teacher qualification cannot move to %', NEW.lifecycle_state USING ERRCODE = 'check_violation';
                    ELSIF OLD.lifecycle_state IN ('expired', 'revoked') AND NEW.lifecycle_state <> OLD.lifecycle_state THEN
                        RAISE EXCEPTION 'terminal teacher qualification state is final' USING ERRCODE = 'check_violation';
                    END IF;
                ELSIF TG_OP = 'UPDATE' AND TG_TABLE_NAME IN ('teacher_profile_branches', 'teacher_skill_authorities', 'teacher_availabilities', 'teacher_workload_limits')
                   AND OLD.lifecycle_state IS DISTINCT FROM NEW.lifecycle_state THEN
                    IF OLD.lifecycle_state = 'planned' AND NEW.lifecycle_state NOT IN ('planned', 'active', 'revoked') THEN
                        RAISE EXCEPTION 'planned teacher authority cannot move to %', NEW.lifecycle_state USING ERRCODE = 'check_violation';
                    ELSIF OLD.lifecycle_state = 'active' AND NEW.lifecycle_state NOT IN ('active', 'ended', 'revoked') THEN
                        RAISE EXCEPTION 'active teacher authority cannot move to %', NEW.lifecycle_state USING ERRCODE = 'check_violation';
                    ELSIF OLD.lifecycle_state IN ('ended', 'revoked') AND NEW.lifecycle_state <> OLD.lifecycle_state THEN
                        RAISE EXCEPTION 'terminal teacher authority state is final' USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                IF TG_TABLE_NAME IN ('teacher_profile_branches', 'teacher_skill_authorities', 'teacher_availabilities', 'teacher_workload_limits')
                   AND NEW.lifecycle_state = 'ended' AND NEW.effective_to IS NULL THEN
                    RAISE EXCEPTION 'ended teacher authority requires an effective end date'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'teacher_qualifications'
                   AND OLD.lifecycle_state IN ('verified', 'expired', 'revoked')
                   AND (
                       NEW.teacher_profile_id IS DISTINCT FROM OLD.teacher_profile_id
                       OR NEW.qualification_type IS DISTINCT FROM OLD.qualification_type
                       OR NEW.title IS DISTINCT FROM OLD.title
                       OR NEW.issuer IS DISTINCT FROM OLD.issuer
                       OR NEW.evidence_ref IS DISTINCT FROM OLD.evidence_ref
                       OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
                       OR NEW.valid_from IS DISTINCT FROM OLD.valid_from
                       OR NEW.valid_to IS DISTINCT FROM OLD.valid_to
                       OR NEW.verified_by IS DISTINCT FROM OLD.verified_by
                       OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
                   ) THEN
                    RAISE EXCEPTION 'verified teacher qualification evidence is immutable'
                        USING ERRCODE = 'check_violation';
                ELSIF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'teacher_profile_branches'
                   AND (
                       NEW.teacher_profile_id IS DISTINCT FROM OLD.teacher_profile_id
                       OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
                       OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
                       OR NEW.provenance_reason IS DISTINCT FROM OLD.provenance_reason
                       OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
                   ) THEN
                    RAISE EXCEPTION 'teacher branch authorization identity and provenance are immutable'
                        USING ERRCODE = 'check_violation';
                ELSIF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'teacher_skill_authorities'
                   AND (
                       NEW.teacher_profile_id IS DISTINCT FROM OLD.teacher_profile_id
                       OR NEW.skill_id IS DISTINCT FROM OLD.skill_id
                       OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
                       OR NEW.authority_kind IS DISTINCT FROM OLD.authority_kind
                       OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
                       OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
                       OR NEW.evidence_ref IS DISTINCT FROM OLD.evidence_ref
                   ) THEN
                    RAISE EXCEPTION 'teacher subject authority identity and evidence are immutable'
                        USING ERRCODE = 'check_violation';
                ELSIF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'teacher_availabilities'
                   AND (
                       NEW.teacher_profile_id IS DISTINCT FROM OLD.teacher_profile_id
                       OR NEW.weekday IS DISTINCT FROM OLD.weekday
                       OR NEW.starts_at IS DISTINCT FROM OLD.starts_at
                       OR NEW.ends_at IS DISTINCT FROM OLD.ends_at
                       OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
                       OR NEW.availability_kind IS DISTINCT FROM OLD.availability_kind
                       OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
                   ) THEN
                    RAISE EXCEPTION 'teacher availability identity is immutable'
                        USING ERRCODE = 'check_violation';
                ELSIF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'teacher_workload_limits'
                   AND (
                       NEW.teacher_profile_id IS DISTINCT FROM OLD.teacher_profile_id
                       OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
                       OR NEW.max_hours_per_week IS DISTINCT FROM OLD.max_hours_per_week
                       OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
                       OR NEW.approved_by IS DISTINCT FROM OLD.approved_by
                       OR NEW.evidence_ref IS DISTINCT FROM OLD.evidence_ref
                   ) THEN
                    RAISE EXCEPTION 'teacher workload limit identity and evidence are immutable'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF TG_TABLE_NAME = 'teacher_qualifications' THEN
                    IF NEW.lifecycle_state = 'verified' AND (NEW.submitted_by IS NULL OR NEW.verified_by IS NULL OR NEW.verified_at IS NULL) THEN
                        RAISE EXCEPTION 'a verified teacher qualification requires independent verification'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF NEW.verified_by IS NOT NULL AND NEW.verified_by IS NOT DISTINCT FROM NEW.submitted_by THEN
                        RAISE EXCEPTION 'qualification verifier must differ from the submitting actor'
                            USING ERRCODE = 'check_violation';
                    END IF;
                ELSIF TG_TABLE_NAME = 'teacher_profile_branches' THEN
                    SELECT lifecycle_state INTO branch_state FROM branches WHERE id = NEW.branch_id;
                    IF branch_state IS DISTINCT FROM 'active' THEN
                        RAISE EXCEPTION 'teacher branch authority requires an active branch'
                            USING ERRCODE = 'check_violation';
                    END IF;
                ELSIF TG_TABLE_NAME = 'teacher_availabilities' THEN
                    SELECT lifecycle_state INTO branch_state FROM branches WHERE id = NEW.branch_id;
                    IF branch_state IS DISTINCT FROM 'active' THEN
                        RAISE EXCEPTION 'teacher availability requires an active branch'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF NOT EXISTS (
                        SELECT 1 FROM teacher_profile_branches tpb
                         WHERE tpb.teacher_profile_id = NEW.teacher_profile_id
                           AND tpb.branch_id = NEW.branch_id
                           AND tpb.lifecycle_state = 'active'
                           AND tpb.effective_from <= NEW.effective_from
                           AND (tpb.effective_to IS NULL OR tpb.effective_to > NEW.effective_from)
                           AND (NEW.effective_to IS NULL OR tpb.effective_to IS NULL OR tpb.effective_to >= NEW.effective_to)
                    ) THEN
                        RAISE EXCEPTION 'teacher availability requires effective teacher branch authorization'
                            USING ERRCODE = 'check_violation';
                    END IF;
                ELSIF TG_TABLE_NAME = 'teacher_workload_limits' THEN
                    SELECT lifecycle_state INTO branch_state FROM branches WHERE id = NEW.branch_id;
                    IF branch_state IS DISTINCT FROM 'active' THEN
                        RAISE EXCEPTION 'teacher workload requires an active branch'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF NOT EXISTS (
                        SELECT 1 FROM teacher_profile_branches tpb
                         WHERE tpb.teacher_profile_id = NEW.teacher_profile_id
                           AND tpb.branch_id = NEW.branch_id
                           AND tpb.lifecycle_state = 'active'
                           AND tpb.effective_from <= NEW.effective_from
                           AND (tpb.effective_to IS NULL OR tpb.effective_to > NEW.effective_from)
                           AND (NEW.effective_to IS NULL OR tpb.effective_to IS NULL OR tpb.effective_to >= NEW.effective_to)
                    ) THEN
                        RAISE EXCEPTION 'teacher workload requires effective teacher branch authorization'
                            USING ERRCODE = 'check_violation';
                    END IF;
                ELSIF TG_TABLE_NAME = 'teacher_skill_authorities' THEN
                    SELECT lifecycle_state INTO branch_state FROM branches WHERE id = NEW.branch_id;
                    IF branch_state IS DISTINCT FROM 'active' THEN
                        RAISE EXCEPTION 'subject authority requires an active branch'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF NEW.lifecycle_state = 'active' AND NEW.approved_by IS NULL THEN
                        RAISE EXCEPTION 'active subject authority requires an approver'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF NOT EXISTS (
                        SELECT 1 FROM teacher_profile_branches tpb
                         WHERE tpb.teacher_profile_id = NEW.teacher_profile_id
                           AND tpb.branch_id = NEW.branch_id
                           AND tpb.lifecycle_state = 'active'
                           AND tpb.effective_from <= NEW.effective_from
                           AND (tpb.effective_to IS NULL OR tpb.effective_to > NEW.effective_from)
                           AND (NEW.effective_to IS NULL OR tpb.effective_to IS NULL OR tpb.effective_to >= NEW.effective_to)
                    ) THEN
                        RAISE EXCEPTION 'subject authority requires effective teacher branch authorization'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER teacher_qualification_reference_guard BEFORE INSERT OR UPDATE ON teacher_qualifications FOR EACH ROW EXECUTE FUNCTION teacher_authority_reference_guard()');
        DB::statement('CREATE TRIGGER teacher_profile_branch_reference_guard BEFORE INSERT OR UPDATE ON teacher_profile_branches FOR EACH ROW EXECUTE FUNCTION teacher_authority_reference_guard()');
        DB::statement('CREATE TRIGGER teacher_skill_authority_reference_guard BEFORE INSERT OR UPDATE ON teacher_skill_authorities FOR EACH ROW EXECUTE FUNCTION teacher_authority_reference_guard()');
        DB::statement('CREATE TRIGGER teacher_availability_reference_guard BEFORE INSERT OR UPDATE ON teacher_availabilities FOR EACH ROW EXECUTE FUNCTION teacher_authority_reference_guard()');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION teacher_profile_branch_overlap_guard() RETURNS trigger AS $fn$
            BEGIN
                IF NEW.lifecycle_state = 'active' THEN
                    PERFORM pg_advisory_xact_lock(hashtext(NEW.teacher_profile_id || ':' || NEW.branch_id));
                END IF;
                IF NEW.lifecycle_state = 'active' AND EXISTS (
                    SELECT 1 FROM teacher_profile_branches tpb
                     WHERE tpb.id <> NEW.id
                       AND tpb.teacher_profile_id = NEW.teacher_profile_id
                       AND tpb.branch_id = NEW.branch_id
                       AND tpb.lifecycle_state = 'active'
                       AND tpb.effective_from < COALESCE(NEW.effective_to, 'infinity'::date)
                       AND COALESCE(tpb.effective_to, 'infinity'::date) > NEW.effective_from
                ) THEN
                    RAISE EXCEPTION 'teacher branch authorizations may not overlap for the same branch'
                        USING ERRCODE = 'exclusion_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER teacher_profile_branch_overlap_guard_trigger BEFORE INSERT OR UPDATE ON teacher_profile_branches FOR EACH ROW EXECUTE FUNCTION teacher_profile_branch_overlap_guard()');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION teacher_availability_overlap_guard() RETURNS trigger AS $fn$
            BEGIN
                IF NEW.lifecycle_state = 'active' THEN
                    PERFORM pg_advisory_xact_lock(hashtext(NEW.teacher_profile_id || ':' || NEW.branch_id || ':' || NEW.weekday));
                END IF;
                IF NEW.lifecycle_state = 'active' AND EXISTS (
                    SELECT 1 FROM teacher_availabilities av
                     WHERE av.id <> NEW.id
                       AND av.teacher_profile_id = NEW.teacher_profile_id
                       AND av.branch_id = NEW.branch_id
                       AND av.weekday = NEW.weekday
                       AND av.lifecycle_state = 'active'
                       AND av.starts_at < NEW.ends_at
                       AND av.ends_at > NEW.starts_at
                       AND av.effective_from < COALESCE(NEW.effective_to, 'infinity'::date)
                       AND COALESCE(av.effective_to, 'infinity'::date) > NEW.effective_from
                ) THEN
                    RAISE EXCEPTION 'teacher availability windows may not overlap'
                        USING ERRCODE = 'exclusion_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER teacher_availability_overlap_guard_trigger BEFORE INSERT OR UPDATE ON teacher_availabilities FOR EACH ROW EXECUTE FUNCTION teacher_availability_overlap_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION teacher_profile_lifecycle_guard() RETURNS trigger AS $fn$
            BEGIN
                IF TG_OP = 'UPDATE' AND (
                    NEW.person_id IS DISTINCT FROM OLD.person_id
                    OR NEW.employment_id IS DISTINCT FROM OLD.employment_id
                    OR NEW.originating_branch_id IS DISTINCT FROM OLD.originating_branch_id
                ) THEN
                    RAISE EXCEPTION 'teacher profile identity and originating provenance are immutable'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM employments e
                     WHERE e.id = NEW.employment_id
                       AND e.person_id = NEW.person_id
                ) THEN
                    RAISE EXCEPTION 'teacher profile employment must belong to the same person'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.lifecycle_state IN ('pending', 'active', 'suspended')
                   AND NOT EXISTS (
                    SELECT 1 FROM branches b
                     WHERE b.id IN (NEW.originating_branch_id, NEW.current_home_branch_id)
                       AND b.lifecycle_state = 'active'
                ) THEN
                    RAISE EXCEPTION 'operational teacher profile requires active branch provenance'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.lifecycle_state IN ('active', 'suspended')
                   AND NOT EXISTS (
                    SELECT 1 FROM teacher_profile_branches tpb
                     WHERE tpb.teacher_profile_id = NEW.id
                       AND tpb.branch_id = NEW.current_home_branch_id
                       AND tpb.lifecycle_state = 'active'
                       AND tpb.effective_from <= CURRENT_DATE
                       AND (tpb.effective_to IS NULL OR tpb.effective_to > CURRENT_DATE)
                ) THEN
                    RAISE EXCEPTION 'active teacher profile requires current-home branch authorization'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF TG_OP = 'UPDATE' AND OLD.lifecycle_state IS DISTINCT FROM NEW.lifecycle_state THEN
                    IF OLD.lifecycle_state = 'pending' AND NEW.lifecycle_state NOT IN ('pending', 'active', 'retired') THEN
                        RAISE EXCEPTION 'pending teacher profile cannot move to %', NEW.lifecycle_state USING ERRCODE = 'check_violation';
                    ELSIF OLD.lifecycle_state = 'active' AND NEW.lifecycle_state NOT IN ('active', 'suspended', 'retired') THEN
                        RAISE EXCEPTION 'active teacher profile cannot move to %', NEW.lifecycle_state USING ERRCODE = 'check_violation';
                    ELSIF OLD.lifecycle_state = 'suspended' AND NEW.lifecycle_state NOT IN ('suspended', 'active', 'retired') THEN
                        RAISE EXCEPTION 'suspended teacher profile cannot move to %', NEW.lifecycle_state USING ERRCODE = 'check_violation';
                    ELSIF OLD.lifecycle_state = 'retired' AND NEW.lifecycle_state <> 'retired' THEN
                        RAISE EXCEPTION 'retired teacher profile is final' USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                IF NEW.lifecycle_state = 'active' THEN
                    IF NOT EXISTS (SELECT 1 FROM people p WHERE p.id = NEW.person_id AND p.verification_state = 'verified') THEN
                        RAISE EXCEPTION 'an active teacher profile requires verified identity'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF NOT EXISTS (SELECT 1 FROM employments e WHERE e.id = NEW.employment_id AND e.person_id = NEW.person_id AND e.lifecycle_state = 'active') THEN
                        RAISE EXCEPTION 'an active teacher profile requires active employment for the same person'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF NOT EXISTS (SELECT 1 FROM teacher_qualifications q WHERE q.teacher_profile_id = NEW.id AND q.lifecycle_state = 'verified' AND (q.valid_from IS NULL OR q.valid_from <= CURRENT_DATE) AND (q.valid_to IS NULL OR q.valid_to >= CURRENT_DATE)) THEN
                        RAISE EXCEPTION 'an active teacher profile requires a current verified qualification'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF NEW.approved_by IS NULL OR NEW.approved_at IS NULL THEN
                        RAISE EXCEPTION 'an active teacher profile requires an approving actor'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER teacher_profile_lifecycle_guard BEFORE INSERT OR UPDATE ON teacher_profiles FOR EACH ROW EXECUTE FUNCTION teacher_profile_lifecycle_guard()');

        DB::statement('CREATE INDEX teacher_skill_authorities_active_lookup ON teacher_skill_authorities (teacher_profile_id, skill_id, effective_from, effective_to) WHERE lifecycle_state = \'active\'');
        DB::statement('CREATE INDEX teacher_availability_active_lookup ON teacher_availabilities (teacher_profile_id, branch_id, weekday, effective_from, effective_to) WHERE lifecycle_state = \'active\'');
        DB::statement('CREATE INDEX teacher_profile_branches_active_lookup ON teacher_profile_branches (teacher_profile_id, branch_id, effective_from, effective_to) WHERE lifecycle_state = \'active\'');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION teacher_workload_overlap_guard() RETURNS trigger AS $fn$
            BEGIN
                IF NEW.lifecycle_state = 'active' THEN
                    PERFORM pg_advisory_xact_lock(hashtext(NEW.teacher_profile_id || ':' || NEW.branch_id));
                END IF;
                IF NEW.lifecycle_state = 'active' AND EXISTS (
                    SELECT 1 FROM teacher_workload_limits wl
                     WHERE wl.id <> NEW.id
                       AND wl.teacher_profile_id = NEW.teacher_profile_id
                       AND wl.branch_id = NEW.branch_id
                       AND wl.lifecycle_state = 'active'
                       AND wl.effective_from < COALESCE(NEW.effective_to, 'infinity'::date)
                       AND COALESCE(wl.effective_to, 'infinity'::date) > NEW.effective_from
                ) THEN
                    RAISE EXCEPTION 'teacher workload limits may not overlap'
                        USING ERRCODE = 'exclusion_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER teacher_workload_overlap_guard_trigger BEFORE INSERT OR UPDATE ON teacher_workload_limits FOR EACH ROW EXECUTE FUNCTION teacher_workload_overlap_guard()');
        DB::statement('CREATE INDEX teacher_workload_limits_active_lookup ON teacher_workload_limits (teacher_profile_id, branch_id, effective_from, effective_to) WHERE lifecycle_state = \'active\'');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION teacher_skill_authority_overlap_guard() RETURNS trigger AS $fn$
            BEGIN
                IF NEW.lifecycle_state = 'active' THEN
                    PERFORM pg_advisory_xact_lock(hashtext(NEW.teacher_profile_id || ':' || NEW.skill_id || ':' || NEW.branch_id || ':' || NEW.authority_kind));
                END IF;
                IF NEW.lifecycle_state = 'active' AND EXISTS (
                    SELECT 1 FROM teacher_skill_authorities tsa
                     WHERE tsa.id <> NEW.id
                       AND tsa.teacher_profile_id = NEW.teacher_profile_id
                       AND tsa.skill_id = NEW.skill_id
                       AND tsa.branch_id = NEW.branch_id
                       AND tsa.authority_kind = NEW.authority_kind
                       AND tsa.lifecycle_state = 'active'
                       AND tsa.effective_from < COALESCE(NEW.effective_to, 'infinity'::date)
                       AND COALESCE(tsa.effective_to, 'infinity'::date) > NEW.effective_from
                ) THEN
                    RAISE EXCEPTION 'teacher subject authorities may not overlap for the same skill, branch, and kind'
                        USING ERRCODE = 'exclusion_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER teacher_skill_authority_overlap_guard_trigger BEFORE INSERT OR UPDATE ON teacher_skill_authorities FOR EACH ROW EXECUTE FUNCTION teacher_skill_authority_overlap_guard()');

        Schema::table('teacher_assignments', function (Blueprint $table): void {
            $table->char('teacher_profile_id', 36)->nullable()->after('teacher_person_id');
            $table->string('lifecycle_state')->nullable()->after('effective_to');
            $table->char('branch_id', 36)->nullable()->after('class_id');
            $table->char('campus_id', 36)->nullable()->after('branch_id');
            $table->char('organization_id', 36)->nullable()->after('campus_id');
            $table->char('assigned_by', 36)->nullable()->after('effective_to');
            $table->string('assignment_reason')->nullable()->after('assigned_by');
            $table->foreign('teacher_profile_id')->references('id')->on('teacher_profiles');
            $table->foreign('branch_id')->references('id')->on('branches');
            $table->foreign('campus_id')->references('id')->on('campuses');
            $table->foreign('organization_id')->references('id')->on('organizations');
        });
        // The academic convergence trigger has no lifecycle awareness and
        // rejects a valid replacement after a future assignment is cancelled.
        // Teacher assignment authority supersedes it with the guards below.
        DB::statement('DROP TRIGGER IF EXISTS academic_teacher_assignment_temporal_guard_trigger ON teacher_assignments');
        DB::statement('DROP FUNCTION IF EXISTS academic_teacher_assignment_temporal_guard()');
        DB::statement("ALTER TABLE teacher_assignments ADD CONSTRAINT teacher_assignments_lifecycle_state_check CHECK (lifecycle_state IS NULL OR lifecycle_state IN ('planned','active','ended','cancelled'))");
        DB::statement('DROP INDEX IF EXISTS teacher_assignments_one_open_per_class_teacher');
        DB::statement("CREATE UNIQUE INDEX teacher_assignments_one_open_per_class_teacher ON teacher_assignments (class_id, teacher_person_id) WHERE effective_to IS NULL AND (lifecycle_state IS NULL OR lifecycle_state IN ('planned','active'))");
        DB::statement('CREATE INDEX teacher_assignments_profile_window ON teacher_assignments (teacher_profile_id, effective_from, effective_to, lifecycle_state)');
        DB::statement('CREATE INDEX teacher_assignments_branch_window ON teacher_assignments (branch_id, effective_from, effective_to, lifecycle_state)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION teacher_assignment_overlap_guard() RETURNS trigger AS $fn$
            BEGIN
                IF NEW.teacher_profile_id IS NOT NULL
                   AND (NEW.lifecycle_state IS NULL OR NEW.lifecycle_state <> 'cancelled') THEN
                    PERFORM pg_advisory_xact_lock(hashtext(NEW.class_id || ':' || NEW.teacher_person_id));
                END IF;
                IF NEW.teacher_profile_id IS NOT NULL
                   AND (NEW.lifecycle_state IS NULL OR NEW.lifecycle_state <> 'cancelled')
                   AND EXISTS (
                    SELECT 1 FROM teacher_assignments ta
                     WHERE ta.id <> NEW.id
                       AND ta.class_id = NEW.class_id
                       AND ta.teacher_person_id = NEW.teacher_person_id
                       AND ta.teacher_profile_id IS NOT NULL
                       AND (ta.lifecycle_state IS NULL OR ta.lifecycle_state <> 'cancelled')
                       AND ta.effective_from < COALESCE(NEW.effective_to, 'infinity'::date)
                       AND COALESCE(ta.effective_to, 'infinity'::date) > NEW.effective_from
                ) THEN
                    RAISE EXCEPTION 'teacher assignment windows may not overlap for the same class and person'
                        USING ERRCODE = 'exclusion_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER teacher_assignment_overlap_guard_trigger BEFORE INSERT OR UPDATE ON teacher_assignments FOR EACH ROW EXECUTE FUNCTION teacher_assignment_overlap_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION teacher_assignment_authority_guard() RETURNS trigger AS $fn$
            DECLARE
                profile_person char(36);
                profile_state text;
                assignment_employment_id char(36);
                employment_state text;
                end_employment_state text;
                class_branch char(36);
                period_start date;
                period_end date;
                branch_authorized boolean;
                leave_conflict boolean;
                operational_required boolean := true;
            BEGIN
                IF TG_OP = 'UPDATE'
                   AND NEW.teacher_profile_id IS NOT DISTINCT FROM OLD.teacher_profile_id
                   AND NEW.teacher_person_id IS NOT DISTINCT FROM OLD.teacher_person_id
                   AND NEW.class_id IS NOT DISTINCT FROM OLD.class_id
                   AND NEW.effective_from IS NOT DISTINCT FROM OLD.effective_from
                   AND NEW.effective_to IS NOT NULL
                   AND (OLD.effective_to IS NULL OR NEW.effective_to < OLD.effective_to) THEN
                    operational_required := false;
                END IF;
                IF TG_OP = 'UPDATE'
                   AND NEW.lifecycle_state = 'cancelled'
                   AND OLD.lifecycle_state IS DISTINCT FROM 'cancelled' THEN
                    operational_required := false;
                END IF;
                IF NEW.effective_to IS NOT NULL AND NEW.effective_to <= NEW.effective_from THEN
                    RAISE EXCEPTION 'teacher assignment effective_to must be after effective_from'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF TG_OP = 'UPDATE' AND OLD.lifecycle_state IS DISTINCT FROM NEW.lifecycle_state THEN
                    IF OLD.lifecycle_state = 'planned' AND NEW.lifecycle_state NOT IN ('planned', 'active', 'ended', 'cancelled') THEN
                        RAISE EXCEPTION 'planned teacher assignment cannot move to %', NEW.lifecycle_state USING ERRCODE = 'check_violation';
                    ELSIF OLD.lifecycle_state = 'active' AND NEW.lifecycle_state NOT IN ('active', 'ended', 'cancelled') THEN
                        RAISE EXCEPTION 'active teacher assignment cannot move to %', NEW.lifecycle_state USING ERRCODE = 'check_violation';
                    ELSIF OLD.lifecycle_state IN ('ended', 'cancelled') AND NEW.lifecycle_state <> OLD.lifecycle_state THEN
                        RAISE EXCEPTION 'terminal teacher assignment state is final' USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                IF NEW.lifecycle_state = 'cancelled' AND NEW.effective_from < CURRENT_DATE THEN
                    RAISE EXCEPTION 'only future-effective teacher assignments may be cancelled'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.lifecycle_state = 'ended' AND NEW.effective_to IS NULL THEN
                    RAISE EXCEPTION 'ended teacher assignments require an effective end date'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF TG_OP = 'UPDATE' AND OLD.teacher_profile_id IS NOT NULL
                   AND OLD.effective_to IS NULL AND NEW.effective_to IS NOT NULL
                   AND NEW.lifecycle_state NOT IN ('ended', 'cancelled') THEN
                    RAISE EXCEPTION 'closing a canonical teacher assignment requires ended or cancelled lifecycle state'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF TG_OP = 'UPDATE' AND OLD.lifecycle_state IN ('ended', 'cancelled')
                   AND NEW.effective_to IS DISTINCT FROM OLD.effective_to THEN
                    RAISE EXCEPTION 'terminal teacher assignment dates are immutable'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF TG_OP = 'INSERT' AND (NEW.lifecycle_state IS NULL OR NEW.lifecycle_state NOT IN ('planned', 'active')) THEN
                    RAISE EXCEPTION 'new teacher assignments require planned or active lifecycle state'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF TG_OP = 'UPDATE'
                   AND OLD.teacher_profile_id IS NOT NULL
                   AND NEW.teacher_profile_id IS NULL THEN
                    RAISE EXCEPTION 'canonical teacher assignments may not be detached from their teacher profile'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF TG_OP = 'UPDATE'
                   AND OLD.teacher_profile_id IS NOT NULL
                   AND (
                       NEW.class_id IS DISTINCT FROM OLD.class_id
                       OR NEW.teacher_person_id IS DISTINCT FROM OLD.teacher_person_id
                       OR NEW.teacher_profile_id IS DISTINCT FROM OLD.teacher_profile_id
                       OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
                       OR NEW.campus_id IS DISTINCT FROM OLD.campus_id
                       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
                       OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
                       OR NEW.assigned_by IS DISTINCT FROM OLD.assigned_by
                       OR NEW.assignment_reason IS DISTINCT FROM OLD.assignment_reason
                   ) THEN
                    RAISE EXCEPTION 'canonical teacher assignment identity and provenance are immutable'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.teacher_profile_id IS NULL THEN
                    IF TG_OP = 'INSERT' THEN
                        RAISE EXCEPTION 'new teacher assignments require canonical teacher profile authority'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF NEW.teacher_person_id IS DISTINCT FROM OLD.teacher_person_id
                       OR NEW.effective_from IS DISTINCT FROM OLD.effective_from THEN
                        RAISE EXCEPTION 'legacy teacher assignments may only be closed through remediation'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    RETURN NEW;
                END IF;

                SELECT tp.person_id, tp.lifecycle_state, tp.employment_id,
                       COALESCE((SELECT es.status FROM employment_statuses es
                                  WHERE es.employment_id = e.id
                                    AND es.effective_from <= NEW.effective_from
                                  ORDER BY es.effective_from DESC, es.created_at DESC, es.id DESC
                                  LIMIT 1), e.lifecycle_state)
                  INTO profile_person, profile_state, assignment_employment_id, employment_state
                  FROM teacher_profiles tp
                  JOIN employments e ON e.id = tp.employment_id
                 WHERE tp.id = NEW.teacher_profile_id;
                IF profile_person IS DISTINCT FROM NEW.teacher_person_id THEN
                    RAISE EXCEPTION 'teacher assignment person must match its teacher profile'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF operational_required AND (profile_state IS DISTINCT FROM 'active' OR employment_state IS DISTINCT FROM 'active') THEN
                    RAISE EXCEPTION 'teacher assignment requires active teacher profile and active employment'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF operational_required AND NEW.effective_to IS NOT NULL THEN
                    SELECT COALESCE((SELECT es.status FROM employment_statuses es
                                      WHERE es.employment_id = assignment_employment_id
                                        AND es.effective_from <= NEW.effective_to - 1
                                      ORDER BY es.effective_from DESC, es.created_at DESC, es.id DESC
                                      LIMIT 1), e.lifecycle_state)
                      INTO end_employment_state
                      FROM employments e
                     WHERE e.id = assignment_employment_id;
                    IF end_employment_state IS DISTINCT FROM 'active' THEN
                        RAISE EXCEPTION 'teacher assignment must remain inside active employment dates'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;

                SELECT c.branch_id, p.starts_on, p.ends_on
                  INTO class_branch, period_start, period_end
                  FROM classes c
                  JOIN academic_periods p ON p.id = c.period_id
                 WHERE c.id = NEW.class_id;
                IF class_branch IS NULL OR NEW.branch_id IS DISTINCT FROM class_branch THEN
                    RAISE EXCEPTION 'teacher assignment branch provenance must match its class'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.effective_from < period_start
                   OR NEW.effective_from > period_end
                   OR (NEW.effective_to IS NOT NULL AND NEW.effective_to > period_end + 1) THEN
                    RAISE EXCEPTION 'teacher assignment must remain inside its class academic period (effective_to is exclusive)'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT EXISTS(
                    SELECT 1 FROM teacher_profile_branches tpb
                     WHERE tpb.teacher_profile_id = NEW.teacher_profile_id
                       AND tpb.branch_id = NEW.branch_id
                       AND tpb.lifecycle_state = 'active'
                       AND tpb.effective_from <= NEW.effective_from
                       AND (tpb.effective_to IS NULL OR tpb.effective_to > NEW.effective_from)
                       AND (NEW.effective_to IS NULL OR tpb.effective_to IS NULL OR tpb.effective_to >= NEW.effective_to)
                ) INTO branch_authorized;
                IF operational_required AND NOT branch_authorized THEN
                    RAISE EXCEPTION 'teacher assignment requires effective branch authorization'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF operational_required AND NOT EXISTS (
                    SELECT 1 FROM teacher_qualifications tq
                     WHERE tq.teacher_profile_id = NEW.teacher_profile_id
                       AND tq.lifecycle_state = 'verified'
                       AND (tq.valid_from IS NULL OR tq.valid_from <= NEW.effective_from)
                       AND (tq.valid_to IS NULL OR tq.valid_to >= COALESCE(NEW.effective_to - 1, NEW.effective_from))
                ) THEN
                    RAISE EXCEPTION 'teacher assignment requires a verified qualification for its full effective window'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF operational_required THEN
                    SELECT EXISTS(
                        SELECT 1 FROM leaves l
                         WHERE l.employment_id = assignment_employment_id
                           AND l.lifecycle_state = 'approved'
                           AND l.date_from <= COALESCE(NEW.effective_to, period_end)
                           AND l.date_to >= NEW.effective_from
                    ) INTO leave_conflict;
                    IF leave_conflict THEN
                        RAISE EXCEPTION 'teacher assignment cannot overlap approved leave'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER teacher_assignment_authority_guard_trigger BEFORE INSERT OR UPDATE ON teacher_assignments FOR EACH ROW EXECUTE FUNCTION teacher_assignment_authority_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION teacher_assignment_provenance_guard() RETURNS trigger AS $fn$
            DECLARE
                scope_campus char(36);
                scope_organization char(36);
            BEGIN
                IF TG_OP = 'UPDATE'
                   AND OLD.teacher_profile_id IS NULL
                   AND NEW.teacher_profile_id IS NULL
                   AND (
                       NEW.class_id IS DISTINCT FROM OLD.class_id
                       OR NEW.teacher_person_id IS DISTINCT FROM OLD.teacher_person_id
                       OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
                       OR NEW.campus_id IS DISTINCT FROM OLD.campus_id
                       OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
                       OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
                       OR NEW.assigned_by IS DISTINCT FROM OLD.assigned_by
                       OR NEW.assignment_reason IS DISTINCT FROM OLD.assignment_reason
                   ) THEN
                    RAISE EXCEPTION 'legacy teacher assignments may only be closed; provenance remediation requires an explicit migration'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF TG_OP = 'UPDATE'
                   AND OLD.teacher_profile_id IS NULL
                   AND NEW.teacher_profile_id IS NULL
                   AND OLD.branch_id IS NULL
                   AND NEW.branch_id IS NULL
                   AND OLD.campus_id IS NULL
                   AND NEW.campus_id IS NULL
                   AND OLD.organization_id IS NULL
                   AND NEW.organization_id IS NULL
                   AND (NEW.lifecycle_state IS NULL OR NEW.lifecycle_state = 'ended') THEN
                    RETURN NEW;
                END IF;
                IF TG_OP = 'UPDATE'
                   AND NEW.teacher_profile_id IS NOT DISTINCT FROM OLD.teacher_profile_id
                   AND NEW.teacher_person_id IS NOT DISTINCT FROM OLD.teacher_person_id
                   AND NEW.branch_id IS NOT DISTINCT FROM OLD.branch_id
                   AND NEW.campus_id IS NOT DISTINCT FROM OLD.campus_id
                   AND NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id
                   AND (NEW.lifecycle_state = 'ended' OR NEW.lifecycle_state = 'cancelled'
                        OR (NEW.effective_to IS NOT NULL AND (OLD.effective_to IS NULL OR NEW.effective_to < OLD.effective_to))) THEN
                    RETURN NEW;
                END IF;
                IF NEW.branch_id IS NULL OR NEW.campus_id IS NULL OR NEW.organization_id IS NULL THEN
                    RAISE EXCEPTION 'new teacher assignments require branch, campus, and organization provenance'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT ca.campus_id, c.organization_id
                  INTO scope_campus, scope_organization
                  FROM campus_assignments ca
                  JOIN campuses c ON c.id = ca.campus_id
                 WHERE ca.branch_id = NEW.branch_id
                   AND ca.effective_from <= NEW.effective_from
                   AND (ca.effective_to IS NULL OR ca.effective_to > NEW.effective_from)
                   AND ca.campus_id = NEW.campus_id
                   AND c.organization_id = NEW.organization_id
                   AND c.lifecycle_state = 'active';
                IF scope_campus IS NULL OR scope_organization IS NULL THEN
                    RAISE EXCEPTION 'teacher assignment provenance is not a valid branch campus organization scope'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER teacher_assignment_provenance_guard_trigger BEFORE INSERT OR UPDATE ON teacher_assignments FOR EACH ROW EXECUTE FUNCTION teacher_assignment_provenance_guard()');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION teacher_assignment_skill_authority_guard() RETURNS trigger AS $fn$
            DECLARE
                assignment_profile char(36);
                assignment_person char(36);
                profile_person char(36);
                assignment_branch char(36);
                assignment_start date;
                assignment_end date;
                assignment_open boolean;
                assignment_state text;
                skill_authorized boolean;
            BEGIN
                SELECT ta.teacher_profile_id, ta.teacher_person_id, tp.person_id, ta.branch_id, ta.effective_from,
                       COALESCE(ta.effective_to - 1, ta.effective_from), ta.effective_to IS NULL, ta.lifecycle_state
                  INTO assignment_profile, assignment_person, profile_person, assignment_branch, assignment_start, assignment_end, assignment_open, assignment_state
                  FROM teacher_assignments ta
                  LEFT JOIN teacher_profiles tp ON tp.id = ta.teacher_profile_id
                 WHERE ta.id = NEW.teacher_assignment_id;
                IF assignment_profile IS NULL
                   OR profile_person IS DISTINCT FROM assignment_person
                   OR assignment_state IN ('ended', 'cancelled') THEN
                    RAISE EXCEPTION 'assignment skills require an open canonical teacher assignment'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT EXISTS(
                    SELECT 1 FROM teacher_skill_authorities tsa
                     WHERE tsa.teacher_profile_id = assignment_profile
                       AND tsa.skill_id = NEW.skill_id
                       AND tsa.branch_id = assignment_branch
                       AND tsa.authority_kind = 'teach'
                       AND tsa.lifecycle_state = 'active'
                       AND tsa.effective_from <= assignment_start
                       AND ((assignment_open AND tsa.effective_to IS NULL)
                            OR (NOT assignment_open AND (tsa.effective_to IS NULL OR tsa.effective_to >= assignment_end)))
                ) INTO skill_authorized;
                IF NOT skill_authorized THEN
                    RAISE EXCEPTION 'assignment skill requires effective teach authority for the full assignment window'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER teacher_assignment_skill_authority_guard_trigger BEFORE INSERT ON teacher_assignment_skills FOR EACH ROW EXECUTE FUNCTION teacher_assignment_skill_authority_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION teacher_session_delivery_guard() RETURNS trigger AS $fn$
            DECLARE
                teacher_exists boolean;
                class_branch char(36);
                candidate_profile_id char(36);
            BEGIN
                SELECT branch_id INTO class_branch FROM classes WHERE id = NEW.class_id;
                FOR candidate_profile_id IN
                    SELECT DISTINCT ta.teacher_profile_id
                      FROM teacher_assignments ta
                     WHERE ta.class_id = NEW.class_id
                       AND ta.teacher_profile_id IS NOT NULL
                       AND (ta.lifecycle_state IS NULL OR ta.lifecycle_state <> 'cancelled')
                       AND ta.effective_from <= NEW.scheduled_on
                       AND (ta.effective_to IS NULL OR ta.effective_to > NEW.scheduled_on)
                     ORDER BY ta.teacher_profile_id
                LOOP
                    PERFORM 1 FROM teacher_profiles WHERE id = candidate_profile_id FOR UPDATE;
                END LOOP;
                SELECT EXISTS(
                    SELECT 1
                      FROM teacher_assignments ta
                      JOIN teacher_profiles tp ON tp.id = ta.teacher_profile_id
                      JOIN employments e ON e.id = tp.employment_id
                     WHERE ta.class_id = NEW.class_id
                       AND ta.branch_id = class_branch
                       AND ta.teacher_person_id = tp.person_id
                       AND (ta.lifecycle_state IS NULL OR ta.lifecycle_state <> 'cancelled')
                       AND ta.effective_from <= NEW.scheduled_on
                       AND (ta.effective_to IS NULL OR ta.effective_to > NEW.scheduled_on)
                       AND tp.lifecycle_state = 'active'
                       AND COALESCE((SELECT es.status FROM employment_statuses es
                                      WHERE es.employment_id = e.id
                                        AND es.effective_from <= NEW.scheduled_on
                                      ORDER BY es.effective_from DESC, es.created_at DESC, es.id DESC
                                      LIMIT 1), e.lifecycle_state) = 'active'
                       AND EXISTS (
                           SELECT 1 FROM teacher_profile_branches tpb
                            WHERE tpb.teacher_profile_id = tp.id
                              AND tpb.branch_id = class_branch
                              AND tpb.lifecycle_state = 'active'
                              AND tpb.effective_from <= NEW.scheduled_on
                              AND (tpb.effective_to IS NULL OR tpb.effective_to > NEW.scheduled_on)
                       )
                       AND EXISTS (
                           SELECT 1 FROM teacher_qualifications tq
                            WHERE tq.teacher_profile_id = tp.id
                              AND tq.lifecycle_state = 'verified'
                              AND (tq.valid_from IS NULL OR tq.valid_from <= NEW.scheduled_on)
                              AND (tq.valid_to IS NULL OR tq.valid_to >= NEW.scheduled_on)
                       )
                       AND (NEW.skill_id IS NULL OR EXISTS (
                           SELECT 1 FROM teacher_assignment_skills tas
                            WHERE tas.teacher_assignment_id = ta.id
                              AND tas.skill_id = NEW.skill_id
                       ))
                       AND (NEW.skill_id IS NULL OR EXISTS (
                           SELECT 1 FROM teacher_skill_authorities tsa
                            WHERE tsa.teacher_profile_id = tp.id
                              AND tsa.branch_id = class_branch
                              AND tsa.skill_id = NEW.skill_id
                              AND tsa.authority_kind = 'teach'
                              AND tsa.lifecycle_state = 'active'
                              AND tsa.effective_from <= NEW.scheduled_on
                              AND (tsa.effective_to IS NULL OR tsa.effective_to > NEW.scheduled_on)
                       ))
                       AND EXISTS (
                           SELECT 1 FROM teacher_availabilities av
                            WHERE av.teacher_profile_id = tp.id
                              AND av.branch_id = class_branch
                              AND av.weekday = EXTRACT(ISODOW FROM NEW.scheduled_on)::integer
                              AND av.availability_kind = 'available'
                              AND av.lifecycle_state = 'active'
                              AND av.effective_from <= NEW.scheduled_on
                              AND (av.effective_to IS NULL OR av.effective_to > NEW.scheduled_on)
                              AND av.starts_at <= NEW.starts_at
                              AND av.ends_at >= NEW.ends_at
                       )
                       AND NOT EXISTS (
                           SELECT 1 FROM leaves l
                            WHERE l.employment_id = e.id
                              AND l.lifecycle_state = 'approved'
                              AND l.date_from <= NEW.scheduled_on
                              AND l.date_to >= NEW.scheduled_on
                       )
                ) INTO teacher_exists;
                IF NOT teacher_exists THEN
                    RAISE EXCEPTION 'session delivery requires an active, available, qualified teacher assignment'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF EXISTS (
                    SELECT 1
                      FROM class_sessions other_session
                      JOIN teacher_assignments ta_other ON ta_other.class_id = other_session.class_id
                      JOIN teacher_profiles tp_other ON tp_other.id = ta_other.teacher_profile_id
                      JOIN teacher_assignments ta_new ON ta_new.class_id = NEW.class_id
                      JOIN teacher_profiles tp_new ON tp_new.id = ta_new.teacher_profile_id
                     WHERE other_session.id <> NEW.id
                       AND other_session.scheduled_on = NEW.scheduled_on
                       AND other_session.starts_at < NEW.ends_at
                       AND other_session.ends_at > NEW.starts_at
                       AND ta_other.teacher_person_id = ta_new.teacher_person_id
                       AND ta_other.teacher_person_id = tp_other.person_id
                       AND ta_new.teacher_person_id = tp_new.person_id
                       AND (ta_other.lifecycle_state IS NULL OR ta_other.lifecycle_state <> 'cancelled')
                       AND (ta_new.lifecycle_state IS NULL OR ta_new.lifecycle_state <> 'cancelled')
                       AND ta_new.effective_from <= NEW.scheduled_on
                       AND (ta_new.effective_to IS NULL OR ta_new.effective_to > NEW.scheduled_on)
                       AND ta_other.effective_from <= NEW.scheduled_on
                       AND (ta_other.effective_to IS NULL OR ta_other.effective_to > NEW.scheduled_on)
                ) THEN
                    RAISE EXCEPTION 'a teacher may not have overlapping class sessions'
                        USING ERRCODE = 'exclusion_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER teacher_session_delivery_guard_trigger BEFORE INSERT OR UPDATE ON class_sessions FOR EACH ROW EXECUTE FUNCTION teacher_session_delivery_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION teacher_session_workload_guard() RETURNS trigger AS $fn$
            DECLARE
                assignment_profile char(36);
                assignment_branch char(36);
                limit_hours numeric;
                used_hours numeric;
                proposed_hours numeric;
                candidate_found boolean := false;
                week_start date;
            BEGIN
                proposed_hours := EXTRACT(EPOCH FROM (NEW.ends_at - NEW.starts_at)) / 3600;
                week_start := date_trunc('week', NEW.scheduled_on)::date;
                FOR assignment_profile, assignment_branch IN
                    SELECT DISTINCT ta.teacher_profile_id, ta.branch_id
                      FROM teacher_assignments ta
                      JOIN teacher_profiles tp ON tp.id = ta.teacher_profile_id
                      JOIN employments e ON e.id = tp.employment_id
                     WHERE ta.class_id = NEW.class_id
                       AND ta.teacher_profile_id IS NOT NULL
                       AND ta.teacher_person_id = tp.person_id
                       AND (ta.lifecycle_state IS NULL OR ta.lifecycle_state <> 'cancelled')
                       AND ta.effective_from <= NEW.scheduled_on
                       AND (ta.effective_to IS NULL OR ta.effective_to > NEW.scheduled_on)
                       AND tp.lifecycle_state = 'active'
                       AND COALESCE((SELECT es.status FROM employment_statuses es
                                      WHERE es.employment_id = e.id
                                        AND es.effective_from <= NEW.scheduled_on
                                      ORDER BY es.effective_from DESC, es.created_at DESC, es.id DESC
                                      LIMIT 1), e.lifecycle_state) = 'active'
                     ORDER BY ta.teacher_profile_id, ta.branch_id
                LOOP
                    PERFORM 1 FROM teacher_profiles WHERE id = assignment_profile FOR UPDATE;
                    PERFORM pg_advisory_xact_lock(hashtext(assignment_profile || ':' || week_start::text));
                    SELECT wl.max_hours_per_week INTO limit_hours
                      FROM teacher_workload_limits wl
                     WHERE wl.teacher_profile_id = assignment_profile
                       AND wl.branch_id = assignment_branch
                       AND wl.lifecycle_state = 'active'
                       AND wl.effective_from <= NEW.scheduled_on
                       AND (wl.effective_to IS NULL OR wl.effective_to > NEW.scheduled_on)
                     ORDER BY wl.effective_from DESC
                     LIMIT 1;
                    IF limit_hours IS NULL THEN
                        candidate_found := true;
                        EXIT;
                    END IF;
                    SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (cs.ends_at - cs.starts_at)) / 3600), 0)
                      INTO used_hours
                      FROM class_sessions cs
                     WHERE cs.id <> NEW.id
                       AND cs.scheduled_on >= week_start
                       AND cs.scheduled_on < week_start + 7
                       AND EXISTS (
                           SELECT 1 FROM teacher_assignments ta2
                            WHERE ta2.class_id = cs.class_id
                              AND ta2.teacher_profile_id = assignment_profile
                              AND ta2.branch_id = assignment_branch
                              AND (ta2.lifecycle_state IS NULL OR ta2.lifecycle_state <> 'cancelled')
                              AND ta2.effective_from <= cs.scheduled_on
                              AND (ta2.effective_to IS NULL OR ta2.effective_to > cs.scheduled_on)
                       );
                    IF used_hours + proposed_hours <= limit_hours THEN
                        candidate_found := true;
                        EXIT;
                    END IF;
                END LOOP;
                IF NOT candidate_found THEN
                    RAISE EXCEPTION 'teacher weekly workload limit would be exceeded'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER teacher_session_workload_guard_trigger BEFORE INSERT OR UPDATE ON class_sessions FOR EACH ROW EXECUTE FUNCTION teacher_session_workload_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION teaching_delivery_teacher_authority_guard() RETURNS trigger AS $fn$
            DECLARE
                session_date date;
                session_class char(36);
                session_skill char(36);
                employment_person char(36);
                admissible boolean;
            BEGIN
                SELECT cs.scheduled_on, cs.class_id, cs.skill_id
                  INTO session_date, session_class, session_skill
                  FROM class_sessions cs WHERE cs.id = NEW.session_id;
                SELECT e.person_id INTO employment_person
                  FROM payroll_calculations pc JOIN employments e ON e.id = pc.employment_id
                 WHERE pc.id = NEW.payroll_calculation_id;
                SELECT EXISTS(
                    SELECT 1
                      FROM teacher_assignments ta
                      JOIN classes c ON c.id = ta.class_id
                      JOIN teacher_profiles tp ON tp.id = ta.teacher_profile_id
                      JOIN employments e ON e.id = tp.employment_id
                      JOIN teacher_assignment_skills tas ON tas.teacher_assignment_id = ta.id
                      JOIN teacher_skill_authorities tsa ON tsa.teacher_profile_id = tp.id AND tsa.skill_id = tas.skill_id AND tsa.branch_id = ta.branch_id
                     WHERE ta.class_id = session_class
                       AND ta.branch_id = c.branch_id
                       AND ta.teacher_person_id = employment_person
                       AND ta.teacher_person_id = tp.person_id
                       AND tp.lifecycle_state = 'active'
                       AND COALESCE((SELECT es.status FROM employment_statuses es
                                      WHERE es.employment_id = e.id
                                        AND es.effective_from <= session_date
                                      ORDER BY es.effective_from DESC, es.created_at DESC, es.id DESC
                                      LIMIT 1), e.lifecycle_state) = 'active'
                       AND (ta.lifecycle_state IS NULL OR ta.lifecycle_state <> 'cancelled')
                       AND ta.teacher_profile_id IS NOT NULL
                       AND tas.skill_id = session_skill
                       AND tsa.authority_kind = 'teach'
                       AND tsa.lifecycle_state = 'active'
                       AND tsa.effective_from <= session_date
                       AND (tsa.effective_to IS NULL OR tsa.effective_to > session_date)
                       AND ta.effective_from <= session_date
                       AND (ta.effective_to IS NULL OR ta.effective_to > session_date)
                       AND EXISTS (
                           SELECT 1 FROM teacher_profile_branches tpb
                            WHERE tpb.teacher_profile_id = tp.id
                              AND tpb.branch_id = ta.branch_id
                              AND tpb.lifecycle_state = 'active'
                              AND tpb.effective_from <= session_date
                              AND (tpb.effective_to IS NULL OR tpb.effective_to > session_date)
                       )
                       AND EXISTS (
                           SELECT 1 FROM teacher_qualifications tq
                            WHERE tq.teacher_profile_id = tp.id
                              AND tq.lifecycle_state = 'verified'
                              AND (tq.valid_from IS NULL OR tq.valid_from <= session_date)
                              AND (tq.valid_to IS NULL OR tq.valid_to >= session_date)
                       )
                       AND NOT EXISTS (
                           SELECT 1 FROM leaves l
                            WHERE l.employment_id = e.id
                              AND l.lifecycle_state = 'approved'
                              AND l.date_from <= session_date
                              AND l.date_to >= session_date
                       )
                ) INTO admissible;
                IF NOT admissible THEN
                    RAISE EXCEPTION 'payroll teaching delivery requires canonical teacher profile, assignment, and subject authority'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER teaching_delivery_teacher_authority_guard_trigger BEFORE INSERT ON teaching_delivery_facts FOR EACH ROW EXECUTE FUNCTION teaching_delivery_teacher_authority_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION academic_canonical_teacher_class_guard() RETURNS trigger AS $fn$
            DECLARE
                needs_active_assignment boolean := true;
            BEGIN
                IF TG_OP = 'UPDATE' THEN
                    IF OLD.lifecycle_state = 'active'
                       AND NEW.branch_id IS NOT DISTINCT FROM OLD.branch_id THEN
                        needs_active_assignment := false;
                    END IF;
                END IF;
                IF NEW.lifecycle_state = 'active' AND needs_active_assignment THEN
                    IF NOT EXISTS (
                        SELECT 1
                          FROM teacher_assignments ta
                          JOIN teacher_profiles tp ON tp.id = ta.teacher_profile_id
                          JOIN employments e ON e.id = tp.employment_id
                         WHERE ta.class_id = NEW.id
                           AND ta.teacher_profile_id IS NOT NULL
                           AND ta.teacher_person_id = tp.person_id
                           AND tp.lifecycle_state = 'active'
                           AND COALESCE((SELECT es.status FROM employment_statuses es
                                          WHERE es.employment_id = e.id
                                            AND es.effective_from <= CURRENT_DATE
                                          ORDER BY es.effective_from DESC, es.created_at DESC, es.id DESC
                                          LIMIT 1), e.lifecycle_state) = 'active'
                           AND (ta.lifecycle_state IS NULL OR ta.lifecycle_state <> 'cancelled')
                           AND ta.branch_id = NEW.branch_id
                           AND ta.effective_from <= CURRENT_DATE
                           AND (ta.effective_to IS NULL OR ta.effective_to > CURRENT_DATE)
                    ) THEN
                        RAISE EXCEPTION 'an active class requires a canonical effective teacher assignment'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER academic_canonical_teacher_class_guard_trigger BEFORE INSERT OR UPDATE ON classes FOR EACH ROW EXECUTE FUNCTION academic_canonical_teacher_class_guard()');

        Schema::table('assessment_attempts', function (Blueprint $table): void {
            $table->date('assessed_on')->nullable()->after('enrollment_id');
        });
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION teacher_assessment_attempt_guard() RETURNS trigger AS $fn$
            DECLARE
                assessment_profile_id char(36);
                assessment_class_id char(36);
                teacher_assignment_exists boolean;
                assessment_authorized boolean;
            BEGIN
                SELECT e.class_id INTO assessment_class_id FROM enrollments e WHERE e.id = NEW.enrollment_id;
                IF NEW.assessed_on IS NULL THEN
                    IF NEW.lifecycle_state = 'submitted' THEN
                        IF TG_OP = 'INSERT' THEN
                            RAISE EXCEPTION 'new submitted assessment evidence requires an assessed date'
                                USING ERRCODE = 'check_violation';
                        ELSIF OLD.lifecycle_state IS DISTINCT FROM 'submitted' THEN
                            RAISE EXCEPTION 'submitted assessment evidence requires an assessed date'
                                USING ERRCODE = 'check_violation';
                        END IF;
                    END IF;
                    RETURN NEW;
                END IF;
                SELECT tp.id INTO assessment_profile_id FROM teacher_profiles tp WHERE tp.person_id = NEW.recorded_by;
                IF assessment_profile_id IS NULL THEN
                    RETURN NEW;
                END IF;
                SELECT EXISTS(
                    SELECT 1 FROM teacher_assignments ta
                     JOIN teacher_profiles tp ON tp.id = ta.teacher_profile_id
                     JOIN employments e ON e.id = tp.employment_id
                     WHERE ta.class_id = assessment_class_id
                       AND ta.teacher_profile_id = assessment_profile_id
                       AND ta.teacher_person_id = NEW.recorded_by
                       AND ta.teacher_person_id = tp.person_id
                       AND tp.lifecycle_state = 'active'
                       AND COALESCE((SELECT es.status FROM employment_statuses es
                                      WHERE es.employment_id = e.id
                                        AND es.effective_from <= NEW.assessed_on
                                      ORDER BY es.effective_from DESC, es.created_at DESC, es.id DESC
                                      LIMIT 1), e.lifecycle_state) = 'active'
                       AND (ta.lifecycle_state IS NULL OR ta.lifecycle_state <> 'cancelled')
                       AND ta.effective_from <= NEW.assessed_on
                       AND (ta.effective_to IS NULL OR ta.effective_to > NEW.assessed_on)
                       AND EXISTS (
                           SELECT 1 FROM teacher_profile_branches tpb
                            WHERE tpb.teacher_profile_id = tp.id
                              AND tpb.branch_id = ta.branch_id
                              AND tpb.lifecycle_state = 'active'
                              AND tpb.effective_from <= NEW.assessed_on
                              AND (tpb.effective_to IS NULL OR tpb.effective_to > NEW.assessed_on)
                       )
                       AND EXISTS (
                           SELECT 1 FROM teacher_qualifications tq
                            WHERE tq.teacher_profile_id = tp.id
                              AND tq.lifecycle_state = 'verified'
                              AND (tq.valid_from IS NULL OR tq.valid_from <= NEW.assessed_on)
                              AND (tq.valid_to IS NULL OR tq.valid_to >= NEW.assessed_on)
                       )
                       AND NOT EXISTS (
                           SELECT 1 FROM leaves l
                            WHERE l.employment_id = e.id
                              AND l.lifecycle_state = 'approved'
                              AND l.date_from <= NEW.assessed_on
                              AND l.date_to >= NEW.assessed_on
                       )
                ) INTO teacher_assignment_exists;
                IF NOT teacher_assignment_exists THEN
                    RAISE EXCEPTION 'teacher assessment evidence requires an effective class assignment on the assessed date'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT EXISTS(
                    SELECT 1 FROM teacher_assignments ta
                     JOIN teacher_profiles tp ON tp.id = ta.teacher_profile_id
                     JOIN employments e ON e.id = tp.employment_id
                     JOIN teacher_assignment_skills tas ON tas.teacher_assignment_id = ta.id
                     JOIN teacher_skill_authorities tsa ON tsa.teacher_profile_id = assessment_profile_id
                                                     AND tsa.skill_id = tas.skill_id
                                                     AND tsa.branch_id = ta.branch_id
                     WHERE ta.class_id = assessment_class_id
                       AND ta.teacher_profile_id = assessment_profile_id
                       AND ta.teacher_person_id = NEW.recorded_by
                       AND ta.teacher_person_id = tp.person_id
                       AND tp.lifecycle_state = 'active'
                       AND COALESCE((SELECT es.status FROM employment_statuses es
                                      WHERE es.employment_id = e.id
                                        AND es.effective_from <= NEW.assessed_on
                                      ORDER BY es.effective_from DESC, es.created_at DESC, es.id DESC
                                      LIMIT 1), e.lifecycle_state) = 'active'
                       AND (ta.lifecycle_state IS NULL OR ta.lifecycle_state <> 'cancelled')
                       AND ta.effective_from <= NEW.assessed_on
                       AND (ta.effective_to IS NULL OR ta.effective_to > NEW.assessed_on)
                       AND tsa.authority_kind = 'assess'
                       AND tsa.lifecycle_state = 'active'
                       AND tsa.effective_from <= NEW.assessed_on
                       AND (tsa.effective_to IS NULL OR tsa.effective_to > NEW.assessed_on)
                       AND EXISTS (
                           SELECT 1 FROM teacher_profile_branches tpb
                            WHERE tpb.teacher_profile_id = tp.id
                              AND tpb.branch_id = ta.branch_id
                              AND tpb.lifecycle_state = 'active'
                              AND tpb.effective_from <= NEW.assessed_on
                              AND (tpb.effective_to IS NULL OR tpb.effective_to > NEW.assessed_on)
                       )
                       AND EXISTS (
                           SELECT 1 FROM teacher_qualifications tq
                            WHERE tq.teacher_profile_id = tp.id
                              AND tq.lifecycle_state = 'verified'
                              AND (tq.valid_from IS NULL OR tq.valid_from <= NEW.assessed_on)
                              AND (tq.valid_to IS NULL OR tq.valid_to >= NEW.assessed_on)
                       )
                       AND NOT EXISTS (
                           SELECT 1 FROM leaves l
                            WHERE l.employment_id = e.id
                              AND l.lifecycle_state = 'approved'
                              AND l.date_from <= NEW.assessed_on
                              AND l.date_to >= NEW.assessed_on
                       )
                ) INTO assessment_authorized;
                IF NOT assessment_authorized THEN
                    RAISE EXCEPTION 'teacher assessment evidence requires effective assess authority for an assigned skill'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER teacher_assessment_attempt_guard_trigger BEFORE INSERT OR UPDATE ON assessment_attempts FOR EACH ROW EXECUTE FUNCTION teacher_assessment_attempt_guard()');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION assessment_attempt_date_immutable() RETURNS trigger AS $fn$
            BEGIN
                IF OLD.lifecycle_state = 'submitted' AND NEW.assessed_on IS DISTINCT FROM OLD.assessed_on THEN
                    RAISE EXCEPTION 'assessment evidence date is immutable after submission'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER assessment_attempt_date_immutable_trigger BEFORE UPDATE ON assessment_attempts FOR EACH ROW EXECUTE FUNCTION assessment_attempt_date_immutable()');

        Schema::create('teacher_profile_statuses', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('teacher_profile_id', 36);
            $table->string('status');
            $table->date('effective_from');
            $table->string('reason');
            $table->char('actor_id', 36);
            $table->timestamps();
            $table->foreign('teacher_profile_id')->references('id')->on('teacher_profiles');
        });
        DB::statement("ALTER TABLE teacher_profile_statuses ADD CONSTRAINT teacher_profile_statuses_state_check CHECK (status IN ('pending','active','suspended','retired'))");
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION teacher_profile_statuses_append_only() RETURNS trigger AS $fn$
            BEGIN
                IF TG_OP = 'INSERT' THEN
                    IF NOT EXISTS (
                        SELECT 1 FROM teacher_profiles tp
                         WHERE tp.id = NEW.teacher_profile_id
                           AND tp.lifecycle_state = NEW.status
                    ) THEN
                        RAISE EXCEPTION 'teacher profile status history must match the current profile state'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    RETURN NEW;
                END IF;
                RAISE EXCEPTION 'teacher profile lifecycle history is append-only';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER teacher_profile_statuses_append_only_trigger BEFORE INSERT OR UPDATE OR DELETE ON teacher_profile_statuses FOR EACH ROW EXECUTE FUNCTION teacher_profile_statuses_append_only()');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION teacher_profile_lifecycle_history_guard() RETURNS trigger AS $fn$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM teacher_profile_statuses tps
                     WHERE tps.teacher_profile_id = NEW.id
                       AND tps.status = NEW.lifecycle_state
                ) THEN
                    RAISE EXCEPTION 'teacher profile lifecycle changes require append-only status history'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE CONSTRAINT TRIGGER teacher_profile_lifecycle_history_guard_trigger AFTER INSERT OR UPDATE ON teacher_profiles DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION teacher_profile_lifecycle_history_guard()');
        DB::statement('CREATE INDEX teacher_profile_statuses_history ON teacher_profile_statuses (teacher_profile_id, effective_from, created_at)');    }

    public function down(): void
    {

        DB::statement('DROP TRIGGER IF EXISTS teacher_profile_lifecycle_history_guard_trigger ON teacher_profiles');
        DB::statement('DROP FUNCTION IF EXISTS teacher_profile_lifecycle_history_guard()');
        DB::statement('DROP TRIGGER IF EXISTS teacher_profile_statuses_append_only_trigger ON teacher_profile_statuses');
        DB::statement('DROP FUNCTION IF EXISTS teacher_profile_statuses_append_only()');
        Schema::dropIfExists('teacher_profile_statuses');

        DB::statement('DROP TRIGGER IF EXISTS assessment_attempt_date_immutable_trigger ON assessment_attempts');
        DB::statement('DROP FUNCTION IF EXISTS assessment_attempt_date_immutable()');
        DB::statement('DROP TRIGGER IF EXISTS teacher_assessment_attempt_guard_trigger ON assessment_attempts');
        DB::statement('DROP FUNCTION IF EXISTS teacher_assessment_attempt_guard()');
        Schema::table('assessment_attempts', function (Blueprint $table): void {
            $table->dropColumn('assessed_on');
        });

        DB::statement('DROP TRIGGER IF EXISTS academic_canonical_teacher_class_guard_trigger ON classes');
        DB::statement('DROP FUNCTION IF EXISTS academic_canonical_teacher_class_guard()');

        DB::statement('DROP TRIGGER IF EXISTS teaching_delivery_teacher_authority_guard_trigger ON teaching_delivery_facts');
        DB::statement('DROP FUNCTION IF EXISTS teaching_delivery_teacher_authority_guard()');

        DB::statement('DROP TRIGGER IF EXISTS teacher_session_workload_guard_trigger ON class_sessions');
        DB::statement('DROP FUNCTION IF EXISTS teacher_session_workload_guard()');
        DB::statement('DROP TRIGGER IF EXISTS teacher_session_delivery_guard_trigger ON class_sessions');
        DB::statement('DROP FUNCTION IF EXISTS teacher_session_delivery_guard()');
        DB::statement('DROP TRIGGER IF EXISTS teacher_assignment_skill_authority_guard_trigger ON teacher_assignment_skills');
        DB::statement('DROP FUNCTION IF EXISTS teacher_assignment_skill_authority_guard()');
        DB::statement('DROP TRIGGER IF EXISTS teacher_assignment_provenance_guard_trigger ON teacher_assignments');
        DB::statement('DROP FUNCTION IF EXISTS teacher_assignment_provenance_guard()');
        DB::statement('DROP TRIGGER IF EXISTS teacher_assignment_overlap_guard_trigger ON teacher_assignments');
        DB::statement('DROP FUNCTION IF EXISTS teacher_assignment_overlap_guard()');
        DB::statement('DROP TRIGGER IF EXISTS teacher_assignment_authority_guard_trigger ON teacher_assignments');
        DB::statement('DROP FUNCTION IF EXISTS teacher_assignment_authority_guard()');
        DB::statement('DROP INDEX IF EXISTS teacher_assignments_branch_window');
        DB::statement('DROP INDEX IF EXISTS teacher_assignments_profile_window');
        DB::statement('DROP INDEX IF EXISTS teacher_assignments_one_open_per_class_teacher');
        DB::statement('DROP INDEX IF EXISTS teacher_workload_limits_active_lookup');
        DB::statement('DROP TRIGGER IF EXISTS teacher_workload_overlap_guard_trigger ON teacher_workload_limits');
        DB::statement('DROP FUNCTION IF EXISTS teacher_workload_overlap_guard()');
        Schema::table('teacher_assignments', function (Blueprint $table): void {
            $table->dropForeign(['teacher_profile_id']);
            $table->dropForeign(['branch_id']);
            $table->dropForeign(['campus_id']);
            $table->dropForeign(['organization_id']);
            $table->dropColumn(['teacher_profile_id', 'lifecycle_state', 'branch_id', 'campus_id', 'organization_id', 'assigned_by', 'assignment_reason']);
        });
        DB::statement('CREATE UNIQUE INDEX teacher_assignments_one_open_per_class_teacher ON teacher_assignments (class_id, teacher_person_id) WHERE effective_to IS NULL');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION academic_teacher_assignment_temporal_guard() RETURNS trigger AS $fn$
            DECLARE
                overlap integer;
            BEGIN
                IF NEW.effective_to IS NOT NULL AND NEW.effective_to <= NEW.effective_from THEN
                    RAISE EXCEPTION 'teacher assignment effective window is invalid'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT count(*) INTO overlap
                  FROM teacher_assignments ta
                 WHERE ta.class_id = NEW.class_id
                   AND ta.teacher_person_id = NEW.teacher_person_id
                   AND ta.id <> NEW.id
                   AND ta.effective_from < COALESCE(NEW.effective_to, 'infinity'::date)
                   AND COALESCE(ta.effective_to, 'infinity'::date) > NEW.effective_from;
                IF overlap > 0 THEN
                    RAISE EXCEPTION 'teacher assignment windows may not overlap for one class and teacher'
                        USING ERRCODE = 'exclusion_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER academic_teacher_assignment_temporal_guard_trigger BEFORE INSERT OR UPDATE ON teacher_assignments FOR EACH ROW EXECUTE FUNCTION academic_teacher_assignment_temporal_guard()');

        DB::statement('DROP TRIGGER IF EXISTS teacher_profile_lifecycle_guard ON teacher_profiles');
        DB::statement('DROP FUNCTION IF EXISTS teacher_profile_lifecycle_guard()');
        DB::statement('DROP TRIGGER IF EXISTS teacher_availability_overlap_guard_trigger ON teacher_availabilities');
        DB::statement('DROP FUNCTION IF EXISTS teacher_availability_overlap_guard()');
        DB::statement('DROP TRIGGER IF EXISTS teacher_availability_reference_guard ON teacher_availabilities');
        DB::statement('DROP TRIGGER IF EXISTS teacher_profile_branch_overlap_guard_trigger ON teacher_profile_branches');
        DB::statement('DROP FUNCTION IF EXISTS teacher_profile_branch_overlap_guard()');
        DB::statement('DROP TRIGGER IF EXISTS teacher_skill_authority_overlap_guard_trigger ON teacher_skill_authorities');
        DB::statement('DROP FUNCTION IF EXISTS teacher_skill_authority_overlap_guard()');
        DB::statement('DROP TRIGGER IF EXISTS teacher_skill_authority_reference_guard ON teacher_skill_authorities');
        DB::statement('DROP TRIGGER IF EXISTS teacher_profile_branch_reference_guard ON teacher_profile_branches');
        DB::statement('DROP TRIGGER IF EXISTS teacher_qualification_reference_guard ON teacher_qualifications');
        DB::statement('DROP FUNCTION IF EXISTS teacher_authority_reference_guard()');
        Schema::dropIfExists('teacher_workload_limits');
        Schema::dropIfExists('teacher_availabilities');
        Schema::dropIfExists('teacher_skill_authorities');
        Schema::dropIfExists('teacher_qualifications');
        Schema::dropIfExists('teacher_profile_branches');
        Schema::dropIfExists('teacher_profiles');
    }
};
