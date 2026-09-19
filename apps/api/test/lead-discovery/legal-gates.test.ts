// §13 — M0 blocklist and robots.txt refusal, including subdomain and path variants; and
// extraction rejecting any value absent from the source text. Pure: no DB, no network.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { blocklist, isBlocklisted, parseFetchableUrl } from '../../src/providers/discovery/blocklist';
import { robotsAllows } from '../../src/providers/discovery/robots';
import { isPrivateAddress } from '../../src/providers/discovery/net-guard';
import { classifyBlocked } from '../../src/providers/discovery/url-fetcher';
import { chunkText, parseModelJson, validateExtraction } from '../../src/providers/discovery/extraction';
import { htmlToLines } from '../../src/providers/discovery/html-text';

describe('blocklist (§10.10)', () => {
  test('blocks the three forbidden sites in every URL shape', () => {
    for (const url of [
      'https://indiamart.com',
      'http://indiamart.com/',
      'https://www.indiamart.com/products/cctv',
      'https://dir.indiamart.com/impcat/dealers.html?city=pune',
      'https://WWW.JUSTDIAL.COM/Mumbai/Distributors',
      'https://justdial.com:443/x',
      'https://www.tradeindia.com/',
      'https://indiamart.com./trailing-dot',
      'https://evil.com@indiamart.com/', // host is indiamart.com, "evil.com" is userinfo
    ]) {
      assert.equal(isBlocklisted(url), true, url);
    }
  });

  test('a scheme-less paste is still blocked — not a way around the list', () => {
    assert.equal(isBlocklisted('indiamart.com/x'), true);
    assert.equal(isBlocklisted('www.justdial.com'), true);
  });

  test('other hosts are not caught by accident', () => {
    for (const url of [
      'https://notindiamart.com',
      'https://indiamart.com.evil.com/',
      'https://evil.com/indiamart.com',
      'https://example.com/?ref=justdial.com',
      'https://indiamart.com@evil.com/', // host is evil.com
    ]) {
      assert.equal(isBlocklisted(url), false, url);
    }
  });

  test('config extends the defaults and never shrinks them', () => {
    const list = blocklist('Example.org, .other.in');
    assert.ok(list.includes('indiamart.com') && list.includes('example.org') && list.includes('other.in'));
    assert.equal(isBlocklisted('https://sub.example.org/x', list), true);
  });

  test('only http(s) is ever fetchable', () => {
    assert.equal(parseFetchableUrl('file:///etc/passwd'), null);
    assert.equal(parseFetchableUrl('ftp://x.com'), null);
    assert.equal(parseFetchableUrl('javascript://x'), null);
    assert.equal(parseFetchableUrl('   '), null);
  });
});

describe('robots.txt', () => {
  const txt = [
    'User-agent: *',
    'Disallow: /private/',
    'Disallow: /*.pdf$',
    'Allow: /private/public-list',
    '',
    'User-agent: DealerOSBot',
    'Disallow: /directory/members',
  ].join('\n');

  test('a group naming us wins over *', () => {
    assert.equal(robotsAllows(txt, 'DealerOSBot', '/directory/members/1'), false);
    // The * group's rules do not apply to a bot that has its own group.
    assert.equal(robotsAllows(txt, 'DealerOSBot', '/private/x'), true);
  });

  test('falls back to * and honours longest-match, wildcards and $', () => {
    assert.equal(robotsAllows(txt, 'OtherBot', '/private/x'), false);
    assert.equal(robotsAllows(txt, 'OtherBot', '/private/public-list'), true); // longer Allow wins
    assert.equal(robotsAllows(txt, 'OtherBot', '/files/a.pdf'), false);
    assert.equal(robotsAllows(txt, 'OtherBot', '/files/a.pdf.html'), true); // $ anchors the end
  });

  test('empty Disallow, comments and no matching group allow everything', () => {
    assert.equal(robotsAllows('User-agent: *\nDisallow:', 'DealerOSBot', '/anything'), true);
    assert.equal(robotsAllows('# nothing here', 'DealerOSBot', '/anything'), true);
    assert.equal(robotsAllows('User-agent: Googlebot\nDisallow: /', 'DealerOSBot', '/anything'), true);
  });

  test('Disallow: / shuts us out entirely', () => {
    assert.equal(robotsAllows('User-agent: *\nDisallow: /', 'DealerOSBot', '/x'), false);
  });

  test('query strings are part of the path being matched', () => {
    assert.equal(robotsAllows('User-agent: *\nDisallow: /*?session=', 'DealerOSBot', '/a?session=1'), false);
  });
});

describe('SSRF guard', () => {
  test('private, loopback, link-local and metadata addresses are refused', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      assert.equal(isPrivateAddress(ip), true, ip);
    }
  });

  test('public addresses pass', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111']) {
      assert.equal(isPrivateAddress(ip), false, ip);
    }
  });
});

describe('blocked-page classification (§10.10)', () => {
  test('401 is a login wall; 403/429 are blocks and are never retried', () => {
    assert.equal(classifyBlocked(401, ''), 'LOGIN_WALL');
    assert.equal(classifyBlocked(403, ''), 'BLOCKED_BY_SITE');
    assert.equal(classifyBlocked(429, ''), 'BLOCKED_BY_SITE');
  });

  test('a 200 that is really a CAPTCHA or challenge page is a block', () => {
    assert.equal(classifyBlocked(200, '<div class="g-recaptcha"></div>'), 'BLOCKED_BY_SITE');
    assert.equal(classifyBlocked(200, '<title>Just a moment...</title>'), 'BLOCKED_BY_SITE');
    assert.equal(classifyBlocked(503, '<div id="cf-turnstile"></div>'), 'BLOCKED_BY_SITE');
  });

  test('a password form on a nearly link-free page is a login wall; on a rich page it is not', () => {
    const form = '<form><input type="password" name="p"></form>';
    assert.equal(classifyBlocked(200, form), 'LOGIN_WALL');
    assert.equal(classifyBlocked(200, form + '<a href="/x">x</a>'.repeat(40)), null);
  });

  test('an ordinary 200 and a plain 503 are not blocks', () => {
    assert.equal(classifyBlocked(200, '<html><body>Hello</body></html>'), null);
    assert.equal(classifyBlocked(503, 'Service Unavailable'), null);
  });
});

describe('extraction never keeps a value that is absent from the source (§10.9)', () => {
  const source = [
    'Sharma Traders, Shop 4, Lamington Road, Mumbai — Ph: 98765 43210, sharma@sharmatraders.in',
    'Verma Electronics | Delhi | 011-2345 6789',
  ].join('\n');

  test('a well-formed row that is fully in the source is accepted', () => {
    const { accepted, rejected } = validateExtraction(
      [{ businessName: 'Sharma Traders', contactPersonName: null, phones: ['98765 43210'], emails: ['sharma@sharmatraders.in'], address: null, city: 'Mumbai', state: null, category: null }],
      source,
    );
    assert.equal(rejected.length, 0);
    assert.equal(accepted[0].city, 'Mumbai');
  });

  test('an invented business is rejected', () => {
    const { accepted, rejected } = validateExtraction([{ businessName: 'Gupta Wholesale' }], source);
    assert.equal(accepted.length, 0);
    assert.match(rejected[0].reason, /businessName/);
  });

  test('an invented phone number sinks the row', () => {
    const { accepted, rejected } = validateExtraction([{ businessName: 'Sharma Traders', phones: ['99999 11111'] }], source);
    assert.equal(accepted.length, 0);
    assert.match(rejected[0].reason, /phone/);
  });

  test('a +91 prefix the model added does not sink a real number', () => {
    const { accepted } = validateExtraction([{ businessName: 'Sharma Traders', phones: ['+91 98765 43210'] }], source);
    assert.equal(accepted.length, 1);
  });

  test('an invented email and an invented contact person each sink the row', () => {
    assert.equal(validateExtraction([{ businessName: 'Sharma Traders', emails: ['ceo@sharmatraders.in'] }], source).accepted.length, 0);
    assert.equal(validateExtraction([{ businessName: 'Sharma Traders', contactPersonName: 'Rajesh Sharma' }], source).accepted.length, 0);
  });

  test('a soft field the source does not contain becomes null — never kept, never a guess', () => {
    const { accepted } = validateExtraction(
      [{ businessName: 'Verma Electronics', city: 'Delhi', state: 'Uttar Pradesh', category: 'Electronics Distributor' }],
      source,
    );
    assert.equal(accepted[0].city, 'Delhi');
    assert.equal(accepted[0].state, null);
    assert.equal(accepted[0].category, null);
  });

  test('a row with no name, and non-object rows, are rejected', () => {
    const { accepted, rejected } = validateExtraction([{ phones: ['98765 43210'] }, 'text', null], source);
    assert.equal(accepted.length, 0);
    assert.equal(rejected.length, 3);
  });
});

describe('model output and text handling', () => {
  test('parseModelJson tolerates a fenced block and surrounding prose', () => {
    assert.deepEqual(parseModelJson('Here you go:\n```json\n[{"a":1}]\n```'), [{ a: 1 }]);
    assert.throws(() => parseModelJson('no array here'));
    assert.throws(() => parseModelJson('[1,'));
  });

  test('chunkText splits on line boundaries and is bounded', () => {
    const text = Array.from({ length: 400 }, (_, i) => `Listing number ${i} with some padding text`).join('\n');
    const chunks = chunkText(text, 1000, 5);
    assert.equal(chunks.length, 5);
    assert.ok(chunks.every((c) => c.endsWith('\n') && !/Listing number \d+ with some padding tex$/.test(c)));
  });

  test('htmlToLines keeps neighbouring listings apart and surfaces mailto: targets', () => {
    const html =
      '<script>var x=1</script><ul><li>Alpha Traders <a href="mailto:a@alpha.in">mail</a></li><li>Beta Co</li></ul>' +
      '<table><tr><td>Gamma</td><td>98765 43210</td></tr></table>';
    const out = htmlToLines(html);
    assert.ok(!out.includes('var x'));
    assert.match(out, /Alpha Traders a@alpha\.in mail\nBeta Co/);
    assert.match(out, /Gamma \| 98765 43210/);
  });
});
