<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/**
 * Placement -> Admissions/Student evidence link (WP-P continuation).
 *
 * Placement is Academic authority and never creates downstream records.
 * When a released placement exists for a person, the Admissions pipeline may
 * carry the immutable placement evidence reference on the applicant, and the
 * student conversion records the same placement on the student record. The
 * columns are nullable and additive; no fabricated historical placement is
 * backfilled.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('applicants', function (Blueprint $table): void {
            $table->char('placement_profile_id', 36)->nullable();
            $table->foreign('placement_profile_id')->references('id')->on('placement_profiles');
        });

        Schema::table('students', function (Blueprint $table): void {
            $table->char('placement_profile_id', 36)->nullable();
            $table->foreign('placement_profile_id')->references('id')->on('placement_profiles');
        });
    }

    public function down(): void
    {
        Schema::table('students', function (Blueprint $table): void {
            $table->dropForeign(['placement_profile_id']);
            $table->dropColumn('placement_profile_id');
        });

        Schema::table('applicants', function (Blueprint $table): void {
            $table->dropForeign(['placement_profile_id']);
            $table->dropColumn('placement_profile_id');
        });
    }
};
