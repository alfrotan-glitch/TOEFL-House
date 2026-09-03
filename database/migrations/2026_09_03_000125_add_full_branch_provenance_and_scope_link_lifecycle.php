<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * WP-2 F1 (WP2-DEC-01) completion of the foundation migration (000121):
 *
 *  1. Every branch-originating operational record carries the two-part
 *     branch semantics the decision requires:
 *       - originating_branch_id  -> WHERE the record originated (immutable once set,
 *                                   NULL = unassigned/unknown, never fabricated);
 *       - current_home_branch_id -> a mutable/decided home-branch DESIGNATION on
 *                                   the operational record (never promoted to
 *                                   financial truth).
 *     Finance source facts (payments, refunds, fund allocations) remain whole-row
 *     immutable, so both values on them are frozen at post time. Contracts retain
 *     the signed-terms immutability and gain the same provenance immutability.
 *
 *  2. branch_scope_links gains the lifecycle/window invariants that make the
 *     junction safe as a real cross-branch scope authority:
 *       - lifecycle is only active|closed;
 *       - active ⇔ effective_to IS NULL (one OPEN link per owner, closed links
 *         are historical);
 *       - effective window is never inverted.
 *
 * All columns are additive and nullable; existing rows are NOT backfilled.
 * No fabricated historical provenance is created.
 */
return new class extends Migration
{
    /** Tables already carrying originating_branch_id from migration 000121. */
    private const EXISTING_PROVENANCE_TABLES = [
        'students',
        'enrollments',
        'obligations',
        'certificates',
    ];

    /** Remainder of the branch-originating operational records named by WP2-DEC-01. */
    private const REMAINING_PROVENANCE_TABLES = [
        'payments',
        'refunds',
        'fund_allocations',
        'contracts',
    ];

    public function up(): void
    {
        // 1. Provenance columns on the remaining branch-originating records.
        foreach (self::REMAINING_PROVENANCE_TABLES as $tableName) {
            Schema::table($tableName, function (Blueprint $table): void {
                $table->char('originating_branch_id', 36)->nullable();
                $table->foreign('originating_branch_id')->references('id')->on('branches');
            });
        }

        // 2. Current-home-branch designation on every branch-originating record.
        foreach (array_merge(self::EXISTING_PROVENANCE_TABLES, self::REMAINING_PROVENANCE_TABLES) as $tableName) {
            Schema::table($tableName, function (Blueprint $table): void {
                $table->char('current_home_branch_id', 36)->nullable();
                $table->foreign('current_home_branch_id')->references('id')->on('branches');
            });
        }

        // 3. Provenance immutability on the newly covered tables. The shared
        //    guard function was created by migration 000121.
        foreach (self::REMAINING_PROVENANCE_TABLES as $tableName) {
            DB::statement(sprintf(
                'CREATE TRIGGER %1$s_originating_immutable BEFORE UPDATE OF originating_branch_id ON %1$s FOR EACH ROW EXECUTE FUNCTION guard_originating_branch_immutable()',
                $tableName,
            ));
        }

        // 4. branch_scope_links lifecycle + effective-window invariants.
        DB::statement("ALTER TABLE branch_scope_links ADD CONSTRAINT branch_scope_links_lifecycle_check CHECK (lifecycle_state IN ('active','closed'))");
        DB::statement("ALTER TABLE branch_scope_links ADD CONSTRAINT branch_scope_links_open_window_check CHECK ((lifecycle_state = 'active') = (effective_to IS NULL))");
        DB::statement('ALTER TABLE branch_scope_links ADD CONSTRAINT branch_scope_links_window_check CHECK (effective_to IS NULL OR effective_to >= effective_from)');
    }

    public function down(): void
    {
        DB::statement('ALTER TABLE branch_scope_links DROP CONSTRAINT IF EXISTS branch_scope_links_window_check');
        DB::statement('ALTER TABLE branch_scope_links DROP CONSTRAINT IF EXISTS branch_scope_links_open_window_check');
        DB::statement('ALTER TABLE branch_scope_links DROP CONSTRAINT IF EXISTS branch_scope_links_lifecycle_check');

        foreach (self::REMAINING_PROVENANCE_TABLES as $tableName) {
            DB::statement(sprintf('DROP TRIGGER IF EXISTS %1$s_originating_immutable ON %1$s', $tableName));
        }

        foreach (array_merge(self::EXISTING_PROVENANCE_TABLES, self::REMAINING_PROVENANCE_TABLES) as $tableName) {
            Schema::table($tableName, function (Blueprint $table): void {
                $table->dropForeign(['current_home_branch_id']);
                $table->dropColumn('current_home_branch_id');
            });
        }

        foreach (self::REMAINING_PROVENANCE_TABLES as $tableName) {
            Schema::table($tableName, function (Blueprint $table): void {
                $table->dropForeign(['originating_branch_id']);
                $table->dropColumn('originating_branch_id');
            });
        }
    }
};
