import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { HUMAN_HINT, catalogText, classify, inr, orderTotalPaise, overCap, parseOrderText, pricesChanged, skuIndex, summary, toPaise, type Line } from '../../src/modules/ordering-bot/rules';

const idx = skuIndex(['A1', 'B2', '1001']);

describe('reading order lines', () => {
  test('several formats, either order, mixed separators', () => {
    assert.deepEqual(parseOrderText('A1 x 10, B2 5', idx), { lines: [{ sku: 'A1', quantity: 10 }, { sku: 'B2', quantity: 5 }], unclear: [] });
    assert.deepEqual(parseOrderText('10 x a1\n5 b2', idx).lines, [{ sku: 'A1', quantity: 10 }, { sku: 'B2', quantity: 5 }]);
    assert.deepEqual(parseOrderText('A1*3;B2:4', idx).lines, [{ sku: 'A1', quantity: 3 }, { sku: 'B2', quantity: 4 }]);
  });
  test('repeats of a sku are summed', () => {
    assert.deepEqual(parseOrderText('A1 5, A1 5', idx).lines, [{ sku: 'A1', quantity: 10 }]);
  });
  test('never guesses: unknown codes, decimals, zero and words go to unclear', () => {
    for (const bad of ['Z9 x 10', 'A1 x 2.5', 'A1 x 0', 'A1 x ten', 'A1', 'ten']) {
      const r = parseOrderText(bad, idx);
      assert.deepEqual(r.lines, [], bad);
      assert.equal(r.unclear.length, 1, bad);
    }
  });
  test('one bad token does not hide behind good ones', () => {
    const r = parseOrderText('A1 x 10, Z9 x 5', idx);
    assert.equal(r.lines.length, 1);
    assert.deepEqual(r.unclear, ['Z9 x 5']);
  });
  test('a numeric sku next to a quantity is ambiguous only if both readings are real', () => {
    assert.deepEqual(parseOrderText('1001 x 5', idx).lines, [{ sku: '1001', quantity: 5 }]);
    assert.equal(parseOrderText('1001 1001', idx).lines[0].quantity, 1001); // same reading both ways
  });
});

describe('commands', () => {
  test('an order is placed only on the word CONFIRM — "ok" and "yes" are not enough', () => {
    assert.equal(classify('CONFIRM', 0), 'CONFIRM');
    assert.equal(classify('Confirm order!', 0), 'CONFIRM');
    for (const t of ['ok', 'yes', 'haan', 'thik hai', 'sure']) assert.notEqual(classify(t, 0), 'CONFIRM', t);
  });
  test('asking for a person beats everything, cancel beats confirm', () => {
    assert.equal(classify('please call me', 0), 'HUMAN');
    assert.equal(classify('I want to talk to a person', 3), 'HUMAN');
    assert.equal(classify('cancel', 0), 'CANCEL');
  });
  test('menu, catalog, reorder', () => {
    assert.equal(classify('Hi', 0), 'MENU');
    assert.equal(classify('catalogue', 0), 'CATALOG');
    assert.equal(classify('Reorder', 0), 'REORDER');
    assert.equal(classify('same as last time', 0), 'REORDER');
  });
  test('anything else is left to a person', () => {
    assert.equal(classify('what is the status of my shipment', 0), 'UNKNOWN');
    assert.equal(classify('', 0), 'UNKNOWN');
    assert.equal(classify('A1 x 10', 1), 'ORDER');
  });
});

describe('money', () => {
  const lines: Line[] = [
    { sku: 'A1', productName: 'Widget', quantity: 10, unitPrice: 120.5 },
    { sku: 'B2', productName: 'Gadget', quantity: 3, unitPrice: 99.99 },
  ];
  test('whole paise, no float drift', () => {
    assert.equal(toPaise('99.99'), 9999);
    assert.equal(toPaise(0.1 + 0.2), 30);
    assert.equal(orderTotalPaise(lines), 12050 * 10 + 9999 * 3);
  });
  test('formatting', () => {
    assert.equal(inr(150000), '₹1,500');
    assert.equal(inr(150050), '₹1,500.50');
  });
  test('the summary states every line and the total, and always offers a person', () => {
    const s = summary(lines);
    assert.match(s, /Widget \(A1\) — 10 × ₹120\.50 = ₹1,205/);
    assert.match(s, /Total: ₹1,504\.97/);
    assert.match(s, /CONFIRM/);
    assert.ok(s.includes(HUMAN_HINT));
    assert.ok(catalogText([{ sku: 'A1', name: 'W', unitPrice: 5 }], 1).includes(HUMAN_HINT));
  });
  test('a quantity over the cap is refused, not clamped', () => {
    assert.deepEqual(overCap([{ sku: 'A1', quantity: 5000 }, { sku: 'B2', quantity: 5 }], 500), [{ sku: 'A1', quantity: 5000 }]);
  });
  test('prices changed or item gone since the dealer was shown them', () => {
    const now = new Map([['A1', { unitPrice: 120.5, active: true }], ['B2', { unitPrice: 99.99, active: true }]]);
    assert.equal(pricesChanged(lines, now), false);
    assert.equal(pricesChanged(lines, new Map([...now, ['A1', { unitPrice: 125, active: true }]])), true);
    assert.equal(pricesChanged(lines, new Map([...now, ['B2', { unitPrice: 99.99, active: false }]])), true);
    assert.equal(pricesChanged(lines, new Map([['A1', { unitPrice: 120.5, active: true }]])), true);
  });
});
