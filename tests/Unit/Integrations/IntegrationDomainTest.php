<?php

declare(strict_types=1);

namespace Tests\Unit\Integrations;

use App\Modules\Integrations\Domain\BackoffPolicy;
use App\Modules\Integrations\Domain\JobCatalog;
use App\Modules\Integrations\Domain\SignatureVerifier;
use App\Modules\Integrations\Domain\TransportResult;
use App\Modules\Integrations\Jobs\IntegrationRetrySweepJob;
use App\Support\Errors\BusinessRejection;
use Tests\TestCase;

final class IntegrationDomainTest extends TestCase
{
    public function test_job_catalog_is_closed(): void
    {
        $this->assertSame(['integrations.retry_sweep'], JobCatalog::keys());
        $this->assertSame(IntegrationRetrySweepJob::class, JobCatalog::handlerFor('integrations.retry_sweep'));

        try {
            JobCatalog::handlerFor('integrations.invented');
            $this->fail('jobs outside the catalog must be rejected');
        } catch (BusinessRejection $rejection) {
            $this->assertSame('integrations.job_unknown', $rejection->errorCode());
        }
    }

    public function test_backoff_is_exponential_and_capped(): void
    {
        $this->assertSame(2, BackoffPolicy::delayForAttempt(1));
        $this->assertSame(4, BackoffPolicy::delayForAttempt(2));
        $this->assertSame(8, BackoffPolicy::delayForAttempt(3));
        $this->assertSame(32, BackoffPolicy::delayForAttempt(5));
        $this->assertSame(BackoffPolicy::CAP_MINUTES, BackoffPolicy::delayForAttempt(7));
        $this->assertSame(BackoffPolicy::CAP_MINUTES, BackoffPolicy::delayForAttempt(50));
        $this->assertSame(1, BackoffPolicy::delayForAttempt(0));
    }

    public function test_signature_verifier_requires_secret_and_exact_mac(): void
    {
        $verifier = new SignatureVerifier(['payment-hook' => 's3cret']);
        $digest = hash('sha256', '{"a":1}');

        $this->assertTrue($verifier->verify('payment-hook', $digest, hash_hmac('sha256', $digest, 's3cret')));
        $this->assertFalse($verifier->verify('payment-hook', $digest, hash_hmac('sha256', $digest, 'wrong')), 'a wrong secret must not verify');
        $this->assertFalse($verifier->verify('payment-hook', hash('sha256', '{"a":2}'), hash_hmac('sha256', $digest, 's3cret')), 'a tampered payload must not verify');
        $this->assertFalse($verifier->verify('unknown-hook', $digest, hash_hmac('sha256', $digest, 's3cret')), 'an endpoint without a configured secret must not verify');
        $this->assertFalse($verifier->verify('payment-hook', $digest, ''), 'an empty signature must not verify');
    }

    public function test_transport_results_never_fabricate_success(): void
    {
        $delivered = TransportResult::delivered('provider-1');
        $this->assertTrue($delivered->delivered);
        $this->assertSame('provider-1', $delivered->reference);
        $this->assertNull($delivered->error);

        $transient = TransportResult::transientFailure('integrations.provider_timeout');
        $this->assertFalse($transient->delivered);
        $this->assertTrue($transient->retryable);

        $permanent = TransportResult::permanentFailure('integrations.provider_rejected');
        $this->assertFalse($permanent->delivered);
        $this->assertFalse($permanent->retryable);
        $this->assertNull($permanent->reference);
    }
}
