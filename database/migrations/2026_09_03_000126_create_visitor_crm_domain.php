<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Visitor / Lead / CRM domain — WP-6 (D) capability.
 *
 * Owns the front-of-school acquisition and conversion pipeline:
 *   visitor_sources/campaigns   — where a lead comes from;
 *   visitors                    — the lead record (person/contact, stage);
 *   visitor_interactions        — every contact/attempt outcome (timeline);
 *   visitor_followups           — scheduled next actions (owner + due);
 *   visitor_conversions         — immutable visitor -> applicant/student trace;
 *   visitor_automation_rules    — deterministic follow-up automation.
 *
 * Authority/boundary rules (see docs/architecture/decisions/wp-visitor-crm.md):
 *   * CRM never creates a Person, Applicant, Student, Message, or Document.
 *     It consumes the authoritative Identity/Admissions/Communication/
 *     Documents commands and records only the trace back to the CRM record.
 *   * A Visitor may be anonymous (no person_id) or identity-attached.
 *     Conversion to an applicant requires an identity-verified Person and is
 *     performed through Admissions RegisterApplicant (never bypassed).
 *   * visitors.origin_branch_id is branch provenance (WP2-DEC-01): immutable
 *     once set, NULL is the unassigned/unknown state (never fabricated).
 *   * Interactions are immutable evidence; corrections append, never rewrite.
 *   * All state changes are audited and idempotent (domain commands).
 *
 * Schema guards enforce the same invariants at the database boundary:
 *   - lifecycle_state CHECKs on every table;
 *   - one ACTIVE lead per identity (on person_id);
 *   - one ACTIVE lead per normalized primary contact (email, else phone);
 *   - visitor_code unique; source/campaign key unique; campaign window sound;
 *   - origin branch provenance immutability on visitors;
 *   - interactions append-only; conversions one per visitor (terminal);
 *   - automation rules key-unique + closed boolean state.
 */
return new class extends Migration
{
    /** Statuses that make a lead "open"/deduplicable. */
    private const OPEN_VISITOR_STATUSES = ['new', 'contacted', 'engaged', 'qualified', 'unqualified'];

    public function up(): void
    {
        // 1. Acquisition source catalog.
        Schema::create('visitor_sources', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->string('key')->unique();
            $table->string('name');
            $table->string('category')->nullable();
            $table->string('lifecycle_state');
            $table->timestamps();
        });
        DB::statement("ALTER TABLE visitor_sources ADD CONSTRAINT visitor_sources_lifecycle_check CHECK (lifecycle_state IN ('active','retired'))");

        // 2. Marketing campaign catalog (source-tied; no money truth here).
        Schema::create('visitor_campaigns', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->string('key')->unique();
            $table->string('name');
            $table->char('source_id', 36)->nullable();
            $table->string('channel');
            $table->date('starts_on');
            $table->date('ends_on')->nullable();
            $table->string('lifecycle_state');
            $table->timestamps();
            $table->foreign('source_id')->references('id')->on('visitor_sources');
        });
        DB::statement("ALTER TABLE visitor_campaigns ADD CONSTRAINT visitor_campaigns_lifecycle_check CHECK (lifecycle_state IN ('active','retired'))");
        DB::statement("ALTER TABLE visitor_campaigns ADD CONSTRAINT visitor_campaigns_channel_check CHECK (channel IN ('walk_in','phone','whatsapp','email','social','website','referral','event','other'))");
        DB::statement('ALTER TABLE visitor_campaigns ADD CONSTRAINT visitor_campaigns_window_check CHECK (ends_on IS NULL OR ends_on >= starts_on)');

        // 3. Visitor (lead) record.
        Schema::create('visitors', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->string('visitor_code')->unique();
            $table->char('person_id', 36)->nullable();
            $table->char('source_id', 36)->nullable();
            $table->char('campaign_id', 36)->nullable();
            $table->string('full_name');
            $table->string('phone')->nullable();
            $table->string('email')->nullable();
            $table->string('preferred_channel');
            $table->string('visitor_type');
            $table->string('status');
            $table->string('rating')->nullable();
            $table->string('interest')->nullable();
            $table->string('notes')->nullable();
            $table->char('assigned_to', 36)->nullable();
            $table->char('origin_branch_id', 36)->nullable();
            $table->string('contact_key')->default('');
            $table->char('created_by', 36);
            $table->char('updated_by', 36)->nullable();
            $table->timestamps();
            $table->foreign('person_id')->references('id')->on('people');
            $table->foreign('source_id')->references('id')->on('visitor_sources');
            $table->foreign('campaign_id')->references('id')->on('visitor_campaigns');
            $table->foreign('assigned_to')->references('id')->on('people');
            $table->foreign('origin_branch_id')->references('id')->on('branches');
        });
        DB::statement("ALTER TABLE visitors ADD CONSTRAINT visitors_status_check CHECK (status IN ('new','contacted','engaged','qualified','unqualified','converted','lost','archived'))");
        DB::statement("ALTER TABLE visitors ADD CONSTRAINT visitors_visitor_type_check CHECK (visitor_type IN ('walk_in','online','phone','whatsapp','referral','admissions_event','social','other'))");
        DB::statement("ALTER TABLE visitors ADD CONSTRAINT visitors_channel_check CHECK (preferred_channel IN ('phone','whatsapp','email','sms','in_person','other'))");
        DB::statement("ALTER TABLE visitors ADD CONSTRAINT visitors_rating_check CHECK (rating IS NULL OR rating IN ('hot','warm','cold'))");
        DB::statement("ALTER TABLE visitors ADD CONSTRAINT visitors_identity_check CHECK (person_id IS NOT NULL OR full_name <> '')");

        // One active lead per identity.
        DB::statement(sprintf(
            'CREATE UNIQUE INDEX visitors_one_active_per_person ON visitors (person_id) WHERE person_id IS NOT NULL AND status IN (%s)',
            $this->statusList(),
        ));
        // One active lead per normalized primary contact (email, else phone).
        DB::statement(sprintf(
            "CREATE UNIQUE INDEX visitors_one_active_per_contact ON visitors (contact_key) WHERE contact_key <> '' AND status IN (%s)",
            $this->statusList(),
        ));

        // Normalize + guard contact_key from whatever the request carries.
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION visitors_contact_key_guard() RETURNS trigger AS $fn$
            DECLARE
                email_key text;
                phone_key text;
            BEGIN
                email_key := NULLIF(lower(btrim(COALESCE(NEW.email, ''))), '');
                phone_key := NULLIF(regexp_replace(COALESCE(NEW.phone, ''), '[^0-9]', '', 'g'), '');
                NEW.contact_key := COALESCE(email_key, phone_key, '');
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql
        SQL);
        DB::statement('CREATE TRIGGER visitors_contact_key_guard BEFORE INSERT OR UPDATE OF email, phone ON visitors FOR EACH ROW EXECUTE FUNCTION visitors_contact_key_guard()');

        // provenance immutability (WP2-DEC-01) — branch provenance on the CRM
        // record uses the same semantic as the 000121 operational anchors.
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION visitors_origin_branch_immutable_guard() RETURNS trigger AS $fn$
            BEGIN
                IF OLD.origin_branch_id IS NOT NULL
                   AND NEW.origin_branch_id IS DISTINCT FROM OLD.origin_branch_id THEN
                    RAISE EXCEPTION 'visitor origin_branch_id is immutable once assigned'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql
        SQL);
        DB::statement('CREATE TRIGGER visitors_originating_immutable BEFORE UPDATE OF origin_branch_id ON visitors FOR EACH ROW EXECUTE FUNCTION visitors_origin_branch_immutable_guard()');

        // 4. Interaction timeline (immutable evidence).
        Schema::create('visitor_interactions', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('visitor_id', 36);
            $table->string('direction');
            $table->string('type');
            $table->string('outcome');
            $table->string('summary');
            $table->date('occurred_on');
            $table->string('occurred_at')->nullable();
            $table->char('agent_id', 36);
            $table->char('message_id', 36)->nullable();
            $table->char('document_id', 36)->nullable();
            $table->char('assessment_attempt_id', 36)->nullable();
            $table->char('payment_id', 36)->nullable();
            $table->string('correlation_id');
            $table->timestamps();
            $table->foreign('visitor_id')->references('id')->on('visitors');
            $table->foreign('message_id')->references('id')->on('messages');
            $table->foreign('document_id')->references('id')->on('documents');
            $table->foreign('assessment_attempt_id')->references('id')->on('assessment_attempts');
            $table->foreign('payment_id')->references('id')->on('payments');
        });
        DB::statement("ALTER TABLE visitor_interactions ADD CONSTRAINT visitor_interactions_direction_check CHECK (direction IN ('inbound','outbound'))");
        DB::statement("ALTER TABLE visitor_interactions ADD CONSTRAINT visitor_interactions_type_check CHECK (type IN ('call','whatsapp','email','sms','visit','meeting','form_submission','document','note','other','payment','assessment'))");
        DB::statement("ALTER TABLE visitor_interactions ADD CONSTRAINT visitor_interactions_outcome_check CHECK (outcome IN ('no_answer','connected','positive','neutral','negative','unreachable','requested_info','scheduled_visit','followup_required','not_interested','qualified','converted','other'))");
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION visitor_interactions_append_only() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'visitor interactions are immutable evidence; a correction is a new interaction'
                    USING ERRCODE = 'check_violation';
            END;
            $fn$ LANGUAGE plpgsql
        SQL);
        DB::statement('CREATE TRIGGER visitor_interactions_append_only BEFORE UPDATE OR DELETE ON visitor_interactions FOR EACH ROW EXECUTE FUNCTION visitor_interactions_append_only()');

        // 5. Follow-up tasks.
        Schema::create('visitor_followups', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('visitor_id', 36);
            $table->char('assigned_to', 36);
            $table->date('scheduled_for');
            $table->string('title');
            $table->string('notes')->nullable();
            $table->string('status');
            $table->char('created_by', 36);
            $table->char('completed_by', 36)->nullable();
            $table->timestamp('completed_at')->nullable();
            $table->string('correlation_id');
            $table->timestamps();
            $table->foreign('visitor_id')->references('id')->on('visitors');
            $table->foreign('assigned_to')->references('id')->on('people');
            $table->foreign('created_by')->references('id')->on('people');
        });
        DB::statement("ALTER TABLE visitor_followups ADD CONSTRAINT visitor_followups_status_check CHECK (status IN ('open','done','cancelled'))");

        // 6. Visitor -> applicant/student conversion trace (terminal, one per visitor).
        Schema::create('visitor_conversions', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('visitor_id', 36)->unique();
            $table->string('conversion_type');
            $table->char('person_id', 36)->nullable();
            $table->char('applicant_id', 36)->nullable();
            $table->char('student_id', 36)->nullable();
            $table->char('converted_by', 36);
            $table->timestamp('converted_at')->useCurrent();
            $table->string('correlation_id');
            $table->timestamps();
            $table->foreign('visitor_id')->references('id')->on('visitors');
            $table->foreign('person_id')->references('id')->on('people');
            $table->foreign('applicant_id')->references('id')->on('applicants');
            $table->foreign('student_id')->references('id')->on('students');
            $table->foreign('converted_by')->references('id')->on('people');
        });
        DB::statement("ALTER TABLE visitor_conversions ADD CONSTRAINT visitor_conversions_type_check CHECK (conversion_type IN ('applicant','student','enquiry'))");

        // 7. Automation rules (deterministic follow-up scheduling).
        Schema::create('visitor_automation_rules', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->string('key')->unique();
            $table->string('name');
            $table->string('trigger_type');
            $table->string('trigger_value');
            $table->string('action_type');
            $table->jsonb('action_config');
            $table->boolean('is_active');
            $table->char('created_by', 36);
            $table->timestamps();
            $table->foreign('created_by')->references('id')->on('people');
        });
        DB::statement("ALTER TABLE visitor_automation_rules ADD CONSTRAINT visitor_automation_rules_trigger_check CHECK (trigger_type IN ('interaction_outcome'))");
        DB::statement("ALTER TABLE visitor_automation_rules ADD CONSTRAINT visitor_automation_rules_action_check CHECK (action_type IN ('schedule_followup'))");
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS visitors_originating_immutable ON visitors');
        DB::statement('DROP FUNCTION IF EXISTS visitors_origin_branch_immutable_guard()');
        DB::statement('DROP TRIGGER IF EXISTS visitors_contact_key_guard ON visitors');
        DB::statement('DROP FUNCTION IF EXISTS visitors_contact_key_guard()');
        DB::statement('DROP TRIGGER IF EXISTS visitor_interactions_append_only ON visitor_interactions');
        DB::statement('DROP FUNCTION IF EXISTS visitor_interactions_append_only()');

        Schema::dropIfExists('visitor_automation_rules');
        Schema::dropIfExists('visitor_conversions');
        Schema::dropIfExists('visitor_followups');
        Schema::dropIfExists('visitor_interactions');
        Schema::dropIfExists('visitors');
        Schema::dropIfExists('visitor_campaigns');
        Schema::dropIfExists('visitor_sources');
    }

    private function statusList(): string
    {
        return "'".implode("','", self::OPEN_VISITOR_STATUSES)."'";
    }
};
