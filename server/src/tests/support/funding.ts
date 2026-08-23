import type Database from 'better-sqlite3';

/**
 * Inserts a complete donation fact for fixtures that intentionally bypass the
 * HTTP command. The pair has the same branch, amount and date as production's
 * deferred one-to-one donation/income relation.
 */
export function seedLinkedDonation(
  db: Database.Database,
  input: { id: string; donorId: string; amount: number; date: string; receiptNo: string; branchId: string; campaignId?: string | null; idempotencyKey?: string | null },
): string {
  const transactionId = `tx_fixture_${input.id}`;
  db.transaction(() => {
    db.prepare(
      `INSERT INTO financial_transactions
         (id, type, category, amount, date, description, reference_id, donation_id, operator_name, branch_id)
       VALUES (?, 'income', 'donation', ?, ?, ?, ?, ?, 'fixture', ?)`,
    ).run(transactionId, input.amount, input.date, `Fixture donation ${input.id}`, input.id, input.id, input.branchId);
    db.prepare(
      `INSERT INTO donations
         (id, campaign_id, donor_id, amount, date, receipt_no, branch_id, transaction_id, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.campaignId ?? null,
      input.donorId,
      input.amount,
      input.date,
      input.receiptNo,
      input.branchId,
      transactionId,
      input.idempotencyKey ?? input.id,
    );
  })();
  return input.id;
}
