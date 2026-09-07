<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * A branch has one effective campus attribution at any instant. The old
 * partial unique index only prevented two open-ended rows; it allowed a
 * closed historical interval to overlap the current row, leaving every
 * organization-scoped command and report to choose an arbitrary tenant.
 */
return new class extends Migration
{
    public function up(): void
    {
        // Do not choose a winner or rewrite organization history when prior
        // data is malformed. An administrator must reconcile the conflicting
        // assignment evidence before this authority boundary can be enabled.
        DB::statement(<<<'SQL'
            DO $migration$
            BEGIN
                IF EXISTS (
                    SELECT 1
                      FROM campus_assignments earlier
                      JOIN campus_assignments later
                        ON later.branch_id = earlier.branch_id
                       AND later.id > earlier.id
                       AND daterange(
                            earlier.effective_from,
                            COALESCE(earlier.effective_to, 'infinity'::date),
                            '[)'
                       ) && daterange(
                            later.effective_from,
                            COALESCE(later.effective_to, 'infinity'::date),
                            '[)'
                       )
                ) THEN
                    RAISE EXCEPTION 'campus-assignment history has overlapping effective intervals; reconcile it without guessing a branch organization'
                        USING ERRCODE = 'check_violation';
                END IF;
            END
            $migration$
            SQL);

        // char/varchar equality needs btree_gist's GiST operator class;
        // daterange supplies inclusive-start/exclusive-end temporal semantics
        // matching TransferBranchToCampus and Branch::activeCampusAssignment.
        DB::statement('CREATE EXTENSION IF NOT EXISTS btree_gist');
        DB::statement(<<<'SQL'
            ALTER TABLE campus_assignments
                ADD CONSTRAINT campus_assignments_no_effective_overlap
                EXCLUDE USING gist (
                    branch_id WITH =,
                    daterange(
                        effective_from,
                        COALESCE(effective_to, 'infinity'::date),
                        '[)'
                    ) WITH &&
                )
            SQL);
    }

    public function down(): void
    {
        // Reopening the ambiguity would make historical tenant provenance
        // nondeterministic; this convergence is deliberately forward-only.
        throw new \RuntimeException('Campus-assignment temporal authority is one-way; do not permit overlapping branch attribution history.');
    }
};
