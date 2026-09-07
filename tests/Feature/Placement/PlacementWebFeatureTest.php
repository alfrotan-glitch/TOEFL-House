<?php

declare(strict_types=1);

namespace Tests\Feature\Placement;

use App\Modules\Academic\Commands\ManageAcademicAppeal;
use App\Modules\Academic\Models\AcademicAppeal;
use App\Modules\Academic\Placement\Commands\DecidePlacement;
use App\Modules\Academic\Placement\Commands\ManagePlacementProfile;
use App\Modules\Academic\Placement\Models\PlacementProfile;
use App\Modules\Academic\Placement\Models\PlacementQuestion;
use App\Modules\Academic\Placement\Models\PlacementQuestionMedia;
use App\Modules\Documents\Commands\DefineDocumentClassification;
use App\Modules\Identity\Models\UserAccount;
use App\Support\Errors\BusinessRejection;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\Hash;
use Tests\Concerns\BuildsPlacementCatalog;
use Tests\TestCase;

/**
 * Placement console transport: a released placement result is registered as
 * a Documents version through the same authoritative Documents command used
 * by the document registry, with classification and subject integrity intact.
 */
final class PlacementWebFeatureTest extends TestCase
{
    use BuildsPlacementCatalog;

    private function signInAs(string $personId, string $username): void
    {
        UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $personId,
            'username' => $username,
            'password_hash' => Hash::make('placement-password'),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);
        $this->post('/login', ['username' => $username, 'password' => 'placement-password'])->assertRedirect('/');
    }

    public function test_in_progress_attempt_renders_only_checksums_media_authority(): void
    {
        $this->setUpPlacementCatalog();
        $person = $this->personWithAuthority('plc-media-person', []);
        $profile = PlacementProfile::query()->findOrFail(app(ManagePlacementProfile::class)->openProfile(
            $this->placementOfficer('plc-media-open'),
            $person->id,
            $this->programVersionId,
            'plc-media-open',
            null,
            $this->placementBranchId,
        )['profile_id']);
        app(ManagePlacementProfile::class)->startAttempt(
            $this->placementOfficer('plc-media-start'),
            $profile,
            $this->testVersionId,
            'digital',
            'plc-media-start',
        );

        $question = PlacementQuestion::query()->where('code', 'grammar-a')->firstOrFail();
        $this->assertNull($question->media_ref, 'new catalog questions must not retain the legacy display pointer');
        $this->assertDatabaseHas('placement_question_media', [
            'question_id' => $question->id,
            'uri' => 'placement-media/grammar-a.mp3',
            'lifecycle_state' => 'active',
        ]);
        $this->assertSame(1, PlacementQuestionMedia::query()->where('question_id', $question->id)->where('lifecycle_state', 'active')->count());

        // Delivery staff do not need catalog-maintenance authority to start
        // or render the compatible frozen version for their own profile.
        $viewer = $this->grantedActor('plc-media-viewer', ['placement.conduct']);
        $this->signInAs($viewer->actorId, 'placement.media.viewer');
        $this->get(route('placement.show', $profile->id))
            ->assertOk()
            ->assertSee('v1 (published)')
            ->assertSee('placement-media/grammar-a.mp3')
            ->assertSee('SHA-256');
    }

    public function test_placement_report_registers_through_documents(): void
    {
        $officer = $this->grantedActor('plc-doc-officer', ['placement.conduct', 'documents.classify', 'documents.register']);
        $classificationId = app(DefineDocumentClassification::class)->defineClassification($officer, 'placement', 'Academic', 'restricted', 'plc-doc-class')['classification_id'];

        $this->setUpPlacementCatalog();
        $person = $this->personWithAuthority('plc-doc-person', []);
        $profile = $this->completeReleasedPlacement($person->id, 'plc-doc');

        $this->signInAs($officer->actorId, 'placement.doc');
        $this->get(route('placement.show', $profile->id))
            ->assertOk()
            ->assertSee('Released at')
            ->assertSee('database_transition');
        $this->post(route('placement.report.register', $profile->id), [
            'classification_id' => $classificationId,
            'title' => 'Placement Report',
            'content_hash' => hash('sha256', 'placement-report-content'),
            'storage_ref' => 'storage/placement/report.pdf',
        ])->assertRedirect();

        $this->assertDatabaseHas('documents', [
            'subject_person_id' => $person->id,
            'title' => 'Placement Report',
        ]);
        $this->assertDatabaseHas('document_versions', [
            'content_hash' => hash('sha256', 'placement-report-content'),
        ]);
    }

    public function test_placement_appeal_can_be_filed_and_reviewed_before_student_conversion(): void
    {
        $appealManager = $this->grantedActor('plc-appeal-manager', ['academic.appeal_manage']);
        $this->setUpPlacementCatalog();
        $person = $this->personWithAuthority('plc-appeal-person', []);
        $profile = $this->completeReleasedPlacement($person->id, 'plc-appeal');

        $this->signInAs($appealManager->actorId, 'placement.appeal');
        $this->post(route('academic.appeal.file'), [
            'subject_type' => 'placement_profile',
            'subject_id' => $profile->id,
            'reason' => 'The placement recommendation does not reflect my performance.',
        ])->assertRedirect();

        $appeal = AcademicAppeal::query()->where('subject_type', 'placement_profile')->where('subject_id', $profile->id)->firstOrFail();
        $this->assertNull($appeal->student_id);
        $this->assertSame('open', $appeal->lifecycle_state);

        $reviewer = $this->grantedActor('plc-appeal-reviewer', ['academic.appeal_manage']);
        app(ManageAcademicAppeal::class)->assign($appealManager, $appeal, $reviewer->actorId, 'plc-appeal-assign');
        $assignedAppeal = $appeal->fresh();
        if ($assignedAppeal === null) {
            $this->fail('placement appeal disappeared after assignment');
        }
        app(ManageAcademicAppeal::class)->investigate($reviewer, $assignedAppeal, 'plc-appeal-investigate');

        // Resolved means upheld AND redressed: the owning placement workflow
        // records the remediation (retake path supersedes the profile) before
        // the reviewer may resolve; the resolve itself mutates nothing.
        try {
            $appealBefore = $appeal->fresh();
            if ($appealBefore === null) {
                $this->fail('placement appeal disappeared before early resolve probe');
            }
            app(ManageAcademicAppeal::class)->resolve($reviewer, $appealBefore, 'adjusted', 'placement/appeal/evidence/'.$appeal->id, 'plc-appeal-resolve-early');
            $this->fail('a still-open profile must not resolve');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('academic.appeal_subject_untouched', $rejection->errorCode());
        }
        app(DecidePlacement::class)->supersede($this->placementReleaser('plc-appeal-releaser'), PlacementProfile::query()->findOrFail($profile->id), 'plc-appeal-supersede');
        $appealForResolve = $appeal->fresh();
        if ($appealForResolve === null) {
            $this->fail('placement appeal disappeared before resolve');
        }
        app(ManageAcademicAppeal::class)->resolve($reviewer, $appealForResolve, 'adjusted', 'placement/appeal/evidence/'.$appeal->id, 'plc-appeal-resolve');
        $appealForClose = $appeal->fresh();
        if ($appealForClose === null) {
            $this->fail('placement appeal disappeared before close');
        }
        app(ManageAcademicAppeal::class)->close($appealManager, $appealForClose, 'plc-appeal-close');

        $refreshedAppeal = $appeal->fresh();
        $this->assertNotNull($refreshedAppeal);
        $this->assertSame('closed', $refreshedAppeal->lifecycle_state);
        $this->assertSame('adjusted', $refreshedAppeal->outcome);
        $refreshedProfile = $profile->fresh();
        $this->assertNotNull($refreshedProfile);
        $this->assertSame('superseded', $refreshedProfile->lifecycle_state);
    }
}
