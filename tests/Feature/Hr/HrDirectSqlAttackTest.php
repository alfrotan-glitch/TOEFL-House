<?php

declare(strict_types=1);

namespace Tests\Feature\Hr;

use App\Modules\Hr\Commands\MaintainContract;
use App\Modules\Hr\Commands\MaintainEmployment;
use App\Modules\Hr\Commands\MaintainLeave;
use App\Modules\Hr\Models\Contract;
use App\Modules\Hr\Models\Employment;
use App\Modules\Hr\Models\Leave;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

/**
 * Direct-SQL attack surface for the HR lifecycle guards. Every fixture
 * state is built through the legitimate domain commands; the attack is a
 * raw INSERT/UPDATE that bypasses the application. The schema — not the
 * application — must reject each lifecycle violation.
 */
final class HrDirectSqlAttackTest extends TestCase
{
    use BuildsActors;

    private string $employmentId;

    private string $personId = 'hratk-teacher-1';

    protected function setUp(): void
    {
        parent::setUp();
        $this->personWithAuthority($this->personId, []);

        $manager = $this->grantedActor('hratk-manager-1', ['hr.employ', 'hr.contract', 'hr.terminate', 'access.assign_position']);
        $employment = app(MaintainEmployment::class)->employ($manager, $this->personId, 'hratk-emp-1');
        $this->employmentId = $employment['employment_id'];

        $contract = app(MaintainContract::class)->draft($manager, Employment::query()->findOrFail($this->employmentId), 'full-time EFL instructor, 40h/week', '2026-09-01', 'hratk-con-1');
        app(MaintainContract::class)->sign($manager, Contract::query()->findOrFail($contract['contract_id']), 'signed/hratk-con-1.pdf', 'hratk-con-2');

        app(MaintainEmployment::class)->hire($manager, Employment::query()->findOrFail($this->employmentId), '2026-09-01', 'hratk-emp-2');
    }

    public function test_direct_sql_cannot_resurrect_a_terminated_employment(): void
    {
        $manager = $this->grantedActor('hratk-manager-1', ['hr.employ', 'hr.terminate', 'access.assign_position']);
        app(MaintainEmployment::class)->terminate($manager, Employment::query()->findOrFail($this->employmentId), '2026-10-01', 'contract ended', 'hratk-emp-3');
        $this->assertSame('terminated', Employment::query()->findOrFail($this->employmentId)->lifecycle_state);

        $this->expectException(QueryException::class);
        DB::table('employments')->where('id', $this->employmentId)->update(['lifecycle_state' => 'active', 'updated_at' => now()]);
    }

    public function test_direct_sql_cannot_skip_lifecycle_steps(): void
    {
        // A brand-new (candidate) employment may not jump to on_leave:
        // the state machine requires candidate -> active first.
        $manager = $this->grantedActor('hratk-manager-1', ['hr.employ', 'hr.terminate', 'access.assign_position']);
        $this->personWithAuthority('hratk-teacher-2', []);
        $fresh = app(MaintainEmployment::class)->employ($manager, 'hratk-teacher-2', 'hratk-emp-4');

        $this->expectException(QueryException::class);
        DB::table('employments')->where('id', $fresh['employment_id'])->update(['lifecycle_state' => 'on_leave', 'updated_at' => now()]);
    }

    public function test_direct_sql_cannot_rebind_an_employment_to_another_person(): void
    {
        $this->personWithAuthority('hratk-teacher-3', []);

        $this->expectException(QueryException::class);
        DB::table('employments')->where('id', $this->employmentId)->update(['person_id' => 'hratk-teacher-3', 'updated_at' => now()]);
    }

    public function test_direct_sql_cannot_open_a_second_concurrent_employment(): void
    {
        $this->expectException(QueryException::class);
        DB::table('employments')->insert([
            'id' => 'bbbbbbbb-cccc-4ddd-8eee-fffffffff002',
            'person_id' => $this->personId,
            'lifecycle_state' => 'candidate',
            'created_at' => now(), 'updated_at' => now(),
        ]);
    }

    public function test_direct_sql_cannot_self_approve_a_leave(): void
    {
        $requester = $this->grantedActor('hratk-req-1', ['hr.leave_request']);
        $leave = app(MaintainLeave::class)->request($requester, Employment::query()->findOrFail($this->employmentId), 'sick', '2026-09-05', '2026-09-07', 'illness', 'hratk-lev-1');
        $leaveId = $leave['leave_id'];

        // The requester cannot become the decider — even from raw SQL.
        $this->expectException(QueryException::class);
        DB::table('leaves')->where('id', $leaveId)->update([
            'lifecycle_state' => 'approved', 'decided_by' => 'hratk-req-1', 'updated_at' => now(),
        ]);
    }

    public function test_direct_sql_cannot_approve_a_leave_without_a_decider(): void
    {
        $requester = $this->grantedActor('hratk-req-2', ['hr.leave_request']);
        $leave = app(MaintainLeave::class)->request($requester, Employment::query()->findOrFail($this->employmentId), 'sick', '2026-09-05', '2026-09-07', 'illness', 'hratk-lev-2');
        $leaveId = $leave['leave_id'];

        $this->expectException(QueryException::class);
        DB::table('leaves')->where('id', $leaveId)->update(['lifecycle_state' => 'approved', 'updated_at' => now()]);
    }

    public function test_direct_sql_cannot_overlap_approved_leaves(): void
    {
        $requester = $this->grantedActor('hratk-req-3', ['hr.leave_request']);
        $decider = $this->grantedActor('hratk-dec-1', ['hr.leave_approve']);

        $first = app(MaintainLeave::class)->request($requester, Employment::query()->findOrFail($this->employmentId), 'sick', '2026-09-05', '2026-09-09', 'illness', 'hratk-lev-3');
        app(MaintainLeave::class)->decide($decider, Leave::query()->findOrFail($first['leave_id']), true, 'hratk-lev-4');

        $second = app(MaintainLeave::class)->request($requester, Employment::query()->findOrFail($this->employmentId), 'personal', '2026-09-08', '2026-09-12', 'family matter', 'hratk-lev-5');

        // Raw approval of the overlapping second leave must fail.
        $this->expectException(QueryException::class);
        DB::table('leaves')->where('id', $second['leave_id'])->update([
            'lifecycle_state' => 'approved', 'decided_by' => 'hratk-dec-1', 'updated_at' => now(),
        ]);
    }

    public function test_direct_sql_cannot_rewrite_or_revive_a_decided_leave(): void
    {
        $requester = $this->grantedActor('hratk-req-4', ['hr.leave_request']);
        $decider = $this->grantedActor('hratk-dec-2', ['hr.leave_approve']);

        $leave = app(MaintainLeave::class)->request($requester, Employment::query()->findOrFail($this->employmentId), 'sick', '2026-09-05', '2026-09-07', 'illness', 'hratk-lev-6');
        app(MaintainLeave::class)->decide($decider, Leave::query()->findOrFail($leave['leave_id']), false, 'hratk-lev-7');

        // A rejected leave is final: revival into approved must fail.
        $this->expectException(QueryException::class);
        DB::table('leaves')->where('id', $leave['leave_id'])->update([
            'lifecycle_state' => 'approved', 'decided_by' => 'hratk-dec-2', 'updated_at' => now(),
        ]);
    }
}
