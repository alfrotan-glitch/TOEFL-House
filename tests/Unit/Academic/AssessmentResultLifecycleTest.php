<?php

declare(strict_types=1);

namespace Tests\Unit\Academic;

use App\Modules\Academic\Domain\AppealLifecycle;
use App\Modules\Academic\Domain\AssessmentResultLifecycle;
use App\Modules\Academic\Domain\ProgressionLifecycle;
use App\Support\Errors\BusinessRejection;
use PHPUnit\Framework\TestCase;

final class AssessmentResultLifecycleTest extends TestCase
{
    public function test_ordered_review_and_release(): void
    {
        $this->assertTrue(AssessmentResultLifecycle::allowsTransition('scored', 'moderated'));
        $this->assertTrue(AssessmentResultLifecycle::allowsTransition('moderated', 'approved'));
        $this->assertTrue(AssessmentResultLifecycle::allowsTransition('approved', 'released'));
        $this->assertTrue(AssessmentResultLifecycle::allowsTransition('released', 'appealed'));
        $this->assertTrue(AssessmentResultLifecycle::allowsTransition('released', 'corrected'));
        $this->assertTrue(AssessmentResultLifecycle::allowsTransition('appealed', 'corrected'));
    }

    public function test_score_is_not_a_release_shortcut(): void
    {
        $this->assertFalse(AssessmentResultLifecycle::allowsTransition('scored', 'released'));
        $this->assertFalse(AssessmentResultLifecycle::allowsTransition('scored', 'approved'));
        $this->assertFalse(AssessmentResultLifecycle::allowsTransition('moderated', 'released'));
        $this->assertFalse(AssessmentResultLifecycle::allowsTransition('corrected', 'released'));
    }

    public function test_progression_chain_and_supersession(): void
    {
        $this->assertTrue(ProgressionLifecycle::allowsTransition('proposed', 'reviewed'));
        $this->assertTrue(ProgressionLifecycle::allowsTransition('reviewed', 'approved'));
        $this->assertTrue(ProgressionLifecycle::allowsTransition('reviewed', 'rejected'));
        $this->assertTrue(ProgressionLifecycle::allowsTransition('appealed', 'superseded'));
        $this->assertFalse(ProgressionLifecycle::allowsTransition('superseded', 'approved'));
        $this->assertFalse(ProgressionLifecycle::allowsTransition('proposed', 'approved'));
    }

    public function test_appeal_chain_requires_evidence_and_cannot_close_silently(): void
    {
        $this->assertTrue(AppealLifecycle::allowsTransition('open', 'assigned'));
        $this->assertTrue(AppealLifecycle::allowsTransition('assigned', 'investigating'));
        $this->assertTrue(AppealLifecycle::allowsTransition('investigating', 'resolved'));
        $this->assertTrue(AppealLifecycle::allowsTransition('investigating', 'escalated'));
        $this->assertTrue(AppealLifecycle::allowsTransition('escalated', 'assigned'));
        $this->assertTrue(AppealLifecycle::allowsTransition('resolved', 'closed'));
        $this->assertFalse(AppealLifecycle::allowsTransition('open', 'closed'), 'no silent closure from open');
        $this->assertFalse(AppealLifecycle::allowsTransition('investigating', 'closed'), 'no silent closure from investigating');
        $this->expectException(BusinessRejection::class);
        ProgressionLifecycle::requireTransition('approved', 'proposed');
    }
}
