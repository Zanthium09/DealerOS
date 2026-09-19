// M4 (§5.4) — what a logged call implies, and who gets called next. Pure: no database.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatInr,
  interactionStatusFor,
  priorityOf,
  rank,
  recentlyCalled,
  stepsFor,
  type Candidate,
} from '../../src/modules/calling/rules';

describe('what an outcome implies for the pipeline', () => {
  const chain = (o: Parameters<typeof stepsFor>[0]) => stepsFor(o).map((s) => `${s.from}>${s.to}`);

  test('interest advances through contact; onboarding passes through every stage so each step is audited', () => {
    assert.deepEqual(chain('SPOKE_INTERESTED'), ['NEW>CONTACTED', 'CONTACTED>INTERESTED']);
    assert.deepEqual(chain('ONBOARDED'), ['NEW>CONTACTED', 'CONTACTED>INTERESTED', 'INTERESTED>ONBOARDED']);
  });

  test('reaching someone is contact; not reaching them changes nothing', () => {
    assert.deepEqual(chain('SPOKE_CALL_BACK'), ['NEW>CONTACTED']);
    assert.deepEqual(chain('SPOKE_NOT_INTERESTED'), ['NEW>CONTACTED']);
    for (const o of ['NO_ANSWER', 'WRONG_NUMBER', 'DO_NOT_CALL'] as const) assert.deepEqual(chain(o), [], o);
  });

  test('only "reached" outcomes count as DELIVERED', () => {
    assert.equal(interactionStatusFor('NO_ANSWER'), 'FAILED');
    assert.equal(interactionStatusFor('WRONG_NUMBER'), 'FAILED');
    assert.equal(interactionStatusFor('SPOKE_INTERESTED'), 'DELIVERED');
    assert.equal(interactionStatusFor('DO_NOT_CALL'), 'DELIVERED');
  });
});

describe('call queue ordering', () => {
  const now = new Date('2026-09-10T12:00:00Z');
  const base: Candidate = { dealerId: 'x', stage: 'NEW', followUpDue: null, lastInboundAt: null, lastCalledAt: null };
  const c = (over: Partial<Candidate>): Candidate => ({ ...base, ...over });

  test('a promised call-back outranks everything, then interested dealers, then fresh inbound', () => {
    assert.equal(priorityOf(c({ followUpDue: new Date('2026-09-09T00:00:00Z') }), now), 0);
    assert.equal(priorityOf(c({ stage: 'INTERESTED' }), now), 1);
    assert.equal(priorityOf(c({ lastInboundAt: new Date('2026-09-09T00:00:00Z') }), now), 2);
    assert.equal(priorityOf(c({}), now), 3);
  });

  test('a follow-up not yet due does not jump the queue', () => {
    assert.equal(priorityOf(c({ followUpDue: new Date('2026-09-11T00:00:00Z') }), now), 3);
  });

  test('within a tier, the most recent inbound goes first', () => {
    const older = c({ dealerId: 'old', stage: 'INTERESTED', lastInboundAt: new Date('2026-09-01T00:00:00Z') });
    const newer = c({ dealerId: 'new', stage: 'INTERESTED', lastInboundAt: new Date('2026-09-08T00:00:00Z') });
    const callback = c({ dealerId: 'cb', followUpDue: new Date('2026-09-09T00:00:00Z') });
    assert.deepEqual(rank([older, newer, callback], now).map((x) => x.dealerId), ['cb', 'new', 'old']);
  });

  test('someone just called is not re-suggested — unless a call-back is pending', () => {
    assert.equal(recentlyCalled(c({ lastCalledAt: new Date('2026-09-09T12:00:00Z') }), now), true);
    assert.equal(recentlyCalled(c({ lastCalledAt: new Date('2026-09-05T12:00:00Z') }), now), false);
    assert.equal(recentlyCalled(c({ lastCalledAt: new Date('2026-09-09T12:00:00Z'), followUpDue: new Date('2026-09-10T00:00:00Z') }), now), false);
  });
});

test('money in a brief is formatted by code with Indian grouping (§1.4)', () => {
  assert.equal(formatInr(123456.5), '₹1,23,456.5');
  assert.equal(formatInr(0), '₹0');
});

