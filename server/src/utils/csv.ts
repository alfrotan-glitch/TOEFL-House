/**
 * THE CSV serializer.
 * ============================================================================
 * One implementation of a deceptively fiddly format. Escaping is where CSV
 * exports go wrong quietly: a student called "Ahmadi, Sara" or a note
 * containing a newline splits into extra columns or extra rows, and the file
 * still opens, so nobody notices until a total is wrong in a spreadsheet
 * somebody else built.
 *
 * RFC 4180: a field is quoted when it contains a comma, a quote, CR or LF, and
 * an embedded quote is doubled. Fields are joined with CRLF because that is
 * what the RFC specifies and what Excel expects.
 */

/** Quotes and escapes one field, per RFC 4180. */
export function csvEscape(value: unknown): string {
  const str = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

/**
 * Serializes a header and rows into a CSV document.
 *
 * Every cell goes through `csvEscape`, so a caller cannot forget one field and
 * produce a file that is correct until the day a name contains a comma.
 */
export function toCsv(header: readonly unknown[], rows: readonly (readonly unknown[])[]): string {
  const lines = [header.map(csvEscape).join(',')];
  for (const row of rows) lines.push(row.map(csvEscape).join(','));
  return lines.join('\r\n');
}
