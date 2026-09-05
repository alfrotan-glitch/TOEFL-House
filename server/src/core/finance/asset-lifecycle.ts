/**
 * WAVE 22 · ASSET LIFECYCLE ECONOMICS (owner-decided policy, 2026-09-05
 * execution mandate — D-197/D-198).
 * ============================================================================
 * Depreciation and disposal, each economically truthful inside a cash-ledger
 * architecture:
 *
 *  · DEPRECIATION is systematic straight-line recognition over the asset's
 *    useful life from its in-service point. It is NON-CASH: no
 *    financial_transactions row exists for it, ever. Each recognized month is
 *    one append-only `asset_depreciations` fact; the schedule is a pure
 *    function of (cost, life, in-service point) with the rounding remainder
 *    absorbed by the final period, so cumulative depreciation ends at exactly
 *    the cost. The P&L surfaces derive the expense from these facts.
 *
 *  · DISPOSAL is a separate economic event from custody loss. It removes the
 *    CARRYING amount (cost − recognized depreciation) from the register,
 *    takes actual proceeds as CASH into branch main through the P&L-neutral
 *    'disposal_proceeds' type (never operating income), and records the
 *    gain/loss (= proceeds − carrying) on the event. Proceeds of zero are a
 *    pure retirement. Lost assets keep the custody-loss semantics (D-188).
 */
import type BetterSqlite3 from 'better-sqlite3';
import { id, today } from '../../utils/ids.js';
import { HttpError } from '../../middleware/errorHandler.js';
import { incrementMainBalance } from '../../utils/financeAccounts.js';
import { assertMoney } from '../../utils/money.js';

export interface DepreciationScheduleRow {
  periodKey: string;
  amount: number;
  cumulative: number;
  recognized: boolean;
}

/** The asset's in-service point: the stated fact, else its acquisition date. */
export function inServicePoint(asset: { in_service_on?: string | null; acquired_on: string }): string {
  return asset.in_service_on && /^\d{4}-\d{2}-\d{2}$/.test(asset.in_service_on) ? asset.in_service_on : asset.acquired_on;
}

/** 0-based month index of `periodKey` (YYYY-MM) from the in-service month. */
export function monthIndexFrom(periodKey: string, inService: string): number {
  const py = Number(periodKey.slice(0, 4));
  const pm = Number(periodKey.slice(5, 7));
  const sy = Number(inService.slice(0, 4));
  const sm = Number(inService.slice(5, 7));
  return (py - sy) * 12 + (pm - sm);
}

/** The period key of a 0-based month index from the in-service month. */
export function periodKeyFor(index: number, inService: string): string {
  const sy = Number(inService.slice(0, 4));
  const sm = Number(inService.slice(5, 7));
  const total = sy * 12 + (sm - 1) + index;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

/**
 * The ONE depreciation schedule authority: whole-AFN straight line with the
 * rounding remainder in the FINAL period. Pure — unit-testable, reproducible
 * from the facts alone.
 */
export function depreciationSchedule(cost: number, usefulLifeMonths: number, inService: string): Array<{ periodKey: string; amount: number }> {
  if (!Number.isInteger(cost) || cost <= 0) throw new HttpError(400, 'Asset cost must be a positive whole-AFN amount.');
  if (!Number.isInteger(usefulLifeMonths) || usefulLifeMonths <= 0) throw new HttpError(400, 'Useful life must be a positive whole number of months.');
  const monthly = Math.floor(cost / usefulLifeMonths);
  const remainder = cost - monthly * usefulLifeMonths;
  const rows: Array<{ periodKey: string; amount: number }> = [];
  let cumulative = 0;
  for (let i = 0; i < usefulLifeMonths; i += 1) {
    const amount = i === usefulLifeMonths - 1 ? monthly + remainder : monthly;
    if (amount <= 0) continue; // a fully-depreciated tail (cost < life) ends early
    cumulative += amount;
    if (cumulative > cost) throw new HttpError(500, 'Depreciation schedule exceeded cost — refusing.');
    rows.push({ periodKey: periodKeyFor(i, inService), amount });
    if (cumulative === cost) break; // remainder absorbed; nothing left to recognize
  }
  return rows;
}

export interface AssetLifecyclePosition {
  assetId: string;
  name: string;
  branchId: string;
  cost: number;
  custodyStatus: string;
  inServiceOn: string;
  usefulLifeMonths: number | null;
  recognized: number;
  carryingValue: number;
  scheduleEnd: string | null;
  recognizedThrough: string | null;
}

export function getAssetLifecyclePosition(db: BetterSqlite3.Database, assetId: string): AssetLifecyclePosition {
  const asset = db.prepare(
    `SELECT id, name, branch_id, cost, custody_status, acquired_on, in_service_on, useful_life_months FROM fixed_assets WHERE id = ?`,
  ).get(assetId) as
    | { id: string; name: string; branch_id: string; cost: number; custody_status: string; acquired_on: string; in_service_on: string | null; useful_life_months: number | null }
    | undefined;
  if (!asset) throw new HttpError(404, 'Fixed asset not found.');
  const recognizedRow = db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS total, MAX(period_key) AS through FROM asset_depreciations WHERE asset_id = ?`,
  ).get(assetId) as { total: number; through: string | null };
  const start = inServicePoint(asset);
  return {
    assetId: asset.id,
    name: asset.name,
    branchId: asset.branch_id,
    cost: Number(asset.cost),
    custodyStatus: asset.custody_status,
    inServiceOn: start,
    usefulLifeMonths: asset.useful_life_months ?? null,
    recognized: Number(recognizedRow.total) || 0,
    carryingValue: Number(asset.cost) - (Number(recognizedRow.total) || 0),
    scheduleEnd: asset.useful_life_months ? periodKeyFor(asset.useful_life_months - 1, start) : null,
    recognizedThrough: recognizedRow.through,
  };
}

export interface DepreciationRunResult {
  inserted: Array<{ periodKey: string; amount: number }>;
  position: AssetLifecyclePosition;
}

/**
 * Recognizes every missing depreciation period from the in-service point up to
 * `throughPeriod` (YYYY-MM, bounded by the schedule end and today). Idempotent
 * per (asset, period) — replay inserts nothing. Refused for lost assets (their
 * depreciation stopped at the loss) and for periods after a disposal.
 */
export function runDepreciation(
  db: BetterSqlite3.Database,
  params: { assetId: string; throughPeriod?: string; recognizedBy: string },
): DepreciationRunResult {
  const asset = db.prepare(
    `SELECT id, branch_id, cost, custody_status, acquired_on, in_service_on, useful_life_months FROM fixed_assets WHERE id = ?`,
  ).get(params.assetId) as
    | { id: string; branch_id: string; cost: number; custody_status: string; acquired_on: string; in_service_on: string | null; useful_life_months: number | null }
    | undefined;
  if (!asset) throw new HttpError(404, 'Fixed asset not found.');
  if (asset.custody_status === 'lost') {
    throw new HttpError(409, 'A lost asset no longer depreciates; its custody-loss semantics govern it (D-188).');
  }
  if (asset.useful_life_months == null) {
    throw new HttpError(409, 'This asset has no useful life stated; set its useful_life_months fact before depreciating it.');
  }
  const start = inServicePoint(asset);
  const disposal = db.prepare(
    `SELECT disposal_on FROM asset_disposals WHERE asset_id = ?`,
  ).get(params.assetId) as { disposal_on: string } | undefined;

  const currentPeriod = today().slice(0, 7);
  const requested = params.throughPeriod && /^\d{4}-\d{2}$/.test(params.throughPeriod) ? params.throughPeriod : currentPeriod;
  const bounds = [requested, currentPeriod];
  if (disposal) bounds.push(disposal.disposal_on.slice(0, 7));
  const through = bounds.reduce((min, v) => (v < min ? v : min));

  const schedule = depreciationSchedule(Number(asset.cost), asset.useful_life_months, start);
  const existing = new Set(
    (db.prepare(`SELECT period_key FROM asset_depreciations WHERE asset_id = ?`).all(params.assetId) as Array<{ period_key: string }>)
      .map((r) => r.period_key),
  );

  const inserted: Array<{ periodKey: string; amount: number }> = [];
  const run = db.transaction(() => {
    const insert = db.prepare(
      `INSERT INTO asset_depreciations (id, asset_id, branch_id, period_key, amount, recognized_on, recognized_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of schedule) {
      if (row.periodKey > through) break;
      if (existing.has(row.periodKey)) continue;
      insert.run(id('dep'), params.assetId, asset.branch_id, row.periodKey, row.amount, today(), params.recognizedBy);
      inserted.push(row);
    }
  });
  run();
  return { inserted, position: getAssetLifecyclePosition(db, params.assetId) };
}

export interface DisposalResult {
  disposalId: string;
  proceeds: number;
  carryingValue: number;
  gainLoss: number;
  transactionId: string | null;
}

/**
 * Disposes of an in-service asset: carrying amount leaves the register, actual
 * proceeds (if any) enter branch main as P&L-neutral cash, and the gain/loss
 * is recorded on the event. One disposal per asset, final.
 */
export function disposeAsset(
  db: BetterSqlite3.Database,
  params: { assetId: string; proceeds: number; disposalOn?: string; buyer?: string | null; reason: string; disposedBy: string },
): DisposalResult {
  let proceeds: number;
  try { proceeds = assertMoney(params.proceeds, 'disposal proceeds', {}); } catch {
    throw new HttpError(400, 'Disposal proceeds must be a whole-AFN non-negative value.');
  }
  if (proceeds < 0) throw new HttpError(400, 'Disposal proceeds cannot be negative.');
  const reason = String(params.reason ?? '').trim();
  if (reason.length < 8) throw new HttpError(400, 'A disposal reason of at least 8 characters is required.');
  const disposalOn = params.disposalOn && /^\d{4}-\d{2}-\d{2}$/.test(params.disposalOn) ? params.disposalOn : today();

  const run = db.transaction((): DisposalResult => {
    const asset = db.prepare(
      `SELECT id, branch_id, cost, custody_status FROM fixed_assets WHERE id = ?`,
    ).get(params.assetId) as { id: string; branch_id: string; cost: number; custody_status: string } | undefined;
    if (!asset) throw new HttpError(404, 'Fixed asset not found.');
    if (asset.custody_status === 'lost') {
      throw new HttpError(409, 'A lost asset is governed by its custody-loss event and cannot be disposed (D-188).');
    }
    if (asset.custody_status === 'disposed') throw new HttpError(409, 'This asset is already disposed; disposal is final.');

    const carrying = Number(asset.cost)
      - Number((db.prepare(`SELECT COALESCE(SUM(amount), 0) AS t FROM asset_depreciations WHERE asset_id = ?`).get(params.assetId) as { t: number }).t);

    let transactionId: string | null = null;
    if (proceeds > 0) {
      incrementMainBalance('branch', asset.branch_id, proceeds);
      transactionId = id('tx');
      db.prepare(
        `INSERT INTO financial_transactions (id, type, category, amount, date, description, reference_id, operator_name, branch_id)
         VALUES (?, 'disposal_proceeds', 'disposal_proceeds', ?, ?, ?, ?, ?, ?)`,
      ).run(transactionId, proceeds, disposalOn,
            `Disposal proceeds for asset ${asset.id} (${carrying} AFN carrying)`, asset.id, params.disposedBy, asset.branch_id);
    }

    const disposalId = id('dsp');
    db.prepare(
      `INSERT INTO asset_disposals (id, asset_id, branch_id, disposal_on, proceeds, carrying_value, gain_loss, proceeds_transaction_id, buyer, reason, disposed_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(disposalId, params.assetId, asset.branch_id, disposalOn, proceeds, carrying, proceeds - carrying,
          transactionId, params.buyer ?? null, reason, params.disposedBy);

    const flipped = db.prepare(
      `UPDATE fixed_assets SET custody_status = 'disposed' WHERE id = ? AND custody_status = 'in_service'`,
    ).run(params.assetId);
    if (flipped.changes !== 1) throw new HttpError(409, 'This asset is no longer in service.');
    return { disposalId, proceeds, carryingValue: carrying, gainLoss: proceeds - carrying, transactionId };
  });
  return run();
}

/** Register of disposals with their economics (newest first). */
export function listAssetDisposals(db: BetterSqlite3.Database, branchId: string | null) {
  const scope = branchId ? 'WHERE d.branch_id = ?' : '';
  const params = branchId ? [branchId] : [];
  return (db.prepare(
    `SELECT d.id, d.asset_id, d.branch_id, d.disposal_on, d.proceeds, d.carrying_value, d.gain_loss,
            d.proceeds_transaction_id, d.buyer, d.reason, d.disposed_by, d.created_at,
            a.name AS asset_name, a.cost
       FROM asset_disposals d JOIN fixed_assets a ON a.id = d.asset_id
       ${scope}
      ORDER BY datetime(d.created_at) DESC, d.id DESC`,
  ).all(...params) as Array<Record<string, unknown>>).map((r) => ({
    id: r.id, assetId: r.asset_id, assetName: r.asset_name, branchId: r.branch_id, disposalOn: r.disposal_on,
    proceeds: r.proceeds, carryingValue: r.carrying_value, gainLoss: r.gain_loss, cost: r.cost,
    proceedsTransactionId: r.proceeds_transaction_id, buyer: r.buyer, reason: r.reason,
    disposedBy: r.disposed_by, createdAt: r.created_at,
  }));
}

/**
 * Depreciation expense + carrying values for the P&L surfaces. `from`/`to`
 * bound the RECOGNIZED date; one row per branch plus the organization total.
 */
export function getDepreciationExpense(db: BetterSqlite3.Database, opts: { branchId?: string | null; from: string; to: string }): { total: number } {
  const total = opts.branchId
    ? Number((db.prepare(
        `SELECT COALESCE(SUM(amount), 0) AS v FROM asset_depreciations WHERE branch_id = ? AND recognized_on >= ? AND recognized_on <= ?`,
      ).get(opts.branchId, opts.from, opts.to) as { v: number }).v) || 0
    : Number((db.prepare(
        `SELECT COALESCE(SUM(amount), 0) AS v FROM asset_depreciations WHERE recognized_on >= ? AND recognized_on <= ?`,
      ).get(opts.from, opts.to) as { v: number }).v) || 0;
  return { total };
}

/** Organization-wide fixed-asset summary: cost, accumulated, carrying, period expense. */
export function getAssetPortfolioSummary(db: BetterSqlite3.Database, branchId: string | null) {
  const gross = Number(((branchId
    ? db.prepare(`SELECT COALESCE(SUM(cost), 0) AS v FROM fixed_assets WHERE branch_id = ?`).get(branchId)
    : db.prepare(`SELECT COALESCE(SUM(cost), 0) AS v FROM fixed_assets`).get()
  ) as { v: number }).v) || 0;
  const accumulated = Number(((branchId
    ? db.prepare(
        `SELECT COALESCE(SUM(d.amount), 0) AS v FROM asset_depreciations d JOIN fixed_assets fa ON fa.id = d.asset_id WHERE fa.branch_id = ?`,
      ).get(branchId)
    : db.prepare(`SELECT COALESCE(SUM(amount), 0) AS v FROM asset_depreciations`).get()
  ) as { v: number }).v) || 0;
  return {
    grossCost: gross,
    accumulatedDepreciation: accumulated,
    netCarryingValue: gross - accumulated,
  };
}
