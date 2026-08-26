<?php

declare(strict_types=1);

namespace Tests\Feature\Integrations;

use App\Modules\Integrations\Commands\DispatchDelivery;
use App\Modules\Integrations\Commands\EnqueueJobRun;
use App\Modules\Integrations\Commands\ProcessDeliveries;
use App\Modules\Integrations\Commands\ProcessInbound;
use App\Modules\Integrations\Commands\ProcessJobRun;
use App\Modules\Integrations\Commands\ReceiveInbound;
use App\Modules\Integrations\Commands\RegisterEndpoint;
use App\Modules\Integrations\Commands\RegisterJob;
use App\Modules\Integrations\Commands\RequeueDelivery;
use App\Modules\Integrations\Models\InboundEvent;
use App\Modules\Integrations\Models\IntegrationDelivery;
use App\Modules\Integrations\Models\IntegrationEndpoint;
use App\Modules\Integrations\Models\JobRun;
use App\Support\Authorization\Actor;
use App\Support\Errors\AuthorizationDenied;
use App\Support\Errors\BusinessRejection;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use RuntimeException;
use Tests\Concerns\BuildsActors;
use Tests\Fakes\ScriptedTransport;
use Tests\TestCase;

final class IntegrationsFeatureTest extends TestCase
{
    use BuildsActors;

    private ScriptedTransport $transport;

    private string $endpointId;

    protected function setUp(): void
    {
        parent::setUp();
        $this->transport = new ScriptedTransport;
        app()->instance(ScriptedTransport::class, $this->transport);
        config(['integrations.transports' => ['sms-gateway' => ScriptedTransport::class]]);
        config(['integrations.secrets' => ['payment-hook' => 's3cret']]);

        $admin = $this->grantedActor('int-admin', ['integrations.endpoint', 'integrations.dispatch', 'integrations.process', 'integrations.inbound', 'integrations.jobs', 'integrations.review']);
        $this->endpointId = app(RegisterEndpoint::class)->register($admin, 'sms-gateway', 'SMS Gateway', 'sms', 'v1', 'vault://sms/gateway', 'https://sms.example/api', 'int-ep-1')['endpoint_id'];
        app(RegisterEndpoint::class)->register($admin, 'payment-hook', 'Payment Webhook', 'payment', 'v1', 'vault://payments/hook', 'https://pay.example/hook', 'int-ep-2');
        app(RegisterJob::class)->register($admin, 'integrations.retry_sweep', 'Integration Retry Sweep', 'every-5-minutes', 'int-job-1');
    }

    private function admin(): Actor
    {
        return $this->grantedActor('int-admin', ['integrations.endpoint', 'integrations.dispatch', 'integrations.process', 'integrations.inbound', 'integrations.jobs', 'integrations.review']);
    }

    public function test_outbound_delivery_lifecycle_with_idempotent_dispatch_and_replay_safety(): void
    {
        $admin = $this->admin();
        $dispatch = app(DispatchDelivery::class)->dispatch($admin, 'sms-gateway', 'receipt-1', 'payment', '00000000-0000-4000-8000-0000000000a1', 'receipt.issued', ['receipt' => 'RCPT-1'], 'int-disp-1');
        $this->assertFalse($dispatch['duplicate']);
        $this->assertSame('queued', $dispatch['status']);
        $this->assertDatabaseHas('integration_deliveries', ['id' => $dispatch['delivery_id'], 'status' => 'queued', 'attempts' => 0]);

        // duplicate dispatch of the same (endpoint, idempotency key) returns the original row
        $again = app(DispatchDelivery::class)->dispatch($admin, 'sms-gateway', 'receipt-1', 'payment', '00000000-0000-4000-8000-0000000000a1', 'receipt.issued', ['receipt' => 'RCPT-1'], 'int-disp-2');
        $this->assertTrue($again['duplicate']);
        $this->assertSame($dispatch['delivery_id'], $again['delivery_id']);
        $this->assertSame(1, IntegrationDelivery::query()->count());

        $sweep = app(ProcessDeliveries::class)->processDue($admin, 'int-proc-1');
        $this->assertSame('delivered', $sweep['results'][0]['outcome']);
        $this->assertSame(1, $sweep['results'][0]['attempts']);
        $this->assertDatabaseHas('integration_deliveries', ['id' => $dispatch['delivery_id'], 'status' => 'delivered']);
        $this->assertDatabaseHas('audit_events', ['operation' => 'integrations.delivery.delivered', 'target_id' => $dispatch['delivery_id']]);

        // replayed processing never sends twice
        app(ProcessDeliveries::class)->processDue($admin, 'int-proc-2');
        $this->assertSame(1, $this->transport->sendCount());
        $this->assertSame(1, (int) IntegrationDelivery::query()->find($dispatch['delivery_id'])->attempts);

        // delivered rows are final: no raw rewrite, no delete
        $this->expectException(QueryException::class);
        DB::statement('DELETE FROM integration_deliveries WHERE id = ?', [$dispatch['delivery_id']]);
    }

    public function test_transient_failures_backoff_bounded_retries_and_audited_requeue(): void
    {
        $admin = $this->admin();
        $this->transport->willFailTransiently(2);
        $dispatch = app(DispatchDelivery::class)->dispatch($admin, 'sms-gateway', 'receipt-2', 'payment', '00000000-0000-4000-8000-0000000000a2', 'receipt.issued', ['receipt' => 'RCPT-2'], 'int-disp-3');

        // attempt 1: transient failure schedules a bounded backoff retry
        $first = app(ProcessDeliveries::class)->processDue($admin, 'int-proc-3');
        $this->assertSame('retry_scheduled', $first['results'][0]['outcome']);
        /** @var IntegrationDelivery $delivery */
        $delivery = IntegrationDelivery::query()->find($dispatch['delivery_id']);
        $this->assertSame('failed', $delivery->status);
        $this->assertSame(1, $delivery->attempts);
        $this->assertNotNull($delivery->next_run_at);
        $this->assertTrue($delivery->next_run_at->isFuture());

        // a premature worker skips (no second attempt inside the backoff window)
        app(ProcessDeliveries::class)->processDue($admin, 'int-proc-4');
        $this->assertSame(1, $this->transport->sendCount());

        // attempt 2 after the backoff elapses
        $this->makeDue($delivery->id);
        $second = app(ProcessDeliveries::class)->processDue($admin, 'int-proc-5');
        $this->assertSame('retry_scheduled', $second['results'][0]['outcome']);
        $this->assertSame(2, (int) IntegrationDelivery::query()->find($delivery->id)->attempts);

        // attempt 3 delivers
        $this->makeDue($delivery->id);
        $third = app(ProcessDeliveries::class)->processDue($admin, 'int-proc-6');
        $this->assertSame('delivered', $third['results'][0]['outcome']);
        $this->assertDatabaseHas('integration_deliveries', ['id' => $delivery->id, 'attempts' => 3, 'status' => 'delivered']);

        // exhaustion: five transient failures dead-letter the delivery visibly
        $this->transport->willFailTransiently(5);
        $doomed = app(DispatchDelivery::class)->dispatch($admin, 'sms-gateway', 'receipt-3', 'payment', '00000000-0000-4000-8000-0000000000a3', 'receipt.issued', ['receipt' => 'RCPT-3'], 'int-disp-4');
        for ($i = 0; $i < 5; $i++) {
            app(ProcessDeliveries::class)->processDue($admin, 'int-proc-7-'.$i);
            $this->makeDue($doomed['delivery_id']);
        }
        $this->assertDatabaseHas('integration_deliveries', ['id' => $doomed['delivery_id'], 'status' => 'dead_letter', 'attempts' => 5]);
        $this->assertDatabaseHas('audit_events', ['operation' => 'integrations.delivery.dead_letter', 'target_id' => $doomed['delivery_id']]);

        // manual review requeues into a fresh bounded window; identity and intervention count retained
        app(RequeueDelivery::class)->requeue($admin, IntegrationDelivery::query()->findOrFail($doomed['delivery_id']), 'int-rq-1');
        $this->assertDatabaseHas('integration_deliveries', ['id' => $doomed['delivery_id'], 'status' => 'queued', 'attempts' => 0, 'requeues' => 1]);
        app(ProcessDeliveries::class)->processDue($admin, 'int-proc-8');
        $this->assertDatabaseHas('integration_deliveries', ['id' => $doomed['delivery_id'], 'status' => 'delivered', 'requeues' => 1]);
    }

    public function test_partial_failure_leaves_sibling_deliveries_intact(): void
    {
        $admin = $this->admin();
        $first = app(DispatchDelivery::class)->dispatch($admin, 'sms-gateway', 'batch-a', 'payment', '00000000-0000-4000-8000-0000000000a4', 'receipt.issued', ['receipt' => 'R-A'], 'int-disp-5');
        $second = app(DispatchDelivery::class)->dispatch($admin, 'sms-gateway', 'batch-b', 'payment', '00000000-0000-4000-8000-0000000000a5', 'receipt.issued', ['receipt' => 'R-B'], 'int-disp-6');

        // the transport blows up on the first delivery (unexpected adapter failure); the sweep still delivers the sibling
        $this->transport->willThrow(new RuntimeException('connection reset'));
        $sweep = app(ProcessDeliveries::class)->processDue($admin, 'int-proc-9');
        $outcomes = array_column($sweep['results'], 'outcome');
        $this->assertContains('delivered', $outcomes);
        $this->assertDatabaseHas('integration_deliveries', ['id' => $second['delivery_id'], 'status' => 'delivered']);
        $this->assertDatabaseHas('integration_deliveries', ['id' => $first['delivery_id'], 'status' => 'queued', 'attempts' => 0]);
    }

    public function test_unconfigured_and_retired_endpoints_fail_closed(): void
    {
        $admin = $this->admin();
        $orphan = app(RegisterEndpoint::class)->register($admin, 'storage-box', 'Storage', 'storage', 'v1', 'vault://storage', 'https://storage.example', 'int-ep-3');

        // no transport configured: permanent failure, dead-lettered visibly, success never fabricated
        app(DispatchDelivery::class)->dispatch($admin, 'storage-box', 'export-1', 'reporting', '00000000-0000-4000-8000-0000000000a6', 'export.ready', ['file' => 'x.csv'], 'int-disp-7');
        $sweep = app(ProcessDeliveries::class)->processDue($admin, 'int-proc-10');
        $this->assertSame('dead_letter', $sweep['results'][0]['outcome']);
        $this->assertDatabaseHas('integration_deliveries', ['endpoint_id' => $orphan['endpoint_id'], 'status' => 'dead_letter', 'delivered_ref' => null]);

        // retirement is one-way and blocks dispatch
        app(RegisterEndpoint::class)->retire($admin, IntegrationEndpoint::query()->findOrFail($orphan['endpoint_id']), 'int-ep-4');
        try {
            app(DispatchDelivery::class)->dispatch($admin, 'storage-box', 'export-2', 'reporting', '00000000-0000-4000-8000-0000000000a7', 'export.ready', ['file' => 'y.csv'], 'int-disp-8');
            $this->fail('a retired endpoint must not accept dispatches');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('integrations.endpoint_inactive', $rejection->errorCode());
        }

        $this->expectException(QueryException::class);
        DB::statement("UPDATE integration_endpoints SET state = 'active' WHERE id = ?", [$orphan['endpoint_id']]);
    }

    public function test_inbound_webhooks_verify_signatures_dedupe_and_process_exactly_once(): void
    {
        $admin = $this->admin();
        $payload = ['event' => 'payment.captured', 'amount' => '150.00'];
        $digest = hash('sha256', json_encode($payload));
        $signature = hash_hmac('sha256', $digest, 's3cret');

        $received = app(ReceiveInbound::class)->receive($admin, 'payment-hook', 'ext-9001', 'payment.captured', $payload, $signature, 'int-in-1');
        $this->assertSame('received', $received['status']);
        $this->assertFalse($received['duplicate']);

        // forged signature: rejected evidence retained
        $forged = app(ReceiveInbound::class)->receive($admin, 'payment-hook', 'ext-9002', 'payment.captured', $payload, 'deadbeef', 'int-in-2');
        $this->assertSame('rejected', $forged['status']);
        $this->assertDatabaseHas('inbound_events', ['id' => $forged['event_id'], 'signature_verified' => false]);

        // malformed payload: rejected
        $malformed = app(ReceiveInbound::class)->receive($admin, 'payment-hook', 'ext-9003', 'payment.captured', null, 'sig', 'int-in-3');
        $this->assertSame('rejected', $malformed['status']);

        // a corrected retry of a rejected external id is accepted (rejection does not block)
        $corrected = app(ReceiveInbound::class)->receive($admin, 'payment-hook', 'ext-9002', 'payment.captured', $payload, $signature, 'int-in-4');
        $this->assertSame('received', $corrected['status']);

        // exactly-once processing
        $processed = app(ProcessInbound::class)->process($admin, InboundEvent::query()->findOrFail($received['event_id']), 'int-in-5');
        $this->assertFalse($processed['already_processed']);
        $replay = app(ProcessInbound::class)->process($admin, InboundEvent::query()->findOrFail($received['event_id']), 'int-in-6');
        $this->assertTrue($replay['already_processed']);
        $this->assertSame(1, DB::table('audit_events')->where('operation', 'integrations.inbound.processed')->where('target_id', $received['event_id'])->count());

        // duplicate delivery of an accepted event answers with the original, never reprocesses
        $duplicate = app(ReceiveInbound::class)->receive($admin, 'payment-hook', 'ext-9001', 'payment.captured', $payload, $signature, 'int-in-7');
        $this->assertTrue($duplicate['duplicate']);
        $this->assertSame($received['event_id'], $duplicate['event_id']);
        $this->assertSame(1, InboundEvent::query()->where('external_id', 'ext-9001')->count());

        // inbound identity is tamper-proof
        $this->expectException(QueryException::class);
        DB::statement("UPDATE inbound_events SET external_id = 'ext-9999' WHERE id = ?", [$received['event_id']]);
    }

    public function test_scheduled_job_runs_execute_once_with_backoff_and_dead_letter(): void
    {
        $admin = $this->admin();

        // unknown jobs cannot be scheduled
        try {
            app(RegisterJob::class)->register($admin, 'integrations.invented_job', 'Nope', 'daily', 'int-job-2');
            $this->fail('jobs outside the catalog must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('integrations.job_unknown', $rejection->errorCode());
        }

        // one durable run per occurrence: a racing scheduler gets the existing row
        $enqueued = app(EnqueueJobRun::class)->enqueue($admin, 'integrations.retry_sweep', '2026-08-26T09:00', 'int-enq-1');
        $this->assertFalse($enqueued['duplicate']);
        $racing = app(EnqueueJobRun::class)->enqueue($admin, 'integrations.retry_sweep', '2026-08-26T09:00', 'int-enq-2');
        $this->assertTrue($racing['duplicate']);
        $this->assertSame($enqueued['run_id'], $racing['run_id']);
        $this->assertSame(1, JobRun::query()->where('run_key', '2026-08-26T09:00')->count());

        // clean sweep succeeds; replaying a succeeded run answers without executing
        $done = app(ProcessJobRun::class)->process($admin, JobRun::query()->findOrFail($enqueued['run_id']), 'int-run-1');
        $this->assertSame('succeeded', $done['status']);
        $this->assertSame(0, $done['outcome']['considered']);
        $replay = app(ProcessJobRun::class)->process($admin, JobRun::query()->findOrFail($enqueued['run_id']), 'int-run-2');
        $this->assertSame('succeeded', $replay['status']);
        $this->assertSame(1, (int) JobRun::query()->find($enqueued['run_id'])->attempts);

        // a throwing handler fails the run with backoff; bounded attempts dead-letter
        // (every one of the three attempts meets the same blowup)
        $this->transport->willThrow(new RuntimeException('sweep blowup'))->willThrow(new RuntimeException('sweep blowup'))->willThrow(new RuntimeException('sweep blowup'));
        $unluckyDelivery = app(DispatchDelivery::class)->dispatch($admin, 'sms-gateway', 'receipt-4', 'payment', '00000000-0000-4000-8000-0000000000a8', 'receipt.issued', ['receipt' => 'RCPT-4'], 'int-disp-9');
        $unlucky = app(EnqueueJobRun::class)->enqueue($admin, 'integrations.retry_sweep', '2026-08-26T09:05', 'int-enq-3');

        $attempt = app(ProcessJobRun::class)->process($admin, JobRun::query()->findOrFail($unlucky['run_id']), 'int-run-3');
        $this->assertSame('failed', $attempt['status']);
        /** @var JobRun $run */
        $run = JobRun::query()->find($unlucky['run_id']);
        $this->assertSame(1, $run->attempts);
        $this->assertTrue($run->next_retry_at->isFuture());

        // inside the backoff window the run waits; not executed
        $waiting = app(ProcessJobRun::class)->process($admin, $run, 'int-run-4');
        $this->assertSame('waiting_retry', $waiting['status']);
        $this->assertSame(1, $this->transport->sendCount());

        DB::table('job_runs')->where('id', $run->id)->update(['next_retry_at' => now()->subMinute()]);
        app(ProcessJobRun::class)->process($admin, $run, 'int-run-5'); // attempt 2 fails
        DB::table('job_runs')->where('id', $run->id)->update(['next_retry_at' => now()->subMinute()]);
        $terminal = app(ProcessJobRun::class)->process($admin, $run, 'int-run-6'); // attempt 3 exhausted

        $this->assertSame('dead_letter', $terminal['status']);
        $this->assertDatabaseHas('job_runs', ['id' => $run->id, 'status' => 'dead_letter', 'attempts' => 3]);
        $this->assertDatabaseHas('audit_events', ['operation' => 'integrations.job.dead_letter', 'target_id' => $run->id]);
        // the aborted sweep attempts fabricated nothing: the delivery is untouched and still retryable
        $this->assertDatabaseHas('integration_deliveries', ['id' => $unluckyDelivery['delivery_id'], 'status' => 'queued', 'attempts' => 0]);
    }

    public function test_unprivileged_integration_operations_are_denied_and_audited(): void
    {
        $nobody = $this->actorWithoutAnyCapability('int-nobody');

        try {
            app(DispatchDelivery::class)->dispatch($nobody, 'sms-gateway', 'receipt-x', 'payment', '00000000-0000-4000-8000-0000000000a9', 'receipt.issued', ['receipt' => 'X'], 'int-neg-1');
            $this->fail('unprivileged dispatch must be denied');
        } catch (AuthorizationDenied) {
            $this->assertDatabaseHas('audit_events', ['operation' => 'integrations.delivery.dispatch.denied', 'actor_id' => 'int-nobody']);
        }

        try {
            app(RegisterEndpoint::class)->register($nobody, 'evil-gateway', 'Evil', 'sms', 'v1', 'vault://evil', 'https://evil.example', 'int-neg-2');
            $this->fail('unprivileged endpoint registration must be denied');
        } catch (AuthorizationDenied) {
            $this->assertDatabaseHas('audit_events', ['operation' => 'integrations.endpoint.register.denied', 'actor_id' => 'int-nobody']);
        }

        try {
            app(ReceiveInbound::class)->receive($nobody, 'payment-hook', 'ext-1', 'payment.captured', ['x' => 1], 'sig', 'int-neg-3');
            $this->fail('unprivileged webhook intake must be denied');
        } catch (AuthorizationDenied) {
            $this->assertDatabaseHas('audit_events', ['operation' => 'integrations.inbound.receive.denied', 'actor_id' => 'int-nobody']);
        }

        try {
            app(EnqueueJobRun::class)->enqueue($nobody, 'integrations.retry_sweep', 'occ-x', 'int-neg-4');
            $this->fail('unprivileged job enqueue must be denied');
        } catch (AuthorizationDenied) {
            $this->assertDatabaseHas('audit_events', ['operation' => 'integrations.job.enqueue.denied', 'actor_id' => 'int-nobody']);
        }

        $this->assertSame(0, IntegrationDelivery::query()->count());
        $this->assertSame(2, IntegrationEndpoint::query()->count()); // only the setUp endpoints — the denied one never landed
        $this->assertSame(0, InboundEvent::query()->count());
        $this->assertSame(0, JobRun::query()->count());
    }

    private function makeDue(string $deliveryId): void
    {
        IntegrationDelivery::query()->whereKey($deliveryId)->update(['next_run_at' => now()->subMinute()]);
    }
}
