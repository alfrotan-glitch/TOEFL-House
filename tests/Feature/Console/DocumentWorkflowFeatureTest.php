<?php

declare(strict_types=1);

namespace Tests\Feature\Console;

use App\Modules\Documents\Commands\DefineDocumentClassification;
use App\Modules\Documents\Commands\RegisterDocument;
use App\Modules\Documents\Commands\TransitionDocument;
use App\Modules\Documents\Models\Document;
use App\Modules\Documents\Models\DocumentClassification;
use App\Modules\Identity\Models\Person;
use App\Modules\Identity\Models\UserAccount;
use App\Support\Errors\BusinessRejection;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

/**
 * PHASE_3 increment E (part one): the document registry — classification
 * and retention rules, registration against a known subject, append-only
 * immutable versions, verification by a distinct employee (the uploader of
 * the version under review can never verify it), the full lifecycle
 * (draft → submitted → verified/rejected → active → expired → archived,
 * rejected resubmits as a new version), and retention decisions under the
 * category's rule — is exercised over the real HTTP surface with distinct
 * sessions per signature.
 */
final class DocumentWorkflowFeatureTest extends TestCase
{
    use BuildsActors;

    private string $subjectPersonId;

    private string $classificationId;

    protected function setUp(): void
    {
        parent::setUp();

        $this->subjectPersonId = 'doc-subject-1';
        $this->personWithAuthority($this->subjectPersonId, []);

        $classifier = $this->grantedActor('doc-fx-classifier', ['documents.classify']);
        $defined = app(DefineDocumentClassification::class)->defineClassification(
            $classifier, 'enrollment-contract', 'academic', 'confidential', 'doc-fx-class',
        );
        $this->classificationId = $defined['classification_id'];
        app(DefineDocumentClassification::class)->defineRetentionRule(
            $classifier, 'enrollment-contract', 365, 'contract law retention schedule', null, 'doc-fx-rule',
        );
    }

    /** @return array{0: Person, 1: UserAccount} */
    private function makeEmployee(string $personId, array $capabilities, string $username): array
    {
        $person = $this->personWithAuthority($personId, $capabilities);
        $account = UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $person->id,
            'username' => $username,
            'password_hash' => Hash::make('doc-password-1'),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);

        return [$person, $account];
    }

    private function signIn(string $username): void
    {
        $this->post('/login', ['username' => $username, 'password' => 'doc-password-1'])->assertRedirect('/');
        $this->assertAuthenticated();
    }

    private function signOut(): void
    {
        $this->post('/logout')->assertRedirect('/login');
        $this->assertGuest();
    }

    public function test_document_lifecycle_end_to_end_over_the_console(): void
    {
        $this->makeEmployee('doc-registrar-1', ['documents.register'], 'registrar');
        $this->makeEmployee('doc-uploader-1', ['documents.register', 'documents.verify'], 'uploader');
        $this->makeEmployee('doc-verifier-1', ['documents.verify'], 'verifier');
        $this->makeEmployee('doc-keeper-1', ['documents.verify', 'documents.retention'], 'keeper');
        $this->makeEmployee('doc-plain-1', [], 'plain');

        $documents = DB::connection()->getTablePrefix().'documents';

        // An employee without the capability cannot register.
        $this->signIn('plain');
        $register = [
            'subject_person_id' => $this->subjectPersonId,
            'classification_id' => $this->classificationId,
            'title' => 'Enrollment contract',
            'content_hash' => 'sha256:doc-1-v1',
            'storage_ref' => 'storage/doc-1/v1',
        ];
        $this->post('/documents', $register, ['referer' => 'http://localhost/documents'])
            ->assertRedirect('/documents')
            ->assertSessionHas('error_code', 'documents.register_denied');
        $this->assertSame(0, DB::table($documents)->count());

        // The registrar registers; unknown subject and unknown
        // classification are refused with their exact codes.
        $this->signOut();
        $this->signIn('registrar');
        $this->post('/documents', $register + ['idempotency_key' => 'doc-reg-1'])->assertRedirect('/documents');
        $this->assertSame(1, DB::table($documents)->count());
        $documentId = DB::table($documents)->value('id');
        $this->assertDatabaseHas($documents, ['id' => $documentId, 'lifecycle_state' => 'draft']);

        // PHP array union keeps the left operand's keys — build the
        // negatives explicitly so the invalid field actually replaces it.
        $unknownSubject = $register;
        $unknownSubject['subject_person_id'] = RandomIdentifier::new();
        $unknownSubject['idempotency_key'] = 'doc-reg-2';
        $this->post('/documents', $unknownSubject, ['referer' => 'http://localhost/documents'])
            ->assertRedirect('/documents')
            ->assertSessionHas('error_code', 'documents.subject_unknown');
        $unknownClassification = $register;
        $unknownClassification['classification_id'] = RandomIdentifier::new();
        $unknownClassification['idempotency_key'] = 'doc-reg-3';
        $this->post('/documents', $unknownClassification, ['referer' => 'http://localhost/documents'])
            ->assertRedirect('/documents')
            ->assertSessionHas('error_code', 'documents.classification_unknown');

        // Idempotent replay adds nothing.
        $this->post('/documents', $register + ['idempotency_key' => 'doc-reg-1'])->assertRedirect('/documents');
        $this->assertSame(1, DB::table($documents)->count());

        // The uploader submits version two; the uploader of that version
        // may never verify it — even holding the capability.
        $this->signOut();
        $this->signIn('uploader');
        $this->post('/documents/'.$documentId.'/submit', [
            'content_hash' => 'sha256:doc-1-v2', 'storage_ref' => 'storage/doc-1/v2',
        ])->assertRedirect('/documents');
        $this->assertDatabaseHas($documents, ['id' => $documentId, 'lifecycle_state' => 'submitted']);
        $this->post('/documents/'.$documentId.'/verify', [
            'result' => 'pass', 'reason' => 'matches the signed original',
        ], ['referer' => 'http://localhost/documents'])
            ->assertRedirect('/documents')
            ->assertSessionHas('error_code', 'documents.verifier_is_uploader');

        // A distinct verifier passes it; the keeper then drives the
        // remaining lifecycle to its terminal state.
        $this->signOut();
        $this->signIn('verifier');
        $this->post('/documents/'.$documentId.'/verify', [
            'result' => 'pass', 'reason' => 'matches the signed original',
        ])->assertRedirect('/documents');
        $this->assertDatabaseHas($documents, ['id' => $documentId, 'lifecycle_state' => 'verified']);

        $this->signOut();
        $this->signIn('keeper');
        $this->post('/documents/'.$documentId.'/activate')->assertRedirect('/documents');
        $this->assertDatabaseHas($documents, ['id' => $documentId, 'lifecycle_state' => 'active']);
        $this->post('/documents/'.$documentId.'/expire')->assertRedirect('/documents');
        $this->assertDatabaseHas($documents, ['id' => $documentId, 'lifecycle_state' => 'expired']);
        $this->post('/documents/'.$documentId.'/archive')->assertRedirect('/documents');
        $this->assertDatabaseHas($documents, ['id' => $documentId, 'lifecycle_state' => 'archived']);

        // Archived is terminal: even a new version cannot resubmit it.
        // (Signed in as the registrar — the submit gate requires the
        // register capability before the transition check is reached.)
        $this->signOut();
        $this->signIn('registrar');
        $this->post('/documents/'.$documentId.'/submit', [
            'content_hash' => 'sha256:doc-1-v3', 'storage_ref' => 'storage/doc-1/v3',
        ], ['referer' => 'http://localhost/documents'])
            ->assertRedirect('/documents')
            ->assertSessionHas('error_code', 'documents.transition_forbidden');
    }

    public function test_a_failed_verification_is_resubmitted_as_a_new_version(): void
    {
        $this->makeEmployee('doc-registrar-2', ['documents.register'], 'registrar-2');
        $this->makeEmployee('doc-uploader-2', ['documents.register', 'documents.verify'], 'uploader-2');
        $this->makeEmployee('doc-verifier-2', ['documents.verify'], 'verifier-2');

        $documents = DB::connection()->getTablePrefix().'documents';

        $this->signIn('registrar-2');
        $this->post('/documents', [
            'subject_person_id' => $this->subjectPersonId,
            'classification_id' => $this->classificationId,
            'title' => 'Fee schedule',
            'content_hash' => 'sha256:fee-v1',
            'storage_ref' => 'storage/fee/v1',
        ])->assertRedirect('/documents');
        $documentId = DB::table($documents)->value('id');

        $this->signOut();
        $this->signIn('uploader-2');
        $this->post('/documents/'.$documentId.'/submit', [
            'content_hash' => 'sha256:fee-v2', 'storage_ref' => 'storage/fee/v2',
        ])->assertRedirect('/documents');

        $this->signOut();
        $this->signIn('verifier-2');
        $this->post('/documents/'.$documentId.'/verify', [
            'result' => 'fail', 'reason' => 'the amendment page is missing its countersignature',
        ])->assertRedirect('/documents');
        $this->assertDatabaseHas($documents, ['id' => $documentId, 'lifecycle_state' => 'rejected']);

        // A rejected document cannot be re-verified in place.
        $this->post('/documents/'.$documentId.'/verify', [
            'result' => 'pass', 'reason' => 'second look',
        ], ['referer' => 'http://localhost/documents'])
            ->assertRedirect('/documents')
            ->assertSessionHas('error_code', 'documents.verify_wrong_state');

        // It resubmits as a new version, and the new version is verified.
        $this->signOut();
        $this->signIn('uploader-2');
        $this->post('/documents/'.$documentId.'/submit', [
            'content_hash' => 'sha256:fee-v3', 'storage_ref' => 'storage/fee/v3',
        ])->assertRedirect('/documents');
        $this->assertSame(3, DB::table(DB::connection()->getTablePrefix().'document_versions')->where('document_id', $documentId)->max('version_no'));

        $this->signOut();
        $this->signIn('verifier-2');
        $this->post('/documents/'.$documentId.'/verify', [
            'result' => 'pass', 'reason' => 'countersigned amendment attached in version three',
        ])->assertRedirect('/documents');
        $this->assertDatabaseHas($documents, ['id' => $documentId, 'lifecycle_state' => 'verified']);
    }

    public function test_retention_decisions_apply_the_category_rule(): void
    {
        $this->makeEmployee('doc-registrar-3', ['documents.register'], 'registrar-3');
        $this->makeEmployee('doc-uploader-3', ['documents.register'], 'uploader-3');
        $this->makeEmployee('doc-verifier-3', ['documents.verify'], 'verifier-3');
        $this->makeEmployee('doc-keeper-3', ['documents.verify', 'documents.retention'], 'keeper-3');
        $this->makeEmployee('doc-classifier-3', ['documents.classify'], 'classifier-3');
        $this->makeEmployee('doc-plain-3', [], 'plain-3');

        $documents = DB::connection()->getTablePrefix().'documents';
        $decisions = DB::connection()->getTablePrefix().'retention_decisions';

        $this->signIn('registrar-3');
        $this->post('/documents', [
            'subject_person_id' => $this->subjectPersonId,
            'classification_id' => $this->classificationId,
            'title' => 'Retention sample',
            'content_hash' => 'sha256:ret-v1',
            'storage_ref' => 'storage/ret/v1',
        ])->assertRedirect('/documents');
        $documentId = DB::table($documents)->value('id');

        $this->signOut();
        $this->signIn('uploader-3');
        $this->post('/documents/'.$documentId.'/submit', [
            'content_hash' => 'sha256:ret-v2', 'storage_ref' => 'storage/ret/v2',
        ])->assertRedirect('/documents');

        $this->signOut();
        $this->signIn('verifier-3');
        $this->post('/documents/'.$documentId.'/verify', [
            'result' => 'pass', 'reason' => 'evidence complete',
        ])->assertRedirect('/documents');

        $this->signOut();
        $this->signIn('keeper-3');
        $this->post('/documents/'.$documentId.'/activate')->assertRedirect('/documents');

        // A plain employee cannot decide retention.
        $this->signOut();
        $this->signIn('plain-3');
        $this->post('/documents/'.$documentId.'/retention', [], ['referer' => 'http://localhost/documents'])
            ->assertRedirect('/documents')
            ->assertSessionHas('error_code', 'documents.retention_denied');

        // The document is inside its 365-day period: retain, no state change.
        $this->signOut();
        $this->signIn('keeper-3');
        $this->post('/documents/'.$documentId.'/retention')->assertRedirect('/documents');
        $this->assertDatabaseHas($decisions, ['document_id' => $documentId, 'action' => 'retain']);
        $this->assertDatabaseHas($documents, ['id' => $documentId, 'lifecycle_state' => 'active']);

        // A document past its retention due date is archived by the decision.
        DB::table($documents)->where('id', $documentId)
            ->update(['created_at' => now()->subDays(400)->toDateTimeString()]);
        $this->post('/documents/'.$documentId.'/retention')->assertRedirect('/documents');
        $this->assertDatabaseHas($decisions, ['document_id' => $documentId, 'action' => 'archive']);
        $this->assertDatabaseHas($documents, ['id' => $documentId, 'lifecycle_state' => 'archived']);

        // A classification without a retention rule cannot be decided.
        $this->signOut();
        $this->signIn('classifier-3');
        $this->post('/documents/classifications', [
            'category' => 'audit-log', 'owner_module' => 'audit', 'access_class' => 'internal',
        ])->assertRedirect('/documents');
        $unruledId = DocumentClassification::query()->where('category', 'audit-log')->value('id');

        $this->signOut();
        $this->signIn('registrar-3');
        $this->post('/documents', [
            'subject_person_id' => $this->subjectPersonId,
            'classification_id' => $unruledId,
            'title' => 'Audit log extract',
            'content_hash' => 'sha256:log-v1',
            'storage_ref' => 'storage/log/v1',
        ])->assertRedirect('/documents');
        $unruledDocId = DB::table($documents)->where('classification_id', $unruledId)->value('id');

        $this->signOut();
        $this->signIn('keeper-3');
        $this->post('/documents/'.$unruledDocId.'/retention', [], ['referer' => 'http://localhost/documents'])
            ->assertRedirect('/documents')
            ->assertSessionHas('error_code', 'documents.retention_rule_missing');
    }

    public function test_the_validation_gates_of_the_document_commands(): void
    {
        $classifier = $this->grantedActor('doc-fx-classifier-2', ['documents.classify']);
        $registrar = $this->grantedActor('doc-fx-registrar-2', ['documents.register']);
        $verifier = $this->grantedActor('doc-fx-verifier-2', ['documents.verify']);

        // Retention rules require a positive period.
        try {
            app(DefineDocumentClassification::class)->defineRetentionRule(
                $classifier, 'zero-category', 0, 'no basis', null, 'doc-dom-rule',
            );
            $this->fail('expected the non-positive retention period to be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('documents.retention_period_invalid', $rejection->errorCode());
        }

        // A document requires its content.
        try {
            app(RegisterDocument::class)->register(
                $registrar, $this->subjectPersonId, $this->classificationId, 'Empty', '', '', 'doc-dom-reg',
            );
            $this->fail('expected the missing content to be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('documents.content_missing', $rejection->errorCode());
        }

        // Verification requires a reason.
        $registered = app(RegisterDocument::class)->register(
            $registrar, $this->subjectPersonId, $this->classificationId, 'Reasonless', 'sha256:r-v1', 'storage/r/v1', 'doc-dom-reg2',
        );
        $document = Document::query()->findOrFail($registered['document_id']);
        app(TransitionDocument::class)->submit(
            $registrar, $document, 'sha256:r-v2', 'storage/r/v2', 'doc-dom-submit',
        );
        try {
            app(TransitionDocument::class)->verify($verifier, $document, true, '', 'doc-dom-verify');
            $this->fail('expected the missing verification reason to be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('documents.verify_reason_missing', $rejection->errorCode());
        }
    }
}
