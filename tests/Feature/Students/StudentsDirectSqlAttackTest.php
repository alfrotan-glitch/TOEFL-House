<?php

declare(strict_types=1);

namespace Tests\Feature\Students;

use App\Modules\Admissions\Commands\DecideAdmission;
use App\Modules\Admissions\Commands\EnrollAdmittedApplicant;
use App\Modules\Admissions\Commands\RegisterApplicant;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Identity\Models\Person;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

/**
 * Direct-SQL attack surface for the student invariants. A forged student
 * row (a second record per person, a second record per admission
 * decision) or fabricated status history must be rejected by the schema.
 */
final class StudentsDirectSqlAttackTest extends TestCase
{
    use BuildsActors;

    private Person $personA;

    private Person $personB;

    /** @var array{applicant_id: string, decision_id: string} */
    private array $applicantA;

    /** @var array{applicant_id: string, decision_id: string} */
    private array $applicantB;

    protected function setUp(): void
    {
        parent::setUp();

        $this->personA = $this->personWithAuthority('statk-person-a', []);
        $this->personB = $this->personWithAuthority('statk-person-b', []);
        $this->applicantA = $this->admittedApplicant($this->personA, 'statk-a');
        $this->applicantB = $this->admittedApplicant($this->personB, 'statk-b');

        // Only person A is converted through the legitimate path.
        app(EnrollAdmittedApplicant::class)->convert($this->admissionsApprover(), Applicant::query()->findOrFail($this->applicantA['applicant_id']), 'statk-conv-1');
    }

    private function admittedApplicant(Person $person, string $prefix): array
    {
        $registered = app(RegisterApplicant::class)->register($this->admissionsClerk(), $person->id, 'TOEFL Intensive', $prefix.'-reg');
        $applicant = Applicant::query()->findOrFail($registered['applicant_id']);
        $decision = app(DecideAdmission::class)->decide($this->admissionsClerk(), $this->admissionsReviewer(), $this->admissionsApprover(), $applicant, true, 'meets entry policy', 'interview-notes/'.$prefix, $prefix.'-dec');

        return ['applicant_id' => $registered['applicant_id'], 'decision_id' => $decision['decision_id']];
    }

    public function test_direct_sql_cannot_create_a_second_student_for_a_person(): void
    {
        // Person B holds an admitted decision but no student; a forged
        // student row for the already-converted person A must fail.
        $this->expectException(QueryException::class);
        DB::table('students')->insert([
            'id' => 'eeeeeeee-ffff-4000-8000-00000000000a',
            'person_id' => $this->personA->id,
            'admission_decision_id' => $this->applicantB['decision_id'],
            'student_code' => 'ST-9999',
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    public function test_direct_sql_cannot_create_a_second_student_for_an_admission_decision(): void
    {
        // Person B is a new student, but the decision already produced a
        // student for person A: the decision may be consumed only once.
        $this->expectException(QueryException::class);
        DB::table('students')->insert([
            'id' => 'eeeeeeee-ffff-4000-8000-00000000000b',
            'person_id' => $this->personB->id,
            'admission_decision_id' => $this->applicantA['decision_id'],
            'student_code' => 'ST-9998',
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    public function test_direct_sql_cannot_fabricate_status_history(): void
    {
        // A forged student row with valid references is admissible; the
        // fabricated status history is not.
        DB::table('students')->insert([
            'id' => 'eeeeeeee-ffff-4000-8000-00000000000c',
            'person_id' => $this->personB->id,
            'admission_decision_id' => $this->applicantB['decision_id'],
            'student_code' => 'ST-9997',
            'created_at' => now(), 'updated_at' => now(),
        ]);
        $forgedStudentId = 'eeeeeeee-ffff-4000-8000-00000000000c';

        // No history yet: only the conversion status (active) is possible.
        $this->expectException(QueryException::class);
        DB::table('student_statuses')->insert([
            'id' => 'eeeeeeee-ffff-4000-8000-00000000000d',
            'student_id' => $forgedStudentId,
            'status' => 'suspended',
            'effective_from' => '2026-08-01',
            'reason' => 'forged suspension with no history',
            'actor_id' => 'statk-forger-1',
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    public function test_direct_sql_cannot_skip_a_status_transition(): void
    {
        // Person A's student exists with the legitimate active status.
        $studentId = DB::table('students')->where('person_id', $this->personA->id)->value('id');

        // active -> alumni is not a registry transition.
        $this->expectException(QueryException::class);
        DB::table('student_statuses')->insert([
            'id' => 'eeeeeeee-ffff-4000-8000-00000000000e',
            'student_id' => $studentId,
            'status' => 'alumni',
            'effective_from' => '2026-08-01',
            'reason' => 'forged alumni status skipping completion',
            'actor_id' => 'statk-forger-1',
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }
}
