// M5 (§5.6) — dormancy thresholds, the auto-send gate, and reactivation attribution.
// Pure: no database.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attributedToNudge,
  autoSendEligible,
  averageOrderValue,
  daysSince,
  isDormant,
  nudgedRecently,
} from '../../src/modules/dormancy/rules';

const now = new Date('2026-09-30T12:00:00Z');
const ago = (days: number, hours = 0) => new Date(now.getTime() - days * 86_400_000 - hours * 3_600_000);

describe('the dormancy threshold', () => {
  test('N days of silence is dormant, N−1 is not — inclusive at the boundary', () => {
    assert.equal(isDormant(ago(30), 30, now), true);
    assert.equal(isDormant(ago(29), 30, now), false);
    assert.equal(isDormant(ago(29, 23), 30, now), false); // 29 days 23 hours is still 29 days
    assert.equal(isDormant(ago(31), 30, now), true);
  });

  test('the threshold is configurable', () => {
    assert.equal(isDormant(ago(45), 60, now), false);
    assert.equal(isDormant(ago(60), 60, now), true);
    assert.equal(isDormant(ago(1), 1, now), true);
  });

  test('a dealer who ordered today is never dormant', () => assert.equal(isDormant(now, 1, now), false));
  test('daysSince counts whole days', () => assert.equal(daysSince(ago(7, 5), now), 7));
});

describe('auto-send gate (§5.6)', () => {
  test('auto-sends only when the average order value is below the configured threshold', () => {
    assert.equal(autoSendEligible(5_000, 10_000), true);
    assert.equal(autoSendEligible(10_000, 10_000), false); // strictly below
    assert.equal(autoSendEligible(50_000, 10_000), false);
  });

  test('no threshold configured, or no order history, means a person looks first', () => {
    assert.equal(autoSendEligible(5_000, null), false);
    assert.equal(autoSendEligible(null, 10_000), false);
    assert.equal(autoSendEligible(null, null), false);
  });

  test('average order value', () => {
    assert.equal(averageOrderValue(30_000, 3), 10_000);
    assert.equal(averageOrderValue(100, 3), 33.33);
    assert.equal(averageOrderValue(0, 0), null);
  });
});

describe('reactivation attribution (§15 — must not over-claim)', () => {
  const nudge = ago(20);

  test('an order shortly after the nudge is credited to it', () => {
    assert.equal(attributedToNudge(ago(10), nudge, 30), true);
    assert.equal(attributedToNudge(ago(-0.0001), nudge, 30), true);
  });

  test('an order that predates the nudge, or comes long after it, is not', () => {
    assert.equal(attributedToNudge(ago(25), nudge, 30), false); // before the nudge
    assert.equal(attributedToNudge(now, ago(60), 30), false); // 60 days after, window is 30
  });

  test('no nudge, no credit', () => assert.equal(attributedToNudge(ago(1), null, 30), false));

  test('the window edge is inclusive', () => {
    assert.equal(attributedToNudge(new Date(nudge.getTime() + 30 * 86_400_000), nudge, 30), true);
    assert.equal(attributedToNudge(new Date(nudge.getTime() + 30 * 86_400_000 + 1), nudge, 30), false);
  });
});

describe('nudge frequency', () => {
  test('never re-nudge inside the quiet period', () => {
    assert.equal(nudgedRecently(ago(5), now), true);
    assert.equal(nudgedRecently(ago(29), now), true);
    assert.equal(nudgedRecently(ago(31), now), false);
    assert.equal(nudgedRecently(null, now), false);
  });
});
