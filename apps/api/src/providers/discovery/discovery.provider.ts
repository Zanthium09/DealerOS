// §1.7 — feature code never calls Google or fetches a URL directly. It goes through a
// DiscoveryProvider. Three implementations behind one interface (design doc §3).
import type { RawLead } from './extraction';

export type DiscoveryParams =
  | { method: 'URL_EXTRACT'; url: string; orgName: string }
  | { method: 'FILE_EXTRACT'; text: string }
  | { method: 'PLACES_API'; city: string; category: string }
  | { method: 'REGISTRY'; gstin: string };

export type DiscoveryResult = {
  leads: RawLead[];
  /** What the source actually said, capped — kept so a human can see why a run found
   *  nothing. Not a shadow copy of a site. */
  excerpt: string;
  /** Where each lead came from. For a URL run, the final URL after redirects. */
  sourceUrl: string;
  costPaise: number;
  /** Rows the model produced that failed the against-the-source check. */
  rejectedCount: number;
  /** The source was longer than one run reads; the rest was NOT processed. */
  truncated: boolean;
};

export interface DiscoveryProvider {
  run(params: DiscoveryParams): Promise<DiscoveryResult>;
}

export const DISCOVERY_PROVIDER = 'DISCOVERY_PROVIDER';

/** A path that exists in the design but cannot run yet. Ends the run FAILED with this
 *  message visible — never a silently empty queue (design doc §6.1). */
export class DiscoveryNotConfiguredError extends Error {}
