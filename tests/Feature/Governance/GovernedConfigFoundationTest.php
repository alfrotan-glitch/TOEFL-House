<?php

declare(strict_types=1);

namespace Tests\Feature\Governance;

use App\Modules\Governance\Commands\MaintainGovernedConfig;
use App\Modules\Governance\Domain\GovernedConfigType;
use App\Modules\Governance\GovernedConfigRegistry;
use App\Modules\Governance\Models\GovernedConfig;
use App\Modules\Governance\Models\GovernedConfigDefinition;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use App\Support\Errors\ValidationError;
use App\Support\Identifiers\RandomIdentifier;
use Carbon\CarbonImmutable;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Tests\Concerns\BuildsActors;
use Tests\TestCase;

/**
 * WP-2 S1 (WP2-DEC-05): typed, versioned, audited governed_configs registry.
 * Focused behavior proofs — typed/structurally-validated values, append-only
 * versioning, effective-date resolution, immutability, audit metadata,
 * fail-closed reads, authorization, DB-level invariants (one OPEN version per
 * key, non-overlapping windows, monotonic versioning, typed value guard,
 * immutability), and preservation of the authorization boundary (governed
 * writes are reachable only through the governance.config capability).
 */
final class GovernedConfigFoundationTest extends TestCase
{
    use BuildsActors;

    private const GOVERNOR = 'gov-s1';

    private MaintainGovernedConfig $command;

    private GovernedConfigRegistry $registry;

    protected function setUp(): void
    {
        parent::setUp();
        $this->command = app(MaintainGovernedConfig::class);
        $this->registry = app(GovernedConfigRegistry::class);
    }

    private function governor(): Actor
    {
        return $this->grantedActor(self::GOVERNOR, [MaintainGovernedConfig::CAPABILITY]);
    }

    /** @return array{config_key: string, correlation_id: string} */
    private function ratify(string $key, string $type, string $title, string $idem): array
    {
        return $this->command->ratifyDefinition($this->governor(), $key, $type, $title, $idem);
    }

    /** @return array{version_id: string, version_no: int, effective_from: string, supersedes_id: string|null, correlation_id: string} */
    private function activate(string $key, int|string $value, string $from, string $idem): array
    {
        return $this->command->activateConfig($this->governor(), $key, $value, new CarbonImmutable($from), $idem);
    }

    public function test_ratify_and_activate_valid_typed_values_versioning_audit_and_effective_resolution(): void
    {
        // (1) valid typed values, (12) authorized modification.
        $moneyKey = 'finance.branch_expense_approval_limit';
        $this->ratify($moneyKey, GovernedConfigType::POSITIVE_MONEY, 'Branch expense approval limit', 'ratify-money');
        $first = $this->activate($moneyKey, 5_000_000, '2026-01-01', 'act-money-1');

        $row = GovernedConfig::query()->findOrFail($first['version_id']);
        $this->assertSame(1, $row->version_no);
        $this->assertSame(GovernedConfig::STATE_ACTIVE, $row->lifecycle_state);
        $this->assertSame(5_000_000, $row->typedValue());
        $this->assertTrue($row->isOpen());

        // Idempotent replay appends nothing and returns the same version.
        $replay = $this->activate($moneyKey, 5_000_000, '2026-01-01', 'act-money-1');
        $this->assertSame($first['version_id'], $replay['version_id']);
        $this->assertSame(1, GovernedConfig::query()->where('config_key', $moneyKey)->count());

        // (4) versioning: a second activation retires v1 and appends v2.
        $second = $this->activate($moneyKey, 7_500_000, '2026-06-01', 'act-money-2');
        $this->assertSame(2, $second['version_no']);
        $this->assertSame($first['version_id'], $second['supersedes_id']);
        $this->assertSame(2, GovernedConfig::query()->where('config_key', $moneyKey)->count());

        $v1 = GovernedConfig::query()->findOrFail($first['version_id']);
        $v2 = GovernedConfig::query()->findOrFail($second['version_id']);
        $this->assertSame(GovernedConfig::STATE_ENDED, $v1->lifecycle_state);
        $this->assertSame('2026-06-01', $v1->effective_to->toDateString());
        $this->assertSame(GovernedConfig::STATE_ACTIVE, $v2->lifecycle_state);
        $this->assertTrue($v2->isOpen());

        // (5) effective-date resolution resolves the authoritative version per day.
        $this->assertSame(5_000_000, $this->registry->effective($moneyKey, new CarbonImmutable('2026-03-15'))->typedValue());
        $this->assertSame(7_500_000, $this->registry->effective($moneyKey, new CarbonImmutable('2026-06-01'))->typedValue());
        $this->assertSame(7_500_000, $this->registry->effective($moneyKey, new CarbonImmutable('2026-12-31'))->typedValue());

        // (7) audit metadata: who, operation, target, before/after states.
        // Correlation is by the known version ids (target_id), never by row order:
        // audit_events.occurred_at is second-precision and multiple activations
        // inside one transaction can legitimately share a timestamp.
        $activateEvents = DB::table('audit_events')
            ->where('operation', 'governance.config.activate')
            ->where('actor_id', self::GOVERNOR)
            ->where('target_type', 'governed_config')
            ->get()
            ->keyBy('target_id');
        $this->assertCount(2, $activateEvents);
        $this->assertArrayHasKey($first['version_id'], $activateEvents);
        $this->assertArrayHasKey($second['version_id'], $activateEvents);
        $event1 = $activateEvents[$first['version_id']];
        $event2 = $activateEvents[$second['version_id']];
        $this->assertNull($event1->before_state);
        $after1 = json_decode((string) $event1->after_state, true);
        $this->assertSame(1, $after1['version_no']);
        $before2 = json_decode((string) $event2->before_state, true);
        $this->assertSame(1, $before2['version_no']);
        $this->assertSame('active', $before2['lifecycle_state']);
    }

    public function test_fail_closed_missing_configuration_and_no_effective_version(): void
    {
        // (8) missing required configuration: never silently defaulted.
        $undefined = 'risk.value_approval_threshold';
        try {
            $this->registry->effective($undefined, new CarbonImmutable('2026-01-01'));
            $this->fail('a config with no ratified definition must fail closed');
        } catch (BusinessRejection $e) {
            $this->assertSame('governance.config_undefined', $e->errorCode());
        }

        // (8/10) definition exists but no value activated yet -> fail closed.
        $declared = 'access.annual_review.cycle_months';
        $this->ratify($declared, GovernedConfigType::POSITIVE_INTEGER, 'Annual access review cycle', 'ratify-review');
        try {
            $this->registry->effective($declared, new CarbonImmutable('2026-01-01'));
            $this->fail('a ratified config with no effective value must fail closed');
        } catch (BusinessRejection $e) {
            $this->assertSame('governance.no_effective_version', $e->errorCode());
        }

        // (8/5) before the single open version's effective_from -> fail closed.
        $this->activate($declared, 12, '2026-06-01', 'act-review-1');
        try {
            $this->registry->effective($declared, new CarbonImmutable('2026-01-01'));
            $this->fail('a date before any effective version must fail closed');
        } catch (BusinessRejection $e) {
            $this->assertSame('governance.no_effective_version', $e->errorCode());
        }
        $this->assertSame(12, $this->registry->effective($declared, new CarbonImmutable('2026-06-01'))->typedValue());
    }

    public function test_invalid_typed_and_constraint_values_are_rejected(): void
    {
        // (2) invalid typed value, (3) invalid constraint, (9) invalid required config.
        $percentKey = 'finance.refund_percent_cap';
        $this->ratify($percentKey, GovernedConfigType::PERCENT, 'Refund percent cap', 'ratify-percent');

        $this->assertRejected(ValidationError::class, 'governance.invalid_value', fn () => $this->activate($percentKey, 101, '2026-01-01', 'bad-1'));
        $this->assertRejected(ValidationError::class, 'governance.invalid_value', fn () => $this->activate($percentKey, 'not-a-number', '2026-01-01', 'bad-2'));
        $this->assertRejected(ValidationError::class, 'governance.invalid_value', fn () => $this->activate($percentKey, -5, '2026-01-01', 'bad-3'));

        $moneyKey = 'finance.disposal_approval_limit';
        $this->ratify($moneyKey, GovernedConfigType::POSITIVE_MONEY, 'Disposal approval limit', 'ratify-money2');
        $this->assertRejected(ValidationError::class, 'governance.invalid_value', fn () => $this->activate($moneyKey, 0, '2026-01-01', 'bad-4'));

        // Activating a value for a key that was never ratified fails closed too.
        $this->assertRejected(BusinessRejection::class, 'governance.config_undefined', fn () => $this->activate('never.ratified', 5, '2026-01-01', 'bad-5'));

        // Nothing was persisted for any rejected activation.
        $this->assertSame(0, GovernedConfig::query()->count());
    }

    public function test_database_level_invariants_overlap_and_immutability(): void
    {
        $key = 'finance.branch_expense_approval_limit';
        $this->ratify($key, GovernedConfigType::POSITIVE_MONEY, 'Branch expense limit', 'ratify-inv');
        $v1 = $this->activate($key, 1_000_000, '2026-01-01', 'act-inv-1');

        // (13) application: a new version overlapping the open window is rejected.
        $this->assertRejected(BusinessRejection::class, 'governance.effective_overlap', fn () => $this->activate($key, 2_000_000, '2026-01-01', 'overlap-1'));
        $this->assertRejected(BusinessRejection::class, 'governance.effective_overlap', fn () => $this->activate($key, 2_000_000, '2025-01-01', 'overlap-2'));

        // Build a chain so v1 is ended [2026-01-01, 2026-05-01) and v2 is open.
        $v2 = $this->activate($key, 2_000_000, '2026-05-01', 'act-inv-2');

        // (14/15) DB-level: a second OPEN version for the same key is rejected
        // by the partial unique index (not by any single-process simulation).
        $this->assertQueryRejected(function () use ($key): void {
            DB::table('governed_configs')->insert($this->rawRow($key, 3, ['v' => 3_000_000], '2026-02-01', null, 'active'));
        });

        // (15) DB-level: an ENDED version overlapping the retired v1 window is
        // rejected by the GiST exclusion constraint (no overlapping windows).
        $this->assertQueryRejected(function () use ($key): void {
            DB::table('governed_configs')->insert($this->rawRow($key, 3, ['v' => 3_000_000], '2026-02-01', '2026-04-01', 'ended'));
        });

        // (15) invalid typed value shape is rejected by the DB value guard.
        $this->assertQueryRejected(function () use ($key): void {
            DB::table('governed_configs')->insert($this->rawRow($key, 3, ['amount' => 3_000_000], '2026-08-01', null, 'active'));
        });
        // (15) config_type mismatch vs the ratified definition is rejected.
        $this->assertQueryRejected(function () use ($key): void {
            $row = $this->rawRow($key, 3, ['v' => 3_000_000], '2026-08-01', null, 'active');
            $row['config_type'] = GovernedConfigType::PERCENT;
            DB::table('governed_configs')->insert($row);
        });
        // (15) non-monotonic version number is rejected.
        $this->assertQueryRejected(function () use ($key): void {
            DB::table('governed_configs')->insert($this->rawRow($key, 2, ['v' => 3_000_000], '2026-08-01', null, 'active'));
        });

        // (6) historical (retired) versions are immutable: value cannot change.
        $this->assertQueryRejected(function () use ($v1): void {
            DB::table('governed_configs')->where('id', $v1['version_id'])->update(['value' => json_encode(['v' => 99])]);
        });
        // (6) a retired version's window cannot be rewritten.
        $this->assertQueryRejected(function () use ($v1): void {
            DB::table('governed_configs')->where('id', $v1['version_id'])->update(['effective_from' => '2020-01-01']);
        });
        // (6) history is never deleted.
        $this->assertQueryRejected(function () use ($v1, $v2): void {
            DB::table('governed_configs')->whereIn('id', [$v1['version_id'], $v2['version_id']])->delete();
        });
        $this->assertSame(2, GovernedConfig::query()->count());
    }

    public function test_authorization_of_governed_config_writes(): void
    {
        // (12) authorized: ratified under governance.config.
        $key = 'finance.branch_expense_approval_limit';
        $this->ratify($key, GovernedConfigType::POSITIVE_MONEY, 'Branch expense limit', 'ratify-auth');
        $this->activate($key, 5_000_000, '2026-01-01', 'act-auth');

        // (11) unauthorized modification is denied and audited; nothing persists.
        $nobody = $this->actorWithoutAnyCapability('unpriv-gov');
        try {
            $this->command->ratifyDefinition($nobody, 'other.key', GovernedConfigType::POSITIVE_INTEGER, 'Denied', 'deny-ratify');
            $this->fail('unauthorized ratify must be denied');
        } catch (AuthorizationDenied $e) {
            $this->assertSame('governance.config_denied', $e->errorCode());
        }
        $this->assertDatabaseHas('audit_events', ['operation' => 'governance.config.ratify.denied', 'actor_id' => 'unpriv-gov']);
        $this->assertDatabaseMissing('governed_config_definitions', ['config_key' => 'other.key']);

        // (16) another authority (access) does not broaden into governed writes:
        // an access administrator may not ratify or activate governed config.
        $accessAdmin = $this->accessAdministrator();
        $this->assertRejected(AuthorizationDenied::class, 'governance.config_denied', fn () => $this->command->ratifyDefinition($accessAdmin, 'other.key2', GovernedConfigType::POSITIVE_INTEGER, 'Denied access', 'deny-access'));

        // Only the governor's one activation exists; unauthorized writes changed nothing.
        $this->assertSame(1, GovernedConfigDefinition::query()->count());
        $this->assertSame(1, GovernedConfig::query()->count());
    }

    /** @param array{v?: int|string, ...} $envelope */
    private function rawRow(string $key, int $versionNo, array $envelope, string $from, ?string $to, string $lifecycle): array
    {
        return [
            'id' => RandomIdentifier::new(),
            'config_key' => $key,
            'config_type' => GovernedConfigType::POSITIVE_MONEY,
            'version_no' => $versionNo,
            'value' => json_encode($envelope, JSON_THROW_ON_ERROR),
            'effective_from' => $from,
            'effective_to' => $to,
            'supersedes_id' => null,
            'lifecycle_state' => $lifecycle,
            'review_cycle' => null,
            'approved_by' => self::GOVERNOR,
            'created_at' => now()->toDateTimeString(),
            'updated_at' => now()->toDateTimeString(),
        ];
    }

    private function assertQueryRejected(callable $action): void
    {
        try {
            $action();
            $this->fail('the database statement should have been rejected by a database invariant');
        } catch (QueryException $e) {
            $this->assertNotSame('', $e->getMessage());
        }
    }

    private function assertRejected(string $class, string $code, callable $action): void
    {
        try {
            $action();
            $this->fail("expected $class with code $code");
        } catch (ValidationError|BusinessRejection|AuthorizationDenied $e) {
            $this->assertInstanceOf($class, $e);
            $this->assertSame($code, $e->errorCode());
        }
    }
}
