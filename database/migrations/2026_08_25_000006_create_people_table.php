<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('people', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->string('legal_name');
            $table->date('date_of_birth');
            $table->string('verification_state');
            $table->string('identity_key')->nullable();
            $table->string('identity_evidence_ref')->nullable();
            $table->timestamp('verified_at')->nullable();
            $table->char('verified_by', 36)->nullable();
        });
        DB::statement("ALTER TABLE people ADD CONSTRAINT people_verification_state_check CHECK (verification_state IN ('unverified','verified'))");
        DB::statement('CREATE UNIQUE INDEX people_single_verified_identity ON people (identity_key) WHERE verification_state = \'verified\'');
    }

    public function down(): void
    {
        Schema::dropIfExists('people');
    }
};
