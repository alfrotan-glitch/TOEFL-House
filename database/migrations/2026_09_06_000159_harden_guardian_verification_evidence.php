<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * Guardian verification evidence is part of the Student relationship fact,
 * not an implicit UI click. Existing legacy verified rows remain historical
 * compatibility data; every new verification must carry actor, timestamp,
 * and evidence reference and the evidence becomes immutable thereafter.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('guardian_relationships', function (Blueprint $table): void {
            $table->string('verification_evidence_ref')->nullable();
            $table->char('verified_by', 36)->nullable();
            $table->timestamp('verified_at')->nullable();
            $table->foreign('verified_by')->references('id')->on('people');
        });

        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION guardian_verification_evidence_guard() RETURNS trigger AS $fn$
            BEGIN
                IF TG_OP = 'INSERT' AND NEW.verification_state = 'verified' THEN
                    IF NEW.verification_evidence_ref IS NULL OR trim(NEW.verification_evidence_ref) = ''
                       OR NEW.verified_by IS NULL OR trim(NEW.verified_by) = ''
                       OR NEW.verified_at IS NULL THEN
                        RAISE EXCEPTION 'a verified guardian relationship requires evidence, verifier, and timestamp'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;

                IF TG_OP = 'UPDATE' THEN
                    IF OLD.verification_state <> 'verified' AND NEW.verification_state = 'verified' THEN
                        IF NEW.verification_evidence_ref IS NULL OR trim(NEW.verification_evidence_ref) = ''
                           OR NEW.verified_by IS NULL OR trim(NEW.verified_by) = ''
                           OR NEW.verified_at IS NULL THEN
                            RAISE EXCEPTION 'verifying a guardian relationship requires evidence, verifier, and timestamp'
                                USING ERRCODE = 'check_violation';
                        END IF;
                    ELSIF OLD.verification_state = 'verified'
                       AND (OLD.verification_evidence_ref IS DISTINCT FROM NEW.verification_evidence_ref
                         OR OLD.verified_by IS DISTINCT FROM NEW.verified_by
                         OR OLD.verified_at IS DISTINCT FROM NEW.verified_at
                         OR OLD.verification_state IS DISTINCT FROM NEW.verification_state) THEN
                        RAISE EXCEPTION 'guardian verification evidence is immutable after verification'
                            USING ERRCODE = 'check_violation';
                    END IF;
                END IF;

                RETURN NEW;
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('DROP TRIGGER IF EXISTS guardian_verification_evidence_guard_trigger ON guardian_relationships');
        DB::statement('CREATE TRIGGER guardian_verification_evidence_guard_trigger BEFORE INSERT OR UPDATE ON guardian_relationships FOR EACH ROW EXECUTE FUNCTION guardian_verification_evidence_guard()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS guardian_verification_evidence_guard_trigger ON guardian_relationships');
        DB::statement('DROP FUNCTION IF EXISTS guardian_verification_evidence_guard()');
        Schema::table('guardian_relationships', function (Blueprint $table): void {
            $table->dropForeign(['verified_by']);
            $table->dropColumn(['verification_evidence_ref', 'verified_by', 'verified_at']);
        });
    }
};
