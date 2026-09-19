/**
 * HTML → line-oriented text for the model. A directory is rows and list items; collapsing
 * those into one paragraph (what a plain tag-strip does) fuses neighbouring listings, so
 * block ends become newlines, cells become " | ", and mailto:/tel: targets are surfaced —
 * they are often the only place an address or number appears.
 */
export function htmlToLines(html: string): string {
  return html
    .replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<a\s[^>]*href=["']mailto:([^"'?]+)[^>]*>/gi, ' $1 ')
    .replace(/<a\s[^>]*href=["']tel:([^"']+)["'][^>]*>/gi, ' $1 ')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<(br|\/p|\/div|\/li|\/tr|\/h[1-6]|\/section|\/article)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, String.fromCharCode(39))
    .replace(/&quot;/g, String.fromCharCode(34))
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
