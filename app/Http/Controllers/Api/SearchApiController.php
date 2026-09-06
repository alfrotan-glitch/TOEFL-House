<?php

declare(strict_types=1);

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Modules\Workspace\Queries\SearchQuery;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/** Branch-scoped search transport; it cannot search an unscoped directory. */
final class SearchApiController extends Controller
{
    public function __construct(private readonly SearchQuery $searchQuery) {}

    public function search(Request $request): JsonResponse
    {
        $term = trim((string) $request->query('q', $request->query('term', '')));
        $limit = (int) $request->query('limit', 25);

        return response()->json([
            'data' => $this->searchQuery->search($this->actor(), $term, $limit),
        ]);
    }
}
