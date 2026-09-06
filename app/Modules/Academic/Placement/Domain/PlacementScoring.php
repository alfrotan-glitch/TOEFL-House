<?php

declare(strict_types=1);

namespace App\Modules\Academic\Placement\Domain;

use App\Modules\Academic\Placement\Models\PlacementQuestion;
use App\Modules\Academic\Placement\Models\PlacementRubric;
use App\Modules\Academic\Placement\Models\PlacementSection;
use App\Support\Errors\BusinessRejection;
use Illuminate\Support\Collection;

/**
 * Deterministic, explainable placement scoring.
 *
 *  - auto-scored sections (mcq / short_answer) award points from the
 *    server-side correct answer;
 *  - productive sections (essay / speaking) are scored professionally via
 *    a rubric and stored as a section result;
 *  - every component is reduced to a percentage
 *      (earned points / maximum points * 100);
 *  - the component percentage is mapped to a CEFR band by the
 *    component's rubric table;
 *  - the weighted percentages (component_weights) produce an
 *    overall percentage mapped to the canonical overall band table.
 */
final class PlacementScoring
{
    public const MODEL_VERSION = 'placement-rubric-v1';

    /** @var array<string, float> */
    private const ALLOWED_TYPES = ['mcq' => 1.0, 'short_answer' => 1.0];

    /**
     * @param  array<string, string>  $answers  question_id => response_value
     * @return array{earned: float, maximum: float, percentage: float, responses: array<string, array{value: string, is_correct: bool, awarded: float}>}
     */
    public static function autoScoreSection(PlacementSection $section, array $answers): array
    {
        if (! $section->can_auto_score) {
            throw BusinessRejection::forCode('placement.section_not_auto_scorable', sprintf('section %s is not auto-scorable', $section->code));
        }

        $questions = $section->questions()->where('lifecycle_state', 'published')->get();
        $maxPoints = 0.0;
        $earned = 0.0;
        $responses = [];
        foreach ($questions as $question) {
            $points = (float) $question->points;
            $maxPoints += $points;
            $value = trim((string) ($answers[$question->id] ?? ''));
            $isCorrect = self::isCorrect($question, $value);
            $responses[$question->id] = ['value' => $answers[$question->id] ?? '', 'is_correct' => $isCorrect, 'awarded' => $isCorrect ? $points : 0.0];
            if ($isCorrect) {
                $earned += $points;
            }
        }
        if ($maxPoints <= 0) {
            throw BusinessRejection::forCode('placement.section_empty', sprintf('section %s has no scored questions', $section->code));
        }

        return [
            'earned' => $earned,
            'maximum' => $maxPoints,
            'percentage' => $earned / $maxPoints * 100,
            'responses' => $responses,
        ];
    }

    public static function isCorrect(PlacementQuestion $question, string $value): bool
    {
        if (! in_array($question->question_type, array_keys(self::ALLOWED_TYPES), true)) {
            return false;
        }
        $expected = trim(strtolower((string) $question->correct_answer));
        $actual = trim(strtolower($value));

        return $expected !== '' && $actual !== '' && ($expected === $actual || self::matchesOption($question, $value));
    }

    /**
     * @param  array<string, float>  $componentPercentages
     * @param  array<string, float>  $weights
     */
    public static function overallPercentage(array $componentPercentages, array $weights): float
    {
        $weighted = 0.0;
        $totalWeight = 0.0;
        foreach ($weights as $component => $weight) {
            $w = (float) $weight;
            $totalWeight += $w;
            $weighted += ($componentPercentages[$component] ?? 0.0) * $w;
        }
        if ($totalWeight <= 0) {
            return 0.0;
        }

        return $weighted / $totalWeight;
    }

    /** @param Collection<int, PlacementRubric> $rubrics */
    public static function cefrForComponent(string $component, float $percentage, Collection $rubrics): ?string
    {
        $band = $rubrics->first(fn (PlacementRubric $rubric): bool => $rubric->component === $component && $rubric->lifecycle_state === 'published' && $rubric->containsScore($percentage));

        return $band?->cefr_ref;
    }

    private static function matchesOption(PlacementQuestion $question, string $value): bool
    {
        if (! is_array($question->options) || $question->options === []) {
            return false;
        }
        foreach ($question->options as $option) {
            if (is_array($option) && isset($option['key']) && trim(strtolower((string) $option['key'])) === trim(strtolower($value))) {
                return true;
            }
        }

        return false;
    }
}
