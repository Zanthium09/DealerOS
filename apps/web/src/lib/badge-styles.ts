// Shared color conventions for pipeline-stage and interaction-status badges,
// used by the dealers list, the dealer detail page, and the dashboard.
// Tailwind named color classes only — no hardcoded hex, per project convention.

export function stageBadgeClass(stage: string): string {
  switch (stage) {
    case 'NEW':
      return 'bg-sky-100 text-sky-800';
    case 'CONTACTED':
    case 'INTERESTED':
      return 'bg-blue-100 text-blue-800';
    case 'ONBOARDED':
    case 'ACTIVE':
      return 'bg-green-100 text-green-800';
    case 'DORMANT':
      return 'bg-amber-100 text-amber-800';
    case 'REACTIVATED':
      return 'bg-teal-100 text-teal-800';
    case 'OPTED_OUT':
    case 'INVALID':
      return 'bg-red-100 text-red-800';
    default:
      return 'bg-muted text-muted-foreground';
  }
}

const NEGATIVE_STATUSES = new Set(['BOUNCED', 'FAILED', 'COMPLAINED']);
const POSITIVE_STATUSES = new Set(['REPLIED', 'CLICKED', 'OPENED']);

export function statusBadgeClass(status: string): string {
  if (NEGATIVE_STATUSES.has(status)) return 'bg-red-100 text-red-800';
  if (POSITIVE_STATUSES.has(status)) return 'bg-green-100 text-green-800';
  if (status === 'DELIVERED' || status === 'SENT') return 'bg-blue-100 text-blue-800';
  return 'bg-muted text-muted-foreground';
}

export function consentBadgeClass(state: string): string {
  if (state === 'OPTED_IN') return 'bg-green-100 text-green-800';
  if (state === 'OPTED_OUT') return 'bg-red-100 text-red-800';
  return 'bg-muted text-muted-foreground';
}
