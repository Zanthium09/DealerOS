import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { callDue, daysOverdue, isFresh, levelFor, shouldRemind, toPaise, validateThresholds, DAY_MS, HOUR_MS } from '../../src/modules/collections/rules';

const t = { gentleAfterDays: 7, firmAfterDays: 30, humanAfterDays: 60 };
const now = new Date('2026-09-19T00:00:00Z');
const ago = (days: number) => new Date(now.getTime() - days * DAY_MS);

describe('the escalation ladder', () => {
  test('boundaries are inclusive and deterministic', () => {
    assert.equal(levelFor(6, t), 'NONE');
    assert.equal(levelFor(7, t), 'GENTLE');
    assert.equal(levelFor(29, t), 'GENTLE');
    assert.equal(levelFor(30, t), 'FIRM');
    assert.equal(levelFor(59, t), 'FIRM');
    assert.equal(levelFor(60, t), 'HUMAN');
    assert.equal(levelFor(400, t), 'HUMAN');
  });

  test('a ladder that is not strictly increasing is refused', () => {
    assert.equal(validateThresholds(t), null);
    assert.match(validateThresholds({ ...t, firmAfterDays: 7 })!, /increase/);
    assert.match(validateThresholds({ ...t, gentleAfterDays: 0 })!, /at least 1/);
    assert.match(validateThresholds({ ...t, humanAfterDays: 1.5 })!, /whole number/);
  });
});

describe('when a written reminder is due', () => {
  const base = { intervalDays: 7, now };
  test('never for NONE or HUMAN — the final rung is a person, never automated', () => {
    assert.equal(shouldRemind({ ...base, level: 'NONE', lastReminderAt: null, lastReminderLevel: null }), false);
    assert.equal(shouldRemind({ ...base, level: 'HUMAN', lastReminderAt: null, lastReminderLevel: null }), false);
  });
  test('first reminder is immediate', () => {
    assert.equal(shouldRemind({ ...base, level: 'GENTLE', lastReminderAt: null, lastReminderLevel: null }), true);
  });
  test('inside the interval, no repeat', () => {
    assert.equal(shouldRemind({ ...base, level: 'GENTLE', lastReminderAt: ago(3), lastReminderLevel: 'GENTLE' }), false);
  });
  test('interval passed, repeat', () => {
    assert.equal(shouldRemind({ ...base, level: 'GENTLE', lastReminderAt: ago(7), lastReminderLevel: 'GENTLE' }), true);
  });
  test('moving up a rung is not held back by the interval', () => {
    assert.equal(shouldRemind({ ...base, level: 'FIRM', lastReminderAt: ago(1), lastReminderLevel: 'GENTLE' }), true);
  });
});

describe('call flag', () => {
  test('only on the HUMAN rung, and quiet for the interval after a person handled it', () => {
    const b = { intervalDays: 7, now };
    assert.equal(callDue({ ...b, level: 'FIRM', handledAt: null }), false);
    assert.equal(callDue({ ...b, level: 'HUMAN', handledAt: null }), true);
    assert.equal(callDue({ ...b, level: 'HUMAN', handledAt: ago(2) }), false);
    assert.equal(callDue({ ...b, level: 'HUMAN', handledAt: ago(7) }), true);
  });
});

describe('freshness (§10.4)', () => {
  test('inside the window is fresh, past it or never synced is not', () => {
    assert.equal(isFresh(new Date(now.getTime() - 47 * HOUR_MS), 48, now), true);
    assert.equal(isFresh(new Date(now.getTime() - 49 * HOUR_MS), 48, now), false);
    assert.equal(isFresh(null, 48, now), false);
  });
});

describe('numbers', () => {
  test('whole paise despite float noise; whole days', () => {
    assert.equal(toPaise(1234.56), 123456);
    assert.equal(toPaise(0.1 + 0.2), 30);
    assert.equal(daysOverdue(ago(10), now), 10);
  });
});
