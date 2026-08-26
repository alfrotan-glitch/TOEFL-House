<?php

declare(strict_types=1);

namespace Tests\Concerns;

use App\Modules\Admissions\Commands\DecideAdmission;
use App\Modules\Admissions\Commands\EnrollAdmittedApplicant;
use App\Modules\Admissions\Commands\RegisterApplicant;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Identity\Models\Person;
use App\Modules\Students\Models\Student;
use App\Support\Identifiers\RandomIdentifier;

/**
 * Builds a real student through the authoritative admissions flow
 * (register → three-signature decision → conversion). Used by feature tests
 * that need a student without re-exercising admissions over HTTP.
 */
trait BuildsStudents
{
    use BuildsActors;

    /**
     * @param  array<string, string>  $ids  deterministic ids: ['initiator','reviewer','approver','applicant','student']
     * @return array{student: Student, person: Person}
     */
    private function makeStudent(array $ids = []): array
    {
        $initiatorId = $ids['initiator'] ?? 'adm-init-'.substr(md5((string) random_int(1, PHP_INT_MAX)), 0, 8);
        $reviewerId = $ids['reviewer'] ?? 'adm-rev-'.substr(md5((string) random_int(1, PHP_INT_MAX)), 0, 8);
        $approverId = $ids['approver'] ?? 'adm-appr-'.substr(md5((string) random_int(1, PHP_INT_MAX)), 0, 8);
        $applicantPersonId = $ids['applicant'] ?? RandomIdentifier::new();

        $this->personWithAuthority($initiatorId, ['admissions.register', 'admissions.initiate']);
        $this->personWithAuthority($reviewerId, ['admissions.review']);
        $this->personWithAuthority($approverId, ['admissions.approve']);

        $person = Person::query()->create([
            'id' => $applicantPersonId,
            'legal_name' => 'Print Fixture Student',
            'date_of_birth' => '1999-03-03',
            'verification_state' => Person::VERIFICATION_VERIFIED,
        ]);

        app(RegisterApplicant::class)->register(
            $this->grantedActor($initiatorId, []),
            $applicantPersonId,
            'TOEFL Intensive',
            'idem-print-'.RandomIdentifier::new(),
        );
        $applicant = Applicant::query()->where('person_id', $applicantPersonId)->firstOrFail();

        app(DecideAdmission::class)->decide(
            $this->grantedActor($initiatorId, []),
            $this->grantedActor($reviewerId, []),
            $this->grantedActor($approverId, []),
            $applicant,
            true,
            'Admitted for print fixture',
            'placement-evidence-1',
            'idem-print-decide-'.RandomIdentifier::new(),
        );

        app(EnrollAdmittedApplicant::class)->convert(
            $this->grantedActor($approverId, []),
            $applicant,
            'idem-print-convert-'.RandomIdentifier::new(),
        );

        $student = Student::query()->where('person_id', $applicantPersonId)->firstOrFail();

        return ['student' => $student, 'person' => $person];
    }
}
