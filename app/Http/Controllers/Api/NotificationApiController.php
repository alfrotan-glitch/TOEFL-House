<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Modules\Communication\Commands\MaintainNotification;
use App\Modules\Communication\Models\Notification;
use App\Modules\Communication\Queries\NotificationQuery;
use Illuminate\Http\JsonResponse;

/** Recipient-scoped notification read-state transport. */
final class NotificationApiController extends Controller
{
    public function __construct(
        private readonly NotificationQuery $notifications,
        private readonly MaintainNotification $maintain,
    ) {}

    public function index(): JsonResponse
    {
        return response()->json(['data' => $this->notifications->forActor($this->actor())]);
    }

    public function read(string $notificationId): JsonResponse
    {
        return $this->transition($notificationId, 'read');
    }

    public function dismiss(string $notificationId): JsonResponse
    {
        return $this->transition($notificationId, 'dismissed');
    }

    private function transition(string $notificationId, string $toState): JsonResponse
    {
        $notification = Notification::query()->whereKey($notificationId)->firstOrFail();
        $result = $this->maintain->transition($this->actor(), $notification, $toState, $this->idempotencyKey('communication.notification.'.$toState));

        return response()->json(['data' => $result]);
    }
}
