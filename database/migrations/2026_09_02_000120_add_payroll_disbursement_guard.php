<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Payroll disbursement guard — a single approved payroll result is paid
 * exactly once. The disbursement of an approved payroll payable is the
 * balanced finance journal that carries source_type='payroll_result' and
 * references the result. Before this guard a repeated (or concurrently
 * raced) disbursement posted a second balanced journal for the same
 * result, duplicating the salary expense/cash movement — a double pay.
 *
 * The authoritative disbursement path (PostJournal) enforces the same
 * rule inside its transaction; this partial unique index is the
 * database backstop that also serialises concurrent INSERTs (any second
 * transaction that reaches the commit with the same payroll result is
 * rejected), mirroring the settlement/derivation guards in migrations
 * 000101 and 000103.
 *
 * Journal reversals and corrections reference source_type='journal' (the
 * reversed journal) or 'other', so they are deliberately NOT subject to
 * this uniqueness — a correction chain remains append-only.
 */
return new class extends Migration
{
    public function up(): void
    {
        // One disbursement journal per payroll result. The WHERE predicate
        // indexes only payroll-sourced journals; source_id is the payroll
        // result id and is non-null for that source type.
        DB::statement(<<<'SQL'
            CREATE UNIQUE INDEX journals_one_disbursement_per_payroll_result
                ON journals (source_id)
                WHERE source_type = 'payroll_result' AND source_id IS NOT NULL
        SQL);
    }

    public function down(): void
    {
        DB::statement('DROP INDEX IF EXISTS journals_one_disbursement_per_payroll_result');
    }
};
