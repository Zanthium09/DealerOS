import { Inject, Injectable } from '@nestjs/common';
import { AI_PROVIDER, AIProvider } from '../ai/ai.provider';
import { DiscoveryParams, DiscoveryProvider, DiscoveryResult } from './discovery.provider';
import { chunkText, EXTRACTION_SYSTEM, parseModelJson, RawLead, validateExtraction } from './extraction';
import { htmlToLines } from './html-text';
import { fetchPage } from './url-fetcher';

const EXCERPT_CHARS = 2000;

/**
 * The extractor — file text and URLs. File upload has no legal gating (the staff member
 * already has the file: no fetch, no robots.txt, no blocklist). A URL goes through every
 * gate in url-fetcher.ts first. Extraction after that is identical for both.
 */
@Injectable()
export class ExtractionProvider implements DiscoveryProvider {
  constructor(@Inject(AI_PROVIDER) private readonly ai: AIProvider) {}

  async run(params: DiscoveryParams): Promise<DiscoveryResult> {
    let text: string;
    let sourceUrl: string;
    if (params.method === 'URL_EXTRACT') {
      const page = await fetchPage(params.url, params.orgName);
      text = htmlToLines(page.html);
      sourceUrl = page.finalUrl;
    } else if (params.method === 'FILE_EXTRACT') {
      text = params.text;
      sourceUrl = 'upload';
    } else {
      throw new Error(`ExtractionProvider does not handle ${params.method}`);
    }

    if (!text.trim()) {
      // A JavaScript-rendered page arrives as an empty shell — say so, don't return [].
      throw new Error(
        'the source contained no readable text (a JavaScript-rendered page, or a scan with no text layer?)',
      );
    }

    const leads: RawLead[] = [];
    let rejectedCount = 0;
    const chunks = chunkText(text);
    // chunkText is bounded so one giant page cannot become unbounded model calls — which
    // means a long source is only partly read. Say so; silent partial results are how a
    // "complete" directory import quietly misses the second half.
    const truncated = chunks.reduce((n, c) => n + c.length, 0) < text.length * 0.98;
    for (const chunk of chunks) {
      const output = await this.ai.complete({
        system: EXTRACTION_SYSTEM,
        prompt: `Text:\n${chunk}`,
        maxTokens: 4096,
      });
      // Validated against the CHUNK it came from, not the whole document: a phone that
      // appears elsewhere in the file must not vouch for a listing it does not belong to.
      const { accepted, rejected } = validateExtraction(parseModelJson(output), chunk);
      leads.push(...accepted);
      rejectedCount += rejected.length;
    }
    return { leads, excerpt: text.slice(0, EXCERPT_CHARS), sourceUrl, costPaise: 0, rejectedCount, truncated };
  }
}
