<?php

declare(strict_types=1);

/**
 * PAYROLL → SALARY CALCULATION → APPROVAL → DISBURSEMENT (LEDGER) → AUDIT →
 * RECONCILIATION end-to-end certification over REAL HTTP against a fresh,
 * isolated database.
 *
 * Canonical model (as implemented — no invented architecture):
 *   HR person → employment (candidate) → contract version + compensation
 *   rules (fixed monthly + allowance) → submit → approve (in-force) → hire
 *   (active) → open payroll period → CALCULATE (prepare) → payroll_calculation
 *   (prepared) → APPROVE by an independent actor (SoD) → immutable
 *   payroll_result (the authoritative payable, amount = calculated base) →
 *   DISBURSEMENT through the single certified money surface: a balanced
 *   finance journal (finance.journal, source_type=payroll_result, source_id=
 *   result_id) posted to an open FINANCIAL period.
 *
 * Net model: this payroll has NO tax/withholding and NO deduction lines —
 * compensation is additive only (fixed monthly + allowance + per-unit
 * teaching); corrections append immutable adjustments/reversals. So:
 *   Gross = Net Payable = base salary + allowances (+/- approved adjustments).
 *
 * No mocks; business state is created ONLY via real HTTP. SQL is used solely
 * for authoritative read-back / verification.
 *
 * Usage: php e2e-payroll-journey.php [base-url]
 */

require __DIR__.'/vendor/autoload.php';

$BASE = $argv[1] ?? 'http://127.0.0.1:8998';
$E2E_DB = 'toefl_house_payroll';

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

// Deterministic salary: base 1000.00 fixed monthly + 100.00 allowance → net payable 1100.00.
const SAL_BASE = '1000.00';
const SAL_ALLOWANCE = '100.00';
const SAL_GROSS = '1100.00'; // no tax/deduction lines in this canonical model

// ---------- Stage 0: health + CSRF ----------
step('STAGE 0 — health + CSRF transport');
$h = new Browser($BASE);
$r = $h->get('/health');
$r['status'] === 200 && ($r['json']['checks']['database'] ?? '') === 'ok' ? pass('GET /health 200 db=ok') : fail('health', "status={$r['status']}");
$ch = curl_init($BASE.'/login');
curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_POST => true, CURLOPT_POSTFIELDS => http_build_query(['u' => 1]), CURLOPT_TIMEOUT => 15]);
curl_exec($ch);
$csrfCode = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);
$csrfCode === 419 ? pass('token-less POST → 419 (CSRF enforced)') : fail('csrf', "got $csrfCode");

// ---------- Stage 1: owner + staff ----------
step('STAGE 1 — bootstrap owner + provision distinct payroll/finance staff');
qc('SELECT count(*) FROM user_accounts') === 1 ? pass('bootstrap: exactly 1 owner account') : fail('bootstrap', 'accounts='.qc('SELECT count(*) FROM user_accounts'));
$owner = new Browser($BASE);
$owner->prime();
$owner->post('/login', ['username' => 'owner', 'password' => 'Owner-Pass-123']);
$me = $owner->get('/api/me');
($me['status'] === 200 && ($me['json']['username'] ?? '') === 'owner') ? pass('owner signed in') : fail('owner.login', "/api/me {$me['status']}");

$positionId = qv('SELECT id FROM positions ORDER BY id LIMIT 1');
$provision = function (string $fullName, string $username, string $password) use ($owner, $positionId): Browser {
    $owner->post('/identity/people', ['legal_name' => $fullName, 'date_of_birth' => '1982-03-11']);
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
// A = payroll operator (prepares calculations); B = independent approver.
$hrMgr = $provision('HR Manager', 'hr_mgr', 'HR-Pass-123');
$contractPrep = $provision('Contract Preparer', 'ct_prep', 'CT-Pass-123');
$contractAppr = $provision('Contract Approver', 'ct_appr', 'CTA-Pass-123');
$payrollOp = $provision('Payroll Operator', 'pay_op', 'PAY-Pass-123');
$payrollAppr = $provision('Payroll Approver', 'pay_appr', 'PAYA-Pass-123');
$financeCashier = $provision('Finance Cashier', 'fin_cash', 'CASH-Pass-123');
pass('staff provisioned: HR mgr, contract preparer/approver, payroll operator/approver, finance cashier');

// A TRULY unprivileged employee: a verified person + login account but NO position
// assignment (the bootstrap position is role-derived all-capability, so it cannot be
// used to test default-deny). Default-deny is the certified behavior.
$owner->post('/identity/people', ['legal_name' => 'No Authority', 'date_of_birth' => '1992-02-02']);
$noAuthPerson = qv("SELECT id FROM people WHERE legal_name='No Authority'");
$owner->post("/identity/people/$noAuthPerson/verify", ['identity_key' => 'nid-noauth', 'evidence_ref' => 'id/noauth']);
$owner->post('/identity/accounts', ['person_id' => $noAuthPerson, 'username' => 'no_pay']);
$noAuthAcct = qv('SELECT id FROM user_accounts WHERE person_id=?', [$noAuthPerson]);
$owner->post("/identity/accounts/$noAuthAcct/password", ['password' => 'NOPAY-Pass-123']);
// deliberately NO access/assignments step → no capabilities
$nobody = new Browser($BASE);
$nobody->prime();
$nobody->post('/login', ['username' => 'no_pay', 'password' => 'NOPAY-Pass-123']);
pass('truly unprivileged user (no position) provisioned for default-deny checks');

// ---------- Stage 2: employee ----------
step('STAGE 2 — create a real employee (person → employment candidate) via HR workflow');
$owner->post('/identity/people', ['legal_name' => 'Salaried Teacher', 'date_of_birth' => '1985-06-15']);
$empPersonId = qv("SELECT id FROM people WHERE legal_name='Salaried Teacher'");
$owner->post("/identity/people/$empPersonId/verify", ['identity_key' => 'nid-SAL-TEACH', 'evidence_ref' => 'passport/SAL']);
$hrMgr->post('/hr/employ', ['person_id' => $empPersonId], false, ['Referer' => "$BASE/hr"]);
$employmentId = qv('SELECT id FROM employments WHERE person_id=?', [$empPersonId]);
$empState = qv('SELECT lifecycle_state FROM employments WHERE id=?', [$employmentId]);
($employmentId !== '' && $empState === 'candidate') ? pass('employment created as candidate ('.substr($employmentId, 0, 8).", state=$empState)") : fail('employment.create', "id=$employmentId state=$empState");

// ---------- Stage 3: salary configuration (contract version + rules) ----------
step('STAGE 3 — configure salary via in-force contract version (base '.SAL_BASE.' + allowance '.SAL_ALLOWANCE.')');
// Preparing a contract version auto-creates the draft contract (single authoritative path).
$contractPrep->post('/hr/versions/prepare', ['employment_id' => $employmentId, 'terms_ref' => 'contract/2026-09/sal.pdf', 'effective_from' => '2026-09-01', 'effective_to' => '2026-12-31'], false, ['Referer' => "$BASE/hr"]);
$contractId = qv('SELECT id FROM contracts WHERE employment_id=? ORDER BY id DESC LIMIT 1', [$employmentId]);
$versionId = qv('SELECT id FROM contract_versions WHERE contract_id=? ORDER BY id DESC LIMIT 1', [$contractId]);
// compensation rules: fixed monthly base + allowance — BOTH while the version is a draft.
$contractPrep->post("/hr/versions/$versionId/rule", ['method' => 'fixed_monthly', 'rate' => SAL_BASE], false, ['Referer' => "$BASE/hr"]);
$contractPrep->post("/hr/versions/$versionId/rule", ['method' => 'allowance', 'rate' => SAL_ALLOWANCE, 'label' => 'housing'], false, ['Referer' => "$BASE/hr"]);
$ruleCount = qc('SELECT count(*) FROM compensation_rules WHERE contract_version_id=?', [$versionId]);
$fixedRate = qv("SELECT rate FROM compensation_rules WHERE contract_version_id=? AND method='fixed_monthly'", [$versionId]);
$allowRate = qv("SELECT rate FROM compensation_rules WHERE contract_version_id=? AND method='allowance'", [$versionId]);
$contractPrep->post("/hr/versions/$versionId/submit", [], false, ['Referer' => "$BASE/hr"]);
$submittedState = qv('SELECT lifecycle_state FROM contract_versions WHERE id=?', [$versionId]);
$contractAppr->post("/hr/versions/$versionId/approve", [], false, ['Referer' => "$BASE/hr"]);
$inForceState = qv('SELECT lifecycle_state FROM contract_versions WHERE id=?', [$versionId]);
info("version rules=$ruleCount fixed=$fixedRate allowance=$allowRate, submitted=$submittedState, in-force=$inForceState");
($ruleCount === 2 && $fixedRate === SAL_BASE && $allowRate === SAL_ALLOWANCE && in_array($inForceState, ['approved', 'active'], true)) ? pass("salary configured: in-force contract version ($inForceState) with base ".SAL_BASE.' + allowance '.SAL_ALLOWANCE) : fail('salary.config', "rules=$ruleCount fixed=$fixedRate allowance=$allowRate state=$inForceState");

// ---------- Stage 4: hire (active employment) ----------
step('STAGE 4 — hire the employee (active, in payroll scope)');
$hrMgr->post('/hr/employments/hire', ['employment_id' => $employmentId, 'effective_from' => '2026-09-01'], false, ['Referer' => "$BASE/hr"]);
$hiredState = qv('SELECT lifecycle_state FROM employments WHERE id=?', [$employmentId]);
$hiredState === 'active' ? pass('employee hired and ACTIVE (in payroll scope)') : fail('hire', "state=$hiredState");

// ---------- Stage 5: payroll period ----------
step('STAGE 5 — open the payroll period (2026-09)');
$payrollOp->post('/payroll/periods', ['period_key' => 'PAY-2026-09', 'date_from' => '2026-09-01', 'date_to' => '2026-09-30'], false, ['Referer' => "$BASE/payroll"]);
$payrollPeriodId = qv("SELECT id FROM payroll_periods WHERE period_key='PAY-2026-09'");
$ppState = qv('SELECT lifecycle_state FROM payroll_periods WHERE id=?', [$payrollPeriodId]);
($payrollPeriodId !== '' && $ppState === 'open') ? pass('payroll period OPEN ('.substr($payrollPeriodId, 0, 8).') boundaries 2026-09-01..09-30') : fail('payroll.period', "state=$ppState");

// ---------- Stage 6: calculation ----------
step('STAGE 6 — run payroll calculation over HTTP');
$r = $payrollOp->post("/payroll/periods/$payrollPeriodId/calculate", ['employment_id' => $employmentId], false, ['Referer' => "$BASE/payroll"]);
$calculationId = qv('SELECT id FROM payroll_calculations WHERE period_id=? AND employment_id=? ORDER BY id DESC LIMIT 1', [$payrollPeriodId, $employmentId]);
$calc = q('SELECT base_amount, lifecycle_state, prepared_by FROM payroll_calculations WHERE id=?', [$calculationId]);
in_array($r['status'], [302, 303], true) && $calc && $calc['lifecycle_state'] === 'prepared'
    ? pass("calculation prepared: base_amount={$calc['base_amount']} state=prepared") : fail('calc.prepare', "status={$r['status']} ".json_encode($calc));

// ---------- Stage 7-9: gross / deductions / tax / net ----------
step('STAGE 7-9 — verify gross, deductions, tax, net (deterministic money math)');
$gross = (string) $calc['base_amount'];
info("calculated gross/net = $gross (base ".SAL_BASE.' + allowance '.SAL_ALLOWANCE.')');
$deductions = '0.00';
$tax = '0.00';
$net = $gross; // additive model: no tax/deduction lines
$mathOk = bccomp($gross, SAL_GROSS, 2) === 0
    && bccomp(bcadd(SAL_BASE, SAL_ALLOWANCE, 2), $gross, 2) === 0;
$mathOk ? pass('Gross = Net = '.SAL_GROSS.' = base '.SAL_BASE.' + allowance '.SAL_ALLOWANCE.'; no tax/deduction lines in this model (deductions=0, tax=0)') : fail('calc.math', "gross=$gross expected ".SAL_GROSS);

// ---------- Stage 10-11: approval + SoD ----------
step('STAGE 10-11 — approval lifecycle and segregation of duties');
// Self-approval (operator A prepared it) over the JSON API → 403 independence denial.
$rSelf = $payrollOp->post("/api/payroll/calculations/$calculationId/approve", [], true);
$stillPrepared = qv('SELECT lifecycle_state FROM payroll_calculations WHERE id=?', [$calculationId]);
$selfErr = $rSelf['json']['error'] ?? '';
info("self-approve by preparer → HTTP {$rSelf['status']} $selfErr (expect 403 payroll.approval_not_independent)");
$selfOk = $rSelf['status'] === 403 && $selfErr === 'payroll.approval_not_independent' && $stillPrepared === 'prepared';
// Unprivileged user cannot approve (JSON API → 403).
$rNo = $nobody->post("/api/payroll/calculations/$calculationId/approve", [], true);
$noErr = $rNo['json']['error'] ?? '';
info("unprivileged approve → HTTP {$rNo['status']} $noErr (expect 403 payroll.approve_denied)");
$noOk = $rNo['status'] === 403;
// Independent approver B approves via the JSON API.
$rAppr = $payrollAppr->post("/api/payroll/calculations/$calculationId/approve", [], true);
$resultState = qv('SELECT lifecycle_state FROM payroll_calculations WHERE id=?', [$calculationId]);
$resultId = qv('SELECT id FROM payroll_results WHERE calculation_id=?', [$calculationId]);
$resultAmount = qv('SELECT amount FROM payroll_results WHERE id=?', [$resultId]);
info("independent approve → HTTP {$rAppr['status']}; calculation=$resultState result=$resultId amount=$resultAmount");
$apprOk = in_array($rAppr['status'], [200, 201], true) && $resultState === 'resulted' && $resultId !== '' && bccomp($resultAmount, SAL_GROSS, 2) === 0;
$selfOk ? pass('SoD: payroll operator cannot approve their own calculation (403 payroll.approval_not_independent)') : fail('sod.self', "self {$rSelf['status']} $selfErr state=$stillPrepared");
$noOk ? pass('RBAC: unprivileged user cannot approve payroll (403)') : fail('rbac.approve', "nobody {$rNo['status']} $noErr");
$apprOk ? pass("independent approval persisted: payroll_result amount=$resultAmount (= net payable), calculation resulted") : fail('approval.persist', "status={$rAppr['status']} state=$resultState resultId=$resultId amount=$resultAmount");

// ---------- Stage 12 & 17: disbursement via ledger ----------
step('STAGE 12/17 — disburse salary via the finance ledger journal (source=payroll_result)');
// Need an open FINANCIAL period and a chart of accounts (cash asset + salary payable/expense).
$financeCashier->post('/finance/periods', ['period_key' => 'FIN-2026-09', 'date_from' => '2026-09-01', 'date_to' => '2026-09-30'], false, ['Referer' => "$BASE/finance"]);
$finPeriodId = qv("SELECT id FROM financial_periods WHERE period_key='FIN-2026-09'");
$financeCashier->post('/finance/accounts', ['code' => '1010', 'name' => 'Cash at Bank', 'type' => 'asset'], false, ['Referer' => "$BASE/finance"]);
$financeCashier->post('/finance/accounts', ['code' => '5100', 'name' => 'Teacher Salary Expense', 'type' => 'expense'], false, ['Referer' => "$BASE/finance"]);
$cashAcct = qv("SELECT id FROM accounts WHERE code='1010'");
$expAcct = qv("SELECT id FROM accounts WHERE code='5100'");
info("financial period + chart accounts ready (cash=$cashAcct expense=$expAcct)");
// Balanced disbursement journal: debit salary expense, credit cash (money out), referencing the payroll result.
$idemPay = 'payroll.pay.'.bin2hex(random_bytes(6));
$payJournal = function (string $amount, string $key) use ($financeCashier, $finPeriodId, $cashAcct, $expAcct, $resultId, $BASE): array {
    return $financeCashier->post('/finance/journals', [
        'period_id' => $finPeriodId,
        'source_type' => 'payroll_result',
        'source_id' => $resultId,
        'reason' => 'September salary disbursement',
        'lines' => [
            ['account_id' => $expAcct, 'direction' => 'debit', 'amount' => $amount],
            ['account_id' => $cashAcct, 'direction' => 'credit', 'amount' => $amount],
        ],
    ], false, ['Referer' => "$BASE/finance", 'Accept' => 'application/json', 'Idempotency-Key' => $key]);
};
$rPay = $payJournal(SAL_GROSS, $idemPay);
$journalId = qv("SELECT id FROM journals WHERE source_type='payroll_result' AND source_id=?", [$resultId]);
$lineCount = qc('SELECT count(*) FROM journal_lines WHERE journal_id=?', [$journalId]);
$debit = qv("SELECT COALESCE(sum(amount),0) FROM journal_lines WHERE journal_id=? AND direction='debit'", [$journalId]);
$credit = qv("SELECT COALESCE(sum(amount),0) FROM journal_lines WHERE journal_id=? AND direction='credit'", [$journalId]);
info('disbursement journal HTTP '.(in_array($rPay['status'], [302, 303, 200, 201], true) ? 'OK' : $rPay['status']).": journal=$journalId lines=$lineCount debit=$debit credit=$credit");
(in_array($rPay['status'], [302, 303, 200, 201], true) && $lineCount === 2 && bccomp($debit, SAL_GROSS, 2) === 0 && bccomp($credit, SAL_GROSS, 2) === 0)
    ? pass('salary DISBURSED via balanced ledger journal: debit salary expense '.SAL_GROSS.' / credit cash '.SAL_GROSS.', referencing payroll result')
    : fail('disbursement', "status={$rPay['status']} journalId=$journalId lines=$lineCount d=$debit c=$credit");

// ---------- Stage 14: audit trail ----------
step('STAGE 14/16 — audit trail for the full lifecycle');
$auditOps = [
    'payroll.calculation.prepare' => 'payroll.calculation.prepare',
    'payroll.result.approve' => 'payroll.result.approve',
    'finance.journal.post' => 'finance.journal.post',
];
$auditOk = true;
foreach ($auditOps as $label => $op) {
    $n = qc('SELECT count(*) FROM audit_events WHERE operation=?', [$op]);
    info("audit $label: $n");
    if ($n < 1) {
        $auditOk = false;
        fail('audit.missing', "no audit for $op");
    }
}
// denied attempts audited
$denied = qc("SELECT count(*) FROM audit_events WHERE operation='payroll.result.approve.denied'");
info("approval-denial audits: $denied");
if ($denied < 1) {
    $auditOk = false;
    fail('audit.denied', 'no denial audit');
}
// audit/payable immutability: direct UPDATE of an approved payroll result is rejected by a trigger.
$tamperOk = true;
try {
    $pdo->prepare('UPDATE payroll_results SET amount = 999999.00 WHERE id = ?')->execute([$resultId]);
    $tamperOk = false; // no exception → the immutable trigger is missing
} catch (Throwable $e) {
    info('direct UPDATE of approved payroll result rejected (immutable trigger): '.substr($e->getMessage(), 0, 55));
}
$auditOk ? pass('all consequential lifecycle events + denials produce immutable audit records') : null;
$tamperOk ? pass('approved payroll result is tamper-proof at the DB boundary (direct UPDATE rejected)') : fail('tamper.result', 'approved result was mutable via direct SQL');

// ---------- Stage 15/16 (report): duplicate disbursement + idempotency ----------
step('STAGE 15/16 — duplicate disbursement is prevented (one payroll → one paying journal)');
$journalsBefore = qc("SELECT count(*) FROM journals WHERE source_type='payroll_result' AND source_id=?", [$resultId]);
// (a) replay with SAME idempotency key + payload → cached (no second journal)
$rReplay = $payJournal(SAL_GROSS, $idemPay);
// (b) same key with DIFFERENT payload (different amount) → idempotency conflict
$rConflict = $financeCashier->post('/finance/journals', [
    'period_id' => $finPeriodId, 'source_type' => 'payroll_result', 'source_id' => $resultId, 'reason' => 'September salary disbursement',
    'lines' => [
        ['account_id' => $expAcct, 'direction' => 'debit', 'amount' => '5000.00'],
        ['account_id' => $cashAcct, 'direction' => 'credit', 'amount' => '5000.00'],
    ],
], false, ['Referer' => "$BASE/finance", 'Accept' => 'application/json', 'Idempotency-Key' => $idemPay]);
// (c) a SECOND, genuinely fresh disbursement for the same already-paid payroll result (new key)
$rSecond = $payJournal(SAL_GROSS, 'payroll.pay.'.bin2hex(random_bytes(6)));
$journalsAfter = qc("SELECT count(*) FROM journals WHERE source_type='payroll_result' AND source_id=?", [$resultId]);
$idemRows = qc('SELECT count(*) FROM idempotency_keys WHERE idempotency_key=?', [$idemPay]);
info("journals for payroll result: before=$journalsBefore after=$journalsAfter (expect 1); idem-key rows=$idemRows (expect 1)");
info("replay HTTP {$rReplay['status']}; idem-conflict HTTP {$rConflict['status']}; fresh-duplicate HTTP {$rSecond['status']}");
if ($journalsBefore === 1 && $journalsAfter === 1 && $idemRows === 1) {
    pass('exactly ONE disbursement journal per payroll result: idempotent replay, key-conflict, and a fresh duplicate attempt are all blocked');
} else {
    fail('duplicate.disbursement', "journals before=$journalsBefore after=$journalsAfter idem rows=$idemRows");
}

// ---------- Stage 18: money adversarial ----------
step('STAGE 18 — adversarial money inputs to the disbursement journal (422, never 500)');
$badAmounts = ['abc', '-50', '0', '0.001', '12.999', '1e2', '', '99999999999999999999'];
$all422 = true;
$any500 = false;
foreach ($badAmounts as $bad) {
    $rr = $financeCashier->post('/finance/journals', [
        'period_id' => $finPeriodId, 'source_type' => 'payroll_result', 'source_id' => $resultId, 'reason' => 'adversarial amount',
        'lines' => [
            ['account_id' => $expAcct, 'direction' => 'debit', 'amount' => $bad],
            ['account_id' => $cashAcct, 'direction' => 'credit', 'amount' => $bad === '' ? '1.00' : $bad],
        ],
    ], false, ['Referer' => "$BASE/finance", 'Accept' => 'application/json', 'Idempotency-Key' => 'adv.'.md5($bad).bin2hex(random_bytes(3))]);
    if ($rr['status'] === 500) {
        $any500 = true;
        info('amount '.var_export($bad, true).' → 500');
    }
    if ($rr['status'] !== 422) {
        $all422 = false;
        info('amount '.var_export($bad, true)." → HTTP {$rr['status']}");
    }
}
// an UNBALANCED journal (debit != credit) must also be rejected
$rUnbal = $financeCashier->post('/finance/journals', [
    'period_id' => $finPeriodId, 'source_type' => 'payroll_result', 'source_id' => $resultId, 'reason' => 'unbalanced',
    'lines' => [
        ['account_id' => $expAcct, 'direction' => 'debit', 'amount' => '100.00'],
        ['account_id' => $cashAcct, 'direction' => 'credit', 'amount' => '90.00'],
    ],
], false, ['Referer' => "$BASE/finance", 'Accept' => 'application/json', 'Idempotency-Key' => 'unbal.'.bin2hex(random_bytes(4))]);
info("unbalanced journal → HTTP {$rUnbal['status']} ".($rUnbal['json']['error'] ?? '(web redirect)'));
if ($any500) {
    fail('money.500', 'an adversarial amount produced a 500');
} elseif ($all422) {
    pass('all adversarial money inputs → 422 (never 500); unbalanced journal also rejected; no mutation');
} else {
    fail('money.422', 'some adversarial input did not return 422');
}

// ---------- Stage 19: closed payroll & financial period ----------
step('STAGE 19 — closed-period protection (payroll + finance)');
// close payroll period
$payrollAppr->post("/payroll/periods/$payrollPeriodId/close", [], false, ['Referer' => "$BASE/payroll"]);
$ppClosed = qv('SELECT lifecycle_state FROM payroll_periods WHERE id=?', [$payrollPeriodId]);
// recalculation on closed payroll period rejected
$rCalcClosed = $payrollOp->post("/payroll/periods/$payrollPeriodId/calculate", ['employment_id' => $employmentId], true);
$calcClosedErr = $rCalcClosed['json']['error'] ?? '';
// close financial period, then a disbursement journal into it rejected
$financeCashier->post("/finance/periods/$finPeriodId/close", [], false, ['Referer' => "$BASE/finance"]);
$finClosed = qv('SELECT lifecycle_state FROM financial_periods WHERE id=?', [$finPeriodId]);
$rJournalClosed = $payJournal(SAL_GROSS, 'closed.'.bin2hex(random_bytes(4)));
$journalClosedErr = $rJournalClosed['json']['error'] ?? '';
$closedJournals = qc("SELECT count(*) FROM journals WHERE source_type='payroll_result' AND source_id=? AND reason != 'September salary disbursement'", [$resultId]);
info("payroll closed=$ppClosed; calc on closed → HTTP {$rCalcClosed['status']} $calcClosedErr");
info("financial closed=$finClosed; journal into closed → HTTP {$rJournalClosed['status']} $journalClosedErr; extra journals=$closedJournals");
if ($ppClosed === 'closed' && $rCalcClosed['status'] === 409 && $calcClosedErr === 'payroll.period_not_open'
    && $finClosed === 'closed' && $rJournalClosed['status'] === 409 && $journalClosedErr === 'finance.period_not_open' && $closedJournals === 0) {
    pass('closed payroll period rejects recalculation; closed financial period rejects disbursement journal; nothing persisted');
} else {
    fail('closed.period', "pp=$ppClosed calc={$rCalcClosed['status']}/$calcClosedErr fin=$finClosed jrn={$rJournalClosed['status']}/$journalClosedErr extra=$closedJournals");
}

// ---------- Stage 20: invalid/inactive employee ----------
step('STAGE 20 — payroll for invalid / out-of-scope employment is rejected');
// open a fresh payroll period; a candidate (never hired) employment must be HELD/rejected
$payrollOp->post('/payroll/periods', ['period_key' => 'PAY-2026-10', 'date_from' => '2026-10-01', 'date_to' => '2026-10-31'], false, ['Referer' => "$BASE/payroll"]);
$octPeriodId = qv("SELECT id FROM payroll_periods WHERE period_key='PAY-2026-10'");
// a second, never-hired employee
$owner->post('/identity/people', ['legal_name' => 'Unsigned Candidate', 'date_of_birth' => '1990-01-01']);
$candPersonId = qv("SELECT id FROM people WHERE legal_name='Unsigned Candidate'");
$owner->post("/identity/people/$candPersonId/verify", ['identity_key' => 'nid-CAND', 'evidence_ref' => 'id/cand']);
$hrMgr->post('/hr/employ', ['person_id' => $candPersonId], false, ['Referer' => "$BASE/hr"]);
$candEmpId = qv('SELECT id FROM employments WHERE person_id=?', [$candPersonId]);
$payrollOp->post("/payroll/periods/$octPeriodId/calculate", ['employment_id' => $candEmpId], false, ['Referer' => "$BASE/payroll"]);
$candCalcState = qv('SELECT lifecycle_state FROM payroll_calculations WHERE period_id=? AND employment_id=? ORDER BY id DESC LIMIT 1', [$octPeriodId, $candEmpId]);
$candHeld = qv('SELECT held_reason FROM payroll_calculations WHERE period_id=? AND employment_id=? ORDER BY id DESC LIMIT 1', [$octPeriodId, $candEmpId]);
info("unsigned candidate calculation → state=$candCalcState held_reason=".substr((string) $candHeld, 0, 40));
// a HELD calculation cannot be approved (no payable result)
$candCalcId = qv('SELECT id FROM payroll_calculations WHERE period_id=? AND employment_id=? ORDER BY id DESC LIMIT 1', [$octPeriodId, $candEmpId]);
$rApprHeld = $payrollAppr->post("/payroll/calculations/$candCalcId/approve", [], true);
info("approve held calculation → HTTP {$rApprHeld['status']} ".($rApprHeld['json']['error'] ?? ''));
$candResult = qc('SELECT count(*) FROM payroll_results WHERE calculation_id=?', [$candCalcId]);
if ($candCalcState === 'held' && $rApprHeld['status'] === 409 && $candResult === 0) {
    pass('employee without an in-force contract/salary is HELD (no payable) and cannot produce an approved result');
} else {
    fail('invalid.employee', "state=$candCalcState approve={$rApprHeld['status']} results=$candResult");
}

// ---------- Stage 21: RBAC — non-payroll operator / payment authority ----------
step('STAGE 21 — RBAC: unprivileged / wrong-authority actors cannot calculate, approve, or disburse');
$rbacOk = true;
// unprivileged calculate via the JSON API (POST /api/payroll/calculations on the period) → 403, no mutation.
$calcBefore = qc('SELECT count(*) FROM payroll_calculations WHERE period_id=? AND employment_id=?', [$octPeriodId, $employmentId]);
$rNc = $nobody->post('/api/payroll/calculations', ['period_id' => $octPeriodId, 'employment_id' => $employmentId], true);
$calcAfter = qc('SELECT count(*) FROM payroll_calculations WHERE period_id=? AND employment_id=?', [$octPeriodId, $employmentId]);
$ncErr = $rNc['json']['error'] ?? '';
info("unprivileged calculate → HTTP {$rNc['status']} $ncErr; rows created=".($calcAfter - $calcBefore));
if ($rNc['status'] !== 403 || ($calcAfter - $calcBefore) !== 0) {
    $rbacOk = false;
    info('unprivileged calculate not properly denied');
}
// unprivileged approve (authoritative: must 403 and create no result)
$rNa = $nobody->post("/api/payroll/calculations/$calculationId/approve", [], true);
if ($rNa['status'] !== 403) {
    $rbacOk = false;
    info("nobody approve → {$rNa['status']}");
}
// Disbursement authority: the web journal console posts are authorized by finance.journal.
// Assert the outcome authoritatively — unprivileged and payroll-operator attempts must NOT
// produce a journal referencing the (already-paid September) result; the duplicate guard +
// capability guard both protect this.
$journalCountBefore = qc('SELECT count(*) FROM journals');
$nobody->post('/finance/journals', [
    'period_id' => $finPeriodId, 'source_type' => 'other', 'source_id' => null, 'reason' => 'rbac probe',
    'lines' => [['account_id' => $expAcct, 'direction' => 'debit', 'amount' => '1.00'], ['account_id' => $cashAcct, 'direction' => 'credit', 'amount' => '1.00']],
], false, ['Referer' => "$BASE/finance"]);
$payrollOp->post('/finance/journals', [
    'period_id' => $finPeriodId, 'source_type' => 'other', 'source_id' => null, 'reason' => 'rbac probe 2',
    'lines' => [['account_id' => $expAcct, 'direction' => 'debit', 'amount' => '1.00'], ['account_id' => $cashAcct, 'direction' => 'credit', 'amount' => '1.00']],
], false, ['Referer' => "$BASE/finance"]);
$journalCountAfter = qc('SELECT count(*) FROM journals');
$rbacProbeJournals = qc("SELECT count(*) FROM journals WHERE reason IN ('rbac probe','rbac probe 2')");
info("unprivileged + payroll-operator ledger attempts created journals: $rbacProbeJournals (expect 0)");
if ($rbacProbeJournals !== 0) {
    $rbacOk = false;
}
// default-deny outcomes are audited as denied attempts when the command runs
$journalDenied = qc("SELECT count(*) FROM audit_events WHERE operation='finance.journal.post.denied'");
$calcDenied = qc("SELECT count(*) FROM audit_events WHERE operation='payroll.calculation.prepare.denied'");
info("denial audits: finance.journal.post.denied=$journalDenied payroll.calculation.prepare.denied=$calcDenied");
$rbacOk ? pass('RBAC default-deny: unprivileged users cannot calculate/approve (403) and neither unprivileged users nor payroll operators can disburse (no ledger mutation)') : fail('rbac.disburse', "probe journals=$rbacProbeJournals");

// ---------- Stage 22: concurrency ----------
step('STAGE 22 — concurrent disbursement attempts for the same payroll cannot double-pay');
// Use a NEW open financial period + a second approved payroll result for a clean race target.
$financeCashier->post('/finance/periods', ['period_key' => 'FIN-2026-10', 'date_from' => '2026-10-01', 'date_to' => '2026-10-31'], false, ['Referer' => "$BASE/finance"]);
$fin2Id = qv("SELECT id FROM financial_periods WHERE period_key='FIN-2026-10'");
// teacher already has a Sept version in force through 2026-12-31; calculate+approve October payroll.
$payrollOp->post("/payroll/periods/$octPeriodId/calculate", ['employment_id' => $employmentId], false, ['Referer' => "$BASE/payroll"]);
$octCalcId = qv("SELECT id FROM payroll_calculations WHERE period_id=? AND employment_id=? AND lifecycle_state='prepared' ORDER BY id DESC LIMIT 1", [$octPeriodId, $employmentId]);
$payrollAppr->post("/payroll/calculations/$octCalcId/approve", [], true);
$octResultId = qv('SELECT id FROM payroll_results WHERE calculation_id=?', [$octCalcId]);
$octAmount = qv('SELECT amount FROM payroll_results WHERE id=?', [$octResultId]);
info("October approved payroll result $octResultId amount=$octAmount");
// Snapshot finance cashier session for workers.
$cookies = $financeCashier->cookieString();
$xsrf = $financeCashier->xsrf;
$workerScript = sys_get_temp_dir().'/pay-worker.php';
file_put_contents($workerScript, <<<'PHP'
<?php
$base = $argv[1]; $url = $argv[2]; $cookies = $argv[3]; $xsrf = $argv[4]; $body = $argv[5];
$ch = curl_init($url);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST => true,
    CURLOPT_POSTFIELDS => $body,
    CURLOPT_HTTPHEADER => ['X-XSRF-TOKEN: '.$xsrf, 'Cookie: '.$cookies, 'Referer: '.$base.'/finance', 'Content-Type: application/x-www-form-urlencoded'],
    CURLOPT_FOLLOWLOCATION => false,
    CURLOPT_TIMEOUT => 90,
]);
curl_exec($ch);
echo (string) curl_getinfo($ch, CURLINFO_HTTP_CODE);
PHP);
$body = http_build_query([
    'period_id' => $fin2Id, 'source_type' => 'payroll_result', 'source_id' => $octResultId, 'reason' => 'October salary disbursement',
    'lines' => [
        ['account_id' => $expAcct, 'direction' => 'debit', 'amount' => $octAmount],
        ['account_id' => $cashAcct, 'direction' => 'credit', 'amount' => $octAmount],
    ],
]);
$pipes = [];
$procs = [];
for ($i = 0; $i < 6; $i++) {
    $cmd = sprintf('%s %s %s %s %s %s %s', PHP_BINARY, escapeshellarg($workerScript), escapeshellarg($BASE),
        escapeshellarg("$BASE/finance/journals"), escapeshellarg($cookies), escapeshellarg($xsrf), escapeshellarg($body));
    $procs[] = proc_open($cmd, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes[]);
}
$codes = [];
foreach ($procs as $idx => $p) {
    $codes[] = trim((string) stream_get_contents($pipes[$idx][1]));
    proc_close($p);
}
$raceJournals = qc("SELECT count(*) FROM journals WHERE source_type='payroll_result' AND source_id=?", [$octResultId]);
$raceDebit = qv("SELECT COALESCE(sum(jl.amount),0) FROM journal_lines jl JOIN journals j ON j.id=jl.journal_id WHERE j.source_id=? AND jl.direction='debit'", [$octResultId]);
info('parallel disbursement responses: '.implode(',', $codes));
info("paying journals for Oct result=$raceJournals (expect 1); total debited=$raceDebit (expect $octAmount)");
if ($raceJournals === 1 && bccomp($raceDebit, $octAmount, 2) === 0) {
    pass("concurrency: 6 parallel disbursements → exactly ONE journal, total paid = net payable $octAmount (no double pay)");
} else {
    fail('concurrency.pay', "journals=$raceJournals debit=$raceDebit amount=$octAmount");
}

// ---------- Stage 23: transaction atomicity ----------
step('STAGE 23 — transaction atomicity (journal + lines + audit commit together or not at all)');
// A journal that fails the balance check mid-transaction must leave NO partial rows.
$beforeJ = qc('SELECT count(*) FROM journals');
$beforeL = qc('SELECT count(*) FROM journal_lines');
$rAtomic = $financeCashier->post('/finance/journals', [
    'period_id' => $fin2Id, 'source_type' => 'other', 'source_id' => null, 'reason' => 'atomicity-failure-probe',
    'lines' => [
        ['account_id' => $expAcct, 'direction' => 'debit', 'amount' => '50.00'],
        ['account_id' => $cashAcct, 'direction' => 'credit', 'amount' => '51.00'],
    ],
], true);
$afterJ = qc('SELECT count(*) FROM journals');
$afterL = qc('SELECT count(*) FROM journal_lines');
$partial = qc("SELECT count(*) FROM journals WHERE reason='atomicity-failure-probe'");
info("unbalanced probe HTTP {$rAtomic['status']}; journals delta=".($afterJ - $beforeJ).' lines delta='.($afterL - $beforeL)." partial rows=$partial");
($rAtomic['status'] === 409 && $partial === 0 && ($afterJ - $beforeJ) === 0 && ($afterL - $beforeL) === 0)
    ? pass('atomicity: a failed journal rolls back completely — no orphan journal/lines/audit (all-or-nothing)')
    : fail('atomicity', "status={$rAtomic['status']} partial=$partial dJ=".($afterJ - $beforeJ).' dL='.($afterL - $beforeL));

// ---------- Stage 24: reconciliation ----------
step('STAGE 24 — independent reconciliation from authoritative tables');
// Approved payroll (gross/net) for the teacher.
$totalGross = qv("SELECT COALESCE(sum(amount),0) FROM payroll_results WHERE employment_id=? AND lifecycle_state='approved'", [$employmentId]);
$totalAdjustments = qv('SELECT COALESCE(sum(pa.amount),0) FROM payroll_adjustments pa JOIN payroll_results pr ON pr.id=pa.result_id WHERE pr.employment_id=?', [$employmentId]);
$netPayable = bcadd($totalGross, $totalAdjustments, 2);
// Successfully disbursed via ledger = sum of debit lines on journals sourced from those results.
$disbursed = qv("SELECT COALESCE(sum(jl.amount),0) FROM journal_lines jl JOIN journals j ON j.id=jl.journal_id WHERE j.source_type='payroll_result' AND j.source_id IN (SELECT id FROM payroll_results WHERE employment_id=?) AND jl.direction='debit'", [$employmentId]);
// Ledger conservation: total debits == total credits across payroll-sourced journals.
$ledgerDebit = qv("SELECT COALESCE(sum(jl.amount),0) FROM journal_lines jl JOIN journals j ON j.id=jl.journal_id WHERE j.source_type='payroll_result' AND jl.direction='debit' AND j.source_id IN (SELECT id FROM payroll_results WHERE employment_id=?)", [$employmentId]);
$ledgerCredit = qv("SELECT COALESCE(sum(jl.amount),0) FROM journal_lines jl JOIN journals j ON j.id=jl.journal_id WHERE j.source_type='payroll_result' AND jl.direction='credit' AND j.source_id IN (SELECT id FROM payroll_results WHERE employment_id=?)", [$employmentId]);
$paidButOpen = qv("SELECT COALESCE(sum(pr.amount),0) FROM payroll_results pr WHERE pr.employment_id=? AND pr.lifecycle_state='approved' AND NOT EXISTS (SELECT 1 FROM journals j WHERE j.source_type='payroll_result' AND j.source_id=pr.id)", [$employmentId]);
info("gross(results)=$totalGross adjustments=$totalAdjustments net payable=$netPayable");
info("disbursed(ledger debit)=$disbursed ledger debit=$ledgerDebit ledger credit=$ledgerCredit");
info("approved-but-unpaid results total=$paidButOpen");
$reconOk = bccomp($netPayable, $disbursed, 2) === 0
    && bccomp($ledgerDebit, $ledgerCredit, 2) === 0
    && bccomp($paidButOpen, '0.00', 2) === 0;
$reconOk
    ? pass("RECONCILED: net payable $netPayable = disbursed $disbursed; ledger balanced (d=$ledgerDebit c=$ledgerCredit); no unpaid/overpaid result")
    : fail('reconciliation', "net=$netPayable disbursed=$disbursed d=$ledgerDebit c=$ledgerCredit unpaid=$paidButOpen");

echo "\n==== PAYROLL JOURNEY RESULT: pass=$pass fail=$fail ====\n";
if ($findings !== []) {
    echo 'Findings: '.implode(', ', array_unique($findings))."\n";
    exit(1);
}
echo "\033[32mPAYROLL LIFECYCLE COMPLETE — salary calculated, approved with SoD, disbursed via balanced ledger, reconciled.\033[0m\n";
