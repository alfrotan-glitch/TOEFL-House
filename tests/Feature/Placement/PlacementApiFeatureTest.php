<?php

declare(strict_types=1);

namespace Tests\Feature\Placement;

use App\Modules\Academic\Placement\Models\PlacementAttempt;
use App\Modules\Academic\Placement\Models\PlacementProfile;
use App\Modules\Academic\Placement\Models\PlacementRubric;
use App\Modules\Academic\Placement\Models\PlacementSectionResult;
use App\Modules\Identity\Models\UserAccount;
use App\Support\Authorization\Actor;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\Hash;
use Tests\Concerns\BuildsPlacementCatalog;
use Tests\TestCase;

/**
 * The placement JSON API is session-authenticated and delegates every
 * mutation to the authoritative commands. These tests exercise the thin
 * transport contract: authenticated listing, profile/attempt intake,
 * physical answer-sheet ingestion, the full scoring/decision chain, and
 * the read-only finance lineage endpoint.
 */
final class PlacementApiFeatureTest extends TestCase
{
    use BuildsPlacementCatalog;

    private function signInAs(string $personId, string $username): void
    {
        UserAccount::query()->firstOrCreate(
            ['username' => $username],
            [
                'id' => RandomIdentifier::new(),
                'person_id' => $personId,
                'password_hash' => Hash::make('placement-password'),
                'account_state' => UserAccount::STATE_ACTIVE,
            ],
        );
        $this->post('/login', ['username' => $username, 'password' => 'placement-password'])->assertRedirect('/');
    }

    private function apiPlacementOfficer(string $actorId): Actor
    {
        return $this->grantedActor($actorId, [
            'placement.catalog',
            'placement.conduct',
            'placement.score',
            'placement.moderate',
            'placement.approve',
            'placement.recommend',
            'placement.release',
        ]);
    }

    private function switchTo(string $personId, string $username): void
    {
        $this->post('/logout');
        $this->signInAs($personId, $username);
    }

    public function test_api_placement_listing_and_profile_open_exposes_the_surface(): void
    {
        $officer = $this->apiPlacementOfficer('plc-api-officer');
        $this->signInAs($officer->actorId, 'placement.api');
        $this->setUpPlacementCatalog();

        $this->getJson('/api/placement/tests')
            ->assertOk()
            ->assertJsonCount(1, 'tests')
            ->assertJsonPath('tests.0.key', 'placement-standard');

        $this->getJson('/api/placement/versions')
            ->assertOk()
            ->assertJsonCount(1, 'versions');

        $opened = $this->postJson('/api/placement/profiles', [
            'person_id' => $officer->actorId,
            'program_version_id' => $this->programVersionId,
        ], ['Idempotency-Key' => 'placement-api-open-1'])
            ->assertCreated()
            ->assertJsonPath('status', 'opened');

        $profileId = (string) $opened->json('profile_id');
        $this->getJson('/api/placement/profiles/'.$profileId)
            ->assertOk()
            ->assertJsonPath('profile.id', $profileId);

        $this->getJson('/api/placement/profiles/'.$profileId.'/finance-link')
            ->assertOk()
            ->assertJsonPath('student_id', null);
    }

    public function test_api_placement_digital_decision_chain_delegates_to_commands(): void
    {
        $scorer = $this->grantedActor('plc-api-scorer', ['placement.conduct', 'placement.score']);
        $moderator = $this->grantedActor('plc-api-moderator', ['placement.moderate']);
        $approver = $this->grantedActor('plc-api-approver', ['placement.approve']);
        $recommender = $this->grantedActor('plc-api-recommender', ['placement.recommend']);
        $reviewer = $this->grantedActor('plc-api-reviewer', ['placement.moderate']);
        $releaser = $this->grantedActor('plc-api-releaser', ['placement.release']);
        $this->signInAs($scorer->actorId, 'placement.api.scorer');
        $this->setUpPlacementCatalog();

        $opened = $this->postJson('/api/placement/profiles', [
            'person_id' => $scorer->actorId,
            'program_version_id' => $this->programVersionId,
        ], ['Idempotency-Key' => 'placement-api-open-2'])
            ->assertCreated();
        $profileId = (string) $opened->json('profile_id');

        $started = $this->postJson('/api/placement/attempts', [
            'profile_id' => $profileId,
            'test_version_id' => $this->testVersionId,
            'delivery_mode' => 'digital',
        ], ['Idempotency-Key' => 'placement-api-start-2'])
            ->assertCreated()
            ->assertJsonPath('status', 'started');
        $attemptId = (string) $started->json('attempt_id');

        $answers = [];
        foreach ($this->questions as $questionId => $component) {
            $answers[$questionId] = in_array($component, ['grammar', 'reading', 'listening'], true) ? 'A' : 'sample response';
        }
        $this->postJson('/api/placement/attempts/'.$attemptId.'/submit', [
            'answers' => $answers,
        ], ['Idempotency-Key' => 'placement-api-submit-2'])
            ->assertOk()
            ->assertJsonPath('status', 'submitted')
            ->assertJsonPath('tamper_flagged', false);

        foreach (['writing', 'speaking'] as $component) {
            $rubric = PlacementRubric::query()->where('test_version_id', $this->testVersionId)->where('component', $component)->where('cefr_ref', 'B1')->firstOrFail();
            $this->postJson('/api/placement/sections/score', [
                'attempt_id' => $attemptId,
                'section_id' => $this->sectionIds[$component],
                'raw_score' => '60.0',
                'rubric_id' => $rubric->id,
                'cefr_ref' => 'B1',
                'rationale' => 'professional marking',
            ], ['Idempotency-Key' => 'placement-api-score-'.$component])
                ->assertOk();
        }

        $attempt = PlacementAttempt::query()->findOrFail($attemptId);
        $this->postJson('/api/placement/profiles/'.$profileId.'/mark-scored', [], ['Idempotency-Key' => 'placement-api-mark-scored-2'])
            ->assertOk()
            ->assertJsonPath('status', 'scored');

        $this->switchTo($moderator->actorId, 'placement.api.moderator');
        foreach (PlacementSectionResult::query()->where('attempt_id', $attempt->id)->get() as $sectionResult) {
            $this->postJson('/api/placement/section-results/'.$sectionResult->id.'/moderate', [], ['Idempotency-Key' => 'placement-api-moderate-'.$sectionResult->id])->assertOk();
        }

        $this->switchTo($approver->actorId, 'placement.api.approver');
        foreach (PlacementSectionResult::query()->where('attempt_id', $attempt->id)->get() as $sectionResult) {
            $this->postJson('/api/placement/section-results/'.$sectionResult->id.'/approve', [], ['Idempotency-Key' => 'placement-api-approve-'.$sectionResult->id])->assertOk();
        }

        $this->switchTo($recommender->actorId, 'placement.api.recommender');
        $this->postJson('/api/placement/profiles/'.$profileId.'/recommend', [], ['Idempotency-Key' => 'placement-api-recommend-2'])->assertOk();

        $this->switchTo($reviewer->actorId, 'placement.api.reviewer');
        $this->postJson('/api/placement/profiles/'.$profileId.'/review', [], ['Idempotency-Key' => 'placement-api-review-2'])->assertOk();

        $this->switchTo($approver->actorId, 'placement.api.approver');
        $this->postJson('/api/placement/profiles/'.$profileId.'/approve', [], ['Idempotency-Key' => 'placement-api-approve-profile-2'])->assertOk();

        $this->switchTo($releaser->actorId, 'placement.api.releaser');
        $this->postJson('/api/placement/profiles/'.$profileId.'/release', [], ['Idempotency-Key' => 'placement-api-release-2'])->assertOk();

        $this->assertSame('released', PlacementProfile::query()->findOrFail($profileId)->lifecycle_state);
    }

    public function test_api_physical_answer_sheet_ingest_delegates_to_commands(): void
    {
        $officer = $this->apiPlacementOfficer('plc-api-officer');
        $this->signInAs($officer->actorId, 'placement.api');
        $this->setUpPlacementCatalog();
        $this->setUpPhysicalAutoCatalog();

        $opened = $this->postJson('/api/placement/profiles', [
            'person_id' => $officer->actorId,
            'program_version_id' => $this->programVersionId,
        ], ['Idempotency-Key' => 'placement-api-open-phys'])
            ->assertCreated();
        $profileId = (string) $opened->json('profile_id');

        $started = $this->postJson('/api/placement/attempts', [
            'profile_id' => $profileId,
            'test_version_id' => $this->physicalVersionId,
            'delivery_mode' => 'physical',
        ], ['Idempotency-Key' => 'placement-api-start-phys'])
            ->assertCreated();
        $attemptId = (string) $started->json('attempt_id');

        $answers = [];
        foreach ($this->physicalQuestions as $questionId => $component) {
            $answers[$questionId] = 'A';
        }

        $this->postJson('/api/placement/attempts/'.$attemptId.'/ingest-answers', [
            'evidence_ref' => 'papers/plc-api-phys/answer-sheet-1',
            'answers' => $answers,
        ], ['Idempotency-Key' => 'placement-api-ingest-phys'])
            ->assertOk()
            ->assertJsonPath('status', 'submitted')
            ->assertJsonPath('tamper_flagged', false);

        $this->assertSame('submitted', PlacementAttempt::query()->findOrFail($attemptId)->status);
        $this->assertSame(3, PlacementSectionResult::query()->where('attempt_id', $attemptId)->whereNotNull('raw_score')->count());
    }
}
