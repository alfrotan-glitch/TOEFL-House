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
 *   - interactions append-only with explicit CRM/downstream trace origin;
 *     downstream traces bind to the immutable authority audit event for their
 *     referenced Message, Document, assessment, payment, or placement fact;
 *   - lifecycle status history append-only; one terminal conversion per
 *     visitor, with a separate immutable Applicant-to-Student handoff trace
 *     when Admissions later enrolls the applicant; both bind to downstream
 *     authority audit events;
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
            $table->char('created_by', 36);
            $table->timestamps();
            $table->foreign('created_by')->references('id')->on('people');
        });
        DB::statement("ALTER TABLE visitor_sources ADD CONSTRAINT visitor_sources_lifecycle_check CHECK (lifecycle_state IN ('active','retired'))");
        DB::statement('ALTER TABLE visitor_sources ADD CONSTRAINT visitor_sources_length_check CHECK (length(key) BETWEEN 1 AND 80 AND length(name) BETWEEN 1 AND 160 AND (category IS NULL OR length(category) <= 80))');

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
            $table->char('created_by', 36);
            $table->timestamps();
            $table->foreign('source_id')->references('id')->on('visitor_sources');
            $table->foreign('created_by')->references('id')->on('people');
        });
        DB::statement("ALTER TABLE visitor_campaigns ADD CONSTRAINT visitor_campaigns_lifecycle_check CHECK (lifecycle_state IN ('active','retired'))");
        DB::statement("ALTER TABLE visitor_campaigns ADD CONSTRAINT visitor_campaigns_channel_check CHECK (channel IN ('walk_in','phone','whatsapp','email','social','website','referral','event','other'))");
        DB::statement('ALTER TABLE visitor_campaigns ADD CONSTRAINT visitor_campaigns_window_check CHECK (ends_on IS NULL OR ends_on >= starts_on)');
        DB::statement('ALTER TABLE visitor_campaigns ADD CONSTRAINT visitor_campaigns_length_check CHECK (length(key) BETWEEN 1 AND 80 AND length(name) BETWEEN 1 AND 160 AND length(channel) BETWEEN 1 AND 40)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION visitor_source_catalog_guard() RETURNS trigger AS $fn$
            DECLARE creator_state text;
            BEGIN
                IF TG_OP = 'INSERT' THEN
                    SELECT verification_state INTO creator_state FROM people WHERE id = NEW.created_by;
                    IF creator_state IS DISTINCT FROM 'verified' THEN
                        RAISE EXCEPTION 'visitor source creator must be a verified Person' USING ERRCODE = 'check_violation';
                    END IF;
                ELSE
                    IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
                        RAISE EXCEPTION 'visitor source creator is immutable' USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                IF TG_OP = 'UPDATE' THEN
                    IF NEW.key IS DISTINCT FROM OLD.key
                       OR NEW.name IS DISTINCT FROM OLD.name
                       OR NEW.category IS DISTINCT FROM OLD.category
                       OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
                        RAISE EXCEPTION 'visitor source identity and metadata are immutable; retire and define a new source'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF OLD.lifecycle_state = 'retired' AND NEW.lifecycle_state <> 'retired' THEN
                        RAISE EXCEPTION 'retired visitor sources cannot be reopened'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF OLD.lifecycle_state = 'active' AND NEW.lifecycle_state = 'retired'
                       AND EXISTS (SELECT 1 FROM visitor_campaigns WHERE source_id = OLD.id AND lifecycle_state = 'active') THEN
                        RAISE EXCEPTION 'visitor source cannot retire while an active campaign references it'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql
        SQL);
        DB::statement('CREATE TRIGGER visitor_source_catalog_guard BEFORE INSERT OR UPDATE ON visitor_sources FOR EACH ROW EXECUTE FUNCTION visitor_source_catalog_guard()');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION visitor_campaign_catalog_guard() RETURNS trigger AS $fn$
            DECLARE
                source_state text;
                creator_state text;
            BEGIN
                IF TG_OP = 'INSERT' THEN
                    SELECT verification_state INTO creator_state FROM people WHERE id = NEW.created_by;
                    IF creator_state IS DISTINCT FROM 'verified' THEN
                        RAISE EXCEPTION 'visitor campaign creator must be a verified Person' USING ERRCODE = 'check_violation';
                    END IF;
                ELSE
                    IF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
                        RAISE EXCEPTION 'visitor campaign creator is immutable' USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                IF TG_OP = 'UPDATE' THEN
                    IF NEW.key IS DISTINCT FROM OLD.key
                       OR NEW.name IS DISTINCT FROM OLD.name
                       OR NEW.source_id IS DISTINCT FROM OLD.source_id
                       OR NEW.channel IS DISTINCT FROM OLD.channel
                       OR NEW.starts_on IS DISTINCT FROM OLD.starts_on
                       OR NEW.ends_on IS DISTINCT FROM OLD.ends_on
                       OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
                        RAISE EXCEPTION 'visitor campaign identity and attribution are immutable; define a new campaign'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF OLD.lifecycle_state = 'retired' AND NEW.lifecycle_state <> 'retired' THEN
                        RAISE EXCEPTION 'retired visitor campaigns cannot be reopened'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                IF NEW.source_id IS NOT NULL THEN
                    SELECT lifecycle_state INTO source_state FROM visitor_sources WHERE id = NEW.source_id;
                    IF source_state IS DISTINCT FROM 'active' AND TG_OP = 'INSERT' THEN
                        RAISE EXCEPTION 'a new visitor campaign requires an active source'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql
        SQL);
        DB::statement('CREATE TRIGGER visitor_campaign_catalog_guard BEFORE INSERT OR UPDATE ON visitor_campaigns FOR EACH ROW EXECUTE FUNCTION visitor_campaign_catalog_guard()');

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
            $table->string('notes', 2000)->nullable();
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
            $table->foreign('created_by')->references('id')->on('people');
            $table->foreign('updated_by')->references('id')->on('people');
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
            $table->string('summary', 2000);
            $table->date('occurred_on');
            $table->string('occurred_at')->nullable();
            $table->char('agent_id', 36);
            $table->string('trace_origin')->default('crm');
            // Downstream traces must bind to the immutable authority event that
            // created the referenced record; CRM-originated interactions leave
            // this null because CRM is their owning authority.
            $table->char('authority_audit_event_id', 36)->nullable();
            $table->char('message_id', 36)->nullable();
            $table->char('document_id', 36)->nullable();
            $table->char('assessment_attempt_id', 36)->nullable();
            $table->char('payment_id', 36)->nullable();
            $table->string('correlation_id');
            $table->timestamps();
            $table->foreign('visitor_id')->references('id')->on('visitors');
            $table->foreign('authority_audit_event_id')->references('id')->on('audit_events');
            $table->foreign('message_id')->references('id')->on('messages');
            $table->foreign('document_id')->references('id')->on('documents');
            $table->foreign('assessment_attempt_id')->references('id')->on('assessment_attempts');
            $table->foreign('payment_id')->references('id')->on('payments');
        });
        DB::statement("ALTER TABLE visitor_interactions ADD CONSTRAINT visitor_interactions_direction_check CHECK (direction IN ('".implode("','", \App\Modules\Crm\Domain\VisitorInteractionCatalog::directions())."'))");
        DB::statement("ALTER TABLE visitor_interactions ADD CONSTRAINT visitor_interactions_type_check CHECK (type IN ('".implode("','", \App\Modules\Crm\Domain\VisitorInteractionCatalog::types())."'))");
        DB::statement("ALTER TABLE visitor_interactions ADD CONSTRAINT visitor_interactions_outcome_check CHECK (outcome IN ('".implode("','", \App\Modules\Crm\Domain\VisitorInteractionCatalog::outcomes())."'))");
        DB::statement("ALTER TABLE visitor_interactions ADD CONSTRAINT visitor_interactions_trace_origin_check CHECK (trace_origin IN ('crm','downstream'))");
        DB::statement('CREATE UNIQUE INDEX visitor_interactions_authority_event_unique ON visitor_interactions (authority_audit_event_id) WHERE authority_audit_event_id IS NOT NULL');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION visitor_interactions_append_only() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'visitor interactions are immutable evidence; a correction is a new interaction'
                    USING ERRCODE = 'check_violation';
            END;
            $fn$ LANGUAGE plpgsql
        SQL);
        DB::statement('CREATE TRIGGER visitor_interactions_append_only BEFORE UPDATE OR DELETE ON visitor_interactions FOR EACH ROW EXECUTE FUNCTION visitor_interactions_append_only()');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION visitor_interaction_reference_guard() RETURNS trigger AS $fn$
            DECLARE
                reference_count integer;
                visitor_status text;
                visitor_branch char(36);
                visitor_person char(36);
                subject_person char(36);
                subject_branch char(36);
                branch_provenance_required boolean := false;
                agent_state text;
                authority_actor char(36);
                authority_operation text;
                authority_target_type text;
                authority_target_id char(36);
                authority_after_state jsonb;
                authority_branch char(36);
            BEGIN
                SELECT status, origin_branch_id INTO visitor_status, visitor_branch FROM visitors WHERE id = NEW.visitor_id;
                IF visitor_status IS NULL THEN
                    RAISE EXCEPTION 'visitor interaction requires an existing visitor' USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.trace_origin = 'crm' AND visitor_status NOT IN ('new','contacted','engaged','qualified','unqualified') THEN
                    RAISE EXCEPTION 'CRM interactions require an open visitor' USING ERRCODE = 'check_violation';
                END IF;
                IF btrim(COALESCE(NEW.summary, '')) = '' OR btrim(COALESCE(NEW.correlation_id, '')) = '' THEN
                    RAISE EXCEPTION 'visitor interaction requires summary and correlation id'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.occurred_on > CURRENT_DATE THEN
                    RAISE EXCEPTION 'visitor interaction cannot be dated in the future'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT verification_state INTO agent_state FROM people WHERE id = NEW.agent_id;
                IF agent_state IS DISTINCT FROM 'verified' THEN
                    RAISE EXCEPTION 'visitor interaction agent must be a verified Person'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.trace_origin = 'downstream' AND NEW.authority_audit_event_id IS NULL THEN
                    RAISE EXCEPTION 'downstream CRM traces require an immutable authority event'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.trace_origin = 'crm' AND NEW.authority_audit_event_id IS NOT NULL THEN
                    RAISE EXCEPTION 'CRM-originated interactions cannot claim a downstream authority event'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.trace_origin = 'downstream' THEN
                    SELECT actor_id, operation, target_type, target_id, after_state
                      INTO authority_actor, authority_operation, authority_target_type, authority_target_id, authority_after_state
                      FROM audit_events
                     WHERE id = NEW.authority_audit_event_id;
                    IF authority_actor IS DISTINCT FROM NEW.agent_id THEN
                        RAISE EXCEPTION 'downstream CRM trace actor must match its authority event actor'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    authority_branch := COALESCE(authority_after_state->>'branch_id', authority_after_state->>'originating_branch_id');
                    IF visitor_branch IS NOT NULL AND authority_branch IS NOT NULL AND visitor_branch IS DISTINCT FROM authority_branch THEN
                        RAISE EXCEPTION 'downstream CRM trace authority event must carry compatible branch provenance'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                reference_count := (CASE WHEN NEW.message_id IS NOT NULL THEN 1 ELSE 0 END)
                    + (CASE WHEN NEW.document_id IS NOT NULL THEN 1 ELSE 0 END)
                    + (CASE WHEN NEW.assessment_attempt_id IS NOT NULL THEN 1 ELSE 0 END)
                    + (CASE WHEN NEW.payment_id IS NOT NULL THEN 1 ELSE 0 END);
                IF NEW.trace_origin = 'downstream' AND reference_count = 0 THEN
                    RAISE EXCEPTION 'downstream CRM traces require an authoritative reference' USING ERRCODE = 'check_violation';
                END IF;
                IF reference_count > 1 THEN
                    RAISE EXCEPTION 'visitor interaction may reference only one authoritative record'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF reference_count = 0 AND NEW.type IN ('document','payment','assessment','placement') THEN
                    RAISE EXCEPTION 'specialized visitor interaction requires an authoritative reference'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.trace_origin = 'downstream' AND NEW.message_id IS NOT NULL
                   AND (authority_target_type IS DISTINCT FROM 'message'
                        OR authority_target_id IS DISTINCT FROM NEW.message_id
                        OR authority_operation IS DISTINCT FROM 'communication.message.queue') THEN
                    RAISE EXCEPTION 'message CRM trace must bind to the message authority event'
                        USING ERRCODE = 'check_violation';
                ELSIF NEW.trace_origin = 'downstream' AND NEW.document_id IS NOT NULL
                   AND (authority_target_type IS DISTINCT FROM 'document'
                        OR authority_target_id IS DISTINCT FROM NEW.document_id
                        OR authority_operation IS DISTINCT FROM 'documents.register') THEN
                    RAISE EXCEPTION 'document CRM trace must bind to the document authority event'
                        USING ERRCODE = 'check_violation';
                ELSIF NEW.trace_origin = 'downstream' AND NEW.assessment_attempt_id IS NOT NULL
                   AND (authority_target_type IS DISTINCT FROM 'assessment_attempt'
                        OR authority_target_id IS DISTINCT FROM NEW.assessment_attempt_id
                        OR authority_operation IS DISTINCT FROM 'academic.attempt.submit') THEN
                    RAISE EXCEPTION 'assessment CRM trace must bind to the assessment authority event'
                        USING ERRCODE = 'check_violation';
                ELSIF NEW.trace_origin = 'downstream' AND NEW.payment_id IS NOT NULL
                   AND (authority_target_type IS DISTINCT FROM 'payment'
                        OR authority_target_id IS DISTINCT FROM NEW.payment_id
                        OR authority_operation IS DISTINCT FROM 'finance.payment.record') THEN
                    RAISE EXCEPTION 'payment CRM trace must bind to the payment authority event'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.message_id IS NOT NULL THEN
                    IF NEW.type NOT IN ('call','whatsapp','email','sms','other') THEN
                        RAISE EXCEPTION 'message reference requires a compatible interaction type'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    SELECT subject_person_id INTO subject_person FROM messages WHERE id = NEW.message_id;
                ELSIF NEW.document_id IS NOT NULL THEN
                    IF NEW.type <> 'document' THEN
                        RAISE EXCEPTION 'document reference requires document interaction type'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    SELECT subject_person_id INTO subject_person FROM documents WHERE id = NEW.document_id;
                ELSIF NEW.assessment_attempt_id IS NOT NULL THEN
                    branch_provenance_required := true;
                    IF NEW.type <> 'assessment' THEN
                        RAISE EXCEPTION 'assessment reference requires assessment interaction type'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    SELECT s.person_id, e.originating_branch_id INTO subject_person, subject_branch
                      FROM assessment_attempts aa
                      JOIN enrollments e ON e.id = aa.enrollment_id
                      JOIN students s ON s.id = e.student_id
                     WHERE aa.id = NEW.assessment_attempt_id;
                ELSIF NEW.payment_id IS NOT NULL THEN
                    branch_provenance_required := true;
                    IF NEW.type <> 'payment' THEN
                        RAISE EXCEPTION 'payment reference requires payment interaction type'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    SELECT s.person_id, p.originating_branch_id INTO subject_person, subject_branch
                      FROM payments p JOIN students s ON s.id = p.student_id
                     WHERE p.id = NEW.payment_id;
                END IF;
                IF reference_count > 0 THEN
                    SELECT v.person_id INTO visitor_person FROM visitors v WHERE v.id = NEW.visitor_id;
                    IF visitor_person IS NULL OR subject_person IS NULL OR visitor_person IS DISTINCT FROM subject_person THEN
                        RAISE EXCEPTION 'visitor interaction reference must belong to the visitor person'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF branch_provenance_required AND visitor_branch IS NOT NULL AND (subject_branch IS NULL OR visitor_branch IS DISTINCT FROM subject_branch) THEN
                        RAISE EXCEPTION 'visitor interaction reference must carry compatible originating branch provenance'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF NOT EXISTS (SELECT 1 FROM people WHERE id = visitor_person AND verification_state = 'verified') THEN
                        RAISE EXCEPTION 'linked visitor interaction requires a verified visitor identity'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql
        SQL);
        DB::statement('CREATE TRIGGER visitor_interaction_reference_guard BEFORE INSERT ON visitor_interactions FOR EACH ROW EXECUTE FUNCTION visitor_interaction_reference_guard()');

        // 5. Follow-up tasks.
        Schema::create('visitor_followups', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('visitor_id', 36);
            $table->char('assigned_to', 36);
            $table->date('scheduled_for');
            $table->string('title', 160);
            $table->string('notes', 2000)->nullable();
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
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION visitor_followup_guard() RETURNS trigger AS $fn$
            DECLARE
                visitor_status text;
                assignee_state text;
                creator_state text;
                completer_state text;
            BEGIN
                SELECT status INTO visitor_status FROM visitors WHERE id = NEW.visitor_id;
                IF visitor_status IS NULL THEN
                    RAISE EXCEPTION 'visitor follow-up requires an existing visitor'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.title IS NULL OR btrim(NEW.title) = '' OR btrim(COALESCE(NEW.correlation_id, '')) = '' THEN
                    RAISE EXCEPTION 'visitor follow-up requires title and correlation id'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF TG_OP = 'INSERT' THEN
                    SELECT verification_state INTO assignee_state FROM people WHERE id = NEW.assigned_to;
                    SELECT verification_state INTO creator_state FROM people WHERE id = NEW.created_by;
                    IF assignee_state IS DISTINCT FROM 'verified' OR creator_state IS DISTINCT FROM 'verified' THEN
                        RAISE EXCEPTION 'visitor follow-up requires verified assignee and creator identities'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF NEW.status <> 'open' OR NEW.completed_by IS NOT NULL OR NEW.completed_at IS NOT NULL THEN
                        RAISE EXCEPTION 'new visitor follow-ups must begin open without completion evidence'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF visitor_status NOT IN ('new','contacted','engaged','qualified','unqualified') THEN
                        RAISE EXCEPTION 'new follow-ups require an open visitor'
                            USING ERRCODE = 'check_violation';
                    END IF;
                ELSE
                    IF OLD.visitor_id IS DISTINCT FROM NEW.visitor_id
                       OR OLD.assigned_to IS DISTINCT FROM NEW.assigned_to
                       OR OLD.scheduled_for IS DISTINCT FROM NEW.scheduled_for
                       OR OLD.title IS DISTINCT FROM NEW.title
                       OR OLD.notes IS DISTINCT FROM NEW.notes
                       OR OLD.created_by IS DISTINCT FROM NEW.created_by
                       OR OLD.correlation_id IS DISTINCT FROM NEW.correlation_id THEN
                        RAISE EXCEPTION 'visitor follow-up identity and content are immutable'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF OLD.status <> 'open' THEN
                        RAISE EXCEPTION 'completed or cancelled visitor follow-ups are terminal'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF visitor_status NOT IN ('new','contacted','engaged','qualified','unqualified') THEN
                        RAISE EXCEPTION 'follow-ups cannot be closed after the visitor reaches a terminal state'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF NEW.status NOT IN ('done','cancelled') OR NEW.completed_by IS NULL OR NEW.completed_at IS NULL THEN
                        RAISE EXCEPTION 'follow-up closure requires done or cancelled status and completion evidence'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    SELECT verification_state INTO completer_state FROM people WHERE id = NEW.completed_by;
                    IF completer_state IS DISTINCT FROM 'verified' THEN
                        RAISE EXCEPTION 'follow-up completion requires a verified identity'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql
        SQL);
        DB::statement('CREATE TRIGGER visitor_followup_guard BEFORE INSERT OR UPDATE ON visitor_followups FOR EACH ROW EXECUTE FUNCTION visitor_followup_guard()');

        // 6. Visitor -> applicant/student conversion trace (terminal, one per visitor).
        Schema::create('visitor_conversions', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('visitor_id', 36)->unique();
            $table->string('conversion_type');
            $table->string('authority');
            $table->char('person_id', 36)->nullable();
            $table->char('applicant_id', 36)->nullable();
            $table->char('student_id', 36)->nullable();
            $table->char('converted_by', 36);
            $table->char('authority_audit_event_id', 36);
            $table->timestamp('converted_at')->useCurrent();
            $table->string('correlation_id');
            $table->timestamps();
            $table->foreign('visitor_id')->references('id')->on('visitors');
            $table->foreign('person_id')->references('id')->on('people');
            $table->foreign('applicant_id')->references('id')->on('applicants');
            $table->foreign('student_id')->references('id')->on('students');
            $table->foreign('converted_by')->references('id')->on('people');
            $table->foreign('authority_audit_event_id')->references('id')->on('audit_events');
        });
        DB::statement("ALTER TABLE visitor_conversions ADD CONSTRAINT visitor_conversions_type_check CHECK (conversion_type IN ('applicant','student'))");
        DB::statement("ALTER TABLE visitor_conversions ADD CONSTRAINT visitor_conversions_authority_check CHECK ((conversion_type = 'applicant' AND authority = 'admissions') OR (conversion_type = 'student' AND authority = 'students'))");
        DB::statement("ALTER TABLE visitor_conversions ADD CONSTRAINT visitor_conversions_target_check CHECK ((conversion_type = 'applicant' AND applicant_id IS NOT NULL AND student_id IS NULL AND person_id IS NOT NULL) OR (conversion_type = 'student' AND student_id IS NOT NULL AND applicant_id IS NULL AND person_id IS NOT NULL))");
        DB::statement('CREATE UNIQUE INDEX visitor_conversions_authority_event_unique ON visitor_conversions (authority_audit_event_id)');
        DB::statement('CREATE UNIQUE INDEX visitor_conversions_applicant_unique ON visitor_conversions (applicant_id) WHERE applicant_id IS NOT NULL');
        DB::statement('CREATE UNIQUE INDEX visitor_conversions_student_unique ON visitor_conversions (student_id) WHERE student_id IS NOT NULL');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION visitors_authority_guard() RETURNS trigger AS $fn$
            DECLARE
                person_state text;
                assignee_state text;
                creator_state text;
                updater_state text;
                source_state text;
                campaign_state text;
                campaign_source char(36);
                expected_contact text;
                origin_scope text;
                validate_origin boolean := false;
                validate_attribution boolean := false;
                validate_person boolean := false;
                validate_assignee boolean := false;
                validate_creator boolean := false;
            BEGIN
                IF TG_OP = 'INSERT' THEN
                    validate_origin := NEW.origin_branch_id IS NOT NULL;
                    validate_attribution := true;
                    validate_person := NEW.person_id IS NOT NULL;
                    validate_assignee := NEW.assigned_to IS NOT NULL;
                    validate_creator := true;
                ELSE
                    validate_origin := OLD.origin_branch_id IS NULL AND NEW.origin_branch_id IS NOT NULL;
                    validate_attribution := NEW.campaign_id IS DISTINCT FROM OLD.campaign_id;
                    validate_person := OLD.person_id IS NULL AND NEW.person_id IS NOT NULL;
                    validate_assignee := NEW.assigned_to IS DISTINCT FROM OLD.assigned_to AND NEW.assigned_to IS NOT NULL;
                END IF;
                expected_contact := COALESCE(NULLIF(lower(btrim(COALESCE(NEW.email, ''))), ''), NULLIF(regexp_replace(COALESCE(NEW.phone, ''), '[^0-9]', '', 'g'), ''), '');
                NEW.contact_key := expected_contact;
                IF NEW.contact_key IS DISTINCT FROM expected_contact THEN
                    RAISE EXCEPTION 'visitor contact_key must be derived from email or phone'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.full_name IS NULL OR btrim(NEW.full_name) = '' THEN
                    RAISE EXCEPTION 'visitor requires a non-empty name'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.person_id IS NULL AND NEW.contact_key = '' THEN
                    RAISE EXCEPTION 'anonymous visitor requires a normalized contact key'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF validate_person THEN
                    SELECT verification_state INTO person_state FROM people WHERE id = NEW.person_id;
                    IF person_state IS DISTINCT FROM 'verified' THEN
                        RAISE EXCEPTION 'visitor person_id requires a verified Person'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                IF validate_assignee THEN
                    SELECT verification_state INTO assignee_state FROM people WHERE id = NEW.assigned_to;
                    IF assignee_state IS DISTINCT FROM 'verified' THEN
                        RAISE EXCEPTION 'visitor assigned_to requires a verified Person'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                IF validate_creator THEN
                    SELECT verification_state INTO creator_state FROM people WHERE id = NEW.created_by;
                    IF creator_state IS DISTINCT FROM 'verified' THEN
                        RAISE EXCEPTION 'visitor created_by requires a verified Person'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                IF NEW.updated_by IS NOT NULL THEN
                    SELECT verification_state INTO updater_state FROM people WHERE id = NEW.updated_by;
                    IF updater_state IS DISTINCT FROM 'verified' THEN
                        RAISE EXCEPTION 'visitor updated_by requires a verified Person'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                IF validate_origin THEN
                    SELECT b.id::text INTO origin_scope
                      FROM branches b
                      JOIN campus_assignments ca ON ca.branch_id = b.id
                      JOIN campuses c ON c.id = ca.campus_id
                      JOIN organizations o ON o.id = c.organization_id
                     WHERE b.id = NEW.origin_branch_id
                       AND b.lifecycle_state = 'active'
                       AND c.lifecycle_state = 'active'
                       AND o.lifecycle_state = 'active'
                       AND ca.effective_from <= CURRENT_DATE
                       AND (ca.effective_to IS NULL OR ca.effective_to > CURRENT_DATE)
                     LIMIT 1;
                    IF origin_scope IS NULL THEN
                        RAISE EXCEPTION 'visitor origin branch must be an active branch with organization provenance'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                IF TG_OP = 'UPDATE' THEN
                    IF OLD.visitor_code IS DISTINCT FROM NEW.visitor_code
                       OR OLD.created_by IS DISTINCT FROM NEW.created_by
                       OR OLD.source_id IS DISTINCT FROM NEW.source_id
                       OR OLD.campaign_id IS DISTINCT FROM NEW.campaign_id
                       OR (OLD.person_id IS NOT NULL AND OLD.person_id IS DISTINCT FROM NEW.person_id)
                       OR (OLD.origin_branch_id IS NOT NULL AND OLD.origin_branch_id IS DISTINCT FROM NEW.origin_branch_id) THEN
                        RAISE EXCEPTION 'visitor identity, attribution, and provenance are immutable'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF OLD.status = 'converted' AND NEW.status <> 'converted' THEN
                        RAISE EXCEPTION 'converted visitors cannot re-enter the CRM pipeline'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF OLD.status = 'archived' AND NEW.status <> 'archived' THEN
                        RAISE EXCEPTION 'archived visitors cannot re-enter the CRM pipeline'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF OLD.status IN ('lost','converted','archived')
                       AND (OLD.full_name IS DISTINCT FROM NEW.full_name
                            OR OLD.phone IS DISTINCT FROM NEW.phone
                            OR OLD.email IS DISTINCT FROM NEW.email
                            OR OLD.preferred_channel IS DISTINCT FROM NEW.preferred_channel
                            OR OLD.visitor_type IS DISTINCT FROM NEW.visitor_type
                            OR OLD.rating IS DISTINCT FROM NEW.rating
                            OR OLD.interest IS DISTINCT FROM NEW.interest
                            OR OLD.notes IS DISTINCT FROM NEW.notes
                            OR OLD.assigned_to IS DISTINCT FROM NEW.assigned_to
                            OR OLD.contact_key IS DISTINCT FROM NEW.contact_key) THEN
                        RAISE EXCEPTION 'terminal visitor history is immutable; only an audited lifecycle transition may change status'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF OLD.person_id IS DISTINCT FROM NEW.person_id AND NEW.updated_by IS NULL THEN
                        RAISE EXCEPTION 'visitor identity binding requires updated_by'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF OLD.origin_branch_id IS NULL AND NEW.origin_branch_id IS NOT NULL AND NEW.updated_by IS NULL THEN
                        RAISE EXCEPTION 'visitor provenance assignment requires updated_by'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF OLD.status IS DISTINCT FROM NEW.status AND NEW.updated_by IS NULL THEN
                        RAISE EXCEPTION 'visitor lifecycle changes require updated_by'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF OLD.status IS DISTINCT FROM NEW.status AND NOT (
                        (OLD.status = 'new' AND NEW.status IN ('contacted','engaged','qualified','unqualified','lost')) OR
                        (OLD.status = 'contacted' AND NEW.status IN ('engaged','qualified','unqualified','lost')) OR
                        (OLD.status = 'engaged' AND NEW.status IN ('qualified','unqualified','lost')) OR
                        (OLD.status = 'qualified' AND NEW.status IN ('unqualified','lost')) OR
                        (OLD.status = 'unqualified' AND NEW.status IN ('engaged','qualified','lost','archived')) OR
                        (OLD.status = 'lost' AND NEW.status IN ('contacted','archived')) OR
                        (NEW.status = 'converted')
                    ) THEN
                        RAISE EXCEPTION 'visitor lifecycle transition is not allowed'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                IF NEW.status = 'converted' AND NOT EXISTS (SELECT 1 FROM visitor_conversions vc WHERE vc.visitor_id = NEW.id) THEN
                    RAISE EXCEPTION 'converted visitor requires an authoritative conversion trace'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF EXISTS (SELECT 1 FROM visitor_conversions vc WHERE vc.visitor_id = NEW.id) AND NEW.status <> 'converted' THEN
                    RAISE EXCEPTION 'a visitor with a conversion trace must remain converted'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF validate_attribution THEN
                    IF NEW.campaign_id IS NOT NULL THEN
                        SELECT lifecycle_state, source_id INTO campaign_state, campaign_source FROM visitor_campaigns WHERE id = NEW.campaign_id;
                        IF campaign_state IS DISTINCT FROM 'active' THEN
                            RAISE EXCEPTION 'new visitor attribution requires an active campaign'
                                USING ERRCODE = 'check_violation';
                        END IF;
                        IF NEW.source_id IS DISTINCT FROM campaign_source THEN
                            RAISE EXCEPTION 'visitor campaign attribution must match the campaign source'
                                USING ERRCODE = 'check_violation';
                        END IF;
                        IF NOT EXISTS (SELECT 1 FROM visitor_campaigns c WHERE c.id = NEW.campaign_id AND c.starts_on <= CURRENT_DATE AND (c.ends_on IS NULL OR c.ends_on >= CURRENT_DATE)) THEN
                            RAISE EXCEPTION 'visitor campaign attribution must be active on the capture date'
                                USING ERRCODE = 'check_violation';
                        END IF;
                    END IF;
                    IF NEW.source_id IS NOT NULL THEN
                        SELECT lifecycle_state INTO source_state FROM visitor_sources WHERE id = NEW.source_id;
                        IF source_state IS DISTINCT FROM 'active' THEN
                            RAISE EXCEPTION 'new visitor attribution requires an active source'
                                USING ERRCODE = 'check_violation';
                        END IF;
                    END IF;
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql
        SQL);
        DB::statement('CREATE TRIGGER visitors_authority_guard BEFORE INSERT OR UPDATE ON visitors FOR EACH ROW EXECUTE FUNCTION visitors_authority_guard()');
        Schema::create('visitor_status_history', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('visitor_id', 36);
            $table->string('from_status')->nullable();
            $table->string('to_status');
            $table->char('changed_by', 36);
            $table->string('correlation_id');
            $table->timestamp('changed_at')->useCurrent();
            $table->foreign('visitor_id')->references('id')->on('visitors');
            $table->foreign('changed_by')->references('id')->on('people');
            $table->index(['visitor_id', 'changed_at']);
        });
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION visitor_status_history_guard() RETURNS trigger AS $fn$
            DECLARE
                actor_id char(36);
                previous_status text;
            BEGIN
                IF TG_OP = 'UPDATE' THEN
                    previous_status := OLD.status;
                    IF OLD.status IS NOT DISTINCT FROM NEW.status THEN
                        RETURN NEW;
                    END IF;
                END IF;
                actor_id := COALESCE(NEW.updated_by, NEW.created_by);
                IF actor_id IS NULL THEN
                    RAISE EXCEPTION 'visitor lifecycle changes require a verified actor'
                        USING ERRCODE = 'check_violation';
                END IF;
                INSERT INTO visitor_status_history (id, visitor_id, from_status, to_status, changed_by, correlation_id)
                VALUES (md5(NEW.id || COALESCE(previous_status, '') || NEW.status || clock_timestamp()::text), NEW.id,
                        previous_status, NEW.status, actor_id,
                        md5(NEW.id || NEW.status || clock_timestamp()::text));
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql
        SQL);
        DB::statement('CREATE TRIGGER visitor_status_history_guard AFTER INSERT OR UPDATE OF status ON visitors FOR EACH ROW EXECUTE FUNCTION visitor_status_history_guard()');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION visitor_status_history_append_only() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'visitor status history is append-only'
                    USING ERRCODE = 'check_violation';
            END;
            $fn$ LANGUAGE plpgsql
        SQL);
        DB::statement('CREATE TRIGGER visitor_status_history_append_only BEFORE UPDATE OR DELETE ON visitor_status_history FOR EACH ROW EXECUTE FUNCTION visitor_status_history_append_only()');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION visitor_conversion_guard() RETURNS trigger AS $fn$
            DECLARE
                visitor_status text;
                visitor_person char(36);
                visitor_branch char(36);
                target_person char(36);
                target_branch char(36);
                target_state text;
                converter_state text;
                authority_actor char(36);
                authority_operation text;
                authority_target_type text;
                authority_target_id char(36);
            BEGIN
                IF btrim(COALESCE(NEW.correlation_id, '')) = '' THEN
                    RAISE EXCEPTION 'visitor conversion requires a correlation id'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT status, person_id, origin_branch_id INTO visitor_status, visitor_person, visitor_branch FROM visitors WHERE id = NEW.visitor_id;
                IF visitor_status IS NULL OR visitor_status NOT IN ('new','contacted','engaged','qualified','unqualified') THEN
                    RAISE EXCEPTION 'only an open visitor may receive a conversion trace'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF visitor_person IS NULL OR visitor_person IS DISTINCT FROM NEW.person_id THEN
                    RAISE EXCEPTION 'visitor conversion person must match the verified visitor identity'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT verification_state INTO converter_state FROM people WHERE id = NEW.converted_by;
                IF converter_state IS DISTINCT FROM 'verified' THEN
                    RAISE EXCEPTION 'visitor conversion actor must be a verified Person'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT actor_id, operation, target_type, target_id
                  INTO authority_actor, authority_operation, authority_target_type, authority_target_id
                  FROM audit_events
                 WHERE id = NEW.authority_audit_event_id;
                IF authority_actor IS DISTINCT FROM NEW.converted_by THEN
                    RAISE EXCEPTION 'visitor conversion actor must match its authority event actor'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.conversion_type = 'applicant'
                   AND (authority_target_type IS DISTINCT FROM 'applicant'
                        OR authority_target_id IS DISTINCT FROM NEW.applicant_id
                        OR authority_operation IS DISTINCT FROM 'admissions.register') THEN
                    RAISE EXCEPTION 'applicant conversion must bind to the Admissions registration event'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.conversion_type = 'student'
                   AND (authority_target_type IS DISTINCT FROM 'student'
                        OR authority_target_id IS DISTINCT FROM NEW.student_id
                        OR authority_operation IS NULL
                        OR authority_operation NOT IN ('admissions.convert', 'students.register')) THEN
                    RAISE EXCEPTION 'student conversion must bind to the Student authority event'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.conversion_type = 'applicant' THEN
                    SELECT person_id, lifecycle_state, originating_branch_id INTO target_person, target_state, target_branch FROM applicants WHERE id = NEW.applicant_id;
                    IF target_state NOT IN ('prospect','applicant','admitted') THEN
                        RAISE EXCEPTION 'applicant conversion target is not open'
                            USING ERRCODE = 'check_violation';
                    END IF;
                ELSE
                    SELECT s.person_id, latest.status, s.originating_branch_id
                      INTO target_person, target_state, target_branch
                      FROM students s
                      LEFT JOIN LATERAL (SELECT status FROM student_statuses WHERE student_id = s.id ORDER BY seq DESC LIMIT 1) latest ON true
                     WHERE s.id = NEW.student_id;
                    IF target_state NOT IN ('active','suspended') THEN
                        RAISE EXCEPTION 'student conversion target is not active or suspended'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                IF target_person IS NULL OR target_person IS DISTINCT FROM NEW.person_id THEN
                    RAISE EXCEPTION 'visitor conversion target must belong to the visitor person'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NOT EXISTS (SELECT 1 FROM people WHERE id = target_person AND verification_state = 'verified') THEN
                    RAISE EXCEPTION 'visitor conversion target requires a verified Person'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF target_branch IS NULL OR NOT EXISTS (
                    SELECT 1
                      FROM branches b
                      JOIN campus_assignments ca ON ca.branch_id = b.id
                      JOIN campuses c ON c.id = ca.campus_id
                      JOIN organizations o ON o.id = c.organization_id
                     WHERE b.id = target_branch AND b.lifecycle_state = 'active'
                       AND c.lifecycle_state = 'active' AND o.lifecycle_state = 'active'
                       AND ca.effective_from <= CURRENT_DATE
                       AND (ca.effective_to IS NULL OR ca.effective_to > CURRENT_DATE)
                ) THEN
                    RAISE EXCEPTION 'visitor conversion target requires active branch provenance'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF visitor_branch IS NOT NULL AND visitor_branch IS DISTINCT FROM target_branch THEN
                    RAISE EXCEPTION 'visitor and downstream conversion branch provenance must match'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql
        SQL);
        DB::statement('CREATE TRIGGER visitor_conversion_guard BEFORE INSERT ON visitor_conversions FOR EACH ROW EXECUTE FUNCTION visitor_conversion_guard()');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION visitor_conversions_append_only() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'visitor conversions are immutable terminal evidence'
                    USING ERRCODE = 'check_violation';
            END;
            $fn$ LANGUAGE plpgsql
        SQL);
        DB::statement('CREATE TRIGGER visitor_conversions_append_only BEFORE UPDATE OR DELETE ON visitor_conversions FOR EACH ROW EXECUTE FUNCTION visitor_conversions_append_only()');

        // Applicant -> Student is a distinct downstream handoff. The original
        // visitor conversion remains immutable; this table records only the
        // later Student authority event and never creates or updates Student.
        Schema::create('visitor_conversion_handoffs', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('source_conversion_id', 36);
            $table->char('visitor_id', 36);
            $table->char('student_id', 36);
            $table->char('person_id', 36);
            $table->char('authority_audit_event_id', 36);
            $table->char('converted_by', 36);
            $table->timestamp('converted_at')->useCurrent();
            $table->string('correlation_id');
            $table->timestamps();
            $table->foreign('source_conversion_id')->references('id')->on('visitor_conversions');
            $table->foreign('visitor_id')->references('id')->on('visitors');
            $table->foreign('student_id')->references('id')->on('students');
            $table->foreign('person_id')->references('id')->on('people');
            $table->foreign('authority_audit_event_id')->references('id')->on('audit_events');
            $table->foreign('converted_by')->references('id')->on('people');
            $table->index(['visitor_id', 'converted_at'], 'visitor_conversion_handoffs_visitor_index');
        });
        DB::statement('CREATE UNIQUE INDEX visitor_conversion_handoffs_source_unique ON visitor_conversion_handoffs (source_conversion_id)');
        DB::statement('CREATE UNIQUE INDEX visitor_conversion_handoffs_student_unique ON visitor_conversion_handoffs (student_id)');
        DB::statement('CREATE UNIQUE INDEX visitor_conversion_handoffs_authority_event_unique ON visitor_conversion_handoffs (authority_audit_event_id)');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION visitor_conversion_handoff_guard() RETURNS trigger AS $fn$
            DECLARE
                visitor_status text;
                visitor_person char(36);
                visitor_branch char(36);
                source_type text;
                source_person char(36);
                source_visitor char(36);
                source_applicant char(36);
                student_person char(36);
                student_branch char(36);
                student_applicant char(36);
                student_state text;
                converter_state text;
                authority_actor char(36);
                authority_operation text;
                authority_target_type text;
                authority_target_id char(36);
            BEGIN
                IF btrim(COALESCE(NEW.correlation_id, '')) = '' THEN
                    RAISE EXCEPTION 'student handoff requires a correlation id'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT status, person_id, origin_branch_id
                  INTO visitor_status, visitor_person, visitor_branch
                  FROM visitors WHERE id = NEW.visitor_id;
                SELECT conversion_type, person_id, visitor_id, applicant_id
                  INTO source_type, source_person, source_visitor, source_applicant
                  FROM visitor_conversions WHERE id = NEW.source_conversion_id;
                IF source_type IS DISTINCT FROM 'applicant'
                   OR source_visitor IS DISTINCT FROM NEW.visitor_id
                   OR visitor_status IS DISTINCT FROM 'converted'
                   OR source_person IS NULL
                   OR source_applicant IS NULL
                   OR visitor_person IS DISTINCT FROM NEW.person_id
                   OR source_person IS DISTINCT FROM NEW.person_id THEN
                    RAISE EXCEPTION 'student handoff requires the converted visitor applicant trace and matching person'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT verification_state INTO converter_state FROM people WHERE id = NEW.converted_by;
                IF converter_state IS DISTINCT FROM 'verified' THEN
                    RAISE EXCEPTION 'student handoff actor must be a verified Person'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT actor_id, operation, target_type, target_id
                  INTO authority_actor, authority_operation, authority_target_type, authority_target_id
                  FROM audit_events WHERE id = NEW.authority_audit_event_id;
                IF authority_actor IS DISTINCT FROM NEW.converted_by
                   OR authority_target_type IS DISTINCT FROM 'student'
                   OR authority_target_id IS DISTINCT FROM NEW.student_id
                   OR authority_operation IS NULL
                   OR authority_operation NOT IN ('admissions.convert','students.register') THEN
                    RAISE EXCEPTION 'student handoff must bind to the authoritative Student event'
                        USING ERRCODE = 'check_violation';
                END IF;
                SELECT s.person_id, s.originating_branch_id, d.applicant_id, latest.status
                  INTO student_person, student_branch, student_applicant, student_state
                  FROM students s
                  JOIN admission_decisions d ON d.id = s.admission_decision_id
                  LEFT JOIN LATERAL (
                      SELECT status FROM student_statuses
                       WHERE student_id = s.id ORDER BY seq DESC LIMIT 1
                  ) latest ON true
                 WHERE s.id = NEW.student_id;
                IF student_person IS NULL
                   OR student_person IS DISTINCT FROM NEW.person_id
                   OR student_applicant IS DISTINCT FROM source_applicant
                   OR student_state IS NULL
                   OR student_state NOT IN ('active','suspended') THEN
                    RAISE EXCEPTION 'student handoff target must be an active or suspended Student for the same person'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF student_branch IS NULL OR NOT EXISTS (
                    SELECT 1
                      FROM branches b
                      JOIN campus_assignments ca ON ca.branch_id = b.id
                      JOIN campuses c ON c.id = ca.campus_id
                      JOIN organizations o ON o.id = c.organization_id
                     WHERE b.id = student_branch AND b.lifecycle_state = 'active'
                       AND c.lifecycle_state = 'active' AND o.lifecycle_state = 'active'
                       AND ca.effective_from <= CURRENT_DATE
                       AND (ca.effective_to IS NULL OR ca.effective_to > CURRENT_DATE)
                ) THEN
                    RAISE EXCEPTION 'student handoff target requires active branch provenance'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF visitor_branch IS NOT NULL AND visitor_branch IS DISTINCT FROM student_branch THEN
                    RAISE EXCEPTION 'student handoff branch provenance must match the visitor when known'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql
        SQL);
        DB::statement('CREATE TRIGGER visitor_conversion_handoff_guard BEFORE INSERT ON visitor_conversion_handoffs FOR EACH ROW EXECUTE FUNCTION visitor_conversion_handoff_guard()');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION visitor_conversion_handoffs_append_only() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'visitor conversion handoffs are immutable terminal evidence'
                    USING ERRCODE = 'check_violation';
            END;
            $fn$ LANGUAGE plpgsql
        SQL);
        DB::statement('CREATE TRIGGER visitor_conversion_handoffs_append_only BEFORE UPDATE OR DELETE ON visitor_conversion_handoffs FOR EACH ROW EXECUTE FUNCTION visitor_conversion_handoffs_append_only()');

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
        DB::statement('ALTER TABLE visitor_automation_rules ADD CONSTRAINT visitor_automation_rules_length_check CHECK (length(key) BETWEEN 1 AND 80 AND length(name) BETWEEN 1 AND 160 AND length(trigger_type) BETWEEN 1 AND 40 AND length(trigger_value) BETWEEN 1 AND 40 AND length(action_type) BETWEEN 1 AND 40)');
        DB::statement('CREATE UNIQUE INDEX visitor_automation_active_trigger ON visitor_automation_rules (trigger_type, trigger_value, action_type) WHERE is_active');
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION visitor_automation_rule_guard() RETURNS trigger AS $fn$
            DECLARE
                assignee_state text;
                creator_state text;
            BEGIN
                IF btrim(NEW.key) = '' OR btrim(NEW.name) = '' OR NEW.trigger_value NOT IN ('no_answer','connected','positive','neutral','negative','unreachable','requested_info','scheduled_visit','followup_required','not_interested','qualified','converted','other') THEN
                    RAISE EXCEPTION 'automation rule identity and trigger value are invalid'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF TG_OP = 'INSERT' THEN
                    IF NEW.is_active = false THEN
                        RAISE EXCEPTION 'new visitor automation rules must begin active'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    SELECT verification_state INTO assignee_state FROM people WHERE id = NEW.action_config->>'assignee';
                    SELECT verification_state INTO creator_state FROM people WHERE id = NEW.created_by;
                    IF assignee_state IS DISTINCT FROM 'verified' THEN
                        RAISE EXCEPTION 'automation rule assignee must be a verified Person' USING ERRCODE = 'check_violation';
                    END IF;
                    IF creator_state IS DISTINCT FROM 'verified' THEN
                        RAISE EXCEPTION 'automation rule creator must be a verified Person' USING ERRCODE = 'check_violation';
                    END IF;
                ELSE
                    IF OLD.is_active = false AND NEW.is_active = true THEN
                        RAISE EXCEPTION 'retired visitor automation rules cannot be reactivated'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF NEW.key IS DISTINCT FROM OLD.key
                       OR NEW.name IS DISTINCT FROM OLD.name
                       OR NEW.trigger_type IS DISTINCT FROM OLD.trigger_type
                       OR NEW.trigger_value IS DISTINCT FROM OLD.trigger_value
                       OR NEW.action_type IS DISTINCT FROM OLD.action_type
                       OR NEW.action_config IS DISTINCT FROM OLD.action_config
                       OR NEW.created_by IS DISTINCT FROM OLD.created_by THEN
                        RAISE EXCEPTION 'automation rule definition is immutable; define a new key'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;
                IF NEW.action_config->>'assignee' IS NULL OR btrim(NEW.action_config->>'assignee') = ''
                   OR NEW.action_config->>'title' IS NULL OR btrim(NEW.action_config->>'title') = ''
                   OR length(NEW.action_config->>'title') > 160
                   OR (NEW.action_config->>'due_in_days') !~ '^[0-9]+$'
                   OR (CASE WHEN (NEW.action_config->>'due_in_days') ~ '^[0-9]+$' THEN (NEW.action_config->>'due_in_days')::numeric ELSE 366 END) > 365 THEN
                    RAISE EXCEPTION 'automation rule requires assignee, title, and non-negative due_in_days'
                        USING ERRCODE = 'check_violation';
                END IF;
                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql
        SQL);
        DB::statement('CREATE TRIGGER visitor_automation_rule_guard BEFORE INSERT OR UPDATE ON visitor_automation_rules FOR EACH ROW EXECUTE FUNCTION visitor_automation_rule_guard()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS visitor_status_history_append_only ON visitor_status_history');
        DB::statement('DROP FUNCTION IF EXISTS visitor_status_history_append_only()');
        DB::statement('DROP TRIGGER IF EXISTS visitor_status_history_guard ON visitors');
        DB::statement('DROP FUNCTION IF EXISTS visitor_status_history_guard()');
        DB::statement('DROP TRIGGER IF EXISTS visitor_conversion_handoffs_append_only ON visitor_conversion_handoffs');
        DB::statement('DROP FUNCTION IF EXISTS visitor_conversion_handoffs_append_only()');
        DB::statement('DROP TRIGGER IF EXISTS visitor_conversion_handoff_guard ON visitor_conversion_handoffs');
        DB::statement('DROP FUNCTION IF EXISTS visitor_conversion_handoff_guard()');
        DB::statement('DROP INDEX IF EXISTS visitor_conversion_handoffs_source_unique');
        DB::statement('DROP INDEX IF EXISTS visitor_conversion_handoffs_student_unique');
        DB::statement('DROP INDEX IF EXISTS visitor_conversion_handoffs_authority_event_unique');
        DB::statement('DROP TRIGGER IF EXISTS visitor_conversions_append_only ON visitor_conversions');
        DB::statement('DROP FUNCTION IF EXISTS visitor_conversions_append_only()');
        DB::statement('DROP TRIGGER IF EXISTS visitor_conversion_guard ON visitor_conversions');
        DB::statement('DROP FUNCTION IF EXISTS visitor_conversion_guard()');
        DB::statement('DROP INDEX IF EXISTS visitor_conversions_authority_event_unique');
        DB::statement('DROP INDEX IF EXISTS visitor_conversions_applicant_unique');
        DB::statement('DROP INDEX IF EXISTS visitor_conversions_student_unique');
        DB::statement('DROP TRIGGER IF EXISTS visitors_authority_guard ON visitors');
        DB::statement('DROP FUNCTION IF EXISTS visitors_authority_guard()');
        DB::statement('DROP TRIGGER IF EXISTS visitor_campaign_catalog_guard ON visitor_campaigns');
        DB::statement('DROP FUNCTION IF EXISTS visitor_campaign_catalog_guard()');
        DB::statement('DROP TRIGGER IF EXISTS visitor_source_catalog_guard ON visitor_sources');
        DB::statement('DROP FUNCTION IF EXISTS visitor_source_catalog_guard()');
        DB::statement('DROP TRIGGER IF EXISTS visitors_originating_immutable ON visitors');
        DB::statement('DROP FUNCTION IF EXISTS visitors_origin_branch_immutable_guard()');
        DB::statement('DROP TRIGGER IF EXISTS visitors_contact_key_guard ON visitors');
        DB::statement('DROP FUNCTION IF EXISTS visitors_contact_key_guard()');
        DB::statement('DROP TRIGGER IF EXISTS visitor_automation_rule_guard ON visitor_automation_rules');
        DB::statement('DROP FUNCTION IF EXISTS visitor_automation_rule_guard()');
        DB::statement('DROP INDEX IF EXISTS visitor_automation_active_trigger');
        DB::statement('DROP TRIGGER IF EXISTS visitor_followup_guard ON visitor_followups');
        DB::statement('DROP FUNCTION IF EXISTS visitor_followup_guard()');
        DB::statement('DROP TRIGGER IF EXISTS visitor_interaction_reference_guard ON visitor_interactions');
        DB::statement('DROP FUNCTION IF EXISTS visitor_interaction_reference_guard()');
        DB::statement('DROP TRIGGER IF EXISTS visitor_interactions_append_only ON visitor_interactions');
        DB::statement('DROP FUNCTION IF EXISTS visitor_interactions_append_only()');
        DB::statement('DROP INDEX IF EXISTS visitor_interactions_authority_event_unique');

        Schema::dropIfExists('visitor_automation_rules');
        Schema::dropIfExists('visitor_status_history');
        Schema::dropIfExists('visitor_conversion_handoffs');
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
