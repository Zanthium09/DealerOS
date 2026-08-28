/**
 * §3 — "shared send throttling (one service, not per module)" and "one-command kill
 * switch per outbound channel" (§12.6) live in core/throttle and core/killswitch.
 * Those are being built concurrently by another agent and did not exist yet when this
 * module was written, so outreach-email codes against the small port it needs and
 * takes an implementation by DI — never a second throttle/kill-switch of its own.
 *
 * WIRING TODO once core/throttle and core/killswitch land: replace the permissive
 * defaults below with providers backed by those services in outreach-email.module.ts
 * (or override the tokens in app.module.ts). Nothing here should survive unreplaced
 * into production — see the ponytail comments on the defaults.
 */

export type SendThrottleDecision = { allowed: boolean; reason?: string };

export interface SendThrottle {
  /** May this org send one more EMAIL right now? Consumes budget if it returns allowed. */
  tryConsume(organizationId: string): Promise<SendThrottleDecision>;
}

export interface KillSwitch {
  isPaused(channel: 'EMAIL'): Promise<boolean>;
}

export const SEND_THROTTLE = 'OUTREACH_EMAIL_SEND_THROTTLE';
export const KILL_SWITCH = 'OUTREACH_EMAIL_KILL_SWITCH';

// ponytail: permissive placeholder — always allows. The real shared throttle service
// (§3) does not exist yet. Replace via DI once core/throttle lands; do not build a
// second real throttle here.
export class AlwaysAllowThrottle implements SendThrottle {
  async tryConsume(): Promise<SendThrottleDecision> {
    return { allowed: true };
  }
}

// ponytail: permissive placeholder — never paused. Replace via DI once core/killswitch
// lands (§12.6).
export class NeverPausedKillSwitch implements KillSwitch {
  async isPaused(): Promise<boolean> {
    return false;
  }
}
