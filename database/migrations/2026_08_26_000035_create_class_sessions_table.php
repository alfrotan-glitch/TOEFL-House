<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('class_sessions', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('class_id', 36);
            $table->date('scheduled_on');
            $table->time('starts_at');
            $table->time('ends_at');
            $table->timestamps();
            $table->foreign('class_id')->references('id')->on('classes');
        });
        DB::statement('ALTER TABLE class_sessions ADD CONSTRAINT class_sessions_time_check CHECK (ends_at > starts_at)');
    }

    public function down(): void
    {
        Schema::dropIfExists('class_sessions');
    }
};
