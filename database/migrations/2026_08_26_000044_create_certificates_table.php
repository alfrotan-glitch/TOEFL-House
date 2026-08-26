<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('certificates', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('graduation_decision_id', 36);
            $table->char('student_id', 36);
            $table->string('serial');
            $table->timestamps();
            $table->foreign('graduation_decision_id')->references('id')->on('graduation_decisions');
            $table->foreign('student_id')->references('id')->on('students');
            $table->unique('serial');
        });
        DB::statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION certificates_immutable() RETURNS trigger AS $fn$
            BEGIN
                RAISE EXCEPTION 'certificate issuance records are immutable';
            END;
            $fn$ LANGUAGE plpgsql;
            SQL);
        DB::statement('CREATE TRIGGER certificates_immutable_trigger BEFORE UPDATE OR DELETE ON certificates FOR EACH ROW EXECUTE FUNCTION certificates_immutable()');
    }

    public function down(): void
    {
        DB::statement('DROP TRIGGER IF EXISTS certificates_immutable_trigger ON certificates');
        DB::statement('DROP FUNCTION IF EXISTS certificates_immutable()');
        Schema::dropIfExists('certificates');
    }
};
