<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('delegations', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('delegator_person_id', 36);
            $table->char('delegate_person_id', 36);
            $table->string('permission')->nullable();
            $table->string('scope_type')->nullable();
            $table->char('scope_id', 36)->nullable();
            $table->string('lifecycle_state');
            $table->date('effective_from');
            $table->date('effective_to');
            $table->string('reason');
            $table->char('created_by', 36);
            $table->timestamps();
            $table->foreign('delegator_person_id')->references('id')->on('people');
            $table->foreign('delegate_person_id')->references('id')->on('people');
        });
        DB::statement("ALTER TABLE delegations ADD CONSTRAINT delegations_lifecycle_state_check CHECK (lifecycle_state IN ('proposed','active','expired','revoked'))");
        DB::statement('ALTER TABLE delegations ADD CONSTRAINT delegations_period_check CHECK (effective_to > effective_from)');
        DB::statement('ALTER TABLE delegations ADD CONSTRAINT delegations_not_self_check CHECK (delegator_person_id <> delegate_person_id)');
        DB::statement('CREATE UNIQUE INDEX delegations_one_open_authority ON delegations (delegator_person_id, delegate_person_id, permission, scope_type, scope_id) WHERE lifecycle_state = \'active\'');
    }

    public function down(): void
    {
        Schema::dropIfExists('delegations');
    }
};
