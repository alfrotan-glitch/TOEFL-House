<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Modules\Audit\Models\AuditEvent;
use Illuminate\Http\Request;
use Illuminate\View\View;

/**
 * Audit &amp; Governance console: the immutable audit trail. Read-only —
 * events are append-only and cannot be filtered into a different truth,
 * only viewed.
 */
final class AuditController extends Controller
{
    public function index(Request $request): View
    {
        $operation = trim((string) $request->query('operation', ''));
        $actorId = trim((string) $request->query('actor_id', ''));
        $targetType = trim((string) $request->query('target_type', ''));

        $query = AuditEvent::query()->orderByDesc('occurred_at');
        if ($operation !== '') {
            $query->where('operation', $operation);
        }
        if ($actorId !== '') {
            $query->where('actor_id', $actorId);
        }
        if ($targetType !== '') {
            $query->where('target_type', $targetType);
        }

        return view('audit.index', [
            'events' => $query->limit(300)->get(),
            'operation' => $operation,
            'actorId' => $actorId,
            'targetType' => $targetType,
            'operations' => AuditEvent::query()->orderBy('operation')->distinct()->limit(200)->pluck('operation')->all(),
        ]);
    }
}
