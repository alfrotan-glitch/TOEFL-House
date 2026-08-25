<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('document_classifications', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->string('category');
            $table->string('owner_module');
            $table->string('access_class');
            $table->timestamps();
            $table->unique('category');
        });
        DB::statement("ALTER TABLE document_classifications ADD CONSTRAINT document_classifications_access_class_check CHECK (access_class IN ('public','internal','confidential','restricted'))");
    }

    public function down(): void
    {
        Schema::dropIfExists('document_classifications');
    }
};
