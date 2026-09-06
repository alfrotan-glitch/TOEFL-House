<?php

declare(strict_types=1);

namespace Tests\Feature\Console;

use App\Modules\Communication\Commands\SendMessage;
use App\Modules\Communication\Models\Message;
use App\Modules\Identity\Models\Person;
use App\Modules\Identity\Models\UserAccount;
use App\Modules\Privacy\Commands\DefineConsentPurpose;
use App\Modules\Privacy\Commands\RecordConsent;
use App\Modules\Privacy\Commands\TransitionConsent;
use App\Modules\Privacy\Models\Consent;
use App\Support\Authorization\Actor;
use App\Support\Errors\BusinessRejection;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

/**
 * PHASE_3 increment E (part five): the communication console — outbound
 * messages queue post-commit only under an ACTIVE consent for the subject
 * and purpose, on the purpose's own channel. Delivery results (sent/failed
 * with the provider reference) close the message; revocation blocks future
 * queueing without erasing history.
 */
final class CommunicationWorkflowFeatureTest extends TestCase
{
    use BuildsActors;

    private const SUBJECT = 'com-subject-1';

    private string $purposeId;

    protected function setUp(): void
    {
        parent::setUp();

        $this->personWithAuthority(self::SUBJECT, []);
        $this->personWithAuthority('com-subject-2', []);

        $this->personWithAuthority('com-definer', ['privacy.define_purpose']);
        $defined = app(DefineConsentPurpose::class)->define(
            new Actor('com-definer', 'Definer'),
            'Progress update', 'email', 'communication', 'com-purpose-1',
        );
        $this->purposeId = $defined['purpose_id'];
    }

    /** @return array{0: Person, 1: UserAccount} */
    private function makeEmployee(string $personId, array $capabilities, string $username): array
    {
        $person = $this->personWithAuthority($personId, $capabilities);
        $account = UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $person->id,
            'username' => $username,
            'password_hash' => Hash::make('com-password-1'),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);

        return [$person, $account];
    }

    private function signIn(string $username): void
    {
        $this->post('/login', ['username' => $username, 'password' => 'com-password-1'])->assertRedirect('/');
        $this->assertAuthenticated();
    }

    private function signOut(): void
    {
        $this->post('/logout')->assertRedirect('/login');
        $this->assertGuest();
    }

    private function activateConsentFor(string $subjectId): void
    {
        $recorder = $this->personWithAuthority('com-recorder', ['privacy.consent']);
        $actor = new Actor('com-recorder', 'Recorder');
        $recorded = app(RecordConsent::class)->record(
            $actor, $subjectId, $this->purposeId, 'evidence/com-consent',
            CarbonImmutable::parse('2026-08-01'), null, 'com-consent-'.$subjectId,
        );
        /** @var Consent $consent */
        $consent = Consent::query()->findOrFail($recorded['consent_id']);
        $transitions = app(TransitionConsent::class);
        $transitions->submit($actor, $consent, 'com-submit-'.$subjectId);
        $transitions->verify($actor, $consent, 'com-verify-'.$subjectId);
        $transitions->activate($actor, $consent, 'com-activate-'.$subjectId);
    }

    public function test_messages_queue_under_active_consent_and_deliver_over_the_console(): void
    {
        $this->activateConsentFor(self::SUBJECT);
        $this->makeEmployee('com-sender-1', ['communication.send'], 'sender-1');

        $messages = DB::connection()->getTablePrefix().'messages';

        $this->signIn('sender-1');

        // A message queues under the active consent, on the purpose's channel.
        $this->post('/communication/messages', [
            'subject_person_id' => self::SUBJECT,
            'purpose_id' => $this->purposeId,
            'channel' => 'email',
            'content_ref' => 'template/progress-update-1',
        ])->assertRedirect('/communication');
        $messageId = DB::table($messages)->value('id');
        $this->assertDatabaseHas($messages, ['id' => $messageId, 'lifecycle_state' => 'queued', 'channel' => 'email']);

        // The purpose's own channel is enforced; so are the purpose and
        // the active consent.
        $this->post('/communication/messages', [
            'subject_person_id' => self::SUBJECT,
            'purpose_id' => $this->purposeId,
            'channel' => 'sms',
            'content_ref' => 'template/progress-update-2',
        ], ['referer' => 'http://localhost/communication'])
            ->assertRedirect('/communication')
            ->assertSessionHas('error_code', 'communication.channel_mismatch');

        $this->post('/communication/messages', [
            'subject_person_id' => 'com-subject-2',
            'purpose_id' => $this->purposeId,
            'channel' => 'email',
            'content_ref' => 'template/progress-update-3',
        ], ['referer' => 'http://localhost/communication'])
            ->assertRedirect('/communication')
            ->assertSessionHas('error_code', 'communication.consent_missing');

        $this->post('/communication/messages', [
            'subject_person_id' => self::SUBJECT,
            'purpose_id' => RandomIdentifier::new(),
            'channel' => 'email',
            'content_ref' => 'template/progress-update-4',
        ], ['referer' => 'http://localhost/communication'])
            ->assertRedirect('/communication')
            ->assertSessionHas('error_code', 'communication.purpose_unknown');
        $this->assertSame(1, DB::table($messages)->count(), 'the refused probes created no messages');

        // Delivery requires the provider's reference (transport validation).
        $this->post('/communication/messages/'.$messageId.'/delivered', [], ['referer' => 'http://localhost/communication'])
            ->assertRedirect('/communication')
            ->assertSessionHasErrors('delivery_ref');

        $this->post('/communication/messages/'.$messageId.'/delivered', [
            'delivery_ref' => 'provider/MSG-1001',
        ])->assertRedirect('/communication');
        $this->assertDatabaseHas($messages, ['id' => $messageId, 'lifecycle_state' => 'sent', 'delivery_ref' => 'provider/MSG-1001']);

        // A delivered message is retained history — no further transition.
        $this->post('/communication/messages/'.$messageId.'/failed', [
            'delivery_ref' => 'provider/MSG-1001-X',
        ], ['referer' => 'http://localhost/communication'])
            ->assertRedirect('/communication')
            ->assertSessionHas('error_code', 'communication.message_transition_forbidden');

        // A second message can fail with its provider reference.
        $this->post('/communication/messages', [
            'subject_person_id' => self::SUBJECT,
            'purpose_id' => $this->purposeId,
            'channel' => 'email',
            'content_ref' => 'template/progress-update-5',
        ])->assertRedirect('/communication');
        $secondId = DB::table($messages)->where('content_ref', 'template/progress-update-5')->value('id');
        $this->post('/communication/messages/'.$secondId.'/failed', [
            'delivery_ref' => 'provider/BOUNCE-2002',
        ])->assertRedirect('/communication');
        $this->assertDatabaseHas($messages, ['id' => $secondId, 'lifecycle_state' => 'failed', 'delivery_ref' => 'provider/BOUNCE-2002']);
        $this->post('/communication/messages/'.$secondId.'/delivered', [
            'delivery_ref' => 'provider/MSG-2002',
        ], ['referer' => 'http://localhost/communication'])
            ->assertRedirect('/communication')
            ->assertSessionHas('error_code', 'communication.message_transition_forbidden');

        // Revocation blocks FUTURE queueing without erasing history.
        $recorder = $this->personWithAuthority('com-recorder', ['privacy.consent']);
        $actor = new Actor('com-recorder', 'Recorder');
        /** @var Consent $consent */
        $consent = Consent::query()->where('subject_person_id', self::SUBJECT)->firstOrFail();
        app(TransitionConsent::class)->revoke($actor, $consent, 'all-channels', 'immediate-cessation', 'com-revoke-1');

        $this->post('/communication/messages', [
            'subject_person_id' => self::SUBJECT,
            'purpose_id' => $this->purposeId,
            'channel' => 'email',
            'content_ref' => 'template/progress-update-6',
        ], ['referer' => 'http://localhost/communication'])
            ->assertRedirect('/communication')
            ->assertSessionHas('error_code', 'communication.consent_missing');
        $this->assertSame(2, DB::table($messages)->count(), 'revocation erases no message history');
    }

    public function test_unprivileged_communication_is_denied_and_audited(): void
    {
        $this->activateConsentFor(self::SUBJECT);
        $sender = $this->grantedActor('com-sender-2', ['communication.send']);
        $nobody = $this->makeEmployee('com-nobody-1', [], 'nobody-1');

        $created = app(SendMessage::class)->queue(
            $sender, self::SUBJECT, $this->purposeId, 'email', 'template/audit-probe', 'com-audit-1',
        );

        // The domain's content backstop (the transport's required rule is
        // the first line; a truly empty reference is refused here too).
        try {
            app(SendMessage::class)->queue(
                $sender, self::SUBJECT, $this->purposeId, 'email', '', 'com-blank-2',
            );
            $this->fail('a blank content reference must be refused');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('communication.content', $rejection->errorCode());
        }

        $this->signIn('nobody-1');

        $this->post('/communication/messages', [
            'subject_person_id' => self::SUBJECT,
            'purpose_id' => $this->purposeId,
            'channel' => 'email',
            'content_ref' => 'template/illicit-1',
        ], ['referer' => 'http://localhost/communication'])
            ->assertRedirect('/communication')
            ->assertSessionHas('error_code', 'communication.denied');
        $this->assertDatabaseHas('audit_events', ['operation' => 'communication.message.queue.denied', 'actor_id' => 'com-nobody-1']);

        $this->post('/communication/messages/'.$created['message_id'].'/delivered', [
            'delivery_ref' => 'provider/illicit-delivery',
        ], ['referer' => 'http://localhost/communication'])
            ->assertRedirect('/communication')
            ->assertSessionHas('error_code', 'communication.denied');
        $this->assertDatabaseHas('audit_events', ['operation' => 'communication.message.deliver.denied', 'actor_id' => 'com-nobody-1']);

        $this->assertSame(1, DB::table(DB::connection()->getTablePrefix().'messages')->count(), 'no rows created by the denied probes');
        $this->assertDatabaseHas(DB::connection()->getTablePrefix().'messages', ['id' => $created['message_id'], 'lifecycle_state' => 'queued']);
    }
}
