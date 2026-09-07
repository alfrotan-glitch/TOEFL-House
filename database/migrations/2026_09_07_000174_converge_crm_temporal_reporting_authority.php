<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * CRM acquisition and conversion reporting needs a trustworthy event clock.
 *
 * A capture is a CRM-owned fact, so the database records its accepted INSERT
 * time. A conversion/handoff is not CRM-owned: it is only an immutable trace
 * to an Admissions/Students authority event. Its reporting clock therefore
 * copies the exact database-recorded time of that bound authority audit event,
 * rather than the later CRM mirror-row insertion time.
 *
 * Audit/outbox time is the prerequisite for that rule. New audit records get
 * their clock from PostgreSQL and new domain-event rows copy that clock from
 * their immutable audit parent. Historical rows deliberately remain null in
 * the new provenance columns; no old application timestamp is relabelled as
 * database evidence.
 */
return new class extends Migration
{
    public function up(): void
    {
        // Reporting needs to distinguish a period that is wholly after a
        // prospective guard from one that overlaps retained unclassified
        // history. This append-only registry records that deployment boundary
        // with a database clock; it is not an editable reporting setting.
        Schema::create('reporting_evidence_epochs', function (Blueprint $table): void {
            $table->string('source_key')->primary();
            $table->timestamp('effective_at');
            $table->string('time_basis');
        });
        DB::statement(<<<'SQL'
            ALTER TABLE reporting_evidence_epochs
                ADD CONSTRAINT reporting_evidence_epochs_shape_check
                CHECK (
                    source_key IN (
                        'audit_event_time_v1',
                        'domain_event_time_v1',
                        'crm_capture_time_v1',
                        'crm_conversion_time_v1',
                        'crm_status_history_time_v1'
                    )
                    AND time_basis = 'database_migration'
                )
            SQL);
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION reporting_evidence_epochs_guard() RETURNS trigger AS $fn$
            BEGIN
                IF TG_OP <> 'INSERT' THEN
                    RAISE EXCEPTION 'reporting evidence epochs are append-only deployment evidence'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.effective_at IS NOT NULL OR NEW.time_basis IS NOT NULL THEN
                    RAISE EXCEPTION 'reporting evidence epoch time is assigned only by the database migration boundary'
                        USING ERRCODE = 'check_violation';
                END IF;
                NEW.effective_at := timezone('UTC', clock_timestamp());
                NEW.time_basis := 'database_migration';
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER reporting_evidence_epochs_guard_trigger BEFORE INSERT OR UPDATE OR DELETE ON reporting_evidence_epochs FOR EACH ROW EXECUTE FUNCTION reporting_evidence_epochs_guard()');

        // The audit event is the transaction-local evidence parent for both a
        // downstream conversion and its outbox publication. Add its prospective
        // time provenance before installing the CRM trace guards below.
        Schema::table('audit_events', function (Blueprint $table): void {
            $table->string('occurred_time_basis')->nullable();
        });
        Schema::table('domain_events', function (Blueprint $table): void {
            $table->string('occurred_time_basis')->nullable();
        });

        Schema::table('visitors', function (Blueprint $table): void {
            $table->timestamp('captured_at')->nullable();
            $table->string('capture_time_basis')->nullable();
            $table->index(['capture_time_basis', 'captured_at'], 'visitors_capture_evidence_index');
        });
        Schema::table('visitor_conversions', function (Blueprint $table): void {
            $table->string('conversion_time_basis')->nullable();
            $table->index(['conversion_time_basis', 'converted_at'], 'visitor_conversions_time_evidence_index');
        });
        Schema::table('visitor_conversion_handoffs', function (Blueprint $table): void {
            $table->string('conversion_time_basis')->nullable();
        });
        Schema::table('visitor_status_history', function (Blueprint $table): void {
            $table->string('change_time_basis')->nullable();
        });

        DB::statement(<<<'SQL'
            ALTER TABLE audit_events
                ADD CONSTRAINT audit_events_time_shape_check
                CHECK (occurred_time_basis IS NULL OR occurred_time_basis = 'database_insert') NOT VALID
            SQL);
        DB::statement(<<<'SQL'
            ALTER TABLE domain_events
                ADD CONSTRAINT domain_events_time_shape_check
                CHECK (occurred_time_basis IS NULL OR occurred_time_basis = 'audit_event') NOT VALID
            SQL);
        DB::statement(<<<'SQL'
            ALTER TABLE visitors
                ADD CONSTRAINT visitors_capture_time_shape_check
                CHECK (
                    (captured_at IS NULL AND capture_time_basis IS NULL)
                    OR (captured_at IS NOT NULL AND capture_time_basis = 'database_insert')
                ) NOT VALID
            SQL);
        DB::statement(<<<'SQL'
            ALTER TABLE visitor_conversions
                ADD CONSTRAINT visitor_conversions_time_shape_check
                CHECK (conversion_time_basis IS NULL OR conversion_time_basis = 'authority_audit_event') NOT VALID
            SQL);
        DB::statement(<<<'SQL'
            ALTER TABLE visitor_conversion_handoffs
                ADD CONSTRAINT visitor_conversion_handoffs_time_shape_check
                CHECK (conversion_time_basis IS NULL OR conversion_time_basis = 'authority_audit_event') NOT VALID
            SQL);
        DB::statement(<<<'SQL'
            ALTER TABLE visitor_status_history
                ADD CONSTRAINT visitor_status_history_time_shape_check
                CHECK (change_time_basis IS NULL OR change_time_basis = 'database_transition') NOT VALID
            SQL);

        // `occurred_at` was append-only but caller-selected on INSERT. Do not
        // accept a supplied value: a reportable audit time is the database's
        // acceptance time, expressed in UTC in this legacy timestamp-without-
        // timezone column.
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION audit_events_temporal_authority_guard() RETURNS trigger AS $fn$
            BEGIN
                IF NEW.occurred_at IS NOT NULL OR NEW.occurred_time_basis IS NOT NULL THEN
                    RAISE EXCEPTION 'audit event time is assigned only by the database insert boundary'
                        USING ERRCODE = 'check_violation';
                END IF;
                NEW.occurred_at := timezone('UTC', clock_timestamp());
                NEW.occurred_time_basis := 'database_insert';
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS audit_events_temporal_authority_guard_trigger ON audit_events');
        DB::statement('CREATE TRIGGER audit_events_temporal_authority_guard_trigger BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION audit_events_temporal_authority_guard()');

        // A domain event is an outbox projection of its audit parent, never a
        // second caller-clocked event. The explicit AT TIME ZONE conversion is
        // required because audit_events.occurred_at predates timestamptz usage
        // and stores an already-UTC timestamp without timezone.
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION domain_events_temporal_authority_guard() RETURNS trigger AS $fn$
            DECLARE
                audit_occurred_at timestamp;
                audit_time_basis text;
            BEGIN
                IF NEW.occurred_at IS NOT NULL OR NEW.occurred_time_basis IS NOT NULL THEN
                    RAISE EXCEPTION 'domain event time is derived only from its audit event'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT occurred_at, occurred_time_basis
                  INTO audit_occurred_at, audit_time_basis
                  FROM audit_events
                 WHERE id = NEW.audit_event_id;
                IF audit_occurred_at IS NULL OR audit_time_basis IS DISTINCT FROM 'database_insert' THEN
                    RAISE EXCEPTION 'domain event requires a database-recorded audit-event clock'
                        USING ERRCODE = 'check_violation';
                END IF;
                NEW.occurred_at := audit_occurred_at AT TIME ZONE 'UTC';
                NEW.occurred_time_basis := 'audit_event';
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS domain_events_temporal_authority_guard_trigger ON domain_events');
        DB::statement('CREATE TRIGGER domain_events_temporal_authority_guard_trigger BEFORE INSERT ON domain_events FOR EACH ROW EXECUTE FUNCTION domain_events_temporal_authority_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION crm_visitor_temporal_facts_guard() RETURNS trigger AS $fn$
            DECLARE
                event_at timestamp;
            BEGIN
                IF TG_OP = 'INSERT' THEN
                    IF NEW.captured_at IS NOT NULL OR NEW.capture_time_basis IS NOT NULL THEN
                        RAISE EXCEPTION 'visitor capture time is assigned only by the database insert boundary'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    event_at := timezone('UTC', clock_timestamp());
                    -- `created_at` remains a compatibility field. Overwrite a
                    -- caller value so a new capture cannot select a reporting
                    -- cohort through either timestamp.
                    NEW.created_at := event_at;
                    NEW.captured_at := event_at;
                    NEW.capture_time_basis := 'database_insert';
                    RETURN NEW;
                END IF;

                IF OLD.created_at IS DISTINCT FROM NEW.created_at THEN
                    RAISE EXCEPTION 'visitor creation time is immutable reporting evidence'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF OLD.captured_at IS DISTINCT FROM NEW.captured_at
                   OR OLD.capture_time_basis IS DISTINCT FROM NEW.capture_time_basis THEN
                    RAISE EXCEPTION 'visitor capture time is immutable historical evidence'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS crm_visitor_temporal_facts_guard_trigger ON visitors');
        DB::statement('CREATE TRIGGER crm_visitor_temporal_facts_guard_trigger BEFORE INSERT OR UPDATE ON visitors FOR EACH ROW EXECUTE FUNCTION crm_visitor_temporal_facts_guard()');

        // Conversion and handoff occurrence belongs to the downstream owner.
        // The CRM row cannot choose (or merely approximate) that occurrence;
        // the existing conversion guards subsequently prove the audit event is
        // the exact Applicant/Student authority event for this target.
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION crm_visitor_conversion_temporal_facts_guard() RETURNS trigger AS $fn$
            DECLARE
                authority_occurred_at timestamp;
                authority_time_basis text;
            BEGIN
                IF NEW.conversion_time_basis IS NOT NULL THEN
                    RAISE EXCEPTION 'visitor conversion time provenance is assigned only from its authority audit event'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT occurred_at, occurred_time_basis
                  INTO authority_occurred_at, authority_time_basis
                  FROM audit_events
                 WHERE id = NEW.authority_audit_event_id;
                IF authority_occurred_at IS NULL OR authority_time_basis IS DISTINCT FROM 'database_insert' THEN
                    RAISE EXCEPTION 'visitor conversion requires a database-recorded authority audit-event clock'
                        USING ERRCODE = 'check_violation';
                END IF;
                -- `converted_at` has a legacy database default. Always replace
                -- that default or a caller value with the authority event time.
                NEW.converted_at := authority_occurred_at;
                NEW.conversion_time_basis := 'authority_audit_event';
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS crm_visitor_conversion_temporal_facts_guard_trigger ON visitor_conversions');
        DB::statement('CREATE TRIGGER crm_visitor_conversion_temporal_facts_guard_trigger BEFORE INSERT ON visitor_conversions FOR EACH ROW EXECUTE FUNCTION crm_visitor_conversion_temporal_facts_guard()');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION crm_visitor_conversion_handoff_temporal_facts_guard() RETURNS trigger AS $fn$
            DECLARE
                authority_occurred_at timestamp;
                authority_time_basis text;
            BEGIN
                IF NEW.conversion_time_basis IS NOT NULL THEN
                    RAISE EXCEPTION 'visitor conversion handoff time provenance is assigned only from its authority audit event'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT occurred_at, occurred_time_basis
                  INTO authority_occurred_at, authority_time_basis
                  FROM audit_events
                 WHERE id = NEW.authority_audit_event_id;
                IF authority_occurred_at IS NULL OR authority_time_basis IS DISTINCT FROM 'database_insert' THEN
                    RAISE EXCEPTION 'visitor conversion handoff requires a database-recorded authority audit-event clock'
                        USING ERRCODE = 'check_violation';
                END IF;
                NEW.converted_at := authority_occurred_at;
                NEW.conversion_time_basis := 'authority_audit_event';
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS crm_visitor_conversion_handoff_temporal_facts_guard_trigger ON visitor_conversion_handoffs');
        DB::statement('CREATE TRIGGER crm_visitor_conversion_handoff_temporal_facts_guard_trigger BEFORE INSERT ON visitor_conversion_handoffs FOR EACH ROW EXECUTE FUNCTION crm_visitor_conversion_handoff_temporal_facts_guard()');

        // visitor_status_history is a CRM-owned lifecycle fact. Its existing
        // parent trigger is the only supported writer. At the nested child
        // trigger PostgreSQL reports depth two (parent visitor trigger plus
        // this BEFORE INSERT trigger); direct SQL reaches depth one and fails.
        // The current visitor state/actor check prevents a different nested
        // write from manufacturing an arbitrary status row for this visitor.
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION crm_visitor_status_history_temporal_guard() RETURNS trigger AS $fn$
            DECLARE
                visitor_status text;
                expected_actor char(36);
            BEGIN
                IF pg_trigger_depth() <> 2 THEN
                    RAISE EXCEPTION 'visitor status history may be appended only by the visitor lifecycle transition trigger'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.change_time_basis IS NOT NULL THEN
                    RAISE EXCEPTION 'visitor status history time provenance is assigned only by the database transition boundary'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT status, COALESCE(updated_by, created_by)
                  INTO visitor_status, expected_actor
                  FROM visitors
                 WHERE id = NEW.visitor_id;
                IF visitor_status IS DISTINCT FROM NEW.to_status
                   OR expected_actor IS DISTINCT FROM NEW.changed_by THEN
                    RAISE EXCEPTION 'visitor status history must match the lifecycle transition parent'
                        USING ERRCODE = 'check_violation';
                END IF;
                NEW.changed_at := timezone('UTC', clock_timestamp());
                NEW.change_time_basis := 'database_transition';
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS crm_visitor_status_history_temporal_guard_trigger ON visitor_status_history');
        DB::statement('CREATE TRIGGER crm_visitor_status_history_temporal_guard_trigger BEFORE INSERT ON visitor_status_history FOR EACH ROW EXECUTE FUNCTION crm_visitor_status_history_temporal_guard()');

        // Insert only after every source guard is active. A report period that
        // begins before one of these UTC instants is explicitly incomplete;
        // a later period additionally checks for any anomalous unclassified
        // row rather than assuming that a migration erased historic evidence.
        DB::table('reporting_evidence_epochs')->insert([
            ['source_key' => 'audit_event_time_v1'],
            ['source_key' => 'domain_event_time_v1'],
            ['source_key' => 'crm_capture_time_v1'],
            ['source_key' => 'crm_conversion_time_v1'],
            ['source_key' => 'crm_status_history_time_v1'],
        ]);
    }

    public function down(): void
    {
        // Removing these markers would relabel retained historical evidence as
        // ordinary caller-clocked data and reopen reporting/cohort bypasses.
        throw new \RuntimeException('Audit and CRM temporal reporting authority are one-way; do not erase immutable event-time provenance.');
    }
};
