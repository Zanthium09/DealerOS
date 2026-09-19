// §5.5 / §13 — ageing buckets and the cell parsers accounting exports depend on.
// Pure functions, no database.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ageingBucketFor, daysOverdue } from '../../src/modules/sync/ageing';
import { parseDate, parseMoney } from '../../src/modules/sync/parse-values';
import { detectMapping, ORDER_FIELDS } from '../../src/modules/sync/columns';

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe('ageing buckets (§5.8)', () => {
  const due = day('2026-06-01');
  const bucket = (daysLate: number, amount = 1000, paid = 0) =>
    ageingBucketFor(
      { dueDate: due, amount, paidAmount: paid },
      new Date(due.getTime() + daysLate * 86_400_000),
    );

  test('not yet due and under 30 days late are CURRENT', () => {
    assert.equal(bucket(-10), 'CURRENT');
    assert.equal(bucket(0), 'CURRENT');
    assert.equal(bucket(29), 'CURRENT');
  });

  test('boundaries land exactly on 30 / 60 / 90', () => {
    assert.equal(bucket(30), 'D30');
    assert.equal(bucket(59), 'D30');
    assert.equal(bucket(60), 'D60');
    assert.equal(bucket(89), 'D60');
    assert.equal(bucket(90), 'D90_PLUS');
    assert.equal(bucket(400), 'D90_PLUS');
  });

  test('a fully paid invoice is CURRENT however old', () => {
    assert.equal(bucket(200, 1000, 1000), 'CURRENT');
    assert.equal(bucket(200, 1000, 1500), 'CURRENT');
  });

  test('a part-paid invoice still ages', () => {
    assert.equal(bucket(200, 1000, 400), 'D90_PLUS');
  });

  test('daysOverdue is negative before the due date', () => {
    assert.equal(daysOverdue(day('2026-06-10'), day('2026-06-05')), -5);
  });
});

describe('parseDate — day-first, never guessing', () => {
  const iso = (d: Date | null) => d?.toISOString().slice(0, 10);

  test('slash dates are day-first (Indian convention)', () => {
    assert.equal(iso(parseDate('31/08/2026')), '2026-08-31');
    // The dangerous one: a US parser reads this as 4 March.
    assert.equal(iso(parseDate('03/04/2026')), '2026-04-03');
  });

  test('other separators and two-digit years', () => {
    assert.equal(iso(parseDate('31-08-2026')), '2026-08-31');
    assert.equal(iso(parseDate('31.08.2026')), '2026-08-31');
    assert.equal(iso(parseDate('1/4/26')), '2026-04-01');
  });

  test('ISO and Tally-style month names', () => {
    assert.equal(iso(parseDate('2026-08-31')), '2026-08-31');
    assert.equal(iso(parseDate('1-Apr-2026')), '2026-04-01');
    assert.equal(iso(parseDate('15 March 2026')), '2026-03-15');
  });

  test('impossible or unreadable dates are null, not rolled over', () => {
    assert.equal(parseDate('31/02/2026'), null);
    assert.equal(parseDate('not a date'), null);
    assert.equal(parseDate(''), null);
  });
});

describe('parseMoney', () => {
  test('rupee symbols and Indian grouping', () => {
    assert.equal(parseMoney('₹1,23,456.50'), 123456.5);
    assert.equal(parseMoney('Rs. 500'), 500);
    assert.equal(parseMoney('INR 2,000'), 2000);
  });

  test('parentheses and Cr are negative; Dr is a plain debit', () => {
    assert.equal(parseMoney('(2,000.00)'), -2000);
    assert.equal(parseMoney('12,000 Dr'), 12000);
    assert.equal(parseMoney('500 Cr'), -500);
  });

  test('unreadable amounts are null, never 0', () => {
    assert.equal(parseMoney('abc'), null);
    assert.equal(parseMoney(''), null);
    assert.equal(parseMoney('12 34'), 1234); // whitespace is grouping, not a second number
  });
});

describe('detectMapping', () => {
  test('finds columns by alias regardless of case and punctuation', () => {
    const m = detectMapping(['Invoice No.', 'Party Name', 'Date', 'Amount'], ORDER_FIELDS);
    assert.equal(m.orderRef, 'Invoice No.');
    assert.equal(m.dealerName, 'Party Name');
    assert.equal(m.orderDate, 'Date');
    assert.equal(m.total, 'Amount');
  });

  test('an explicit override always wins and its header is not reused', () => {
    const m = detectMapping(['Date', 'Bill Date', 'Party'], ORDER_FIELDS, { orderDate: 'Bill Date' });
    assert.equal(m.orderDate, 'Bill Date');
  });
});
