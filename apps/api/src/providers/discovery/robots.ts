// RFC 9309 robots.txt, the part a polite fetcher needs: group selection by user-agent
// token, `*` and `$` in patterns, longest-match wins, Allow beats Disallow on a tie.
//
// Pure — the fetching of robots.txt itself (and what to do when it is missing or
// unreachable) is url-fetcher.ts's decision.

type Rule = { allow: boolean; pattern: string };
type Group = { agents: string[]; rules: Rule[] };

export function parseRobots(text: string): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      // Consecutive User-agent lines share one group.
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === 'allow' || field === 'disallow') {
      lastWasAgent = false;
      if (!current) continue;
      // An empty Disallow means "nothing is disallowed" — no rule at all.
      if (value === '') continue;
      current.rules.push({ allow: field === 'allow', pattern: value });
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

function patternToRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

/**
 * May `userAgentToken` fetch `path` (path + query)? The group naming our token wins over
 * `*`; if none names us, `*` applies; if there is no applicable group, everything is
 * allowed. Among matching rules the longest pattern wins, and Allow wins a tie.
 */
export function robotsAllows(robotsTxt: string, userAgentToken: string, path: string): boolean {
  const groups = parseRobots(robotsTxt);
  const token = userAgentToken.toLowerCase();

  const named = groups.filter((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
  const applicable = named.length > 0 ? named : groups.filter((g) => g.agents.includes('*'));
  const rules = applicable.flatMap((g) => g.rules);

  let best: (Rule & { length: number }) | null = null;
  for (const rule of rules) {
    if (!patternToRegExp(rule.pattern).test(path)) continue;
    const length = rule.pattern.length;
    if (!best || length > best.length || (length === best.length && rule.allow && !best.allow)) {
      best = { ...rule, length };
    }
  }
  return best ? best.allow : true;
}
