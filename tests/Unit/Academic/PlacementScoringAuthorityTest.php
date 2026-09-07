<?php

declare(strict_types=1);

namespace Tests\Unit\Academic;

use App\Modules\Academic\Placement\Domain\PlacementBand;
use App\Modules\Academic\Placement\Domain\PlacementScoring;
use App\Modules\Academic\Placement\Models\PlacementQuestion;
use PHPUnit\Framework\TestCase;

/**
 * The option list is presentation metadata. The published correct_answer is
 * the sole automatic-scoring authority, so a valid distractor must never earn
 * a point merely because it is a selectable option.
 */
final class PlacementScoringAuthorityTest extends TestCase
{
    public function test_a_valid_distractor_option_is_not_scored_as_correct(): void
    {
        $question = new PlacementQuestion;
        $question->forceFill([
            'question_type' => 'mcq',
            'correct_answer' => 'A',
            'options' => [
                ['key' => 'A', 'label' => 'Correct answer'],
                ['key' => 'B', 'label' => 'Distractor'],
            ],
        ]);

        self::assertTrue(PlacementScoring::isCorrect($question, ' a '));
        self::assertFalse(PlacementScoring::isCorrect($question, 'B'));
    }

    public function test_overall_band_uses_the_canonical_two_decimal_score_at_a_boundary(): void
    {
        // This produces 39.995 before persistence. The authoritative score
        // snapshot is 40.00, so it must classify as A2 rather than fall into a
        // floating-point gap between the A1 and A2 bands.
        $overall = PlacementScoring::overallPercentage(
            ['grammar' => 39.99, 'reading' => 40.00],
            ['grammar' => 50.0, 'reading' => 50.0],
        );

        self::assertEqualsWithDelta(39.995, $overall, 0.000001);
        self::assertSame('A2', PlacementBand::forPercentage($overall));
    }

    public function test_blank_or_nonautomatic_answers_do_not_score(): void
    {
        $question = new PlacementQuestion;
        $question->forceFill([
            'question_type' => 'short_answer',
            'correct_answer' => 'Afghanistan',
        ]);
        self::assertFalse(PlacementScoring::isCorrect($question, ''));
        self::assertTrue(PlacementScoring::isCorrect($question, 'afghanistan'));

        $question->forceFill(['question_type' => 'essay']);
        self::assertFalse(PlacementScoring::isCorrect($question, 'Afghanistan'));
    }
}
