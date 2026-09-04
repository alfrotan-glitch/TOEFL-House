<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Placement appeals reuse the Academic appeal workflow (WP-P AD). The first
 * placement decision may be filed while the subject is still a candidate
 * (pre-Student), so academic_appeals.student_id becomes nullable and the
 * subject registry accepts placement_profile.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::statement('ALTER TABLE academic_appeals ALTER COLUMN student_id DROP NOT NULL');
        DB::statement('ALTER TABLE academic_appeals DROP CONSTRAINT IF EXISTS academic_appeals_subject_type_check');
        DB::statement("ALTER TABLE academic_appeals ADD CONSTRAINT academic_appeals_subject_type_check CHECK (subject_type IN ('assessment_result','progression_decision','placement_profile'))");
    }

    public function down(): void
    {
        DB::table('academic_appeals')->where('subject_type', 'placement_profile')->delete();
        DB::statement('ALTER TABLE academic_appeals DROP CONSTRAINT IF EXISTS academic_appeals_subject_type_check');
        DB::statement("ALTER TABLE academic_appeals ADD CONSTRAINT academic_appeals_subject_type_check CHECK (subject_type IN ('assessment_result','progression_decision'))");
        DB::statement('ALTER TABLE academic_appeals ALTER COLUMN student_id SET NOT NULL');
    }
};
