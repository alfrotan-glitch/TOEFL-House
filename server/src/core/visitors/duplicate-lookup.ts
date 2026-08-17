/**
 * Possible-duplicate lookup — advisory, never blocking.
 *
 * WHY ADVISORY AND NOT A CONSTRAINT
 * ---------------------------------
 * The audit proved a receptionist can re-register a returning walk-in: posting
 * the same name and phone created a second row, because the only hard
 * uniqueness rule on visitors is Tazkira (migration 072), and Tazkira is
 * optional and buried in the collapsed "advanced" section of the form.
 *
 * The tempting fix — make phone UNIQUE — would be wrong for this domain. In
 * Kabul a single household or office line is routinely shared by siblings and
 * by a parent registering several children; the live database already contains
 * legitimately shared numbers. A hard constraint would block real enrolments at
 * the front desk, which is a worse failure than a duplicate row.
 *
 * So identity stays enforced where identity is actually known (Tazkira), and
 * this module answers a different, softer question: "have we probably seen this
 * person before?" The operator decides. That keeps the authority with the human
 * who is looking at the person, and keeps the API honest: this endpoint can
 * only ever return information, never refuse a write.
 *
 * SCOPE AND SAFETY
 * ----------------
 * Results are branch-scoped by the caller exactly like every other visitor
 * read, so this cannot be used to enumerate leads in another branch. Only the
 * few fields the operator needs in order to recognise a person are returned —
 * enough to say "yes, that's him", not a full record dump.
 */
import type BetterSqlite3 from 'better-sqlite3';

export interface DuplicateCandidate {
  id: string;
  serialNo: string | null;
  fullName: string;
  phone: string | null;
  visitDate: string | null;
  /** Lifecycle bucket, so the UI can say "already enrolled" vs "open lead". */
  status: string | null;
  stage: string | null;
  /** Why this row was suggested. */
  matchedOn: 'tazkira' | 'phone' | 'name';
}

export interface DuplicateScope {
  branchId: string | null;
  isAll: boolean;
}

/**
 * Digits-only comparison key for a phone number.
 *
 * `0700 123 456`, `0700-123-456` and `+93700123456` are the same line to a
 * human and must be to us as well, otherwise the check is trivially defeated by
 * a space. Comparing the last 9 digits ignores the country-code prefix and the
 * national leading zero, which are written inconsistently in practice.
 */
export function phoneMatchKey(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  if (digits.length < 7) return null;
  return digits.slice(-9);
}

/**
 * Find leads that may already represent this person.
 *
 * Ordered by confidence: an exact Tazkira match is an identity match, a phone
 * match is strong, a name match is weak and only offered when nothing better
 * was found. Never throws on absent input — an empty query yields no candidates.
 */
export function findDuplicateCandidates(
  db: BetterSqlite3.Database,
  scope: DuplicateScope,
  input: { phone?: string | null; tazkiraNo?: string | null; fullName?: string | null; excludeVisitorId?: string | null },
  limit = 5
): DuplicateCandidate[] {
  const scopeSql = scope.isAll ? '' : ' AND branch_id = ?';
  const scopeParams: unknown[] = scope.isAll ? [] : [scope.branchId];
  const exclude = input.excludeVisitorId ? ' AND id <> ?' : '';
  const excludeParams: unknown[] = input.excludeVisitorId ? [input.excludeVisitorId] : [];

  const select = `SELECT id, serial_no, full_name, phone, visit_date, status, stage FROM visitors`;
  const seen = new Set<string>();
  const out: DuplicateCandidate[] = [];

  const push = (rows: unknown[], matchedOn: DuplicateCandidate['matchedOn']) => {
    for (const raw of rows as Array<Record<string, unknown>>) {
      const id = String(raw.id);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        serialNo: (raw.serial_no as string) ?? null,
        fullName: String(raw.full_name ?? ''),
        phone: (raw.phone as string) ?? null,
        visitDate: (raw.visit_date as string) ?? null,
        status: (raw.status as string) ?? null,
        stage: (raw.stage as string) ?? null,
        matchedOn,
      });
    }
  };

  // 1. Tazkira — an identity match. This is also the value the database
  //    enforces, so surfacing it here turns a future 409 into a warning the
  //    operator sees before they have typed the rest of the form.
  const tazkira = input.tazkiraNo?.trim();
  if (tazkira) {
    push(
      db.prepare(`${select} WHERE tazkira_no = ?${scopeSql}${exclude} LIMIT ?`)
        .all(tazkira, ...scopeParams, ...excludeParams, limit),
      'tazkira'
    );
  }

  // 2. Phone — strong but legitimately shareable, hence advisory.
  //    Compared on a normalised digit suffix so formatting cannot defeat it.
  const key = phoneMatchKey(input.phone);
  if (key && out.length < limit) {
    push(
      db.prepare(
        `${select} WHERE phone IS NOT NULL AND TRIM(phone) <> ''
           AND REPLACE(REPLACE(REPLACE(REPLACE(phone,' ',''),'-',''),'(',''),')','') LIKE ?
           ${scopeSql}${exclude} LIMIT ?`
      ).all(`%${key}`, ...scopeParams, ...excludeParams, limit),
      'phone'
    );
  }

  // 3. Name — weakest signal. Only consulted when nothing stronger matched, so
  //    a common name does not bury a real Tazkira/phone hit under noise.
  const name = input.fullName?.trim();
  if (name && name.length >= 3 && out.length === 0) {
    push(
      db.prepare(`${select} WHERE LOWER(TRIM(full_name)) = LOWER(?)${scopeSql}${exclude} LIMIT ?`)
        .all(name, ...scopeParams, ...excludeParams, limit),
      'name'
    );
  }

  return out.slice(0, limit);
}
