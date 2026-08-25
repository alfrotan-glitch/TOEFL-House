<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('documents', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->char('subject_person_id', 36);
            $table->char('classification_id', 36);
            $table->string('title');
            $table->string('lifecycle_state');
            $table->timestamps();
            $table->foreign('subject_person_id')->references('id')->on('people');
            $table->foreign('classification_id')->references('id')->on('document_classifications');
        });
        DB::statement("ALTER TABLE documents ADD CONSTRAINT documents_lifecycle_state_check CHECK (lifecycle_state IN ('draft','submitted','verified','rejected','active','expired','archived'))");
    }

    public function down(): void
    {
        Schema::dropIfExists('documents');
    }
};
