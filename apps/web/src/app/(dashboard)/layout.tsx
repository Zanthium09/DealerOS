'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { apiFetch } from '@/lib/api';

const NAV = [
  { href: '/dealers', label: 'Dealers' },
  { href: '/queue', label: 'Approval Queue' },
  { href: '/sent', label: 'Sent' },
  { href: '/schedules', label: 'Schedules' },
  { href: '/settings', label: 'Settings' },
];

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    apiFetch('/auth/session')
      .then(() => setChecked(true))
      .catch(() => router.replace('/login'));
  }, [router]);

  async function logout() {
    await apiFetch('/auth/logout', { method: 'POST' }).catch(() => {});
    router.replace('/login');
  }

  if (!checked) {
    return <div className="p-8 text-sm text-neutral-500">Loading…</div>;
  }

  return (
    <div className="min-h-screen bg-neutral-50">
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-6">
            <span className="text-sm font-semibold">DealerOS</span>
            <nav className="flex gap-4 text-sm">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className={
                    pathname?.startsWith(item.href)
                      ? 'font-medium text-neutral-900'
                      : 'text-neutral-500 hover:text-neutral-900'
                  }
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
          <button onClick={logout} className="text-sm text-neutral-500 hover:text-neutral-900">
            Log out
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
