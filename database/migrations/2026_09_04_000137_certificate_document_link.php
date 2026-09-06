<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('certificates', function (Blueprint $table): void {
            // Locator pin to the managed certificate document, set once at
            // INSERT inside the issuance transaction. No FK: the document has
            // its own lifecycle and the certificates immutability trigger
            // forbids any later UPDATE, so the pin can never drift.
            $table->char('document_id', 36)->nullable()->unique()->after('serial');
        });
    }

    public function down(): void
    {
        Schema::table('certificates', function (Blueprint $table): void {
            $table->dropUnique(['document_id']);
            $table->dropColumn('document_id');
        });
    }
};
