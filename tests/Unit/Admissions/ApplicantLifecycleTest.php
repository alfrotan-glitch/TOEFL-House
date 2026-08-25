<?php

declare(strict_types=1);

namespace Tests\Unit\Admissions;

use App\Modules\Admissions\Domain\ApplicantLifecycle;
use App\Support\Errors\BusinessRejection;
use PHPUnit\Framework\TestCase;

final class ApplicantLifecycleTest extends TestCase
{
    public function test_prospect_becomes_applicant_then_decided(): void
    {
        $this->assertTrue(ApplicantLifecycle::allowsTransition('prospect', 'applicant'));
        $this->assertTrue(ApplicantLifecycle::allowsTransition('applicant', 'admitted'));
        $this->assertTrue(ApplicantLifecycle::allowsTransition('applicant', 'rejected'));
        $this->assertTrue(ApplicantLifecycle::allowsTransition('rejected', 'applicant'));
    }

    public function test_admitted_is_final_for_the_file(): void
    {
        $this->assertFalse(ApplicantLifecycle::allowsTransition('admitted', 'applicant'));
        $this->assertFalse(ApplicantLifecycle::allowsTransition('admitted', 'rejected'));
        $this->assertFalse(ApplicantLifecycle::allowsTransition('prospect', 'admitted'));
    }

    public function test_unknown_transition_throws(): void
    {
        $this->expectException(BusinessRejection::class);
        $this->expectExceptionMessage('transition prospect -> admitted is not allowed');
        ApplicantLifecycle::requireTransition('prospect', 'admitted');
    }
}
