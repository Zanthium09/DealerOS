// §5.0 / design doc §6.3 — the URL entry point, gated in this order BEFORE any page is
// requested:
//
//   1. blocklist                        → REFUSED, BLOCKLISTED_DOMAIN
//   2. non-public address (SSRF)        → REFUSED, NON_PUBLIC_ADDRESS
//   3. robots.txt                       → REFUSED, ROBOTS_DISALLOWED
//   4. fetch with an honest User-Agent, one connection at a time per host, with a delay
//   5. login page / CAPTCHA / 401 / 403 → REFUSED, LOGIN_WALL | BLOCKED_BY_SITE
//
// Never retried under a different identity, never with a spoofed User-Agent, never
// around a CAPTCHA. A block is an answer.
import { RefusalReason } from '@prisma/client';
import { blocklist, hostnameOf, isBlocklisted, parseFetchableUrl } from './blocklist';
import { GetResult, NonPublicAddressError, safeGet } from './net-guard';
import { robotsAllows } from './robots';

/** The robots.txt product token. Stable — sites write rules against it. */
export const ROBOT_TOKEN = 'DealerOSBot';

export class DiscoveryRefusedError extends Error {
  constructor(
    public readonly reason: RefusalReason,
    message: string,
  ) {
    super(message);
  }
}

const MAX_REDIRECTS = 3;
const MIN_DELAY_MS = 2_000;

/** Honest, and names the business (design doc §6.3 step 3). */
export function userAgent(orgName: string, contact = process.env.DISCOVERY_CONTACT ?? 'contact not configured'): string {
  return `${ROBOT_TOKEN}/1.0 (${orgName}; ${contact})`;
}

const CAPTCHA_MARKERS = [/g-recaptcha/i, /h-captcha/i, /hcaptcha\.com/i, /cf-challenge/i, /cf-turnstile/i, /Just a moment\.\.\./i, /Attention Required! \| Cloudflare/i, /px-captcha/i];

/**
 * What a "you can't have this" page looks like when the server answered 200 anyway.
 * Heuristic on purpose — a false positive REFUSES a page (costs a person a manual
 * paste); a false negative would extract from a login form (garbage, but harmless).
 */
export function classifyBlocked(status: number, html: string): RefusalReason | null {
  if (status === 401) return 'LOGIN_WALL';
  if (status === 403 || status === 429 || status === 503) {
    return CAPTCHA_MARKERS.some((r) => r.test(html)) || status !== 503 ? 'BLOCKED_BY_SITE' : null;
  }
  if (CAPTCHA_MARKERS.some((r) => r.test(html))) return 'BLOCKED_BY_SITE';
  if (/<input[^>]+type=["']?password/i.test(html)) {
    // A password box on a page with almost no links is a login wall, not a directory.
    const links = (html.match(/<a\s/gi) ?? []).length;
    if (links < 15) return 'LOGIN_WALL';
  }
  return null;
}

// One connection at a time per host, with a delay between requests (design doc §8).
// ponytail: in-process, so two API replicas would not coordinate. Move to the shared
// Redis throttle when there is more than one replica.
const chains = new Map<string, Promise<unknown>>();
const lastHit = new Map<string, number>();

function paced<T>(host: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(host) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const wait = (lastHit.get(host) ?? 0) + MIN_DELAY_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await fn();
    } finally {
      lastHit.set(host, Date.now());
    }
  });
  chains.set(host, next);
  return next;
}

export type FetchedPage = { finalUrl: string; html: string };

async function robotsFor(origin: URL, ua: string): Promise<string | null> {
  const robotsUrl = new URL('/robots.txt', origin);
  const res = await paced(hostnameOf(origin), () => safeGet(robotsUrl, { headers: { 'User-Agent': ua }, maxBytes: 500_000 }));
  if (res.status === 404 || res.status === 410) return null; // no robots.txt — nothing forbidden
  // A robots.txt the site refuses to serve us, or cannot serve at all, is not permission.
  if (res.status === 401 || res.status === 403 || res.status >= 500) {
    throw new DiscoveryRefusedError('ROBOTS_DISALLOWED', `robots.txt for ${origin.host} answered ${res.status} — treated as disallowed`);
  }
  return res.body.toString('utf8');
}

export async function fetchPage(rawUrl: string, orgName: string): Promise<FetchedPage> {
  const ua = userAgent(orgName);
  let url = parseFetchableUrl(rawUrl);
  if (!url) throw new Error(`"${rawUrl}" is not a fetchable http(s) URL`);
  const list = blocklist();

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (isBlocklisted(url.href, list)) {
      throw new DiscoveryRefusedError(
        'BLOCKLISTED_DOMAIN',
        `${hostnameOf(url)} forbids automated access — open it in your browser and add the dealer manually`,
      );
    }

    try {
      const robots = await robotsFor(url, ua);
      if (robots !== null && !robotsAllows(robots, ROBOT_TOKEN, url.pathname + url.search)) {
        throw new DiscoveryRefusedError('ROBOTS_DISALLOWED', `${hostnameOf(url)}'s robots.txt disallows ${url.pathname}`);
      }

      const target = url;
      const res: GetResult = await paced(hostnameOf(target), () =>
        safeGet(target, { headers: { 'User-Agent': ua, Accept: 'text/html,text/plain;q=0.9' } }),
      );

      if (res.status >= 300 && res.status < 400 && res.headers.location) {
        // Every gate re-runs on the next hop: a redirect must not launder a blocklisted host.
        url = new URL(String(res.headers.location), url);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('redirected to a non-http(s) URL');
        continue;
      }

      const html = res.body.toString('utf8');
      const blocked = classifyBlocked(res.status, html);
      if (blocked) {
        throw new DiscoveryRefusedError(blocked, `${hostnameOf(url)} answered ${res.status} with a ${blocked === 'LOGIN_WALL' ? 'login wall' : 'block / CAPTCHA'}`);
      }
      if (res.status >= 400) throw new Error(`${hostnameOf(url)} answered ${res.status}`);
      const type = String(res.headers['content-type'] ?? '');
      if (type && !/text\/|html|xml/i.test(type)) throw new Error(`unsupported content type ${type}`);
      if (res.truncated) throw new Error('page is larger than the size limit');
      return { finalUrl: url.href, html };
    } catch (err) {
      if (err instanceof NonPublicAddressError || /non-public address|not a public address/.test(String((err as Error)?.message))) {
        throw new DiscoveryRefusedError('NON_PUBLIC_ADDRESS', `${hostnameOf(url)} is not a public internet address`);
      }
      throw err;
    }
  }
  throw new Error(`more than ${MAX_REDIRECTS} redirects`);
}
