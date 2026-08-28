// §5.1 — CSV/XLSX upload → rows + detected headers. Nothing org-aware here: pure
// parsing, so it is testable without a database.
//
// csv-parse (node-csv) rather than a hand-rolled splitter: RFC 4180 quoting,
// embedded newlines and BOM stripping are a bug farm to write and a one-liner to
// configure. read-excel-file for XLSX because it only reads (6 transitive deps
// against exceljs's 70, and we never write a spreadsheet).
import { parse } from 'csv-parse/sync';
import readXlsxFile from 'read-excel-file/node';

export type Row = Record<string, string>;
export type Parsed = { headers: string[]; rows: Row[] };

/** Duplicate header names would silently overwrite each other in a Row. */
function uniqueHeaders(raw: unknown[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((h, i) => {
    const name = String(h ?? '').trim() || `column_${i + 1}`;
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return n === 1 ? name : `${name}_${n}`;
  });
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).trim();
}

function toParsed(matrix: unknown[][]): Parsed {
  const rows = matrix.filter((r) => r.some((c) => cell(c) !== ''));
  if (rows.length === 0) return { headers: [], rows: [] };
  const headers = uniqueHeaders(rows[0]);
  return {
    headers,
    rows: rows.slice(1).map((r) => Object.fromEntries(headers.map((h, i) => [h, cell(r[i])]))),
  };
}

export async function parseFile(filename: string, buffer: Buffer): Promise<Parsed> {
  if (/\.xlsx?$/i.test(filename)) {
    return toParsed((await readXlsxFile(buffer as never)) as unknown as unknown[][]);
  }
  return toParsed(
    parse(buffer, {
      bom: true,
      // Header handling is ours (uniqueHeaders), so read everything as arrays.
      columns: false,
      relax_column_count: true,
      skip_empty_lines: true,
      trim: true,
    }) as unknown[][],
  );
}
