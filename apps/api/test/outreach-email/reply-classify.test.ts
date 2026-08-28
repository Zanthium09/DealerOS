// §6 / §13 — "an out-of-office marking a dealer as interested is the failure to
// avoid." Heuristics first, AI only for what heuristics leave ambiguous.
import '../support';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { classifyReply, InboundEmail } from '../../src/modules/outreach-email/reply-classify';
import { FakeAIProvider } from '../../src/providers/ai/fake.provider';

const email = (overrides: Partial<InboundEmail>): InboundEmail => ({
  headers: {},
  subject: 'Re: Partnering with us',
  body: 'Sounds interesting, tell me more.',
  fromAddress: 'owner@sharmatraders.example',
  ...overrides,
});

describe('heuristics catch the common cases without ever asking the model', () => {
  test('Auto-Submitted header — out of office is NOT a human reply', async () => {
    const ai = new FakeAIProvider();
    const result = await classifyReply(
      email({ headers: { 'Auto-Submitted': 'auto-replied' }, subject: 'Out of Office: Re: Partnering with us' }),
      ai,
    );
    assert.equal(result, 'AUTO_REPLY');
    assert.equal(ai.calls.length, 0, 'heuristic decided it — the model was never asked');
  });

  test('X-Autoreply header alone is enough', async () => {
    const ai = new FakeAIProvider();
    const result = await classifyReply(email({ headers: { 'X-Autoreply': 'yes' } }), ai);
    assert.equal(result, 'AUTO_REPLY');
    assert.equal(ai.calls.length, 0);
  });

  test('Auto-Submitted: no means it is NOT auto — falls through to other checks / AI', async () => {
    const ai = new FakeAIProvider('HUMAN_REPLY');
    const result = await classifyReply(email({ headers: { 'Auto-Submitted': 'no' } }), ai);
    assert.equal(result, 'HUMAN_REPLY');
  });

  test('an out-of-office subject with no special header is still caught', async () => {
    const ai = new FakeAIProvider();
    const result = await classifyReply(email({ subject: 'Automatic reply: Re: Partnering with us' }), ai);
    assert.equal(result, 'AUTO_REPLY');
    assert.equal(ai.calls.length, 0);
  });

  test('a mailer-daemon bounce is BOUNCE, not a reply', async () => {
    const ai = new FakeAIProvider();
    const result = await classifyReply(
      email({ fromAddress: 'MAILER-DAEMON@mx.example.com', subject: 'Undelivered Mail Returned to Sender' }),
      ai,
    );
    assert.equal(result, 'BOUNCE');
    assert.equal(ai.calls.length, 0);
  });

  test('a delivery status notification subject is BOUNCE', async () => {
    const ai = new FakeAIProvider();
    const result = await classifyReply(email({ subject: 'Delivery Status Notification (Failure)' }), ai);
    assert.equal(result, 'BOUNCE');
  });

  test('an explicit unsubscribe request in the body', async () => {
    // Moved out of "without ever asking the model": a bare phrase match is no longer
    // the decision by itself, because "unsubscribe me from the newsletter, but yes we
    // want this" contains the same phrase while being genuine interest (§13 — the
    // reviewer that found this traced it end to end). The model is now always asked
    // which intent dominates when the phrase appears; an unclear answer defaults to
    // UNSUBSCRIBE_REQUEST (§1.6, consent-first), which this un-configured fake produces.
    const ai = new FakeAIProvider();
    const result = await classifyReply(email({ body: 'Please unsubscribe me from this list.' }), ai);
    assert.equal(result, 'UNSUBSCRIBE_REQUEST');
    assert.equal(ai.calls.length, 1, 'the phrase alone no longer decides it — the model is asked');
  });

  test('unsubscribe phrase alongside genuine interest is NOT auto-opted-out', async () => {
    const ai = new FakeAIProvider('HUMAN_REPLY');
    const result = await classifyReply(
      email({ body: 'please unsubscribe me from the newsletter, but yes we want this' }),
      ai,
    );
    assert.equal(result, 'HUMAN_REPLY');
    assert.equal(ai.calls.length, 1);
  });

  test('text with no heuristic match falls through to the model, not a guess', async () => {
    const ai = new FakeAIProvider('HUMAN_REPLY');
    const result = await classifyReply(email({ body: 'Yes, we would like to hear more about your products.' }), ai);
    assert.equal(result, 'HUMAN_REPLY');
    assert.equal(ai.calls.length, 1);
  });
});

describe('genuinely ambiguous text is escalated to the model, not guessed heuristically', () => {
  test('the model is asked, and its HUMAN_REPLY answer is trusted', async () => {
    const ai = new FakeAIProvider('HUMAN_REPLY');
    const result = await classifyReply(email({ body: 'ok' }), ai);
    assert.equal(result, 'HUMAN_REPLY');
    assert.equal(ai.calls.length, 1);
  });

  test('an unparseable or negative model answer defaults to AUTO_REPLY — the safe side', async () => {
    const ai = new FakeAIProvider('unsure, hard to tell');
    const result = await classifyReply(email({ body: 'ok' }), ai);
    assert.equal(result, 'AUTO_REPLY');
  });

  test('the model explicitly saying AUTO_REPLY is honoured', async () => {
    const ai = new FakeAIProvider('AUTO_REPLY');
    const result = await classifyReply(email({ body: 'ok' }), ai);
    assert.equal(result, 'AUTO_REPLY');
  });
});
