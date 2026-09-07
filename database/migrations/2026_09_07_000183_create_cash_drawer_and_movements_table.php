<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Finance-owned cash drawer and cash movement.
 *
 * The canonical financial domain model (foundation 34) names Cash Drawer /
 * Cash Movement as "accountable physical cash custody and movement (custodian,
 * observed amount, movement)". This is the cashier's custody ledger: a drawer
 * is opened with a custodian and float, movements record cash in/out, and a
 * close records the counted balance and variance. The drawer's running cash is
 * always derived from opening float plus net movements — never stored — and a
 * physical draw can never exceed the cash currently in the drawer. Cash
 * custody evidence is intentionally separate from the journal: the accountant
 * journalizes a receipt or an expense as the accounting truth, while this
 * ledger evidences what is physically in the till.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('cash_drawers', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('organization_id', 36);
            $table->char('branch_id', 36);
            $table->char('custodian_id', 36);
            $table->decimal('opening_balance', 14, 2);
            $table->decimal('counted_balance', 14, 2)->nullable();
            $table->decimal('close_variance', 14, 2)->nullable();
            $table->string('close_reason')->nullable();
            $table->char('opened_by', 36);
            $table->timestamp('opened_at');
            $table->char('closed_by', 36)->nullable();
            $table->timestamp('closed_at')->nullable();
            $table->string('lifecycle_state');
            $table->timestamps();
            $table->foreign('organization_id')->references('id')->on('organizations');
            $table->foreign('branch_id')->references('id')->on('branches');
            $table->foreign('custodian_id')->references('id')->on('people');
            $table->foreign('opened_by')->references('id')->on('people');
            $table->foreign('closed_by')->references('id')->on('people');
        });
        DB::statement('ALTER TABLE cash_drawers ADD CONSTRAINT cash_drawers_opening_check CHECK (opening_balance >= 0)');
        DB::statement('ALTER TABLE cash_drawers ADD CONSTRAINT cash_drawers_variances_check CHECK ((lifecycle_state = \'open\' AND counted_balance IS NULL AND close_variance IS NULL AND close_reason IS NULL AND closed_by IS NULL AND closed_at IS NULL) OR (lifecycle_state = \'closed\' AND counted_balance IS NOT NULL AND close_variance IS NOT NULL AND close_reason IS NOT NULL AND closed_by IS NOT NULL AND closed_at IS NOT NULL))');
        // Readable provenance: a branch belongs to exactly one organization
        // through its campus attribution; the drawer copies that anchor so the
        // ledger is stable and never silently re-homed.
        DB::statement('CREATE UNIQUE INDEX cash_drawers_one_open_per_custodian ON cash_drawers (branch_id, custodian_id) WHERE lifecycle_state = \'open\'');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION cash_drawers_guard() RETURNS trigger AS $fn$
            BEGIN
                IF TG_OP = 'DELETE' THEN
                    RAISE EXCEPTION 'cash drawers are accountable custody records and cannot be deleted'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NOT EXISTS (
                    SELECT 1 FROM branches b
                     WHERE b.id = NEW.branch_id AND b.lifecycle_state = 'active'
                ) THEN
                    RAISE EXCEPTION 'a cash drawer requires an active branch'
                        USING ERRCODE = 'check_violation';
                END IF;
                -- The organization anchor must be the branch's actual owning
                -- organization, not an arbitrary one supplied by a caller. A
                -- forged organization on a foreign branch would break tenant
                -- isolation of custody evidence.
                IF NOT EXISTS (
                    SELECT 1
                      FROM branches b
                      JOIN campus_assignments ca ON ca.branch_id = b.id AND ca.effective_from <= CURRENT_DATE AND (ca.effective_to IS NULL OR ca.effective_to > CURRENT_DATE)
                      JOIN campuses c ON c.id = ca.campus_id
                      JOIN organizations o ON o.id = c.organization_id AND o.lifecycle_state = 'active'
                     WHERE b.id = NEW.branch_id
                       AND o.id = NEW.organization_id
                ) THEN
                    RAISE EXCEPTION 'a cash drawer requires its branch owning organization provenance'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF TG_OP = 'INSERT' THEN
                    IF NEW.lifecycle_state <> 'open' THEN
                        RAISE EXCEPTION 'a cash drawer is born open'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    IF NEW.closed_by IS NOT NULL OR NEW.closed_at IS NOT NULL OR NEW.counted_balance IS NOT NULL THEN
                        RAISE EXCEPTION 'an open cash drawer cannot carry closure evidence'
                            USING ERRCODE = 'check_violation';
                    END IF;
                    RETURN NEW;
                END IF;

                IF OLD.lifecycle_state = 'closed' THEN
                    RAISE EXCEPTION 'a closed cash drawer is immutable'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.lifecycle_state <> 'closed' THEN
                    RAISE EXCEPTION 'a cash drawer may transition only open -> closed'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF OLD.organization_id IS DISTINCT FROM NEW.organization_id
                   OR OLD.branch_id IS DISTINCT FROM NEW.branch_id
                   OR OLD.custodian_id IS DISTINCT FROM NEW.custodian_id
                   OR OLD.opening_balance IS DISTINCT FROM NEW.opening_balance
                   OR OLD.opened_by IS DISTINCT FROM NEW.opened_by
                   OR OLD.opened_at IS DISTINCT FROM NEW.opened_at THEN
                    RAISE EXCEPTION 'a cash drawer opening terms are immutable'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.closed_by IS NULL OR trim(NEW.closed_by) = trim(NEW.custodian_id) THEN
                    RAISE EXCEPTION 'a cash drawer close requires an independent closer distinct from the custodian'
                        USING ERRCODE = 'check_violation';
                END IF;
                IF NEW.close_reason = '' THEN
                    RAISE EXCEPTION 'a closed cash drawer requires its documented reason'
                        USING ERRCODE = 'check_violation';
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER cash_drawers_guard_trigger BEFORE INSERT OR UPDATE OR DELETE ON cash_drawers FOR EACH ROW EXECUTE FUNCTION cash_drawers_guard()');

        Schema::create('cash_movements', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('drawer_id', 36);
            $table->string('type');
            $table->decimal('amount', 14, 2);
            $table->string('reason');
            $table->char('recorded_by', 36);
            $table->timestamp('occurred_at');
            $table->timestamps();
            $table->foreign('drawer_id')->references('id')->on('cash_drawers');
            $table->foreign('recorded_by')->references('id')->on('people');
        });
        DB::statement("ALTER TABLE cash_movements ADD CONSTRAINT cash_movements_type_check CHECK (type IN ('in', 'out'))");
        DB::statement('ALTER TABLE cash_movements ADD CONSTRAINT cash_movements_amount_check CHECK (amount > 0)');
        DB::statement('ALTER TABLE cash_movements ADD CONSTRAINT cash_movements_reason_check CHECK (reason <> \'\')');

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION cash_movements_guard() RETURNS trigger AS $fn$
            DECLARE
                drawer_state text;
                running_cash numeric;
            BEGIN
                IF TG_OP <> 'INSERT' THEN
                    RAISE EXCEPTION 'cash movements are immutable custody history'
                        USING ERRCODE = 'check_violation';
                END IF;

                SELECT lifecycle_state INTO drawer_state
                  FROM cash_drawers WHERE id = NEW.drawer_id FOR UPDATE;
                IF drawer_state IS NULL THEN
                    RAISE EXCEPTION 'cash movement references a missing cash drawer'
                        USING ERRCODE = 'foreign_key_violation';
                END IF;
                IF drawer_state <> 'open' THEN
                    RAISE EXCEPTION 'cash movements record only into an open cash drawer'
                        USING ERRCODE = 'check_violation';
                END IF;

                IF NEW.type = 'out' THEN
                    SELECT d.opening_balance
                           + COALESCE(SUM(cm.amount) FILTER (WHERE cm.type = 'in'), 0)
                           - COALESCE(SUM(cm.amount) FILTER (WHERE cm.type = 'out'), 0)
                      INTO running_cash
                      FROM cash_drawers d
                      LEFT JOIN cash_movements cm ON cm.drawer_id = d.id
                     WHERE d.id = NEW.drawer_id
                     GROUP BY d.id, d.opening_balance;
                    IF NEW.amount > COALESCE(running_cash, 0) THEN
                        RAISE EXCEPTION 'a cash draw cannot exceed the cash currently in the drawer'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER cash_movements_guard_trigger BEFORE INSERT ON cash_movements FOR EACH ROW EXECUTE FUNCTION cash_movements_guard()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS cash_movements_guard_trigger ON cash_movements');
        DB::statement('DROP FUNCTION IF EXISTS cash_movements_guard()');
        Schema::dropIfExists('cash_movements');
        DB::statement('DROP TRIGGER IF EXISTS cash_drawers_guard_trigger ON cash_drawers');
        DB::statement('DROP FUNCTION IF EXISTS cash_drawers_guard()');
        Schema::dropIfExists('cash_drawers');
    }
};
