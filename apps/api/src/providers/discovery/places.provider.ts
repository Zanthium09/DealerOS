import { Injectable } from '@nestjs/common';
import { DiscoveryNotConfiguredError, DiscoveryParams, DiscoveryProvider, DiscoveryResult } from './discovery.provider';

/**
 * Google Places crawl — the volume engine, and deliberately not built yet.
 *
 * CLAUDE.md §16.8 / design doc §6.1: "Confirm current Places API pricing before writing
 * the cost estimator" and the permitted retention window for unpromoted candidates.
 * Google has repriced this API more than once; a hardcoded rate silently drifts wrong,
 * and shipping a crawl with no cost gate is exactly what the design forbids (two billable
 * calls per business, estimated and confirmed before the run).
 *
 * The slot is open and the run ends FAILED with this message — never a silently empty
 * review queue. Unblocked by: GOOGLE_PLACES_API_KEY + the two §16.8 answers.
 */
@Injectable()
export class PlacesProvider implements DiscoveryProvider {
  async run(_params: DiscoveryParams): Promise<DiscoveryResult> {
    throw new DiscoveryNotConfiguredError(
      'Google Places discovery is not enabled: it needs a GOOGLE_PLACES_API_KEY and the current pricing / ' +
        'data-caching terms confirmed first (CLAUDE.md §16.8), so the cost estimate shown before a run is real.',
    );
  }
}
