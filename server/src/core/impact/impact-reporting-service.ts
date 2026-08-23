import type { Database } from 'better-sqlite3';
import { HttpError } from '../../middleware/errorHandler.js';
import { periodBoundariesForKey } from '../calendar/periods.js';
import { id } from '../../utils/ids.js';

export type ImpactScopeKind = 'branch' | 'donor' | 'campaign';

export interface ImpactMetricSnapshot {
  id: string;
  label: string;
  unit: 'afn' | 'count';
  value: number;
  source: string;
}

export interface ImpactReportSnapshot {
  id: string;
  title: string;
  scopeKind: ImpactScopeKind;
  scopeId: string | null;
  period: string;
  periodFrom: string;
  periodTo: string;
  metrics: ImpactMetricSnapshot[];
  narrative: string;
  branchId: string;
}

function scalar(db: Database, sql: string, args: unknown[]): number {
  return Number((db.prepare(sql).get(...args) as { value: number } | undefined)?.value ?? 0);
}

function requireScopeEntity(db: Database, kind: Exclude<ImpactScopeKind, 'branch'>, scopeId: string, branchId: string): void {
  if (kind === 'donor') {
    const row = db.prepare('SELECT id FROM donors WHERE id = ?').get(scopeId);
    if (!row) throw new HttpError(404, 'Donor report scope not found.');
    return;
  }
  const row = db.prepare('SELECT branch_id FROM funding_campaigns WHERE id = ?').get(scopeId) as { branch_id: string } | undefined;
  if (!row) throw new HttpError(404, 'Campaign report scope not found.');
  if (row.branch_id !== branchId) throw new HttpError(400, 'Campaign report scope belongs to another branch.');
}

function aidScopePredicate(scopeKind: ImpactScopeKind, scopeId: string | null): { sql: string; args: string[] } {
  if (scopeKind === 'branch') return { sql: '', args: [] };
  if (!scopeId) throw new HttpError(400, 'A donor or campaign impact report requires scopeId.');
  return scopeKind === 'donor'
    ? { sql: ' AND source_donor_id = ?', args: [scopeId] }
    : { sql: ' AND source_campaign_id = ?', args: [scopeId] };
}

/**
 * The only source graph used for aid-impact claims. A row is eligible only when
 * an active tuition allocation identifies a concrete scholarship funding or
 * sponsorship receipt, which in turn reaches an original donation.
 */
const AID_SOURCE_CTE = `
WITH source_allocations AS (
  SELECT a.id,
         a.amount,
         a.date,
         a.source_kind,
         o.student_id,
         o.branch_id,
         d.donor_id AS source_donor_id,
         COALESCE(sch_entry.campaign_id, spr_entry.campaign_id, d.campaign_id) AS source_campaign_id
    FROM obligation_allocations a
    JOIN student_obligations o ON o.id = a.obligation_id
    LEFT JOIN scholarship_fundings sf ON sf.id = a.scholarship_funding_id
    LEFT JOIN campaign_funding_entries sch_entry ON sch_entry.id = sf.campaign_funding_entry_id
    LEFT JOIN sponsorship_receipts sr ON sr.id = a.sponsorship_receipt_id
    LEFT JOIN campaign_funding_entries spr_entry ON spr_entry.id = sr.campaign_funding_entry_id
    LEFT JOIN donations d ON d.id = COALESCE(sf.donation_id, sr.donation_id, sch_entry.source_donation_id, spr_entry.source_donation_id)
   WHERE a.status = 'active'
     AND a.source_kind IN ('scholarship', 'sponsorship')
)
`;

export function deriveImpactSnapshot(
  db: Database,
  input: { scopeKind: ImpactScopeKind; scopeId?: string | null; branchId: string; period: string },
): Omit<ImpactReportSnapshot, 'id'> {
  const scopeId = input.scopeKind === 'branch' ? null : (typeof input.scopeId === 'string' && input.scopeId.trim() ? input.scopeId.trim() : null);
  if (input.scopeKind !== 'branch' && !scopeId) throw new HttpError(400, 'A donor or campaign impact report requires scopeId.');
  if (scopeId) requireScopeEntity(db, input.scopeKind as Exclude<ImpactScopeKind, 'branch'>, scopeId, input.branchId);

  let span;
  try {
    span = periodBoundariesForKey(input.period);
  } catch (error) {
    throw new HttpError(400, `Impact report period must be a valid Shamsi key. ${error instanceof Error ? error.message : ''}`.trim());
  }

  const donationFilter = input.scopeKind === 'branch'
    ? ''
    : input.scopeKind === 'donor'
      ? ' AND d.donor_id = ?'
      : ' AND d.campaign_id = ?';
  const donationArgs = [input.branchId, span.from, span.to, ...(scopeId ? [scopeId] : [])];
  const donationsReceived = scalar(
    db,
    `SELECT COALESCE(SUM(d.amount), 0) AS value
       FROM donations d
      WHERE d.branch_id = ? AND d.date >= ? AND d.date <= ?${donationFilter}`,
    donationArgs,
  );

  const aidScope = aidScopePredicate(input.scopeKind, scopeId);
  const aidBaseArgs = [input.branchId, span.from, span.to, ...aidScope.args];
  const scholarshipAid = scalar(
    db,
    `${AID_SOURCE_CTE}
     SELECT COALESCE(SUM(amount), 0) AS value
       FROM source_allocations
      WHERE branch_id = ? AND date >= ? AND date <= ? AND source_kind = 'scholarship'${aidScope.sql}`,
    aidBaseArgs,
  );
  const sponsorshipAid = scalar(
    db,
    `${AID_SOURCE_CTE}
     SELECT COALESCE(SUM(amount), 0) AS value
       FROM source_allocations
      WHERE branch_id = ? AND date >= ? AND date <= ? AND source_kind = 'sponsorship'${aidScope.sql}`,
    aidBaseArgs,
  );
  const beneficiaries = scalar(
    db,
    `${AID_SOURCE_CTE}
     SELECT COUNT(DISTINCT student_id) AS value
       FROM source_allocations
      WHERE branch_id = ? AND date >= ? AND date <= ?${aidScope.sql}`,
    aidBaseArgs,
  );

  const metrics: ImpactMetricSnapshot[] = [
    {
      id: 'funding.donations_received',
      label: 'Donations received',
      unit: 'afn',
      value: donationsReceived,
      source: 'donations',
    },
    {
      id: 'funding.scholarship_aid_applied',
      label: 'Scholarship aid applied to tuition',
      unit: 'afn',
      value: scholarshipAid,
      source: 'obligation_allocations → scholarship_fundings',
    },
    {
      id: 'funding.sponsorship_aid_applied',
      label: 'Sponsorship aid applied to tuition',
      unit: 'afn',
      value: sponsorshipAid,
      source: 'obligation_allocations → sponsorship_receipts',
    },
    {
      id: 'funding.aid_beneficiaries',
      label: 'Students with source-traceable aid applied',
      unit: 'count',
      value: beneficiaries,
      source: 'source-aware obligation_allocations',
    },
  ];

  const scopeLabel = input.scopeKind === 'branch'
    ? 'the selected branch'
    : input.scopeKind === 'donor'
      ? 'the selected donor'
      : 'the selected campaign';
  const title = `Impact Report — ${span.periodKey}`;
  const narrative = `For ${scopeLabel} during ${span.periodKey}, ${donationsReceived.toLocaleString()} AFN in donations was received. `
    + `${(scholarshipAid + sponsorshipAid).toLocaleString()} AFN of source-traceable aid was applied to tuition for ${beneficiaries.toLocaleString()} student(s).`;

  return {
    title,
    scopeKind: input.scopeKind,
    scopeId,
    period: span.periodKey,
    periodFrom: span.from,
    periodTo: span.to,
    metrics,
    narrative,
    branchId: input.branchId,
  };
}

export function persistImpactSnapshot(
  db: Database,
  snapshot: Omit<ImpactReportSnapshot, 'id'>,
  generatedBy: string,
  idempotencyKey: string,
): ImpactReportSnapshot {
  if (!db.inTransaction) throw new Error('persistImpactSnapshot() must run inside a transaction.');
  const reportId = id('ir');
  db.prepare(
    `INSERT INTO impact_reports
       (id, title, scope_kind, donor_id, campaign_id, period_key, period_from, period_to,
        generated_by, metrics, narrative, idempotency_key, branch_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    reportId,
    snapshot.title,
    snapshot.scopeKind,
    snapshot.scopeKind === 'donor' ? snapshot.scopeId : null,
    snapshot.scopeKind === 'campaign' ? snapshot.scopeId : null,
    snapshot.period,
    snapshot.periodFrom,
    snapshot.periodTo,
    generatedBy,
    JSON.stringify(snapshot.metrics),
    snapshot.narrative,
    idempotencyKey,
    snapshot.branchId,
  );
  return { id: reportId, ...snapshot };
}
