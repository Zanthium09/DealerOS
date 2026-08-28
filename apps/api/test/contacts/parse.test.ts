// M1 parsing and normalisation (§5.1). Pure functions — no database needed.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFile } from '../../src/modules/contacts/parse';
import {
  normalizePhone,
  normalizeRow,
  suggestMapping,
} from '../../src/modules/contacts/normalize';

const csv = (s: string) => Buffer.from(s, 'utf8');

describe('CSV parsing edge cases', () => {
  test('BOM, CRLF, quoted commas, embedded newlines and blank rows', async () => {
    const { headers, rows } = await parseFile(
      'dealers.csv',
      csv(
        '﻿"Business Name","City","Phone"\r\n' +
          '"Acme, Traders","Pune","9876543210"\r\n' +
          '\r\n' +
          '"Multi\nLine Co","Nashik","022 1234 5678"\r\n',
      ),
    );

    assert.deepEqual(headers, ['Business Name', 'City', 'Phone']);
    assert.equal(rows.length, 2, 'the blank row is dropped, the two real ones are not');
    assert.equal(rows[0]['Business Name'], 'Acme, Traders');
    assert.equal(rows[1]['Business Name'], 'Multi\nLine Co');
  });

  test('duplicate header names do not overwrite each other', async () => {
    const { headers, rows } = await parseFile('x.csv', csv('Phone,Phone\n11111,22222\n'));
    assert.deepEqual(headers, ['Phone', 'Phone_2']);
    assert.deepEqual(rows[0], { Phone: '11111', Phone_2: '22222' });
  });

  test('an unnamed column still gets a usable header', async () => {
    const { headers } = await parseFile('x.csv', csv('Name,,City\na,b,c\n'));
    assert.deepEqual(headers, ['Name', 'column_2', 'City']);
  });

  test('ragged rows do not throw', async () => {
    const { rows } = await parseFile('x.csv', csv('a,b,c\n1,2\n1,2,3,4\n'));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].c, '');
  });
});

describe('column mapping suggestion', () => {
  test('recognises the usual header spellings, and collects phone columns', () => {
    const mapping = suggestMapping([
      'Firm Name',
      'Contact Person',
      'Mobile No',
      'WhatsApp',
      'Email ID',
      'City',
      'State',
      'Category',
    ]);
    assert.equal(mapping.businessName, 'Firm Name');
    assert.equal(mapping.contactPersonName, 'Contact Person');
    assert.deepEqual(mapping.phone, ['Mobile No', 'WhatsApp']);
    assert.deepEqual(mapping.email, ['Email ID']);
    assert.equal(mapping.city, 'City');
    assert.equal(mapping.state, 'State');
    assert.equal(mapping.businessCategory, 'Category');
  });

  test('unknown headers are simply not mapped — nothing is guessed', () => {
    assert.deepEqual(suggestMapping(['GSTIN', 'Remarks']), {});
  });
});

describe('normalisation (§5.1)', () => {
  test('an unparseable phone is FLAGGED, not dropped, and raw survives', () => {
    const bad = normalizePhone('not-a-number');
    assert.equal(bad.valid, false);
    assert.equal(bad.e164, null);
    assert.equal(bad.raw, 'not-a-number');
  });

  test('default region IN, both raw and E.164 stored', () => {
    const good = normalizePhone('98765 43210');
    assert.equal(good.valid, true);
    assert.equal(good.e164, '+919876543210');
    assert.equal(good.raw, '98765 43210');
  });

  test('emails lowercase, one cell may hold several numbers', () => {
    const row = normalizeRow(
      { Name: 'Acme', Phone: '9876543210 / not-a-number', Email: 'A@Example.COM' },
      { businessName: 'Name', phone: 'Phone', email: 'Email' },
    );
    assert.deepEqual(row.emails, ['a@example.com']);
    assert.equal(row.phones.length, 2);
    assert.deepEqual(
      row.phones.map((p) => p.valid),
      [true, false],
    );
    assert.equal(row.dedupeKey, 'p:+919876543210');
  });

  test('dedupeKey falls back email → name+city when no number parses', () => {
    const byEmail = normalizeRow(
      { N: 'Acme', E: 'a@b.com' },
      { businessName: 'N', email: 'E' },
    );
    assert.equal(byEmail.dedupeKey, 'e:a@b.com');

    const byName = normalizeRow({ N: 'Acme Traders', C: 'Pune' }, { businessName: 'N', city: 'C' });
    assert.equal(byName.dedupeKey, 'n:acmetraders|pune');
  });
});
