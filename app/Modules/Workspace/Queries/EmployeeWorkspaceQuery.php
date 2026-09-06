<?php

declare(strict_types=1);

namespace App\Modules\Workspace\Queries;

use App\Modules\Access\Models\Position;
use App\Modules\Access\Models\PositionAssignment;
use App\Modules\Academic\Models\AcademicAppeal;
use App\Modules\Admissions\Models\AdmissionDecision;
use App\Modules\Communication\Queries\NotificationQuery;
use App\Modules\Crm\Models\VisitorFollowup;
use App\Modules\Hr\Domain\EmploymentLifecycle;
use App\Modules\Hr\Models\Employment;
use App\Modules\Organization\Models\Branch;
use App\Modules\Organization\Models\Organization;
use App\Modules\Payroll\Models\PayrollCalculation;
use App\Support\Authorization\AccessDecision;
use App\Modules\WorkManagement\Queries\WorkItemQuery;
use App\Support\Authorization\Actor;
use App\Support\Authorization\ActorBranches;
use App\Support\Authorization\StructureScope;
use Carbon\CarbonImmutable;

/**
 * Rebuildable employee workspace composition.
 *
 * The query deliberately composes only canonical records. A workspace item
 * carries a source type/id and a command route; it never becomes a task,
 * approval, permission, balance, or lifecycle authority. Every source query
 * is actor-scoped or branch-scoped before it is projected.
 */
final class EmployeeWorkspaceQuery
{
    /** @return array<string, mixed> */
    public function snapshot(Actor $actor): array
    {
        $today = CarbonImmutable::today()->toDateString();
        $eligible = $this->employmentEligible($actor->actorId);
        $branches = $eligible ? app(ActorBranches::class)->visibleBranchIds($actor) : [];
        $organizationIds = $eligible ? $this->authorizedOrganizations($actor) : [];
        $followupBranches = $this->authorizedBranches($actor, $branches, 'crm.followup');
        $followupOrganizationScope = $eligible && app(AccessDecision::class)->decide($actor, 'crm.followup', null)->allowed;
        $admissionReviewBranches = $this->authorizedBranches($actor, $branches, 'admissions.review');
        $admissionApproveBranches = $this->authorizedBranches($actor, $branches, 'admissions.approve');
        $appealBranches = $this->authorizedBranches($actor, $branches, 'academic.appeal_manage');
        $payrollBranches = $this->authorizedBranches($actor, $branches, 'payroll.calculate');

        $assignments = $eligible ? PositionAssignment::query()
            ->where('person_id', $actor->actorId)
            ->where('lifecycle_state', 'active')
            ->where('effective_from', '<=', $today)
            ->where(fn ($query) => $query->whereNull('effective_to')->orWhere('effective_to', '>', $today))
            ->orderBy('effective_from')
            ->get(['id', 'position_id', 'effective_from', 'effective_to']) : collect();
        $positions = Position::query()
            ->whereIn('id', $assignments->pluck('position_id')->filter()->values()->all())
            ->get(['id', 'name'])
            ->keyBy('id');

        $employmentIds = $eligible ? Employment::query()
            ->where('person_id', $actor->actorId)
            ->where('lifecycle_state', 'active')
            ->pluck('id')
            ->values()
            ->all() : [];

        $items = [];
        foreach ($this->assignedFollowups($actor, $followupBranches, $followupOrganizationScope) as $followup) {
            $items[] = [
                'kind' => 'follow_up',
                'source_type' => 'visitor_followup',
                'source_id' => (string) $followup->id,
                'title' => (string) $followup->title,
                'status' => (string) $followup->status,
                'due_at' => (string) $followup->scheduled_for,
                'route' => '/crm',
            ];
        }

        foreach ($this->assignedAdmissionReviews($actor, $admissionReviewBranches, $admissionApproveBranches) as $decision) {
            $items[] = [
                'kind' => 'admission_review',
                'source_type' => 'admission_decision',
                'source_id' => (string) $decision->id,
                'title' => 'Admission decision requires review',
                'status' => (string) $decision->lifecycle_state,
                'due_at' => null,
                'route' => '/students/applicants',
            ];
        }

        if ($employmentIds !== [] && $payrollBranches !== []) {
            foreach (PayrollCalculation::query()
                ->whereIn('employment_id', $employmentIds)
                ->where('lifecycle_state', 'held')
                ->orderBy('created_at')
                ->limit(50)
                ->get(['id', 'period_id', 'employment_id', 'held_reason', 'lifecycle_state']) as $calculation) {
                $items[] = [
                    'kind' => 'payroll_exception',
                    'source_type' => 'payroll_calculation',
                    'source_id' => (string) $calculation->id,
                    'title' => 'Payroll calculation is held',
                    'status' => (string) $calculation->lifecycle_state,
                    'due_at' => null,
                    'route' => '/payroll',
                    'reason' => $calculation->held_reason,
                ];
            }
        }

        if ($appealBranches !== []) {
            foreach (AcademicAppeal::query()
                ->where('assigned_reviewer_id', $actor->actorId)
                ->whereHas('student', function ($student) use ($appealBranches): void {
                    $student->whereIn('current_home_branch_id', $appealBranches)
                        ->orWhere(function ($fallback) use ($appealBranches): void {
                            $fallback->whereNull('current_home_branch_id')->whereIn('originating_branch_id', $appealBranches);
                        });
                })
                ->whereNotIn('lifecycle_state', ['resolved', 'closed', 'rejected'])
                ->orderBy('created_at')
            ->limit(50)
            ->get(['id', 'student_id', 'subject_type', 'subject_id', 'lifecycle_state']) as $appeal) {
            $items[] = [
                'kind' => 'academic_appeal',
                'source_type' => 'academic_appeal',
                'source_id' => (string) $appeal->id,
                'title' => 'Academic appeal requires review',
                'status' => (string) $appeal->lifecycle_state,
                'due_at' => null,
                'route' => '/academic',
            ];
            }
        }

        $projectedItems = $eligible ? app(WorkItemQuery::class)->forActor($actor) : [];
        if ($projectedItems !== []) {
            // Canonical-source fallback rows keep the workspace useful while
            // the relay is unavailable or a projection is stale. Once the
            // corresponding Work Management item is present, prefer that
            // coordination representation so one source fact is not shown
            // as two actionable cards.
            $projectedKeys = [];
            foreach ($projectedItems as $projectedItem) {
                $projectedKeys[(string) $projectedItem['source_type'].'|'.(string) $projectedItem['source_id']] = true;
            }
            $items = array_values(array_filter($items, static function (array $item) use ($projectedKeys): bool {
                $key = (string) ($item['source_type'] ?? '').'|'.(string) ($item['source_id'] ?? '');

                return ! isset($projectedKeys[$key]);
            }));
            $items = array_merge($items, $projectedItems);
        }

        usort($items, static function (array $left, array $right): int {
            return strcmp((string) ($left['due_at'] ?? '9999-12-31'), (string) ($right['due_at'] ?? '9999-12-31'));
        });
        $notifications = $eligible
            ? app(NotificationQuery::class)->forActor($actor)
            : ['status' => 'not_available', 'unread_count' => 0, 'items' => []];

        return [
            'actor' => ['id' => $actor->actorId, 'display_name' => $actor->displayName],
            'positions' => $assignments->map(fn ($assignment): array => [
                'id' => (string) $assignment->id,
                'position_id' => (string) $assignment->position_id,
                'position_name' => (string) ($positions->get($assignment->position_id)?->name ?? 'Unlabelled position'),
                'effective_from' => (string) $assignment->effective_from,
                'effective_to' => $assignment->effective_to,
            ])->values()->all(),
            'scope' => [
                'organization_ids' => $organizationIds,
                'branch_ids' => $branches,
                'scope_known' => $branches !== [] || $organizationIds !== [],
            ],
            'work' => [
                'items' => $items,
                'count' => count($items),
            ],
            'notifications' => $notifications,
            'generated_at' => CarbonImmutable::now()->toIso8601String(),
        ];
    }

    /** @return iterable<int, VisitorFollowup> */
    private function assignedFollowups(Actor $actor, array $branches, bool $organizationScope): iterable
    {
        if ($branches === [] && ! $organizationScope) {
            return [];
        }

        return VisitorFollowup::query()
            ->where('assigned_to', $actor->actorId)
            ->where('status', VisitorFollowup::STATUS_OPEN)
            ->whereHas('visitor', function ($query) use ($branches, $organizationScope): void {
                if ($branches !== []) {
                    $query->whereIn('origin_branch_id', $branches);
                }
                if ($organizationScope) {
                    $query->when($branches !== [], fn ($scoped) => $scoped->orWhereNull('origin_branch_id'))
                        ->when($branches === [], fn ($scoped) => $scoped->whereNull('origin_branch_id'));
                }
            })
            ->orderBy('scheduled_for')
            ->limit(50)
            ->get(['id', 'visitor_id', 'title', 'scheduled_for', 'status']);
    }

    /** @param list<string> $reviewBranches @param list<string> $approveBranches @return iterable<int, AdmissionDecision> */
    private function assignedAdmissionReviews(Actor $actor, array $reviewBranches, array $approveBranches): iterable
    {
        if ($reviewBranches === [] && $approveBranches === []) {
            return [];
        }

        return AdmissionDecision::query()
            ->where(function ($query) use ($actor, $reviewBranches, $approveBranches): void {
                if ($reviewBranches !== []) {
                    $query->where(function ($review) use ($actor, $reviewBranches): void {
                        $review->where('reviewer_id', $actor->actorId)
                            ->where('lifecycle_state', 'proposed')
                            ->whereHas('applicant', function ($applicant) use ($reviewBranches): void {
                                $applicant->whereIn('current_home_branch_id', $reviewBranches)
                                    ->orWhere(function ($fallback) use ($reviewBranches): void {
                                        $fallback->whereNull('current_home_branch_id')->whereIn('originating_branch_id', $reviewBranches);
                                    });
                            });
                    });
                }
                if ($approveBranches !== []) {
                    $approve = function ($approve) use ($actor, $approveBranches): void {
                        $approve->where('approver_id', $actor->actorId)
                            ->where('lifecycle_state', 'reviewed')
                            ->whereHas('applicant', function ($applicant) use ($approveBranches): void {
                            $applicant->whereIn('current_home_branch_id', $approveBranches)
                                ->orWhere(function ($fallback) use ($approveBranches): void {
                                    $fallback->whereNull('current_home_branch_id')->whereIn('originating_branch_id', $approveBranches);
                                });
                        });
                    };
                    if ($reviewBranches === []) {
                        $query->where($approve);
                    } else {
                        $query->orWhere($approve);
                    }
                }
            })
            ->orderBy('created_at')
            ->limit(50)
            ->get(['id', 'applicant_id', 'outcome', 'lifecycle_state']);
    }

    private function employmentEligible(string $personId): bool
    {
        $hasEmployment = Employment::query()->where('person_id', $personId)->exists();
        if (! $hasEmployment) {
            return true;
        }

        /** @var Employment|null $current */
        $current = Employment::query()
            ->where('person_id', $personId)
            ->orderByDesc('created_at')
            ->orderByDesc('id')
            ->first();

        return $current !== null && $current->lifecycle_state === EmploymentLifecycle::STATE_ACTIVE;
    }

    /** @return list<string> */
    private function authorizedOrganizations(Actor $actor): array
    {
        $decision = app(AccessDecision::class);
        $authorized = [];
        foreach (Organization::query()->where('lifecycle_state', 'active')->get(['id']) as $organization) {
            $scope = StructureScope::organization((string) $organization->id);
            if ($decision->decide($actor, 'workflow.work', $scope)->allowed
                || $decision->decide($actor, 'communication.notification.read', $scope)->allowed) {
                $authorized[] = (string) $organization->id;
            }
        }
        sort($authorized);

        return $authorized;
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
