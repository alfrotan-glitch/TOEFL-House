<?php

declare(strict_types=1);

namespace Tests\Feature\Students;

use App\Modules\Identity\Models\UserAccount;
use App\Modules\Organization\Models\Branch;
use App\Modules\Students\Models\Student;
use App\Support\Identifiers\RandomIdentifier;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Hash;
use Tests\Concerns\BuildsStudents;
use Tests\TestCase;

final class StudentLifecycleRoutesFeatureTest extends TestCase
{
    use BuildsStudents;

    private function signInAs(string $personId, string $username): void
    {
        UserAccount::query()->create([
            'id' => RandomIdentifier::new(),
            'person_id' => $personId,
            'username' => $username,
            'password_hash' => Hash::make('route-password-1'),
            'account_state' => UserAccount::STATE_ACTIVE,
        ]);
        $this->post('/login', ['username' => $username, 'password' => 'route-password-1'])->assertRedirect('/');
    }

    private function branch(string $suffix): Branch
    {
        /** @var Branch $branch */
        $branch = Branch::query()->create([
            'id' => RandomIdentifier::new(),
            'name' => 'Lifecycle Route Branch '.$suffix,
            'lifecycle_state' => 'active',
        ]);

        return $branch;
    }

    public function test_web_transfer_and_hold_routes_delegate_to_commands(): void
    {
        $student = $this->makeStudent()['student'];
        $branch = $this->branch('web-transfer');
        $personId = 'route-life-1';
        $this->personWithAuthority($personId, ['students.transfer', 'students.hold', 'students.communication']);
        $this->signInAs($personId, 'route.life');

        $this->post(route('students.transfer', $student->id), [
            'branch_id' => $branch->id,
            'reason' => 'initial assignment',
            'idempotency_key' => 'route-web-transfer-1',
        ])->assertRedirect(route('students.show', $student->id));

        /** @var Student $fresh */
        $fresh = Student::query()->findOrFail($student->id);
        $this->assertSame($branch->id, trim((string) $fresh->current_home_branch_id));

        $this->post(route('students.hold.freeze', $student->id), [
            'reason' => 'medical hold',
            'idempotency_key' => 'route-web-hold-1',
        ])->assertRedirect(route('students.show', $student->id));
        $this->post(route('students.hold.resume', $student->id), [
            'reason' => 'clearance',
            'idempotency_key' => 'route-web-hold-2',
        ])->assertRedirect(route('students.show', $student->id));

        $this->assertSame(2, DB::table('student_hold_events')->where('student_id', $student->id)->count());
    }

    public function test_web_communication_preference_supports_absent_checkbox_as_disabled(): void
    {
        $student = $this->makeStudent()['student'];
        $personId = 'route-comm-1';
        $this->personWithAuthority($personId, ['students.communication']);
        $this->signInAs($personId, 'route.comm');

        // An unchecked box does not submit enabled; the console treats absence as disabled.
        $this->post(route('students.communication', $student->id), [
            'channel' => 'email',
            'idempotency_key' => 'route-web-comm-1',
        ])->assertRedirect(route('students.show', $student->id));
        $this->assertDatabaseHas('student_communication_preferences', [
            'student_id' => $student->id,
            'channel' => 'email',
            'enabled' => false,
        ]);

        $this->post(route('students.communication', $student->id), [
            'channel' => 'email',
            'enabled' => '1',
            'idempotency_key' => 'route-web-comm-2',
        ])->assertRedirect(route('students.show', $student->id));

        $this->assertSame(1, DB::table('student_communication_preferences')->where('student_id', $student->id)->count());
        $this->assertDatabaseHas('student_communication_preferences', [
            'student_id' => $student->id,
            'channel' => 'email',
            'enabled' => true,
        ]);
    }

    public function test_api_lifecycle_show_transfer_and_authorization_rejection(): void
    {
        $student = $this->makeStudent()['student'];
        $branch = $this->branch('api-transfer');
        $personId = 'route-api-transfer-1';
        $this->personWithAuthority($personId, ['students.transfer']);
        $this->signInAs($personId, 'route.api.transfer');

        $this->postJson('/api/students/'.$student->id.'/transfer', [
            'branch_id' => $branch->id,
            'reason' => 'API transfer',
        ], ['Idempotency-Key' => 'api-transfer-key-1'])
            ->assertOk()
            ->assertJsonPath('status', 'transferred')
            ->assertJsonPath('to_branch_id', $branch->id);

        $this->getJson('/api/students/'.$student->id)
            ->assertOk()
            ->assertJsonPath('current_home_branch_id', $branch->id)
            ->assertJsonPath('branch_transfers.0.to_branch_id', $branch->id);

        $nobodyId = 'route-api-nobody-1';
        $this->personWithAuthority($nobodyId, []);
        $this->signInAs($nobodyId, 'route.api.nobody');

        $this->postJson('/api/students/'.$student->id.'/transfer', [
            'branch_id' => $branch->id,
            'reason' => 'denied',
        ], ['Idempotency-Key' => 'api-transfer-key-2'])
            ->assertForbidden()
            ->assertJsonPath('error', 'students.transfer_denied')
            ->assertJsonPath('category', 'authorization');
    }

    public function test_api_communication_and_hold_contract(): void
    {
        $student = $this->makeStudent()['student'];
        $personId = 'route-api-life-1';
        $this->personWithAuthority($personId, ['students.hold', 'students.communication']);
        $this->signInAs($personId, 'route.api.life');

        $this->postJson('/api/students/'.$student->id.'/communication-preference', [
            'channel' => 'sms',
            'enabled' => true,
        ], ['Idempotency-Key' => 'api-comm-key-1'])
            ->assertOk()
            ->assertJsonPath('channel', 'sms')
            ->assertJsonPath('enabled', true);

        $this->postJson('/api/students/'.$student->id.'/hold', [
            'action' => 'freeze',
            'reason' => 'travel hold',
        ], ['Idempotency-Key' => 'api-hold-key-1'])
            ->assertOk()
            ->assertJsonPath('action', 'freeze');

        $this->postJson('/api/students/'.$student->id.'/hold', [
            'action' => 'resume',
            'reason' => 'returned',
        ], ['Idempotency-Key' => 'api-hold-key-2'])
            ->assertOk()
            ->assertJsonPath('action', 'resume');

        $this->postJson('/api/students/'.$student->id.'/communication-preference', [
            'channel' => 'fax',
            'enabled' => true,
        ], ['Idempotency-Key' => 'api-comm-key-2'])
            ->assertStatus(422);
    }
}
