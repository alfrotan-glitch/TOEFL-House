<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Modules\Academic\Models\ClassSession;
use App\Modules\Admissions\Models\Applicant;
use App\Modules\Hr\Models\Employment;
use App\Modules\Payroll\Models\PayrollCalculation;
use App\Modules\Students\Models\Student;
use Carbon\CarbonImmutable;
use Illuminate\View\View;

/**
 * Console home: a navigation aid with live operational counts read directly
 * from the authoritative models. These are directory figures, not reported
 * metrics — reported financial/academic metrics remain owned by the
 * reporting module's deterministic calculators.
 */
final class HomeController extends Controller
{
    public function index(): View
    {
        $today = CarbonImmutable::today();
        $weekEnd = $today->addDays(7);

        return view('home', [
            'activeStudents' => Student::query()->whereExists(function ($query): void {
                $query->selectRaw('1')
                    ->from('student_statuses as ss')
                    ->whereColumn('ss.student_id', 'students.id')
                    ->where('ss.status', 'active')
                    ->whereNotExists(function ($inner): void {
                        $inner->selectRaw('1')
                            ->from('student_statuses as ss2')
                            ->whereColumn('ss2.student_id', 'students.id')
                            ->where(function ($current) {
                                $current->whereColumn('ss2.effective_from', '>', 'ss.effective_from')
                                    ->orWhere(function ($sameDay) {
                                        $sameDay->whereColumn('ss2.effective_from', '=', 'ss.effective_from')
                                            ->whereColumn('ss2.id', '>', 'ss.id');
                                    });
                            });
                    });
            })->count(),
            'pendingApplicants' => Applicant::query()
                ->whereIn('lifecycle_state', ['prospect', 'applicant'])
                ->count(),
            'activeTeachers' => Employment::query()->where('lifecycle_state', 'active')->count(),
            'sessionsThisWeek' => ClassSession::query()
                ->whereBetween('scheduled_on', [$today, $weekEnd])
                ->count(),
            'heldCalculations' => PayrollCalculation::query()->where('lifecycle_state', 'held')->count(),
            'today' => $today->toDateString(),
        ]);
    }
}
