<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('user_accounts', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('person_id', 36);
            $table->string('username');
            $table->string('account_state');
            $table->timestamp('deactivated_at')->nullable();
            $table->string('deactivation_reason')->nullable();
            $table->foreign('person_id')->references('id')->on('people');
            $table->unique('username');
        });
        DB::statement("ALTER TABLE user_accounts ADD CONSTRAINT user_accounts_state_check CHECK (account_state IN ('active','deactivated'))");
        DB::statement('CREATE UNIQUE INDEX user_accounts_one_active_per_person ON user_accounts (person_id) WHERE account_state = \'active\'');
    }

    public function down(): void
    {
        Schema::dropIfExists('user_accounts');
    }
};
