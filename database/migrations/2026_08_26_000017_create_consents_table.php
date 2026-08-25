<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('consents', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('subject_person_id', 36);
            $table->char('purpose_id', 36);
            $table->string('lifecycle_state');
            $table->date('effective_from');
            $table->date('effective_to')->nullable();
            $table->string('evidence_ref');
            $table->char('recorded_by', 36);
            $table->timestamps();
            $table->foreign('subject_person_id')->references('id')->on('people');
            $table->foreign('purpose_id')->references('id')->on('consent_purposes');
        });
        DB::statement("ALTER TABLE consents ADD CONSTRAINT consents_lifecycle_state_check CHECK (lifecycle_state IN ('draft','submitted','verified','active','expired','revoked','archived'))");
        DB::statement('ALTER TABLE consents ADD CONSTRAINT consents_period_check CHECK (effective_to IS NULL OR effective_to > effective_from)');
        DB::statement("CREATE UNIQUE INDEX consents_one_open_per_subject_purpose ON consents (subject_person_id, purpose_id) WHERE lifecycle_state IN ('draft','submitted','verified') OR (lifecycle_state = 'active' AND effective_to IS NULL)");
    }

    public function down(): void
    {
        Schema::dropIfExists('consents');
    }
};
