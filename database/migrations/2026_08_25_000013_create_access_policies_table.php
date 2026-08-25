<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('access_policies', function (Blueprint $table): void {
            $table->char('id', 36)->primary();
            $table->string('binding_type');
            $table->char('binding_id', 36);
            $table->string('grants_type');
            $table->char('grants_id', 36)->nullable();
            $table->string('permission');
            $table->date('effective_from');
            $table->date('effective_to')->nullable();
            $table->char('published_by', 36);
            $table->timestamps();
            $table->index(['binding_type', 'binding_id']);
            $table->index(['grants_type', 'grants_id']);
        });
        DB::statement("ALTER TABLE access_policies ADD CONSTRAINT access_policies_binding_type_check CHECK (binding_type IN ('position','role'))");
        DB::statement("ALTER TABLE access_policies ADD CONSTRAINT access_policies_grants_type_check CHECK (grants_type IN ('role','permission'))");
        DB::statement('ALTER TABLE access_policies ADD CONSTRAINT access_policies_period_check CHECK (effective_to IS NULL OR effective_to > effective_from)');
        DB::statement('CREATE UNIQUE INDEX access_policies_one_open_position_role ON access_policies (binding_id) WHERE grants_type = \'role\' AND effective_to IS NULL');
    }

    public function down(): void
    {
        Schema::dropIfExists('access_policies');
    }
};
