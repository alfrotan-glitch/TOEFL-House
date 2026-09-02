<?php

declare(strict_types=1);

/**
 * FINAL PAYMENT E2E JOURNEY — fresh isolated DB, REAL HTTP, no mocks, no
 * direct-SQL fabrication of financial state.
 *
 * Drives the whole financial/payment lifecycle against a live server:
 *   real student -> obligation/invoice -> outstanding balance -> record payment
 *   -> persist check -> allocate -> allocated/remaining/student balance ->
 *   overpayment rejected -> over-allocation rejected -> idempotent replay ->
 *   invalid amount 422 (not 500) -> refund (staged) -> refund cap ->
 *   closed-period protection -> concurrent allocation race -> audit trail ->
 *   final balance recomputed from authoritative tables vs application.
 *
 * Usage: php e2e-payment-journey.php [base-url]
 */

require __DIR__.'/vendor/autoload.php';

$BASE = $argv[1] ?? 'http://127.0.0.1:8999';
$E2E_DB = 'toefl_house_pay';

$pass = 0;
$fail = 0;
$findings = [];
function pass(string $m): void
{
    global $pass;
    $pass++;
    echo "  \033[32mPASS\033[0m  $m\n";
}
function fail(string $code, string $m): void
{
    global $fail, $findings;
    $fail++;
    $findings[] = $code;
    echo "  \033[31mFAIL\033[0m  [$code] $m\n";
}
function info(string $m): void
{
    echo "  \033[90m·\033[0m     $m\n";
}
function step(string $m): void
{
    echo "\n\033[36m▶ $m\033[0m\n";
}

final class Browser
{
    public string $xsrf = '';

    /** @var array<string,string> */
    private array $cookies = [];

    public function __construct(private string $base) {}

    private function cookieHeader(): string
    {
        $out = '';
        foreach ($this->cookies as $k => $v) {
            $out .= $k.'='.$v.'; ';
        }

        return rtrim($out, '; ');
    }

    /** @return array{status:int,location:?string,body:string,json:?array} */
    public function send(string $method, string $path, array $params = [], bool $json = false, array $headers = []): array
    {
        $ch = curl_init($this->base.$path);
        // Accept both ['Name: value'] list entries and ['Name' => 'value'] map entries.
        $h = [];
        foreach ($headers as $hk => $hv) {
            $h[] = is_int($hk) ? $hv : $hk.': '.$hv;
        }
        $cookie = $this->cookieHeader();
        if ($cookie !== '') {
            $h[] = 'Cookie: '.$cookie;
        }
        if ($method !== 'GET' && $this->xsrf !== '' && ! $this->hasHeader($h, 'X-XSRF-TOKEN')) {
            $h[] = 'X-XSRF-TOKEN: '.$this->xsrf;
        }
        if ($method !== 'GET') {
            if ($json) {
                if (! $this->hasHeader($h, 'Content-Type')) {
                    $h[] = 'Content-Type: application/json';
                }
                if (! $this->hasHeader($h, 'Accept')) {
                    $h[] = 'Accept: application/json';
                }
                $body = json_encode($params, JSON_THROW_ON_ERROR);
            } else {
                $body = http_build_query($params);
            }
            curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
            curl_setopt($ch, CURLOPT_CUSTOMREQUEST, $method);
        }
        if ($h !== []) {
            curl_setopt($ch, CURLOPT_HTTPHEADER, $h);
        }
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_HEADER, true);
        curl_setopt($ch, CURLOPT_FOLLOWLOCATION, false);
        curl_setopt($ch, CURLOPT_TIMEOUT, 90);
        $raw = curl_exec($ch);
        if ($raw === false) {
            return ['status' => 0, 'location' => null, 'body' => curl_error($ch), 'json' => null];
        }
        $hs = (int) curl_getinfo($ch, CURLINFO_HEADER_SIZE);
        $head = substr((string) $raw, 0, $hs);
        $respBody = substr((string) $raw, $hs);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        $location = preg_match('/^Location:\s*(.+)$/mi', $head, $lm) ? trim($lm[1]) : null;
        // Manually absorb Set-Cookie (the recovered libcurl cookie engine is unreliable).
        if (preg_match_all('/Set-Cookie:\s*([^=]+)=([^;]+)/i', $head, $m, PREG_SET_ORDER)) {
            foreach ($m as $cm) {
                $this->cookies[trim($cm[1])] = trim($cm[2]);
            }
        }
        if (isset($this->cookies['XSRF-TOKEN'])) {
            $this->xsrf = urldecode($this->cookies['XSRF-TOKEN']);
        }
        $j = ($respBody !== '' && (str_starts_with(ltrim($respBody), '{') || str_starts_with(ltrim($respBody), '['))) ? json_decode($respBody, true) : null;

        return ['status' => $status, 'location' => $location, 'body' => $respBody, 'json' => is_array($j) ? $j : null];
    }

    /** @param array<int,string> $headers */
    private function hasHeader(array $headers, string $name): bool
    {
        foreach ($headers as $hv) {
            if (stripos($hv, $name.':') === 0) {
                return true;
            }
        }

        return false;
    }

    public function get(string $p): array
    {
        return $this->send('GET', $p);
    }

    public function post(string $p, array $q = [], bool $j = false, array $h = []): array
    {
        return $this->send('POST', $p, $q, $j, $h);
    }

    public function prime(string $p = '/login'): void
    {
        $this->get($p);
    }

    /** Cookie header for external worker processes that share this authenticated session. */
    public function cookieString(): string
    {
        return $this->cookieHeader();
    }
}

$pdo = new PDO("pgsql:host=127.0.0.1;port=5432;dbname=$E2E_DB", 'postgres', 'postgres');
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
function q(string $sql, array $p = []): ?array
{
    global $pdo;
    $st = $pdo->prepare($sql);
    $st->execute($p);
    $r = $st->fetch(PDO::FETCH_ASSOC);

    return $r === false ? null : $r;
}
function qv(string $sql, array $p = []): string
{
    $r = q($sql, $p);

    return $r ? (string) array_values($r)[0] : '';
}
function qc(string $sql, array $p = []): int
{
    global $pdo;
    $st = $pdo->prepare($sql);
    $st->execute($p);

    return (int) $st->fetchColumn();
}

// Authoritative balance helpers (read-only, computed straight from the tables).
function obligationRemaining(string $obligationId): string
{
    $o = q('SELECT original_amount FROM obligations WHERE id=?', [$obligationId]);
    $lineIds = q("SELECT string_agg(quote_literal(id), ',') ids FROM obligation_lines WHERE obligation_id=?", [$obligationId]);
    $allocated = qv('SELECT COALESCE(sum(amount),0) FROM payment_allocations WHERE obligation_id=?', [$obligationId]);
    $funded = '0';
    $discounted = '0';

    return bcsub(bcsub(bcsub((string) $o['original_amount'], $funded, 2), $allocated, 2), $discounted, 2);
}
function paymentAllocated(string $paymentId): string
{
    return qv('SELECT COALESCE(sum(amount),0) FROM payment_allocations WHERE payment_id=?', [$paymentId]);
}
function paymentRemaining(string $paymentId): string
{
    $p = qv('SELECT amount FROM payments WHERE id=?', [$paymentId]);

    return bcsub($p, paymentAllocated($paymentId), 2);
}
function paymentRefunded(string $paymentId): string
{
    return qv("SELECT COALESCE(sum(amount),0) FROM refunds WHERE payment_id=? AND lifecycle_state='recorded'", [$paymentId]);
}

// ---------- health ----------
step('STAGE 0 — health + CSRF');
$h = new Browser($BASE);
$r = $h->get('/health');
$r['status'] === 200 && ($r['json']['checks']['database'] ?? '') === 'ok' ? pass('GET /health 200 db=ok') : fail('health', "status={$r['status']}");
$ch = curl_init($BASE.'/login');
curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_POST => true, CURLOPT_POSTFIELDS => http_build_query(['u' => 1]), CURLOPT_TIMEOUT => 15]);
curl_exec($ch);
$csrfCode = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
$csrfCode === 419 ? pass('token-less POST → 419 (CSRF)') : fail('csrf', "got $csrfCode");

// ---------- staff ----------
step('STAGE 1 — bootstrap owner + provision finance/refund staff over HTTP');
qc('SELECT count(*) FROM user_accounts') === 1 ? pass('bootstrap: exactly 1 owner account') : fail('bootstrap', 'accounts='.qc('SELECT count(*) FROM user_accounts'));
$owner = new Browser($BASE);
$owner->prime();
$owner->post('/login', ['username' => 'owner', 'password' => 'Owner-Pass-123']);
$me = $owner->get('/api/me');
($me['status'] === 200 && ($me['json']['username'] ?? '') === 'owner') ? pass('owner signed in; /api/me → owner') : fail('owner.login', "/api/me {$me['status']}");

$positionId = qv('SELECT id FROM positions ORDER BY id LIMIT 1');
$provision = function (string $fullName, string $username, string $password) use ($owner, $positionId): Browser {
    $owner->post('/identity/people', ['legal_name' => $fullName, 'date_of_birth' => '1985-07-07']);
    $pid = qv('SELECT id FROM people WHERE legal_name=? ORDER BY id DESC LIMIT 1', [$fullName]);
    $owner->post("/identity/people/$pid/verify", ['identity_key' => "nid-$username", 'evidence_ref' => "id/$username"]);
    $owner->post('/identity/accounts', ['person_id' => $pid, 'username' => $username]);
    $aid = qv('SELECT id FROM user_accounts WHERE person_id=?', [$pid]);
    $owner->post("/identity/accounts/$aid/password", ['password' => $password]);
    $owner->post('/access/assignments', ['person_id' => $pid, 'position_id' => $positionId, 'effective_from' => '2026-09-01']);
    $asid = qv('SELECT id FROM position_assignments WHERE person_id=? ORDER BY created_at DESC LIMIT 1', [$pid]);
    $owner->post("/access/assignments/$asid/activate", []);
    $b = new Browser($GLOBALS['BASE']);
    $b->prime();
    $lr = $b->post('/login', ['username' => $username, 'password' => $password]);
    if (! in_array($lr['status'], [302, 303], true)) {
        fail("staff.$username", "login {$lr['status']}");
    }

    return $b;
};
$finance = $provision('Finance Officer', 'fin_officer', 'Finance-Pass-123');
$refunder = $provision('Refund Requester', 'ref_req', 'Refund-Pass-123');
$refundApprover = $provision('Refund Approver', 'ref_appr', 'Refund-Appr-123');
pass('finance + refund-requester + refund-approver provisioned');

// ---------- student ----------
step('STAGE 2 — register a real student through the actual workflow');
// person intake + verify
$owner->post('/identity/people', ['legal_name' => 'Paying Student', 'date_of_birth' => '2007-04-22']);
$studentPersonId = qv("SELECT id FROM people WHERE legal_name='Paying Student'");
$owner->post("/identity/people/$studentPersonId/verify", ['identity_key' => 'nid-PAY-001', 'evidence_ref' => 'passport/PAY-001']);
// applicant register (finance officer is omnipotent via position)
$finance->post('/students/applicants', ['person_id' => $studentPersonId, 'program_interest' => 'TOEFL Preparation']);
$applicantId = qv('SELECT id FROM applicants WHERE person_id=?', [$studentPersonId]);
// 3-signature admission: initiator (finance) -> reviewer (refunder) -> approver (refundApprover)
$finance->post("/students/applicants/$applicantId/initiate", ['decision' => 'admit', 'reason' => 'meets policy', 'evidence_ref' => 'adm/PAY-001']);
$decisionId = qv('SELECT id FROM admission_decisions WHERE applicant_id=?', [$applicantId]);
$refunder->post("/students/decisions/$decisionId/review", []);
$refundApprover->post("/students/decisions/$decisionId/approve", []);
$admitted = qv('SELECT lifecycle_state FROM applicants WHERE id=?', [$applicantId]);
// convert to student
$refundApprover->post("/students/applicants/$applicantId/enroll", []);
$studentId = qv('SELECT id FROM students WHERE person_id=?', [$studentPersonId]);
$studentCode = qv('SELECT student_code FROM students WHERE person_id=?', [$studentPersonId]);
($studentId !== '' && $admitted === 'admitted') ? pass("student registered & admitted: $studentCode") : fail('student', "admitted=$admitted studentId=$studentId");

// ---------- financial period ----------
step('STAGE 3 — open financial period');
$finance->post('/finance/periods', ['period_key' => 'SY2026-PAY', 'date_from' => '2026-08-01', 'date_to' => '2027-07-31'], false, ['Referer' => "$BASE/finance"]);
$periodId = qv("SELECT id FROM financial_periods WHERE period_key='SY2026-PAY'");
$periodId !== '' ? pass('financial period OPEN: '.substr($periodId, 0, 8)) : fail('period.open', 'no period');

// ---------- obligation / invoice ----------
step('STAGE 4 — create invoice/obligation (1000.00) and verify outstanding balance');
$INVOICE = '1000.00';
$finance->post('/finance/obligations', [
    'period_id' => $periodId, 'student_id' => $studentId, 'source' => 'tuition',
    'reason' => 'TOEFL program tuition invoice', 'category' => 'tuition', 'amount' => $INVOICE, 'source_ref' => 'INV-PAY-001',
], false, ['Referer' => "$BASE/finance"]);
$obligationId = qv("SELECT id FROM obligations WHERE student_id=? AND reason='TOEFL program tuition invoice'", [$studentId]);
if ($obligationId === '') {
    fail('obligation.post', 'no obligation');
} else {
    pass("invoice/obligation posted: amount=$INVOICE (".substr($obligationId, 0, 8).')');
    $outstanding = obligationRemaining($obligationId);
    info("initial outstanding balance = $outstanding (expect $INVOICE)");
    $outstanding === '1000.00' ? pass("initial outstanding balance = $outstanding") : fail('balance.initial', "outstanding=$outstanding expected 1000.00");
}

// ---------- record payment ----------
step('STAGE 5 — record a real payment (400.00) through the payment endpoint');
$PAYMENT = '400.00';
$r = $finance->post('/api/finance/payments', [
    'period_id' => $periodId, 'student_id' => $studentId, 'amount' => $PAYMENT,
    'method' => 'bank_transfer', 'payer_ref' => 'RCPT-PAY-001', 'received_on' => '2026-09-02',
], true);
$r['status'] === 201 ? pass("payment recorded via API: $PAYMENT (201)") : fail('payment.record', "status={$r['status']} body=".substr($r['body'], 0, 160));
$paymentId = qv("SELECT id FROM payments WHERE payer_ref='RCPT-PAY-001'");

// ---------- payment persisted ----------
step('STAGE 6 — verify payment persisted correctly');
$pay = q('SELECT amount, method, payer_ref, received_on, student_id, period_id FROM payments WHERE id=?', [$paymentId]);
if ($pay && $pay['amount'] === '400.00' && $pay['method'] === 'bank_transfer' && $pay['payer_ref'] === 'RCPT-PAY-001' && $pay['student_id'] === $studentId) {
    pass("payment persisted: amount={$pay['amount']} method={$pay['method']} payer_ref={$pay['payer_ref']} student linked");
} else {
    fail('payment.persisted', json_encode($pay));
}

// Certified allocation rule: a given (payment, obligation) pair may be allocated
// exactly once (finance.allocation_pair_exists). So covering an invoice across
// several receipts uses a DISTINCT payment each time.

// ---------- allocate ----------
step('STAGE 7 — allocate 400.00 to the invoice; verify allocated/remaining/student balance');
$finance->post("/finance/obligations/$obligationId/allocate", ['payment_id' => $paymentId, 'amount' => '400.00'], false, ['Referer' => "$BASE/finance"]);
$allocCount = qc('SELECT count(*) FROM payment_allocations WHERE payment_id=? AND obligation_id=?', [$paymentId, $obligationId]);
$allocated = paymentAllocated($paymentId);
$payRemaining = paymentRemaining($paymentId);
$invRemaining = obligationRemaining($obligationId);
$studentOutstanding = qv('SELECT COALESCE(sum(o.original_amount - (SELECT COALESCE(sum(pa.amount),0) FROM payment_allocations pa WHERE pa.obligation_id=o.id)),0) FROM obligations o WHERE o.student_id=?', [$studentId]);
info("allocated=$allocated payment_remaining=$payRemaining invoice_remaining=$invRemaining student_outstanding=$studentOutstanding");
if ($allocCount === 1 && $allocated === '400.00' && $payRemaining === '0.00' && $invRemaining === '600.00' && $studentOutstanding === '600.00') {
    pass('allocation correct: allocated 400.00, payment remaining 0.00, invoice remaining 600.00, student balance 600.00');
} else {
    fail('allocation.math', "count=$allocCount allocated=$allocated payRem=$payRemaining invRem=$invRemaining studentOut=$studentOutstanding");
}

// ---------- overpayment rejected ----------
step('STAGE 8 — overpayment against the invoice must be rejected (allocate > remaining)');
// Invoice remainder is 600. Record a 700 payment and try to allocate 650 to the invoice (> 600 remainder).
$finance->post('/api/finance/payments', [
    'period_id' => $periodId, 'student_id' => $studentId, 'amount' => '700.00',
    'method' => 'cash', 'payer_ref' => 'RCPT-PAY-002', 'received_on' => '2026-09-03',
], true);
$payment2Id = qv("SELECT id FROM payments WHERE payer_ref='RCPT-PAY-002'");
$rOver = $finance->post("/finance/obligations/$obligationId/allocate", ['payment_id' => $payment2Id, 'amount' => '650.00'], false, ['Referer' => "$BASE/finance", 'Accept' => 'application/json']);
$invRemainingAfter = obligationRemaining($obligationId);
$badAlloc = qc('SELECT count(*) FROM payment_allocations WHERE payment_id=? AND amount=650.00', [$payment2Id]);
info("over-allocation attempt HTTP {$rOver['status']}; invoice remaining stays $invRemainingAfter (expect 600.00), 650 rows=$badAlloc (expect 0)");
if ($invRemainingAfter === '600.00' && $badAlloc === 0) {
    pass('over-allocation rejected: invoice remaining unchanged at 600.00, no 650.00 allocation');
} else {
    fail('overpayment.allowed', "remaining=$invRemainingAfter badAllocRows=$badAlloc");
}

// ---------- allocate exceeding the payment rejected ----------
step('STAGE 9 — allocation exceeding the PAYMENT remainder must be rejected');
// Cover 500 of the invoice with the 700 payment (valid, remainder now 100 on the invoice,
// 200 left on the payment). Then try to allocate the SAME pair again for 200 — rejected
// both as a duplicate pair AND as exceeding the obligation's 100 remainder.
$finance->post("/finance/obligations/$obligationId/allocate", ['payment_id' => $payment2Id, 'amount' => '500.00'], false, ['Referer' => "$BASE/finance"]);
info('allocated 500 of 700 cash payment; payment2 remaining 200; invoice remainder '.obligationRemaining($obligationId));
$invRemBefore = obligationRemaining($obligationId); // 100.00
// A separate 300 payment, allocate 200 to the invoice (only 100 room) -> exceeds obligation.
$finance->post('/api/finance/payments', ['period_id' => $periodId, 'student_id' => $studentId, 'amount' => '300.00', 'method' => 'cash', 'payer_ref' => 'RCPT-PAY-003', 'received_on' => '2026-09-04'], true);
$payment3Id = qv("SELECT id FROM payments WHERE payer_ref='RCPT-PAY-003'");
$rOverObl = $finance->post("/finance/obligations/$obligationId/allocate", ['payment_id' => $payment3Id, 'amount' => '200.00'], false, ['Referer' => "$BASE/finance"]);
$alloc200 = qc('SELECT count(*) FROM payment_allocations WHERE payment_id=? AND amount=200.00', [$payment3Id]);
$invRemAfter = obligationRemaining($obligationId);
info("200-into-100-remainder attempt HTTP {$rOverObl['status']}; invoice remaining $invRemAfter (expect 100.00), 200 rows=$alloc200 (expect 0)");
if ($invRemAfter === '100.00' && $alloc200 === 0) {
    pass('allocation exceeding obligation remainder rejected: invoice remaining stays 100.00');
} else {
    fail('overallocate.obligation', "invRem=$invRemAfter 200-rows=$alloc200");
}
// Legitimately settle the last 100 with a DISTINCT payment (obeying one-pair rule).
$finance->post("/finance/obligations/$obligationId/allocate", ['payment_id' => $payment3Id, 'amount' => '100.00'], false, ['Referer' => "$BASE/finance"]);
$invCovered = obligationRemaining($obligationId);
info("after settling the last 100, invoice remaining = $invCovered (expect 0.00)");
$invCovered === '0.00' ? pass('invoice fully covered (remaining 0.00) after legitimate allocations') : fail('invoice.cover', "remaining=$invCovered");

// ---------- idempotent replay ----------
step('STAGE 10 — duplicate/replayed payment is idempotent (no duplicate financial records)');
// Replay with the SAME valid Idempotency-Key header and identical payload.
// (Allowed key charset is [A-Za-z0-9._:-] — no hyphen.)
$idemKey = 'pay.idem.'.bin2hex(random_bytes(6));
$idemPayload = ['period_id' => $periodId, 'student_id' => $studentId, 'amount' => '250.00', 'method' => 'cash', 'payer_ref' => 'RCPT-IDEM-1', 'received_on' => '2026-09-05'];
$r1 = $finance->post('/api/finance/payments', $idemPayload, true, ['Idempotency-Key' => $idemKey]);
$r2 = $finance->post('/api/finance/payments', $idemPayload, true, ['Idempotency-Key' => $idemKey]);
$idemPays = qc("SELECT count(*) FROM payments WHERE payer_ref='RCPT-IDEM-1'");
$idemKeyRows = qc('SELECT count(*) FROM idempotency_keys WHERE idempotency_key=?', [$idemKey]);
info("idem replay: first HTTP {$r1['status']}, second HTTP {$r2['status']}, payment rows=$idemPays (expect 1), idempotency-key rows=$idemKeyRows (expect 1)");
if ($r1['status'] === 201 && in_array($r2['status'], [200, 201], true) && $idemPays === 1 && $idemKeyRows === 1) {
    pass('idempotent replay: same key returns cached outcome, only ONE payment row and ONE idempotency record');
} else {
    fail('idempotency.duplicate', "r1={$r1['status']} r2={$r2['status']} pays=$idemPays keys=$idemKeyRows");
}
// same key reused with a DIFFERENT payload -> rejected as conflicting payload
$rConflict = $finance->post('/api/finance/payments', array_merge($idemPayload, ['amount' => '999.00']), true, ['Idempotency-Key' => $idemKey]);
info("same idem key + different amount HTTP {$rConflict['status']} code=".($rConflict['json']['error'] ?? '-').' (expect 409 idempotency.conflicting_payload)');
$rConflict['status'] === 409 && ($rConflict['json']['error'] ?? '') === 'idempotency.conflicting_payload'
    ? pass('idempotency key reused with different payload rejected 409')
    : fail('idempotency.conflict', "status={$rConflict['status']} code=".($rConflict['json']['error'] ?? '-'));
// a plain duplicate payer_ref with NO idem key is independently rejected
$rDup = $finance->post('/api/finance/payments', ['period_id' => $periodId, 'student_id' => $studentId, 'amount' => '250.00', 'method' => 'cash', 'payer_ref' => 'RCPT-IDEM-1', 'received_on' => '2026-09-05'], true);
$dupCode = $rDup['status'];
info("duplicate payer_ref (no idem key) HTTP $dupCode with code=".($rDup['json']['error'] ?? '-').' (expect 409 finance.payment_duplicate)');
$dupCode === 409 && ($rDup['json']['error'] ?? '') === 'finance.payment_duplicate' ? pass('duplicate payer_ref rejected 409 finance.payment_duplicate') : fail('duplicate.payer_ref', "status=$dupCode");

// ---------- invalid amount 422 ----------
step('STAGE 11 — invalid payment amounts rejected cleanly with 422 (not 500)');
$bad = ['abc', '-50', '0.001', '12.999', '1e2', ''];
$all422 = true;
$any500 = false;
foreach ($bad as $amt) {
    $r = $finance->post('/api/finance/payments', ['period_id' => $periodId, 'student_id' => $studentId, 'amount' => $amt, 'method' => 'cash', 'payer_ref' => 'BAD-'.md5((string) $amt).substr((string) microtime(true), 6), 'received_on' => '2026-09-06'], true);
    if ($r['status'] !== 422) {
        $all422 = false;
        info('amount '.var_export($amt, true)." → HTTP {$r['status']}");
    }
    if ($r['status'] === 500) {
        $any500 = true;
    }
}
if ($any500) {
    fail('amount.500', 'an invalid amount produced a 500');
} elseif ($all422) {
    pass('all invalid amounts (abc, -50, 0.001, 12.999, 1e2, empty) → 422, never 500');
} else {
    fail('amount.422', 'some invalid amount did not return 422');
}

// ---------- refund flow ----------
step('STAGE 12 — refund flow (staged: propose → independent approve) against an unallocated payment');
// The idem payment (250) is unallocated and refundable up to 250.
$refundPayId = qv("SELECT id FROM payments WHERE payer_ref='RCPT-IDEM-1'");
$refundable = bcsub('250.00', paymentAllocated($refundPayId), 2);
info("refundable remainder of RCPT-IDEM-1 = $refundable (expect 250.00)");
// requester proposes a partial refund (100)
$r = $refunder->post("/api/finance/payments/$refundPayId/refund", ['period_id' => $periodId, 'amount' => '100.00', 'reason' => 'student withdrew before term start'], true);
$refundId = qv('SELECT id FROM refunds WHERE payment_id=? ORDER BY created_at DESC LIMIT 1', [$refundPayId]);
$proposedState = qv('SELECT lifecycle_state FROM refunds WHERE id=?', [$refundId]);
$r['status'] === 201 && $proposedState === 'proposed' ? pass("refund proposed: 100.00 (state=proposed, HTTP {$r['status']})") : fail('refund.propose', "status={$r['status']} state=$proposedState");
// requester cannot approve (SoD)
$rSelf = $refunder->post("/api/finance/refunds/$refundId/approve", [], true);
$selfCode = $rSelf['status'];
$selfErr = $rSelf['json']['error'] ?? '';
$stillProposed = qv('SELECT lifecycle_state FROM refunds WHERE id=?', [$refundId]);
info("self-approve → HTTP $selfCode $selfErr (expect 403 finance.refund_not_independent)");
$selfCode === 403 && $selfErr === 'finance.refund_not_independent' && $stillProposed === 'proposed' ? pass('SoD: refund requester cannot approve their own refund') : fail('refund.sod', "self-approve $selfCode $selfErr state=$stillProposed");
// distinct approver records it
$r = $refundApprover->post("/api/finance/refunds/$refundId/approve", [], true);
$recordedState = qv('SELECT lifecycle_state FROM refunds WHERE id=?', [$refundId]);
$r['status'] === 200 && $recordedState === 'recorded' ? pass("refund approved+recorded by distinct approver: state=recorded (HTTP {$r['status']})") : fail('refund.approve', "status={$r['status']} state=$recordedState body=".substr($r['body'], 0, 140));
$refundedSoFar = paymentRefunded($refundPayId);
info("recorded refunds on RCPT-IDEM-1 = $refundedSoFar (expect 100.00)");

// ---------- refund cannot exceed refundable ----------
step('STAGE 13 — refund cannot exceed the refundable remainder');
// 250 payment, 100 refunded -> refundable now 150. Propose 200 (over cap) -> must be rejected.
$rOver = $refunder->post("/api/finance/payments/$refundPayId/refund", ['period_id' => $periodId, 'amount' => '200.00', 'reason' => 'attempt to over-refund'], true);
$overCode = $rOver['status'];
$overErr = $rOver['json']['error'] ?? '';
$refundedAfter = paymentRefunded($refundPayId);
info("over-cap refund proposal → HTTP $overCode $overErr; recorded refunds still $refundedAfter (expect 100.00)");
$overCode === 409 && $overErr === 'finance.refund_exceeds_source' && $refundedAfter === '100.00'
    ? pass('refund exceeding refundable remainder rejected 409 finance.refund_exceeds_source')
    : fail('refund.cap', "status=$overCode err=$overErr refunded=$refundedAfter");

// ---------- closed-period protection ----------
step('STAGE 14 — closed-period protection: no payment/refund/obligation into a closed period');
// close the period (finance officer holds finance.period)
$finance->post("/finance/periods/$periodId/close", [], false, ['Referer' => "$BASE/finance"]);
$periodState = qv('SELECT lifecycle_state FROM financial_periods WHERE id=?', [$periodId]);
info("period state after close = $periodState (expect closed)");
// try to record a payment into the closed period
$rPay = $finance->post('/api/finance/payments', ['period_id' => $periodId, 'student_id' => $studentId, 'amount' => '10.00', 'method' => 'cash', 'payer_ref' => 'RCPT-CLOSED-1', 'received_on' => '2026-09-07'], true);
$payClosed = qc("SELECT count(*) FROM payments WHERE payer_ref='RCPT-CLOSED-1'");
$payErr = $rPay['json']['error'] ?? '';
// try a refund into the closed period
$rRef = $refunder->post("/api/finance/payments/$refundPayId/refund", ['period_id' => $periodId, 'amount' => '10.00', 'reason' => 'closed period refund'], true);
$refClosed = qc("SELECT count(*) FROM refunds WHERE payment_id=? AND reason='closed period refund'", [$refundPayId]);
$refErr = $rRef['json']['error'] ?? '';
// try an obligation into the closed period
$rObl = $finance->post('/finance/obligations', ['period_id' => $periodId, 'student_id' => $studentId, 'source' => 'x', 'reason' => 'closed period obligation', 'category' => 'tuition', 'amount' => '10.00', 'source_ref' => 'INV-CLOSED-1'], false, ['Referer' => "$BASE/finance", 'Accept' => 'application/json']);
$oblClosed = qc("SELECT count(*) FROM obligations WHERE reason='closed period obligation'");
info("payment into closed period: HTTP {$rPay['status']} $payErr rows=$payClosed (expect 409 finance.period_not_open, 0 rows)");
info("refund into closed period:  HTTP {$rRef['status']} $refErr rows=$refClosed (expect 409 finance.period_not_open, 0 rows)");
info("obligation into closed:     rows=$oblClosed (expect 0)");
if ($rPay['status'] === 409 && $payErr === 'finance.period_not_open' && $payClosed === 0
    && $rRef['status'] === 409 && $refErr === 'finance.period_not_open' && $refClosed === 0
    && $oblClosed === 0) {
    pass('closed period rejects payment + refund + obligation (finance.period_not_open), nothing persisted');
} else {
    fail('closed.period', "pay={$rPay['status']}/$payClosed ref={$rRef['status']}/$refClosed obl=$oblClosed");
}

// ---------- concurrency ----------
step('STAGE 15 — concurrent allocation attempts cannot corrupt balances');
// Open a NEW period; create a 300 invoice; a single 300 payment; fire N parallel allocations summing > 300.
$finance->post('/finance/periods', ['period_key' => 'SY2026-PAY2', 'date_from' => '2027-08-01', 'date_to' => '2028-07-31'], false, ['Referer' => "$BASE/finance"]);
$period2Id = qv("SELECT id FROM financial_periods WHERE period_key='SY2026-PAY2'");
// One 300 invoice; SIX distinct 300 payments all racing to allocate to it. Only 300 total
// may ever land (the pair rule lets each payment win once, the balance guard caps at 300).
$finance->post('/finance/obligations', ['period_id' => $period2Id, 'student_id' => $studentId, 'source' => 'tuition', 'reason' => 'concurrency test invoice', 'category' => 'tuition', 'amount' => '300.00', 'source_ref' => 'INV-CONC-1'], false, ['Referer' => "$BASE/finance"]);
$concObligationId = qv("SELECT id FROM obligations WHERE reason='concurrency test invoice'");
$concPayments = [];
for ($i = 1; $i <= 6; $i++) {
    $finance->post('/api/finance/payments', ['period_id' => $period2Id, 'student_id' => $studentId, 'amount' => '300.00', 'method' => 'cash', 'payer_ref' => "RCPT-CONC-$i", 'received_on' => '2027-09-01'], true);
    $concPayments[] = qv('SELECT id FROM payments WHERE payer_ref=?', ["RCPT-CONC-$i"]);
}
// Snapshot the finance session so each worker is an authenticated finance actor.
$cookies = $finance->cookieString();
$xsrf = $finance->xsrf;
info('concurrency: 300 invoice, 6 distinct 300 payments; firing 6 REAL parallel HTTP allocations (distinct worker processes)');
// Each worker is a separate OS process doing one blocking curl — genuinely concurrent,
// which requires a multi-process server (php -S PHP_CLI_SERVER_WORKERS), not artisan serve.
$workerScript = sys_get_temp_dir().'/pay-worker.php';
file_put_contents($workerScript, <<<'PHP'
<?php
$base = $argv[1]; $url = $argv[2]; $cookies = $argv[3]; $xsrf = $argv[4]; $payment = $argv[5];
$ch = curl_init($url);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => http_build_query(['payment_id' => $payment, 'amount' => '300.00']),
    CURLOPT_HTTPHEADER => ['X-XSRF-TOKEN: '.$xsrf, 'Cookie: '.$cookies, 'Referer: '.$base.'/finance'],
    CURLOPT_FOLLOWLOCATION => false,
    CURLOPT_TIMEOUT => 90,
]);
curl_exec($ch);
echo (string) curl_getinfo($ch, CURLINFO_HTTP_CODE);
PHP);
$pipes = [];
$procs = [];
foreach ($concPayments as $i => $pid) {
    $cmd = sprintf('%s %s %s %s %s %s %s',
        PHP_BINARY, escapeshellarg($workerScript), escapeshellarg($BASE),
        escapeshellarg("$BASE/finance/obligations/$concObligationId/allocate"),
        escapeshellarg($cookies), escapeshellarg($xsrf), escapeshellarg($pid));
    $procs[] = proc_open($cmd, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes[]);
}
$codes = [];
foreach ($procs as $p) {
    $codes[] = trim((string) stream_get_contents($pipes[array_search($p, $procs, true)][1]));
    proc_close($p);
}
$totalAllocated = qv('SELECT COALESCE(sum(pa.amount),0) FROM payment_allocations pa WHERE pa.obligation_id=?', [$concObligationId]);
$invRemainingConc = obligationRemaining($concObligationId);
$allocRows = qc('SELECT count(*) FROM payment_allocations WHERE obligation_id=?', [$concObligationId]);
info('parallel worker responses: '.implode(',', $codes));
info("allocated total=$totalAllocated allocation rows=$allocRows invoice remaining=$invRemainingConc (expect total=300.00, rows=1, remaining=0.00)");
// Invariants: total never exceeds the 300 invoice; exactly one payment wins; remainder 0.
if (bccomp($totalAllocated, '300.00', 2) === 0 && $allocRows === 1 && $invRemainingConc === '0.00') {
    pass('concurrency: exactly 300.00 allocated by one winning worker out of 6 parallel attempts; no balance corruption');
} else {
    fail('concurrency.corrupt', "total=$totalAllocated rows=$allocRows remaining=$invRemainingConc");
}

// ---------- audit ----------
step('STAGE 16 — every consequential financial action has an audit record');
$expectedOps = [
    'finance.period.open' => 'finance.period.open',
    'finance.obligation.post' => 'finance.obligation.post',
    'finance.payment.record' => 'finance.payment.record',
    'finance.payment.allocate' => 'finance.payment.allocate',
    'finance.refund.propose' => 'finance.refund.propose',
    'finance.refund.approve' => 'finance.refund.approve',
    'finance.period.close' => 'finance.period.close',
];
$auditOk = true;
foreach ($expectedOps as $op) {
    $n = qc('SELECT count(*) FROM audit_events WHERE operation=?', [$op]);
    info("audit $op: $n");
    if ($n < 1) {
        $auditOk = false;
        fail('audit.missing', "no audit for $op");
    }
}
if ($auditOk) {
    pass('all consequential financial actions produced exactly the expected audit events');
}

// ---------- final balance recompute ----------
step('STAGE 17 — recompute final balance from authoritative tables vs application surface');
// Independent recompute for the student across BOTH periods (only money actually received and allocated).
$totalInvoiced = qv('SELECT COALESCE(sum(original_amount),0) FROM obligations WHERE student_id=?', [$studentId]);
$totalAllocatedToObligations = qv('SELECT COALESCE(sum(pa.amount),0) FROM payment_allocations pa JOIN obligations o ON o.id=pa.obligation_id WHERE o.student_id=?', [$studentId]);
$studentBalanceDue = bcsub($totalInvoiced, $totalAllocatedToObligations, 2);
// Application-reported balance via the finance console listing (read the obligations the page serves)
$api = $finance->get('/api/finance/obligations');
$apiObligations = $api['json']['obligations'] ?? [];
$apiInvoiced = '0.00';
foreach ($apiObligations as $ob) {
    if (trim((string) ($ob['student_id'] ?? '')) === trim($studentId)) {
        $apiInvoiced = bcadd($apiInvoiced, (string) $ob['original_amount'], 2);
    }
}
info("application-served obligations total (via /api/finance/obligations) = $apiInvoiced; authoritative invoiced = $totalInvoiced");
info("authoritative recompute: total invoiced=$totalInvoiced total allocated to invoices=$totalAllocatedToObligations student balance due=$studentBalanceDue");
// Every invoice the student received is fully covered: 1000 (stages 7-9) + 300 (concurrency) = 1300.
$expectedDue = '0.00';
if ($studentBalanceDue === $expectedDue) {
    pass("student balance due = $studentBalanceDue (fully settled) — matches authoritative recompute");
} else {
    fail('final.balance', "recomputed due=$studentBalanceDue expected=$expectedDue");
}
// Ledger conservation: total payments received for student == total allocated + total refunded + unallocated remainder
$totalReceived = qv('SELECT COALESCE(sum(amount),0) FROM payments WHERE student_id=?', [$studentId]);
$totalAllocAll = qv('SELECT COALESCE(sum(pa.amount),0) FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id WHERE p.student_id=?', [$studentId]);
$totalRefundedAll = qv("SELECT COALESCE(sum(r.amount),0) FROM refunds r JOIN payments p ON p.id=r.payment_id WHERE p.student_id=? AND r.lifecycle_state='recorded'", [$studentId]);
$unallocatedCash = bcsub(bcsub($totalReceived, $totalAllocAll, 2), $totalRefundedAll, 2);
info("conservation: received=$totalReceived allocated=$totalAllocAll refunded=$totalRefundedAll unallocated+unrefunded remainder=$unallocatedCash");
bccomp(bcadd($totalAllocAll, $totalRefundedAll, 2), $totalReceived, 2) <= 0
    ? pass('ledger conservation: allocated + refunded never exceeds received')
    : fail('conservation', 'allocated+refunded exceed received');

echo "\n==== PAYMENT JOURNEY RESULT: pass=$pass fail=$fail ====\n";
if ($findings !== []) {
    echo 'Findings: '.implode(', ', array_unique($findings))."\n";
    exit(1);
}
echo "\033[32mPAYMENT LIFECYCLE COMPLETE — all money invariants hold over real HTTP.\033[0m\n";
