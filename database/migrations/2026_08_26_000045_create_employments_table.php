<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('employments', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('person_id', 36);
            $table->string('lifecycle_state');
            $table->timestamps();
            $table->foreign('person_id')->references('id')->on('people');
        });
        DB::statement("ALTER TABLE employments ADD CONSTRAINT employments_lifecycle_state_check CHECK (lifecycle_state IN ('candidate','active','on_leave','suspended','terminated'))");
        DB::statement("CREATE UNIQUE INDEX employments_one_open_per_person ON employments (person_id) WHERE lifecycle_state <> 'terminated'");
    }

    public function down(): void
    {
        DB::statement('DROP INDEX IF EXISTS employments_one_open_per_person');
        Schema::dropIfExists('employments');
    }
};
