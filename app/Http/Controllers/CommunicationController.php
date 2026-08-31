<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Modules\Communication\Commands\SendMessage;
use App\Modules\Communication\Models\Message;
use App\Modules\Identity\Models\Person;
use App\Modules\Privacy\Models\ConsentPurpose;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\View\View;

/**
 * Communication console: outbound messages are queued post-commit only
 * under an active consent for the subject and purpose, on the purpose's
 * own channel. Delivery results (sent/failed with the provider reference)
 * close the message; history is retained. All rules remain owned by the
 * communication module command; this controller only validates transport
 * input and delegates.
 */
final class CommunicationController extends Controller
{
    public function index(): View
    {
        return view('communication.index', [
            'purposes' => ConsentPurpose::query()->orderBy('name')->limit(200)->get(),
            'people' => Person::query()->where('verification_state', 'verified')->orderBy('legal_name')->limit(300)->get(),
            'messages' => Message::query()->orderByDesc('id')->limit(200)->get(),
        ]);
    }

    public function queueMessage(Request $request): RedirectResponse
    {
        $input = $request->validate([
            'subject_person_id' => ['required', 'string'],
            'purpose_id' => ['required', 'string'],
            'channel' => ['required', 'string', 'max:64'],
            'content_ref' => ['required', 'string', 'max:255'],
        ]);

        app(SendMessage::class)->queue(
            $this->actor(),
            $input['subject_person_id'],
            $input['purpose_id'],
            $input['channel'],
            $input['content_ref'],
            $this->idempotencyKey('communication.message.queue'),
        );

        return redirect()->route('communication.index')->with('success', 'Message queued under active consent.');
    }

    public function markDelivered(Request $request, string $messageId): RedirectResponse
    {
        $input = $request->validate([
            'delivery_ref' => ['required', 'string', 'max:255'],
        ]);

        app(SendMessage::class)->markDelivered(
            $this->actor(),
            Message::query()->findOrFail($messageId),
            $input['delivery_ref'],
            $this->idempotencyKey('communication.message.delivered'),
        );

        return redirect()->route('communication.index')->with('success', 'Delivery recorded; message retained.');
    }

    public function markFailed(Request $request, string $messageId): RedirectResponse
    {
        $input = $request->validate([
            'delivery_ref' => ['required', 'string', 'max:255'],
        ]);

        app(SendMessage::class)->markFailed(
            $this->actor(),
            Message::query()->findOrFail($messageId),
            $input['delivery_ref'],
            $this->idempotencyKey('communication.message.failed'),
        );

        return redirect()->route('communication.index')->with('success', 'Delivery failure recorded with its provider reference.');
    }
}
