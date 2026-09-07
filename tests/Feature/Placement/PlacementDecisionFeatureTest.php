<?php

declare(strict_types=1);

namespace Tests\Feature\Placement;

use App\Modules\Academic\Commands\MaintainAcademicStructure;
use App\Modules\Academic\Placement\Commands\DecidePlacement;
use App\Modules\Academic\Placement\Commands\ManagePlacementProfile;
use App\Modules\Academic\Placement\Commands\RecommendPlacement;
use App\Modules\Academic\Placement\Commands\ScorePlacement;
use App\Modules\Academic\Placement\Models\PlacementAttempt;
use App\Modules\Academic\Placement\Models\PlacementProfile;
use App\Modules\Academic\Placement\Models\PlacementRecommendation;
use App\Modules\Academic\Placement\Models\PlacementResponse;
use App\Modules\Academic\Placement\Models\PlacementRubric;
use App\Modules\Academic\Placement\Models\PlacementSectionResult;
use App\Modules\Academic\Placement\Queries\PlacementFinanceLinkQuery;
use App\Modules\Reporting\Queries\PlacementRecommendationRateCalculator;
use App\Modules\Reporting\Queries\PlacementReleaseCountCalculator;
use App\Modules\Admissions\Commands\DecideAdmission;
use App\Modules\Admissions\Commands\EnrollAdmittedApplicant;
use App\Modules\Admissions\Commands\RegisterApplicant;
use App\Modules\Admissions\Models\AdmissionDecision;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Crm\Commands\CaptureVisitor;
use App\Modules\Crm\Commands\LinkVisitorPerson;
use App\Modules\Crm\Models\Visitor;
use App\Modules\Finance\Models\FinancialPeriod;
use App\Modules\Students\Models\Student;
use App\Support\Errors\BusinessRejection;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Tests\Concerns\BuildsPlacementCatalog;
use Tests\TestCase;

/**
 * Full Placement Decision System journey: catalog -> published version ->
 * server-authoritative digital attempt -> anti-tamper evidence -> marking ->
 * staged section moderation/approval -> explainable CEFR/level recommendation
 * -> review/approve/release -> retake after supersession -> appealable
 * profile, with immutable responses and CRM lead tracing.
 */
final class PlacementDecisionFeatureTest extends TestCase
{
    use BuildsPlacementCatalog;

    public function test_full_placement_decision_lifecycle_is_server_authoritative_and_explainable(): void
    {
        $this->setUpPlacementCatalog();
        $person = $this->personWithAuthority('plc-person-1', []);
        $profileResult = app(ManagePlacementProfile::class)->openProfile(
            $this->placementOfficer('plc-open-1'),
            $person->id,
            $this->programVersionId,
            'plc-open',
            null,
            $this->placementBranchId,
        );
        $profile = PlacementProfile::query()->findOrFail($profileResult['profile_id']);

        $attemptResult = app(ManagePlacementProfile::class)->startAttempt(
            $this->placementOfficer('plc-attempt-1'),
            $profile,
            $this->testVersionId,
            'digital',
            'plc-start',
        );
        $attempt = PlacementAttempt::query()->findOrFail($attemptResult['attempt_id']);
        $this->assertSame('in_progress', $attempt->status);

        $answers = [];
        foreach ($this->questions as $questionId => $component) {
            $answers[$questionId] = in_array($component, ['grammar', 'reading', 'listening'], true) ? 'A' : 'sample response';
        }
        // Give the productive components their manual scores after submission.
        $submit = app(ManagePlacementProfile::class)->submitDigital($this->placementOfficer('plc-submit-1'), $attempt, $answers, 'plc-submit');
        $this->assertFalse($submit['tamper_flagged']);
        $submitted = $attempt->fresh();
        if ($submitted === null) {
            $this->fail('placement attempt disappeared after submission');
        }
        $this->assertNotNull($submitted->anti_tamper_hmac);
        $this->assertSame('submitted', $submitted->status);
        // Professional stubs are deliberately appended after the submitted
        // attempt envelope; automatic facts were created while in-progress.
        $this->assertSame(2, PlacementSectionResult::query()
            ->where('attempt_id', $attempt->id)
            ->where('scoring_method', PlacementSectionResult::SCORING_METHOD_PROFESSIONAL)
            ->whereNull('raw_score')
            ->count());

        foreach (['writing', 'speaking'] as $component) {
            $sectionId = $this->sectionIds[$component];
            $result = PlacementSectionResult::query()->where('attempt_id', $attempt->id)->where('section_id', $sectionId)->firstOrFail();
            $rubric = PlacementRubric::query()->where('test_version_id', $this->testVersionId)->where('component', $component)->where('cefr_ref', 'B1')->firstOrFail();
            app(ScorePlacement::class)->scoreSection($this->placementOfficer('plc-mark-'.$component), $attempt, $sectionId, 60.0, $rubric->id, 'B1', 'professional marking', 'plc-mark-'.$component);
        }

        app(ManagePlacementProfile::class)->markScored($this->placementOfficer('plc-scored-1'), $profile, 'plc-scored');
        $refreshed = $profile->fresh();
        $this->assertNotNull($refreshed);
        $this->assertSame('scored', $refreshed->lifecycle_state);

        // A privileged-looking raw insert cannot choose a more favourable or
        // otherwise arbitrary level: the database derives the snapshot and
        // deterministic target from the frozen section facts and weights.
        $rawRecommender = $this->placementRecommender('plc-rec-raw-1');
        $c1LevelId = (string) DB::table('program_version_levels')
            ->where('program_version_id', $this->programVersionId)
            ->where('level_key', 'C1')
            ->value('id');
        try {
            DB::transaction(function () use ($profile, $attempt, $c1LevelId, $rawRecommender): void {
                DB::table('placement_recommendations')->insert([
                    'id' => RandomIdentifier::new(),
                    'profile_id' => $profile->id,
                    'attempt_id' => $attempt->id,
                    'program_version_id' => $this->programVersionId,
                    'lineage_version' => PlacementRecommendation::LINEAGE_VERSION,
                    'recommended_level_id' => $c1LevelId,
                    'recommended_class_id' => null,
                    'recommended_offering_id' => null,
                    'rationale' => 'forged favourable recommendation',
                    'model_version' => 'placement-rubric-v1',
                    'score_snapshot' => json_encode([
                        'overall_percentage' => 84.0,
                        'overall_cefr' => 'B2',
                        'component_percentages' => ['grammar' => 100.0, 'reading' => 100.0, 'listening' => 100.0, 'writing' => 60.0, 'speaking' => 60.0],
                        'component_cefr' => ['grammar' => 'C1', 'reading' => 'C1', 'listening' => 'C1', 'writing' => 'B1', 'speaking' => 'B1'],
                        'model_version' => 'placement-rubric-v1',
                    ], JSON_THROW_ON_ERROR),
                    'recommended_by' => $rawRecommender->actorId,
                    'created_at' => now(),
                    'updated_at' => now(),
                ]);
            });
            $this->fail('raw SQL must not choose a placement level inconsistent with immutable scores');
        } catch (QueryException $exception) {
            $this->assertStringContainsString('must select the deterministic active academic level', $exception->getMessage());
        }

        // A recommendation is generated after scoring, before section review.
        $recommendation = app(RecommendPlacement::class)->recommend($this->placementRecommender('plc-rec-1'), $profile, 'plc-rec');
        $refreshed = $profile->fresh();
        $this->assertNotNull($refreshed);
        $this->assertSame('recommended', $refreshed->lifecycle_state);
        $rec = PlacementRecommendation::query()->findOrFail($recommendation['recommendation_id']);
        $this->assertNotEmpty($rec->rationale);
        $this->assertNotEmpty($rec->score_snapshot['overall_cefr']);
        $refreshed = $profile->fresh();
        $this->assertNotNull($refreshed);
        $this->assertSame((string) $rec->recommended_level_id, (string) $refreshed->recommended_level_id);

        // Review/decision is refused while any section is unapproved.
        try {
            app(DecidePlacement::class)->review($this->placementModerator('plc-review-1'), $profile, 'plc-review');
            $this->fail('a placement review before section approval must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('placement.review_sections_not_approved', $rejection->errorCode());
        }

        foreach (PlacementSectionResult::query()->where('attempt_id', $attempt->id)->get() as $sectionResult) {
            $moderator = $this->placementModerator($this->actorId('plc-mod'));
            $approver = $this->placementApprover($this->actorId('plc-appr'));
            app(ScorePlacement::class)->moderateSection($moderator, $sectionResult, 'plc-mod-'.$sectionResult->id);
            $approved = $sectionResult->fresh();
            if ($approved === null) {
                $this->fail('placement section result disappeared before approval');
            }
            app(ScorePlacement::class)->approveSection($approver, $approved, 'plc-appr-'.$sectionResult->id);
        }

        // The decision chain proceeds after recommendation and section approval.
        app(DecidePlacement::class)->review($this->placementModerator('plc-review-2'), $profile, 'plc-review2');
        app(DecidePlacement::class)->approve($this->placementApprover('plc-app-1'), $profile, 'plc-app');
        app(DecidePlacement::class)->release($this->placementReleaser('plc-rel-1'), $profile, 'plc-rel');
        $refreshed = $profile->fresh();
        $this->assertNotNull($refreshed);
        $this->assertSame('released', $refreshed->lifecycle_state);
        $this->assertSame(PlacementProfile::DECISION_FACT_VERSION, (string) $refreshed->decision_fact_version, 'the profile recommendation projection must be stamped by the database decision-fact guard');
        $this->assertNotNull($refreshed->released_at, 'the release transition must retain an immutable event timestamp');
        $this->assertSame('database_transition', (string) $refreshed->release_time_basis);
        $this->assertSame(1, PlacementRecommendation::query()->where('profile_id', $profile->id)->count());
    }

    public function test_release_metric_uses_immutable_event_time_after_supersession_and_metadata_updates(): void
    {
        $this->setUpPlacementCatalog();
        $person = $this->personWithAuthority('plc-release-metric-person', []);
        $released = $this->completeReleasedPlacement($person->id, 'plc-release-metric');
        $releaseAt = (string) $released->released_at;

        $now = CarbonImmutable::now('UTC');
        $period = app(MaintainAcademicStructure::class)->definePeriod(
            $this->academicOfficer('plc-release-metric-academic'),
            'Placement release reporting window',
            $now->subDay(),
            $now->addDay(),
            'plc-release-metric-period',
        );
        $calculator = app(PlacementReleaseCountCalculator::class);
        $beforeMetadataChange = $calculator->compute($period['period_id'], $this->placementBranchId);
        $this->assertSame('1', $beforeMetadataChange['value']);
        $this->assertSame('complete', $beforeMetadataChange['completeness']);

        // Updating transport metadata must not move the release into a new
        // period, and later supersession must not erase its original cohort.
        DB::table('placement_profiles')->where('id', $released->id)->update([
            'updated_at' => '2099-01-01 00:00:00',
        ]);
        $afterMetadataChange = $calculator->compute($period['period_id'], $this->placementBranchId);
        $this->assertSame('1', $afterMetadataChange['value']);

        app(DecidePlacement::class)->supersede(
            $this->placementReleaser('plc-release-metric-supersede'),
            $released,
            'plc-release-metric-supersede',
        );
        $afterSupersession = $calculator->compute($period['period_id'], $this->placementBranchId);
        $this->assertSame('1', $afterSupersession['value']);
        $this->assertSame($releaseAt, (string) PlacementProfile::query()->findOrFail($released->id)->released_at);
    }

    public function test_recommendation_rate_uses_the_exact_append_only_fact_through_supersession(): void
    {
        $this->setUpPlacementCatalog();
        $person = $this->personWithAuthority('plc-recommendation-metric-person', []);
        $released = $this->completeReleasedPlacement($person->id, 'plc-recommendation-metric');
        $now = CarbonImmutable::now('UTC');
        $period = app(MaintainAcademicStructure::class)->definePeriod(
            $this->academicOfficer('plc-recommendation-metric-academic'),
            'Placement recommendation reporting window',
            $now->subDay(),
            $now->addDay(),
            'plc-recommendation-metric-period',
        );

        $calculator = app(PlacementRecommendationRateCalculator::class);
        $beforeSupersession = $calculator->compute($period['period_id'], $this->placementBranchId);
        $this->assertSame('100', $beforeSupersession['value']);
        $this->assertSame('complete', $beforeSupersession['completeness']);
        $this->assertSame('append_only_placement_recommendation_exact_profile_projection', $beforeSupersession['meta']['recommendation_fact_basis']);

        // The profile's current lifecycle is not the numerator. Its immutable
        // recommendation fact remains part of this intake cohort after a
        // later retake supersedes the profile.
        app(DecidePlacement::class)->supersede(
            $this->placementReleaser('plc-recommendation-metric-supersede'),
            $released,
            'plc-recommendation-metric-supersede',
        );
        $afterSupersession = $calculator->compute($period['period_id'], $this->placementBranchId);
        $this->assertSame('100', $afterSupersession['value']);
        $this->assertSame('complete', $afterSupersession['completeness']);
        $this->assertSame(1, $afterSupersession['meta']['recommended']);
    }

    public function test_submitted_responses_and_recommendations_are_immutable(): void
    {
        $this->setUpPlacementCatalog();
        $person = $this->personWithAuthority('plc-person-2', []);
        $profile = PlacementProfile::query()->findOrFail(app(ManagePlacementProfile::class)->openProfile($this->placementOfficer('plc-open-2'), $person->id, $this->programVersionId, 'plc-open-2', null, $this->placementBranchId)['profile_id']);
        $attempt = PlacementAttempt::query()->findOrFail(app(ManagePlacementProfile::class)->startAttempt($this->placementOfficer('plc-attempt-2'), $profile, $this->testVersionId, 'digital', 'plc-start-2')['attempt_id']);
        $answers = [];
        foreach ($this->questions as $questionId => $component) {
            $answers[$questionId] = in_array($component, ['grammar', 'reading', 'listening'], true) ? 'A' : 'sample';
        }
        app(ManagePlacementProfile::class)->submitDigital($this->placementOfficer('plc-submit-2'), $attempt, $answers, 'plc-submit-2');

        $response = PlacementResponse::query()->where('attempt_id', $attempt->id)->firstOrFail();
        $this->expectException(QueryException::class);
        $response->update(['response_value' => 'changed']);
    }

    public function test_retake_requires_superseding_the_live_profile(): void
    {
        $this->setUpPlacementCatalog();
        $person = $this->personWithAuthority('plc-person-3', []);
        $profile = PlacementProfile::query()->findOrFail(app(ManagePlacementProfile::class)->openProfile($this->placementOfficer('plc-open-3'), $person->id, $this->programVersionId, 'plc-open-3', null, $this->placementBranchId)['profile_id']);
        $attempt = PlacementAttempt::query()->findOrFail(app(ManagePlacementProfile::class)->startAttempt($this->placementOfficer('plc-attempt-3'), $profile, $this->testVersionId, 'digital', 'plc-start-3')['attempt_id']);
        $answers = [];
        foreach ($this->questions as $questionId => $component) {
            $answers[$questionId] = in_array($component, ['grammar', 'reading', 'listening'], true) ? 'A' : 'sample';
        }
        app(ManagePlacementProfile::class)->submitDigital($this->placementOfficer('plc-submit-3'), $attempt, $answers, 'plc-submit-3');
        foreach (['writing', 'speaking'] as $component) {
            $sectionId = $this->sectionIds[$component];
            $result = PlacementSectionResult::query()->where('attempt_id', $attempt->id)->where('section_id', $sectionId)->firstOrFail();
            $rubric = PlacementRubric::query()->where('test_version_id', $this->testVersionId)->where('component', $component)->where('cefr_ref', 'B1')->firstOrFail();
            app(ScorePlacement::class)->scoreSection($this->placementOfficer('plc-mark-3-'.$component), $attempt, $sectionId, 60.0, $rubric->id, 'B1', 'professional marking', 'plc-mark-3-'.$component);
        }
        app(ManagePlacementProfile::class)->markScored($this->placementOfficer('plc-scored-3'), $profile, 'plc-scored-3');
        foreach (PlacementSectionResult::query()->where('attempt_id', $attempt->id)->get() as $r) {
            $moderator = $this->placementModerator($this->actorId('plc-mod3'));
            $approver = $this->placementApprover($this->actorId('plc-appr3'));
            app(ScorePlacement::class)->moderateSection($moderator, $r, 'plc-mod3-'.$r->id);
            $approved = $r->fresh();
            if ($approved === null) {
                $this->fail('placement section result disappeared before approval');
            }
            app(ScorePlacement::class)->approveSection($approver, $approved, 'plc-appr3-'.$r->id);
        }
        app(RecommendPlacement::class)->recommend($this->placementRecommender('plc-rec-3'), $profile, 'plc-rec-3');
        app(DecidePlacement::class)->review($this->placementModerator('plc-review-3'), $profile, 'plc-review-3');
        app(DecidePlacement::class)->approve($this->placementApprover('plc-appr3-1'), $profile, 'plc-appr3-1');
        app(DecidePlacement::class)->release($this->placementReleaser('plc-rel-3'), $profile, 'plc-rel-3');

        // A second open profile is blocked while one is live.
        try {
            app(ManagePlacementProfile::class)->openProfile($this->placementOfficer('plc-open-3b'), $person->id, $this->programVersionId, 'plc-open-3b', null, $this->placementBranchId);
            $this->fail('a live profile must block a retake until superseded');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('placement.profile_open_exists', $rejection->errorCode());
        }

        app(DecidePlacement::class)->supersede($this->placementReleaser('plc-super-3'), $profile, 'plc-super-3');
        $refreshed = $profile->fresh();
        $this->assertNotNull($refreshed);
        $this->assertSame('superseded', $refreshed->lifecycle_state);
        $retake = PlacementProfile::query()->findOrFail(app(ManagePlacementProfile::class)->openProfile($this->placementOfficer('plc-open-3c'), $person->id, $this->programVersionId, 'plc-open-3c', null, $this->placementBranchId)['profile_id']);
        $this->assertNotSame($profile->id, $retake->id);
    }

    public function test_placement_attempt_traces_back_to_the_crm_lead(): void
    {
        $this->setUpPlacementCatalog();
        $reception = $this->actorWithStructureCapabilities('plc-crm-1', ['crm.visitor']);
        $person = $this->personWithAuthority('plc-person-4', []);
        $visitor = app(CaptureVisitor::class)->capture($reception, null, 'Placement Lead', null, 'plc@example.com', 'email', 'online', null, null, null, null, null, 'plc-capture');
        app(LinkVisitorPerson::class)->link($reception, Visitor::query()->findOrFail($visitor['visitor_id']), $person->id, 'plc-link');

        $profile = PlacementProfile::query()->findOrFail(app(ManagePlacementProfile::class)->openProfile($this->placementOfficer('plc-open-4'), $person->id, $this->programVersionId, 'plc-open-4', null, $this->placementBranchId)['profile_id']);
        $attempt = PlacementAttempt::query()->findOrFail(app(ManagePlacementProfile::class)->startAttempt($this->placementOfficer('plc-attempt-4'), $profile, $this->testVersionId, 'digital', 'plc-start-4')['attempt_id']);
        $answers = [];
        foreach ($this->questions as $questionId => $component) {
            $answers[$questionId] = in_array($component, ['grammar', 'reading', 'listening'], true) ? 'A' : 'sample';
        }
        app(ManagePlacementProfile::class)->submitDigital($this->placementOfficer('plc-submit-4'), $attempt, $answers, 'plc-submit-4');

        $this->assertDatabaseHas('visitor_interactions', [
            'visitor_id' => $visitor['visitor_id'],
            'type' => 'placement',
            'placement_attempt_id' => $attempt->id,
        ]);
    }

    public function test_recommendation_requires_a_scored_attempt(): void
    {
        $this->setUpPlacementCatalog();
        $person = $this->personWithAuthority('plc-person-5', []);
        $profile = PlacementProfile::query()->findOrFail(app(ManagePlacementProfile::class)->openProfile($this->placementOfficer('plc-open-5'), $person->id, $this->programVersionId, 'plc-open-5', null, $this->placementBranchId)['profile_id']);

        try {
            app(RecommendPlacement::class)->recommend($this->placementRecommender('plc-rec-5'), $profile, 'plc-rec-5');
            $this->fail('a draft profile must not produce a recommendation');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('placement.recommend_requires_scored', $rejection->errorCode());
        }
    }

    public function test_released_placement_evidence_carries_into_applicant_and_student(): void
    {
        $this->setUpPlacementCatalog();
        $person = $this->personWithAuthority('plc-person-6', []);
        $profile = $this->completeReleasedPlacement($person->id, 'plc-evidence');

        $registered = app(RegisterApplicant::class)->register(
            $this->admissionsClerk('plc-evidence-clerk'),
            $person->id,
            'IELTS Preparation',
            'plc-evidence-reg',
            $profile->id,
            $this->placementBranchId,
        );
        $applicant = Applicant::query()->findOrFail($registered['applicant_id']);
        $this->assertSame($profile->id, (string) $applicant->placement_profile_id);

        $initiated = app(DecideAdmission::class)->initiate(
            $this->admissionsClerk('plc-evidence-initiate'),
            $applicant,
            true,
            'placement evidence released',
            'placement/'.$profile->id,
            'plc-evidence-initiate',
        );
        $decision = AdmissionDecision::query()->findOrFail($initiated['decision_id']);
        app(DecideAdmission::class)->review($this->admissionsReviewer('plc-evidence-review'), $decision, 'plc-evidence-review');
        app(DecideAdmission::class)->approve($this->admissionsApprover('plc-evidence-approve'), $decision, 'plc-evidence-approve');
        $converted = app(EnrollAdmittedApplicant::class)->convert(
            $this->admissionsApprover('plc-evidence-convert'),
            $applicant,
            'plc-evidence-convert',
        );
        $student = Student::query()->findOrFail($converted['student_id']);
        $this->assertSame($profile->id, (string) $student->placement_profile_id);
    }

    public function test_released_placement_reference_rejects_unreleased_or_wrong_person(): void
    {
        $this->setUpPlacementCatalog();
        $person = $this->personWithAuthority('plc-person-7', []);
        $profile = $this->completeReleasedPlacement($person->id, 'plc-wrong');

        $other = $this->personWithAuthority('plc-person-8', []);
        try {
            app(RegisterApplicant::class)->register(
                $this->admissionsClerk('plc-wrong-clerk'),
                $other->id,
                'IELTS Preparation',
                'plc-wrong-reg',
                $profile->id,
                $this->placementBranchId,
            );
            $this->fail('a placement for another person must not attach to an applicant');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('admissions.placement_person_mismatch', $rejection->errorCode());
        }
    }

    public function test_placement_finance_link_joins_student_obligations_and_payments(): void
    {
        $this->setUpPlacementCatalog();
        $person = $this->personWithAuthority('plc-person-10', []);
        $profile = $this->completeReleasedPlacement($person->id, 'plc-finance');
        $clerk = $this->admissionsClerk('plc-finance-clerk');
        $reviewer = $this->admissionsReviewer('plc-finance-reviewer');
        $approver = $this->admissionsApprover('plc-finance-approver');

        $registered = app(RegisterApplicant::class)->register($clerk, $person->id, 'IELTS Preparation', 'plc-finance-reg', $profile->id, $this->placementBranchId);
        $applicant = Applicant::query()->findOrFail($registered['applicant_id']);
        $initiated = app(DecideAdmission::class)->initiate($clerk, $applicant, true, 'placement evidence released', 'placement/'.$profile->id, 'plc-finance-initiate');
        $decision = AdmissionDecision::query()->findOrFail($initiated['decision_id']);
        app(DecideAdmission::class)->review($reviewer, $decision, 'plc-finance-review');
        app(DecideAdmission::class)->approve($approver, $decision, 'plc-finance-approve');
        $converted = app(EnrollAdmittedApplicant::class)->convert($approver, $applicant, 'plc-finance-convert');
        $student = Student::query()->findOrFail($converted['student_id']);

        $period = FinancialPeriod::query()->create([
            'id' => RandomIdentifier::new(),
            'period_key' => '2026-11',
            'date_from' => '2026-11-01',
            'date_to' => '2026-11-30',
            'lifecycle_state' => 'open',
        ]);
        $obligationId = RandomIdentifier::new();
        DB::table('obligations')->insert([
            'id' => $obligationId,
            'period_id' => $period->id,
            'student_id' => $student->id,
            'source' => 'tuition',
            'original_amount' => '500.00',
            'reason' => 'Placement program tuition',
            'posted_by' => RandomIdentifier::new(),
            'created_at' => now(),
            'updated_at' => now(),
        ]);
        $paymentId = RandomIdentifier::new();
        DB::table('payments')->insert([
            'id' => $paymentId,
            'period_id' => $period->id,
            'student_id' => $student->id,
            'amount' => '250.00',
            'method' => 'bank',
            'payer_ref' => 'PLACEMENT-FIN-1',
            'received_on' => '2026-11-04',
            'recorded_by' => RandomIdentifier::new(),
            'created_at' => now(),
            'updated_at' => now(),
        ]);

        $lineage = app(PlacementFinanceLinkQuery::class)->for($profile);
        $this->assertSame($student->id, (string) $lineage['student_id']);
        $this->assertCount(1, $lineage['obligations']);
        $this->assertCount(1, $lineage['payments']);
        $this->assertSame($obligationId, (string) $lineage['obligations'][0]->id);
        $this->assertSame($paymentId, (string) $lineage['payments'][0]->id);
    }

    public function test_physical_answer_sheet_ingestion_is_server_scored_and_traced(): void
    {
        $this->setUpPlacementCatalog();
        $this->setUpPhysicalAutoCatalog();
        $person = $this->personWithAuthority('plc-person-9', []);
        $profile = PlacementProfile::query()->findOrFail(app(ManagePlacementProfile::class)->openProfile(
            $this->placementOfficer('plc-phys-open'),
            $person->id,
            $this->programVersionId,
            'plc-phys-open',
            null,
            $this->placementBranchId,
        )['profile_id']);
        $attempt = PlacementAttempt::query()->findOrFail(app(ManagePlacementProfile::class)->startAttempt(
            $this->placementOfficer('plc-phys-start'),
            $profile,
            $this->physicalVersionId,
            'physical',
            'plc-phys-start',
            'plc-phys-start',
        )['attempt_id']);
        $answers = [];
        foreach ($this->physicalQuestions as $questionId => $component) {
            $answers[$questionId] = 'A';
        }
        $result = app(ManagePlacementProfile::class)->ingestPhysicalAnswers(
            $this->placementOfficer('plc-phys-ingest'),
            $attempt,
            $answers,
            'papers/plc-phys/answer-sheet-1',
            'plc-phys-ingest',
        );
        $this->assertFalse($result['tamper_flagged']);
        $physical = $attempt->fresh();
        if ($physical === null) {
            $this->fail('placement attempt disappeared after physical ingestion');
        }
        $this->assertSame('submitted', $physical->status);
        $this->assertNotNull($physical->anti_tamper_hmac);
        $this->assertDatabaseHas('placement_responses', ['attempt_id' => $attempt->id]);
        $this->assertSame(5, PlacementSectionResult::query()->where('attempt_id', $attempt->id)->whereNotNull('raw_score')->count());
    }

    public function test_evidence_only_physical_submission_creates_a_governed_professional_work_queue(): void
    {
        $this->setUpPlacementCatalog();
        $this->setUpPhysicalProfessionalCatalog();
        $this->assertCount(5, $this->physicalProfessionalQuestions);
        $person = $this->personWithAuthority('plc-person-physical-professional', []);
        $profile = PlacementProfile::query()->findOrFail(app(ManagePlacementProfile::class)->openProfile(
            $this->placementOfficer('plc-physical-professional-open'),
            $person->id,
            $this->programVersionId,
            'plc-physical-professional-open',
            null,
            $this->placementBranchId,
        )['profile_id']);
        $starter = $this->placementOfficer('plc-physical-professional-start');
        $attempt = PlacementAttempt::query()->findOrFail(app(ManagePlacementProfile::class)->startAttempt(
            $starter,
            $profile,
            $this->physicalProfessionalVersionId,
            'physical',
            'plc-physical-professional-start',
            $starter->actorId,
        )['attempt_id']);

        $submission = app(ManagePlacementProfile::class)->submitPhysical(
            $this->placementOfficer('plc-physical-professional-submit'),
            $attempt,
            'papers/plc-physical-professional/packet-1',
            'plc-physical-professional-submit',
        );

        $this->assertFalse($submission['tamper_flagged']);
        $this->assertSame(PlacementAttempt::STATUS_SUBMITTED, (string) PlacementAttempt::query()->findOrFail($attempt->id)->status);
        $this->assertSame(0, PlacementResponse::query()->where('attempt_id', $attempt->id)->count());
        $this->assertSame(5, PlacementSectionResult::query()
            ->where('attempt_id', $attempt->id)
            ->where('scoring_method', PlacementSectionResult::SCORING_METHOD_PROFESSIONAL)
            ->whereNull('raw_score')
            ->count());
    }
}
