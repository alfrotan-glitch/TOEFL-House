<?php

declare(strict_types=1);

namespace App\Modules\Workspace\Queries;

use App\Modules\Crm\Models\Visitor;
use App\Modules\Organization\Models\Branch;
use App\Modules\Students\Models\Student;
use App\Support\Authorization\AccessDecision;
use App\Support\Authorization\Actor;
use App\Support\Authorization\ActorBranches;

/**
 * Branch-safe cross-module search. Search is a read projection, not a new
 * directory authority: every source remains owned by its module and every
 * result carries its source and provenance. Source-specific capabilities are
 * evaluated for each concrete branch; generic branch visibility alone never
 * authorizes disclosure of either directory.
 */
final class SearchQuery
{
    /** @return array{term: string, results: list<array<string, mixed>>, scope: array<string, mixed>} */
    public function search(Actor $actor, string $term, int $limit = 25): array
    {
        $term = trim($term);
        $visible = app(ActorBranches::class)->visibleBranchIds($actor);
        $studentBranches = $this->authorizedBranches($actor, $visible, 'students.manage');
        $visitorBranches = $this->authorizedBranches($actor, $visible, 'crm.visitor');
        $branchIds = array_values(array_unique(array_merge($studentBranches, $visitorBranches), SORT_STRING));
        sort($branchIds);
        $limit = max(1, min($limit, 50));

        if (mb_strlen($term) < 2 || $branchIds === []) {
            return [
                'term' => $term,
                'results' => [],
                'scope' => ['branch_ids' => $branchIds, 'scope_known' => $branchIds !== []],
            ];
        }

        $needle = '%'.addcslashes($term, '%_\\').'%';
        $results = [];

        if ($studentBranches !== []) {
            foreach (Student::query()
                ->with('person:id,legal_name')
                ->where(function ($scope) use ($studentBranches): void {
                    $scope->whereIn('current_home_branch_id', $studentBranches)
                        ->orWhere(function ($origin) use ($studentBranches): void {
                            $origin->whereNull('current_home_branch_id')->whereIn('originating_branch_id', $studentBranches);
                        });
                })
                ->where(function ($query) use ($needle): void {
                    $query->where('student_code', 'like', $needle)
                        ->orWhereHas('person', fn ($person) => $person->where('legal_name', 'like', $needle));
                })
                ->orderBy('student_code')
                ->limit($limit)
                ->get(['id', 'person_id', 'student_code', 'current_home_branch_id', 'originating_branch_id']) as $student) {
                $results[] = [
                    'type' => 'student',
                    'id' => (string) $student->id,
                    'label' => (string) ($student->person?->legal_name ?? $student->student_code),
                    'secondary' => (string) $student->student_code,
                    'provenance_branch_id' => (string) ($student->current_home_branch_id ?? $student->originating_branch_id),
                    'route' => '/students/'.(string) $student->id,
                ];
            }
        }

        if ($visitorBranches !== []) {
            foreach (Visitor::query()
                ->whereIn('origin_branch_id', $visitorBranches)
                ->where(function ($query) use ($needle): void {
                    $query->where('visitor_code', 'like', $needle)
                        ->orWhere('full_name', 'like', $needle)
                        ->orWhere('email', 'like', $needle)
                        ->orWhere('phone', 'like', $needle);
                })
                ->orderByDesc('created_at')
                ->limit($limit)
                ->get(['id', 'visitor_code', 'full_name', 'email', 'phone', 'origin_branch_id', 'status']) as $visitor) {
                $results[] = [
                    'type' => 'visitor',
                    'id' => (string) $visitor->id,
                    'label' => (string) $visitor->full_name,
                    'secondary' => (string) $visitor->visitor_code,
                    'provenance_branch_id' => (string) $visitor->origin_branch_id,
                    'status' => (string) $visitor->status,
                    'route' => '/crm',
                ];
            }
        }

        return [
            'term' => $term,
            'results' => array_slice($results, 0, $limit),
            'scope' => ['branch_ids' => $branchIds, 'scope_known' => true],
        ];
    }

    /** @param list<string> $candidateBranchIds @return list<string> */
    private function authorizedBranches(Actor $actor, array $candidateBranchIds, string $capability): array
    {
        $decision = app(AccessDecision::class);
        $authorized = [];
        foreach (Branch::query()->whereIn('id', $candidateBranchIds)->get() as $branch) {
            if ($decision->decide($actor, $capability, $branch->structureScope())->allowed) {
                $authorized[] = (string) $branch->id;
            }
        }

        sort($authorized);

        return $authorized;
    }
}
