// A server fetching a URL a user typed is an SSRF primitive: "http://169.254.169.254/"
// is the cloud metadata service, "http://localhost:6379" is our own Redis. Discovery only
// ever needs the PUBLIC internet, so private, loopback and link-local addresses are
// refused — checked at CONNECT time (guardedLookup), not just before, so a hostname that
// resolves public for a pre-check and private for the real connection (DNS rebinding)
// cannot slip through.
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';

export class NonPublicAddressError extends Error {}

export function isPrivateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT
      (a === 169 && b === 254) || // link-local, incl. cloud metadata
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      a >= 224 // multicast + reserved
    );
  }
  if (net.isIPv6(address)) {
    const v = address.toLowerCase();
    if (v === '::' || v === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return isPrivateAddress(mapped[1]);
    return /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('ff'); // ULA, link-local, multicast
  }
  return true; // not an IP at all — refuse rather than guess
}

/** dns.lookup that refuses non-public results — Node calls this for every connection. */
function guardedLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void,
): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    const list = addresses as dns.LookupAddress[];
    const bad = list.find((a) => isPrivateAddress(a.address));
    if (bad || list.length === 0) {
      return callback(new NonPublicAddressError(`${hostname} resolves to a non-public address`) as NodeJS.ErrnoException, '', 0);
    }
    if (options.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

export type GetResult = {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  truncated: boolean;
};

/**
 * One GET, no redirect following (the fetcher re-runs every gate on each hop), a hard
 * timeout, and a hard size cap on both the wire and the decompressed body.
 */
export function safeGet(
  url: URL,
  opts: { headers?: Record<string, string>; timeoutMs?: number; maxBytes?: number } = {},
): Promise<GetResult> {
  const { timeoutMs = 15_000, maxBytes = 2_000_000 } = opts;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isPrivateAddress(host)) {
    return Promise.reject(new NonPublicAddressError(`${host} is not a public address`));
  }

  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(
      url,
      {
        method: 'GET',
        headers: { 'Accept-Encoding': 'gzip, deflate', ...(opts.headers ?? {}) },
        lookup: guardedLookup as never,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            truncated = true;
            res.destroy();
            return;
          }
          chunks.push(c);
        });
        const finish = () => {
          let body = Buffer.concat(chunks);
          try {
            const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
            if (enc.includes('gzip')) body = zlib.gunzipSync(body, { maxOutputLength: maxBytes * 4 });
            else if (enc.includes('deflate')) body = zlib.inflateSync(body, { maxOutputLength: maxBytes * 4 });
          } catch {
            truncated = true; // a corrupt or oversized stream — treat as unusable, not as empty
            body = Buffer.alloc(0);
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, truncated });
        };
        res.on('end', finish);
        res.on('close', () => {
          if (truncated) finish();
        });
        res.on('error', reject);
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end();
  });
}
