<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('scope_grants', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('person_id', 36);
            $table->string('permission');
            $table->string('scope_type');
            $table->char('scope_id', 36);
            $table->string('lifecycle_state');
            $table->date('effective_from');
            $table->date('effective_to')->nullable();
            $table->boolean('is_emergency')->default(false);
            $table->boolean('review_required')->default(false);
            $table->char('granted_by', 36);
            $table->timestamps();
            $table->foreign('person_id')->references('id')->on('people');
            $table->index(['person_id', 'permission', 'lifecycle_state']);
        });
        DB::statement("ALTER TABLE scope_grants ADD CONSTRAINT scope_grants_lifecycle_state_check CHECK (lifecycle_state IN ('proposed','active','expired','revoked'))");
        DB::statement("ALTER TABLE scope_grants ADD CONSTRAINT scope_grants_scope_type_check CHECK (scope_type IN ('organization','campus','branch','department'))");
        DB::statement('CREATE UNIQUE INDEX scope_grants_one_open_grant ON scope_grants (person_id, permission, scope_type, scope_id) WHERE lifecycle_state = \'active\' AND effective_to IS NULL');
        DB::statement('ALTER TABLE scope_grants ADD CONSTRAINT scope_grants_period_check CHECK (effective_to IS NULL OR effective_to > effective_from)');
    }

    public function down(): void
    {
        Schema::dropIfExists('scope_grants');
    }
};
