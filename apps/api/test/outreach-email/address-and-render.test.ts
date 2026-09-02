// The address guard and deterministic rendering — both sit directly on the send
// path (§13: a wrong send is a damaged relationship, not a cosmetic bug).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { isPlausibleEmail } from '../../src/modules/outreach-email/send.service';
import { renderPlain } from '../../src/modules/outreach-email/cold-draft.service';
import { normalizeRow } from '../../src/modules/contacts/normalize';

describe('isPlausibleEmail', () => {
  test('accepts ordinary addresses, including plus tags and subdomains', () => {
    for (const good of [
      'info@v2jtechservices.com',
      'sales+dealers@mail-plexus.in',
      'a.b@x.co.in',
      'RAJ@EXAMPLE.COM',
    ]) {
      assert.equal(isPlausibleEmail(good), true, good);
    }
  });

  test('rejects the fragments a free-text cell shreds into', () => {
    // Exactly the values found on a real dealer whose send failed: a business
    // name split on whitespace, each word stored as if it were an address.
    for (const bad of ['microdots', 'consultancy', 'v2j', 'tech', '', '   ', 'no-at-sign.com', 'a@b']) {
      assert.equal(isPlausibleEmail(bad), false, JSON.stringify(bad));
    }
  });

  test('rejects an address still wearing its angle brackets', () => {
    // It IS a real address, but not in a form a provider accepts — repairing it
    // means unwrapping, not sending it as-is.
    assert.equal(isPlausibleEmail('<info@v2jtechservices.com>'), false);
  });
});

describe('import no longer stores non-addresses', () => {
  test('a free-text cell yields only the real address', () => {
    const row = normalizeRow(
      { Name: 'Microdots', Email: 'Microdots Consultancy Services <info@v2jtechservices.com>' },
      { businessName: 'Name', email: 'Email' },
    );
    assert.deepEqual(row.emails, ['info@v2jtechservices.com']);
  });

  test('genuinely multi-valued cells still split', () => {
    const row = normalizeRow(
      { Name: 'Acme', Email: 'a@x.com, b@y.com' },
      { businessName: 'Name', email: 'Email' },
    );
    assert.deepEqual(row.emails, ['a@x.com', 'b@y.com']);
  });
});

describe('renderPlain', () => {
  test('substitutes every known placeholder and leaves unknown ones alone', () => {
    assert.equal(
      renderPlain('Hello {{contactName}} at {{businessName}} in {{city}} — {{nope}}', {
        contactName: 'Raj',
        businessName: '24x7 Traders',
        city: 'Mumbai',
      }),
      'Hello Raj at 24x7 Traders in Mumbai — {{nope}}',
    );
  });

  test('a digit in the value is preserved — it is a database column, not model prose (§1.4)', () => {
    assert.equal(renderPlain('{{businessName}}', { businessName: '24x7 Traders' }), '24x7 Traders');
  });
});
