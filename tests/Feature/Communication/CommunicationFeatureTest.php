<?php

declare(strict_types=1);

namespace Tests\Feature\Communication;

use App\Modules\Communication\Commands\SendMessage;
use App\Modules\Communication\Models\Message;
use App\Modules\Privacy\Commands\DefineConsentPurpose;
use App\Modules\Privacy\Commands\RecordConsent;
use App\Modules\Privacy\Commands\TransitionConsent;
use App\Modules\Privacy\Models\Consent;
use App\Support\Errors\BusinessRejection;
use Carbon\CarbonImmutable;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

final class CommunicationFeatureTest extends TestCase
{
    use BuildsActors;

    private string $subjectId = 'comm-subject-1';

    private string $purposeId;

    protected function setUp(): void
    {
        parent::setUp();
        $this->personWithAuthority($this->subjectId, []);
        $privacyOfficer = $this->privacyOfficer('comm-privacy');

        $purpose = app(DefineConsentPurpose::class)->define($privacyOfficer, 'program-updates', 'sms', 'communication', 'comm-p-1');
        $this->purposeId = $purpose['purpose_id'];

        $consent = app(RecordConsent::class)->record($privacyOfficer, $this->subjectId, $this->purposeId, 'consent/form-42', new CarbonImmutable('2026-08-01'), null, 'comm-c-1');
        app(TransitionConsent::class)->submit($privacyOfficer, Consent::query()->findOrFail($consent['consent_id']), 'comm-c-2');
        app(TransitionConsent::class)->verify($privacyOfficer, Consent::query()->findOrFail($consent['consent_id']), 'comm-c-3');
        app(TransitionConsent::class)->activate($privacyOfficer, Consent::query()->findOrFail($consent['consent_id']), 'comm-c-4');
    }

    public function test_message_requires_channel_match_and_active_consent(): void
    {
        $sender = $this->grantedActor('comm-sender', ['communication.send']);

        try {
            app(SendMessage::class)->queue($sender, $this->subjectId, $this->purposeId, 'email', 'templates/nov-update', 'comm-m-1');
            $this->fail('channel mismatch must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('communication.channel_mismatch', $rejection->errorCode());
        }

        $this->personWithAuthority('comm-subject-2', []);
        try {
            app(SendMessage::class)->queue($sender, 'comm-subject-2', $this->purposeId, 'sms', 'templates/nov-update', 'comm-m-2');
            $this->fail('a subject without active consent cannot be messaged');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('communication.consent_missing', $rejection->errorCode());
        }

        $message = app(SendMessage::class)->queue($sender, $this->subjectId, $this->purposeId, 'sms', 'templates/nov-update', 'comm-m-3');
        $this->assertDatabaseHas('messages', ['id' => $message['message_id'], 'lifecycle_state' => 'queued']);

        app(SendMessage::class)->markDelivered($sender, Message::query()->findOrFail($message['message_id']), 'provider/sms-77341', 'comm-m-4');
        $this->assertDatabaseHas('messages', ['id' => $message['message_id'], 'lifecycle_state' => 'sent', 'delivery_ref' => 'provider/sms-77341']);

        $this->expectException(QueryException::class);
        DB::statement("UPDATE messages SET lifecycle_state = 'queued' WHERE id = ?", [$message['message_id']]);
    }

    public function test_revocation_blocks_future_messages_without_erasing_history(): void
    {
        $sender = $this->grantedActor('comm-sender', ['communication.send']);
        $privacyOfficer = $this->privacyOfficer('comm-privacy');

        $queued = app(SendMessage::class)->queue($sender, $this->subjectId, $this->purposeId, 'sms', 'templates/dec-update', 'comm-m-5');
        app(SendMessage::class)->markDelivered($sender, Message::query()->findOrFail($queued['message_id']), 'provider/sms-77342', 'comm-m-6');

        /** @var Consent $consent */
        $consent = Consent::query()->where('subject_person_id', $this->subjectId)->where('purpose_id', $this->purposeId)->firstOrFail();
        app(TransitionConsent::class)->revoke($privacyOfficer, $consent, 'all', 'future', 'comm-c-5');

        try {
            app(SendMessage::class)->queue($sender, $this->subjectId, $this->purposeId, 'sms', 'templates/jan-update', 'comm-m-7');
            $this->fail('revocation must block future messages');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('communication.consent_missing', $rejection->errorCode());
        }

        $this->assertDatabaseHas('messages', ['id' => $queued['message_id'], 'lifecycle_state' => 'sent']);
        $this->assertSame(1, DB::table('messages')->where('subject_person_id', $this->subjectId)->count(), 'history retained');
    }
}
