import { Injectable } from '@nestjs/common';
import { DiscoveryNotConfiguredError, DiscoveryParams, DiscoveryProvider, DiscoveryResult } from './discovery.provider';

/**
 * GST / MCA verification — enriches a known business, discovers nothing on its own.
 * The GST portal is CAPTCHA-gated and bypassing that is excluded outright (design doc
 * §2.1), so this can only ever be a licensed verification API.
 *
 * Which vendor, at what cost, returning what fields is a §16.7 unknown — "do not guess
 * it". Ships last of the three paths for exactly that reason.
 */
@Injectable()
export class RegistryProvider implements DiscoveryProvider {
  async run(_params: DiscoveryParams): Promise<DiscoveryResult> {
    throw new DiscoveryNotConfiguredError(
      'GST/MCA verification is not enabled: it needs a licensed verification vendor chosen first ' +
        '(CLAUDE.md §16.7). The GST portal itself is CAPTCHA-gated and is never automated.',
    );
  }
}
