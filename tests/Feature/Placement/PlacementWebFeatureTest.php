<?php

declare(strict_types=1);

namespace Tests\Feature\Placement;

use App\Modules\Documents\Commands\DefineDocumentClassification;
use App\Modules\Identity\Models\UserAccount;
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

    public function test_placement_report_registers_through_documents(): void
    {
        $officer = $this->grantedActor('plc-doc-officer', ['documents.classify', 'documents.register']);
        $classificationId = app(DefineDocumentClassification::class)->defineClassification($officer, 'placement', 'Academic', 'restricted', 'plc-doc-class')['classification_id'];

        $this->setUpPlacementCatalog();
        $person = $this->personWithAuthority('plc-doc-person', []);
        $profile = $this->completeReleasedPlacement($person->id, 'plc-doc');

        $this->signInAs($officer->actorId, 'placement.doc');
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
}
