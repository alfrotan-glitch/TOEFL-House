<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('leaves', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('employment_id', 36);
            $table->string('category');
            $table->date('date_from');
            $table->date('date_to');
            $table->string('reason');
            $table->string('lifecycle_state');
            $table->char('requested_by', 36);
            $table->char('decided_by', 36)->nullable();
            $table->timestamps();
            $table->foreign('employment_id')->references('id')->on('employments');
        });
        DB::statement("ALTER TABLE leaves ADD CONSTRAINT leaves_lifecycle_state_check CHECK (lifecycle_state IN ('requested','approved','rejected','cancelled'))");
        DB::statement('ALTER TABLE leaves ADD CONSTRAINT leaves_period_check CHECK (date_to >= date_from)');
        DB::statement("CREATE UNIQUE INDEX leaves_one_pending_per_employment ON leaves (employment_id) WHERE lifecycle_state = 'requested'");
    }

    public function down(): void
    {
        DB::statement('DROP INDEX IF EXISTS leaves_one_pending_per_employment');
        Schema::dropIfExists('leaves');
    }
};
