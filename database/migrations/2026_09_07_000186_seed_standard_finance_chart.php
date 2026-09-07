<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Standard school chart of accounts.
 *
 * The general ledger posts automatically from Finance source facts. Those
 * postings resolve debit/credit accounts against a deterministic, canonical
 * chart so the books are consistent and auditable across the organization.
 * This migration seeds the standard chart only where a code is absent; it
 * never overwrites an account an operator has already defined, and it never
 * fabricates history (codes already in use are left untouched).
 */
return new class extends Migration
{
    /**
     * @var array<int, array{code: string, name: string, type: string}>
     */
    private const CHART = [
        ['code' => '1000', 'name' => 'Cash & Bank', 'type' => 'asset'],
        ['code' => '1100', 'name' => 'Accounts Receivable — Student Tuition', 'type' => 'asset'],
        ['code' => '2000', 'name' => 'Accounts Payable', 'type' => 'liability'],
        ['code' => '2010', 'name' => 'Accrued Payroll', 'type' => 'liability'],
        ['code' => '3000', 'name' => 'Opening Fund Balance', 'type' => 'equity'],
        ['code' => '4000', 'name' => 'Tuition & Instruction Revenue', 'type' => 'revenue'],
        ['code' => '4100', 'name' => 'Fees & Other Revenue', 'type' => 'revenue'],
        ['code' => '5000', 'name' => 'Salaries & Benefits Expense', 'type' => 'expense'],
        ['code' => '5100', 'name' => 'Financial Aid & Scholarship Expense', 'type' => 'expense'],
        ['code' => '5200', 'name' => 'Discounts & Allowances', 'type' => 'expense'],
        ['code' => '6000', 'name' => 'Operating & Administrative Expense', 'type' => 'expense'],
    ];

    public function up(): void
    {
        $now = now();
        foreach (self::CHART as $account) {
            DB::statement(
                "INSERT INTO accounts (id, code, name, type, created_at, updated_at) ".
                'VALUES (gen_random_uuid(), ?, ?, ?, ?, ?) ON CONFLICT (code) DO NOTHING',
                [$account['code'], $account['name'], $account['type'], $now, $now],
            );
        }
    }

    public function down(): void
    {
        // Never delete chart entries: they may carry immutability (accounts
        // immutable trigger) and journal lines. The seed is ignored on re-run
        // for codes already present, so no reverse migration is needed.
    }
};
