import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DAY_MS, attributeOrder, matchesSegment, validateRule, validateWindow, type DealerFacts, type SchemeFacts } from '../../src/modules/schemes/rules';

const now = new Date('2026-09-19T00:00:00Z');
const dealer = (o: Partial<DealerFacts> = {}): DealerFacts => ({ pipelineStage: 'ACTIVE', businessCategory: 'Hardware', state: 'Gujarat', city: 'Surat', lastBoughtSchemeProductAt: null, ...o });

describe('segment rule validation', () => {
  test('accepts a sane rule, refuses typos, bad types and untargetable stages', () => {
    assert.equal(validateRule({ categories: ['Hardware'], boughtSchemeProductsWithinDays: 90 }), null);
    assert.match(validateRule({ categorys: ['x'] })!, /unknown segment field/);
    assert.match(validateRule({ cities: 'Surat' })!, /list of text/);
    assert.match(validateRule({ stages: ['OPTED_OUT'] })!, /cannot be targeted/);
    assert.match(validateRule({ boughtSchemeProductsWithinDays: 0 })!, /at least 1/);
    assert.match(validateRule(null)!, /object/);
  });
  test('the window must not end before it starts', () => {
    assert.equal(validateWindow(new Date('2026-09-01'), new Date('2026-09-01')), null);
    assert.match(validateWindow(new Date('2026-09-02'), new Date('2026-09-01'))!, /ends before/);
    assert.match(validateWindow(new Date('x'), new Date('2026-09-01'))!, /not valid/);
  });
});

describe('who a scheme targets', () => {
  test('an empty rule means every buying dealer, never a prospect or opted-out one', () => {
    assert.equal(matchesSegment(dealer(), {}, now), true);
    assert.equal(matchesSegment(dealer({ pipelineStage: 'DORMANT' }), {}, now), true);
    assert.equal(matchesSegment(dealer({ pipelineStage: 'NEW' }), {}, now), false);
    assert.equal(matchesSegment(dealer({ pipelineStage: 'OPTED_OUT' }), { stages: ['ACTIVE'] }, now), false);
    assert.equal(matchesSegment(dealer({ pipelineStage: 'OPTED_OUT' }), {}, now), false);
  });
  test('category / state / city match case-insensitively; all named fields must match', () => {
    assert.equal(matchesSegment(dealer(), { categories: ['hardware'], cities: ['SURAT'] }, now), true);
    assert.equal(matchesSegment(dealer(), { categories: ['Paint'] }, now), false);
    assert.equal(matchesSegment(dealer({ city: null }), { cities: ['Surat'] }, now), false);
  });
  test('purchase pattern: bought a scheme product recently, inclusive at the boundary', () => {
    const r = { boughtSchemeProductsWithinDays: 30 };
    assert.equal(matchesSegment(dealer({ lastBoughtSchemeProductAt: new Date(now.getTime() - 30 * DAY_MS) }), r, now), true);
    assert.equal(matchesSegment(dealer({ lastBoughtSchemeProductAt: new Date(now.getTime() - 31 * DAY_MS) }), r, now), false);
    assert.equal(matchesSegment(dealer(), r, now), false);
  });
});

describe('attribution', () => {
  const s = (o: Partial<SchemeFacts> = {}): SchemeFacts => ({
    id: 's1',
    validFrom: new Date('2026-09-01T00:00:00Z'),
    validTo: new Date('2026-09-30T00:00:00Z'),
    skus: new Set(['A1']),
    targetDealerIds: new Set(['d1']),
    ...o,
  });
  const order = (o = {}) => ({ dealerId: 'd1', orderDate: new Date('2026-09-10T00:00:00Z'), skus: ['A1'], ...o });

  test('dealer targeted + in window + product overlap = credited', () => {
    assert.equal(attributeOrder(order(), [s()]), 's1');
  });
  test('any one condition failing means no credit', () => {
    assert.equal(attributeOrder(order({ dealerId: 'other' }), [s()]), null);
    assert.equal(attributeOrder(order({ orderDate: new Date('2026-08-31T23:59:59Z') }), [s()]), null);
    assert.equal(attributeOrder(order({ orderDate: new Date('2026-10-01T00:00:00Z') }), [s()]), null);
    assert.equal(attributeOrder(order({ skus: ['ZZ'] }), [s()]), null);
  });
  test('the last day is inclusive of the whole day', () => {
    assert.equal(attributeOrder(order({ orderDate: new Date('2026-09-30T18:00:00Z') }), [s()]), 's1');
  });
  test('overlapping schemes: latest start wins, ties by id, independent of input order', () => {
    const early = s({ id: 'a', validFrom: new Date('2026-09-01T00:00:00Z') });
    const late = s({ id: 'b', validFrom: new Date('2026-09-05T00:00:00Z') });
    assert.equal(attributeOrder(order(), [early, late]), 'b');
    assert.equal(attributeOrder(order(), [late, early]), 'b');
    const t1 = s({ id: 'x' });
    const t2 = s({ id: 'y' });
    assert.equal(attributeOrder(order(), [t2, t1]), 'x');
  });
});
