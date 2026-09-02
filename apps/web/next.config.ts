import type { NextConfig } from 'next';

// Proxies the browser's same-origin /api/* calls to the real API server-side.
// Keeps the session cookie genuinely same-origin regardless of where each half
// is hosted (Vercel vs Railway are different sites; a proxied same-origin call
// sidesteps that instead of loosening the cookie's SameSite=Lax policy).
const BACKEND_URL = process.env.BACKEND_URL ?? 'http://localhost:3001';

const nextConfig: NextConfig = {
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${BACKEND_URL}/:path*` }];
  },
};

export default nextConfig;
