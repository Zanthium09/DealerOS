// §5.3 / §7 — the WhatsApp rules and the Meta plumbing, pure (no DB, no network).
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyIntent,
  estimateCost,
  fromWaId,
  isPositiveIntent,
  isWarm,
  nextConversation,
  paramsFor,
  renderTemplate,
  sessionExpiryFrom,
  sessionOpen,
  SESSION_MS,
  validateTemplate,
} from '../../src/modules/outreach-whatsapp/rules';
import { pickWhatsAppNumber } from '../../src/modules/outreach-whatsapp/eligibility';
import { normalizeWebhook } from '../../src/providers/whatsapp/cloud-api.provider';
import { signMetaPayload, verifyMetaSignature } from '../../src/providers/whatsapp/signature';

describe('24-hour service window (§7)', () => {
  const t0 = new Date('2026-09-01T10:00:00Z');

  test('opens 24h after the dealer’s message and closes exactly then', () => {
    const expiry = sessionExpiryFrom(t0);
    assert.equal(expiry.getTime() - t0.getTime(), SESSION_MS);
    assert.equal(sessionOpen(expiry, new Date(expiry.getTime() - 1)), true);
    assert.equal(sessionOpen(expiry, expiry), false);
  });

  test('no session is a closed session', () => {
    assert.equal(sessionOpen(null), false);
    assert.equal(sessionOpen(undefined), false);
  });
});

describe('warm-routing (§1.2, §7)', () => {
  test('a cold contact is not warm', () => {
    assert.equal(isWarm({ consent: null, hasEngaged: false, stage: 'NEW' }), false);
    assert.equal(isWarm({ consent: 'UNKNOWN', hasEngaged: false, stage: 'NEW' }), false);
    assert.equal(isWarm({ consent: null, hasEngaged: false, stage: 'CONTACTED' }), false);
  });

  test('each of the four routes in is enough on its own', () => {
    assert.equal(isWarm({ consent: 'OPTED_IN', hasEngaged: false, stage: 'NEW' }), true); // opted in
    assert.equal(isWarm({ consent: null, hasEngaged: true, stage: 'NEW' }), true); // replied/clicked/messaged first
    for (const stage of ['INTERESTED', 'ONBOARDED', 'ACTIVE', 'DORMANT', 'REACTIVATED'] as const) {
      assert.equal(isWarm({ consent: null, hasEngaged: false, stage }), true, stage); // already a relationship
    }
  });

  test('an opt-out beats every warm signal — consent is per channel and latest wins (§10.2)', () => {
    assert.equal(isWarm({ consent: 'OPTED_OUT', hasEngaged: true, stage: 'ACTIVE' }), false);
  });
});

describe('inbound intent → conversation state (§5.3)', () => {
  const cases: [string, ReturnType<typeof classifyIntent>][] = [
    ['STOP', 'STOP'],
    ['please unsubscribe me', 'STOP'],
    ['Do not contact me again', 'STOP'],
    ['not interested, thanks', 'NOT_INTERESTED'],
    ['nahi chahiye', 'NOT_INTERESTED'],
    ['can you send the catalogue?', 'CATALOG'],
    ['what is the price of the 4MP camera', 'PRICING'],
    ['kitna rate hai', 'PRICING'],
    ['best price for bulk order please', 'NEGOTIATION'],
    ['I want to negotiate the payment terms', 'NEGOTIATION'],
    ['yes I am interested, call me', 'INTERESTED'],
    ['haan', 'INTERESTED'],
    ['hello', 'OTHER'],
    ['ok', 'OTHER'], // a bare ok answers whatever came last; it is not a buying signal
    ['', 'OTHER'],
  ];
  for (const [text, intent] of cases) {
    test(`"${text}" → ${intent}`, () => assert.equal(classifyIntent(text), intent));
  }

  test('the safer reading wins when a message matches several', () => {
    assert.equal(classifyIntent('send the price list — actually not interested'), 'NOT_INTERESTED');
    assert.equal(classifyIntent('stop, I am not interested in the catalogue'), 'STOP');
  });

  test('pricing, negotiation and unknown messages go to a human; STOP and declines do not', () => {
    assert.equal(nextConversation('PRICING').needsHuman, true);
    assert.equal(nextConversation('NEGOTIATION').needsHuman, true);
    assert.equal(nextConversation('OTHER').needsHuman, true);
    assert.equal(nextConversation('OTHER').state, 'HUMAN');
    assert.equal(nextConversation('STOP').needsHuman, false);
    assert.equal(nextConversation('NOT_INTERESTED').needsHuman, false);
  });

  test('only asking / interest is a positive signal', () => {
    for (const i of ['CATALOG', 'PRICING', 'NEGOTIATION', 'INTERESTED'] as const) assert.equal(isPositiveIntent(i), true, i);
    for (const i of ['STOP', 'NOT_INTERESTED', 'OTHER'] as const) assert.equal(isPositiveIntent(i), false, i);
  });
});

describe('template rules', () => {
  const ok = { name: 'dealer_intro', bodyText: 'Hi {{1}}, we distribute to businesses like {{2}}. Reply to know more.', paramKeys: ['contactName', 'businessName'] };

  test('a well-formed template passes', () => assert.equal(validateTemplate(ok), null));

  test('rejects what Meta would reject, with a reason', () => {
    assert.match(validateTemplate({ ...ok, name: 'Dealer Intro' })!, /lowercase/);
    assert.match(validateTemplate({ ...ok, bodyText: '   ' })!, /empty/);
    assert.match(validateTemplate({ ...ok, bodyText: 'x'.repeat(1025) })!, /1024/);
    assert.match(validateTemplate({ ...ok, paramKeys: ['contactName'] })!, /exactly once/); // {{2}} has no field
    assert.match(validateTemplate({ ...ok, bodyText: 'Hi {{2}} and {{2}}', paramKeys: ['a', 'b'] })!, /exactly once|only once/);
    assert.match(validateTemplate({ ...ok, bodyText: '{{1}} hello {{2}}' })!, /starts or ends/);
    assert.match(validateTemplate({ ...ok, paramKeys: ['contactName', 'amountDue'] })!, /not a field/);
  });

  test('placeholders must be numbered from 1 with no gaps', () => {
    assert.match(validateTemplate({ name: 'a', bodyText: 'Hi {{2}} there', paramKeys: ['contactName'] })!, /exactly once/);
  });

  test('rendering substitutes from the database values; a missing name falls back politely', () => {
    assert.equal(renderTemplate('Hi {{1}}, re {{2}}.', ['Asha', 'Sharma Traders']), 'Hi Asha, re Sharma Traders.');
    assert.deepEqual(paramsFor(['contactName', 'city'], { contactName: null, city: 'Pune' }), ['Sir/Madam', 'Pune']);
    assert.deepEqual(paramsFor(['city'], {}), ['-']);
  });
});

describe('cost estimate (§7)', () => {
  test('marketing costs ~7.5x utility, and the total is rounded to paise', () => {
    const m = estimateCost('MARKETING', 100);
    const u = estimateCost('UTILITY', 100);
    assert.equal(m.total, 86.31);
    assert.equal(u.total, 11.5);
    assert.ok(m.total / u.total > 7 && m.total / u.total < 8);
    assert.equal(estimateCost('MARKETING', 0).total, 0);
  });
});

describe('phone selection', () => {
  const p = (e164: string | null, over: object = {}) => ({ e164, valid: true, isWhatsapp: false, isPrimary: false, ...over });
  test('prefers a WhatsApp-marked number, then primary; skips invalid and unparsed', () => {
    assert.equal(pickWhatsAppNumber([p('+911', { isPrimary: true }), p('+912', { isWhatsapp: true })]), '+912');
    assert.equal(pickWhatsAppNumber([p('+911'), p('+912', { isPrimary: true })]), '+912');
    assert.equal(pickWhatsAppNumber([p('+911', { valid: false }), p(null)]), null);
    assert.equal(fromWaId('919876543210'), '+919876543210');
  });
});

describe('Meta webhook signature (§8)', () => {
  const secret = 'app-secret';
  const body = Buffer.from('{"object":"whatsapp_business_account"}');

  test('accepts a correctly signed body', () => {
    assert.equal(verifyMetaSignature(body, signMetaPayload(body, secret), secret), true);
  });

  test('rejects a tampered body, wrong secret, missing/short/malformed header', () => {
    const sig = signMetaPayload(body, secret);
    assert.equal(verifyMetaSignature(Buffer.from('{"object":"x"}'), sig, secret), false);
    assert.equal(verifyMetaSignature(body, sig, 'other-secret'), false);
    assert.equal(verifyMetaSignature(body, undefined, secret), false);
    assert.equal(verifyMetaSignature(body, 'sha256=abc', secret), false);
    assert.equal(verifyMetaSignature(body, sig.replace('sha256=', ''), secret), false);
    assert.equal(verifyMetaSignature(body, sig, ''), false);
  });
});

describe('webhook normalisation', () => {
  const wrap = (field: string, value: object, id = 'WABA1') => ({ object: 'whatsapp_business_account', entry: [{ id, changes: [{ field, value }] }] });

  test('an inbound text message', () => {
    const [e] = normalizeWebhook(
      wrap('messages', {
        metadata: { phone_number_id: 'PN1' },
        contacts: [{ wa_id: '919876543210', profile: { name: 'Asha' } }],
        messages: [{ from: '919876543210', id: 'wamid.1', timestamp: '1788000000', type: 'text', text: { body: 'price?' } }],
      }),
    );
    assert.deepEqual({ ...e, at: undefined }, { type: 'MESSAGE', phoneNumberId: 'PN1', from: '919876543210', profileName: 'Asha', text: 'price?', providerMessageId: 'wamid.1', at: undefined });
  });

  test('button replies and media are represented truthfully, not dropped', () => {
    const events = normalizeWebhook(
      wrap('messages', {
        metadata: { phone_number_id: 'PN1' },
        messages: [
          { from: '9', id: 'a', timestamp: '1', type: 'button', button: { text: 'Yes' } },
          { from: '9', id: 'b', timestamp: '1', type: 'image', image: {} },
        ],
      }),
    );
    assert.deepEqual(events.map((e) => (e.type === 'MESSAGE' ? e.text : null)), ['Yes', '[image message]']);
  });

  test('statuses: delivered, read and failed (with Meta’s error code)', () => {
    const events = normalizeWebhook(
      wrap('messages', {
        metadata: { phone_number_id: 'PN1' },
        statuses: [
          { id: 'w1', status: 'delivered', timestamp: '1' },
          { id: 'w1', status: 'read', timestamp: '2' },
          { id: 'w2', status: 'failed', timestamp: '3', errors: [{ code: 131047, title: 'Re-engagement message' }] },
          { id: 'w3', status: 'deleted', timestamp: '4' }, // not one we act on
        ],
      }),
    );
    assert.deepEqual(events.map((e) => (e.type === 'STATUS' ? e.status : null)), ['DELIVERED', 'READ', 'FAILED']);
    const failed = events[2];
    assert.equal(failed.type === 'STATUS' && failed.error, '#131047 Re-engagement message');
  });

  test('template status and quality updates', () => {
    const [t] = normalizeWebhook(
      wrap('message_template_status_update', { event: 'REJECTED', message_template_id: 't1', message_template_name: 'x', reason: 'INVALID_FORMAT' }),
    );
    assert.deepEqual(t, { type: 'TEMPLATE', wabaId: 'WABA1', metaTemplateId: 't1', name: 'x', status: 'REJECTED', reason: 'INVALID_FORMAT' });

    const [q] = normalizeWebhook(wrap('phone_number_quality_update', { metadata: { phone_number_id: 'PN1' }, event: 'FLAGGED', current_limit: 'TIER_1K' }));
    assert.deepEqual(q, { type: 'QUALITY', phoneNumberId: 'PN1', event: 'FLAGGED', tier: 'TIER_1K' });
  });

  test('garbage in, nothing out', () => {
    assert.deepEqual(normalizeWebhook({}), []);
    assert.deepEqual(normalizeWebhook(null), []);
    assert.deepEqual(normalizeWebhook(wrap('unknown_field', {})), []);
  });
});
