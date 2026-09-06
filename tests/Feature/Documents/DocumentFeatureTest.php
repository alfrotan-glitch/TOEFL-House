<?php

declare(strict_types=1);

namespace Tests\Feature\Documents;

use App\Modules\Documents\Commands\DecideRetention;
use App\Modules\Documents\Commands\DefineDocumentClassification;
use App\Modules\Documents\Commands\RegisterDocument;
use App\Modules\Documents\Commands\TransitionDocument;
use App\Modules\Documents\Models\Document;
use App\Modules\Documents\Queries\DocumentHistoryQuery;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

final class DocumentFeatureTest extends TestCase
{
    use BuildsActors;

    private string $classificationId;

    private string $subjectId;

    protected function setUp(): void
    {
        parent::setUp();
        $officer = $this->documentsOfficer('doc-admin');
        $this->classificationId = app(DefineDocumentClassification::class)->defineClassification($officer, 'national-id', 'Identity', 'restricted', 'class-key-1')['classification_id'];
        $this->subjectId = 'doc-subject-1';
        $this->personWithAuthority($this->subjectId, []);
    }

    private function registerDocument(Actor $registrar, string $key): Document
    {
        $result = app(RegisterDocument::class)->register($registrar, $this->subjectId, $this->classificationId, 'National ID', 'hash-'.sha1($key), 'storage/'.$key, $key);

        return Document::query()->findOrFail($result['document_id']);
    }

    public function test_document_moves_submit_verify_activate_with_separation_of_duties(): void
    {
        $registrar = $this->documentsOfficer('doc-registrar');
        $verifier = $this->documentsOfficer('doc-verifier');
        $document = $this->registerDocument($registrar, 'doc-key-1');

        app(TransitionDocument::class)->submit($registrar, $document, 'hash-v2', 'storage/v2', 'doc-key-2');
        $result = app(TransitionDocument::class)->verify($verifier, $document, true, 'matches subject identity', 'doc-key-3');
        $this->assertSame('verified', $result['lifecycle_state']);
        app(TransitionDocument::class)->activate($verifier, $document, 'doc-key-4');

        $this->assertDatabaseHas('documents', ['id' => $document->id, 'lifecycle_state' => 'active']);
        $this->assertDatabaseHas('document_verifications', ['document_id' => $document->id, 'version_no' => 2, 'result' => 'pass']);
        $this->assertDatabaseHas('audit_events', ['operation' => 'documents.verify', 'target_type' => 'document', 'target_id' => $document->id]);
    }

    public function test_verifier_may_not_be_the_uploader(): void
    {
        $registrar = $this->documentsOfficer('doc-both');
        $document = $this->registerDocument($registrar, 'doc-key-5');
        app(TransitionDocument::class)->submit($registrar, $document, 'hash-v2', 'storage/v2', 'doc-key-6');

        $this->expectException(BusinessRejection::class);
        $this->expectExceptionMessage('the verifier may not be the uploader');
        app(TransitionDocument::class)->verify($registrar, $document, true, 'self approval attempt', 'doc-key-7');
    }

    public function test_failed_verification_rejects_and_resubmission_appends_a_new_version(): void
    {
        $registrar = $this->documentsOfficer('doc-registrar-2');
        $verifier = $this->documentsOfficer('doc-verifier-2');
        $document = $this->registerDocument($registrar, 'doc-key-8');
        app(TransitionDocument::class)->submit($registrar, $document, 'hash-blurry', 'storage/blurry', 'doc-key-9');

        $failed = app(TransitionDocument::class)->verify($verifier, $document, false, 'unreadable scan', 'doc-key-10');
        $this->assertSame('rejected', $failed['lifecycle_state']);

        $resubmitted = app(TransitionDocument::class)->submit($registrar, $document, 'hash-clear', 'storage/clear', 'doc-key-11');
        $this->assertSame(3, $resubmitted['version_no']);
        $passed = app(TransitionDocument::class)->verify($verifier, $document, true, 'clear scan matches', 'doc-key-12');
        $this->assertSame('verified', $passed['lifecycle_state']);

        $history = (new DocumentHistoryQuery)->documentHistory($document->id);
        $this->assertSame('verified', $history['lifecycle_state']);
        $this->assertCount(3, $history['versions']);
        $this->assertSame('fail', $history['versions'][1]['verifications'][0]['result']);
        $this->assertSame('pass', $history['versions'][2]['verifications'][0]['result']);
    }

    public function test_versions_are_immutable_even_against_raw_sql(): void
    {
        $registrar = $this->documentsOfficer('doc-registrar-3');
        $document = $this->registerDocument($registrar, 'doc-key-13');

        $this->expectException(QueryException::class);
        DB::statement('UPDATE document_versions SET content_hash = ? WHERE document_id = ?', ['tampered', $document->id]);
    }

    public function test_verifications_are_append_only_even_against_raw_sql(): void
    {
        $registrar = $this->documentsOfficer('doc-registrar-4');
        $verifier = $this->documentsOfficer('doc-verifier-4');
        $document = $this->registerDocument($registrar, 'doc-key-14');
        app(TransitionDocument::class)->submit($registrar, $document, 'hash-x', 'storage/x', 'doc-key-15');
        app(TransitionDocument::class)->verify($verifier, $document, true, 'valid', 'doc-key-16');

        $this->expectException(QueryException::class);
        DB::statement("UPDATE document_verifications SET result = 'fail' WHERE document_id = ?", [$document->id]);
    }

    public function test_unprivileged_registrar_is_denied_and_audited(): void
    {
        $nobody = $this->actorWithoutAnyCapability('doc-nobody');

        $this->expectException(AuthorizationDenied::class);
        $this->expectExceptionMessage('no active authority grants documents.register');
        app(RegisterDocument::class)->register($nobody, $this->subjectId, $this->classificationId, 'Stolen ID', 'hash-s', 'storage/s', 'doc-key-17');

        $this->assertDatabaseHas('audit_events', ['operation' => 'documents.register.denied', 'actor_id' => 'doc-nobody']);
    }

    public function test_retention_requires_a_rule_then_retains_before_due_and_archives_after(): void
    {
        $officer = $this->documentsOfficer('doc-retention');
        $registrar = $this->documentsOfficer('doc-registrar-5');
        $verifier = $this->documentsOfficer('doc-verifier-5');
        $document = $this->registerDocument($registrar, 'doc-key-18');
        app(TransitionDocument::class)->submit($registrar, $document, 'hash-r', 'storage/r', 'doc-key-19');
        app(TransitionDocument::class)->verify($verifier, $document, true, 'valid', 'doc-key-20');
        app(TransitionDocument::class)->activate($verifier, $document, 'doc-key-21');

        try {
            app(DecideRetention::class)->decide($officer, $document, 'ret-key-1');
            $this->fail('retention without a rule must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('documents.retention_rule_missing', $rejection->errorCode());
        }

        app(DefineDocumentClassification::class)->defineRetentionRule($officer, 'national-id', 365, 'identity-statute-7y', 'operational hold', 'ret-rule-key-1');
        $early = app(DecideRetention::class)->decide($officer, $document, 'ret-key-2');
        $this->assertSame('retain', $early['action']);
        $this->assertDatabaseHas('documents', ['id' => $document->id, 'lifecycle_state' => 'active']);

        DB::statement('UPDATE documents SET created_at = ? WHERE id = ?', ['2020-01-01 10:00:00', $document->id]);
        $late = app(DecideRetention::class)->decide($officer, $document, 'ret-key-3');
        $this->assertSame('archive', $late['action']);
        $this->assertDatabaseHas('documents', ['id' => $document->id, 'lifecycle_state' => 'archived']);
        $this->assertDatabaseHas('retention_decisions', ['document_id' => $document->id, 'action' => 'retain']);
        $this->assertDatabaseHas('retention_decisions', ['document_id' => $document->id, 'action' => 'archive']);
    }

    public function test_retention_decisions_are_append_only(): void
    {
        $officer = $this->documentsOfficer('doc-retention-2');
        $registrar = $this->documentsOfficer('doc-registrar-6');
        $document = $this->registerDocument($registrar, 'doc-key-22');
        app(DefineDocumentClassification::class)->defineRetentionRule($officer, 'national-id', 30, 'identity-statute-7y', null, 'ret-rule-key-2');
        $decision = app(DecideRetention::class)->decide($officer, $document, 'ret-key-4');

        $this->expectException(QueryException::class);
        DB::statement("UPDATE retention_decisions SET action = 'archive' WHERE id = ?", [$decision['decision_id']]);
    }

    public function test_forbidden_document_transitions_fail_closed(): void
    {
        $registrar = $this->documentsOfficer('doc-registrar-7');
        $document = $this->registerDocument($registrar, 'doc-key-23');

        try {
            app(TransitionDocument::class)->activate($registrar, $document, 'doc-key-24');
            $this->fail('draft -> active must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('documents.transition_forbidden', $rejection->errorCode());
        }

        $this->expectException(BusinessRejection::class);
        $this->expectExceptionMessage('only a submitted document can be verified');
        app(TransitionDocument::class)->verify($this->documentsOfficer('doc-verifier-7'), $document, true, 'nothing to verify', 'doc-key-25');
    }
}
