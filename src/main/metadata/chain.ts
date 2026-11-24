/**
 * Location-chain bookkeeping.
 *
 * A session is a stack of places: the machine it was opened on, then every
 * nested login the user performed inside it. These functions are the only ones
 * that write to that stack, so the rules about what a hop means live in one
 * place and can be tested without a terminal:
 *
 *   - a hop that only changes the user (`su`, `sudo -i`, `sudo su -`) stays on
 *     the same machine: address, port and probe results keep describing reality;
 *   - the address a hop was dialed on is never replaced by the name the machine
 *     calls itself — that name is `hostname`, and both are worth keeping;
 *   - a hop only ever enters the chain once something on the other side says the
 *     user got there: a prompt, a title or a login banner. A typed `ssh` / `su`
 *     is a *candidate* (`commitHop()`), and until it is confirmed the chain does
 *     not move at all — a password that was refused, a connection that never
 *     answered or a `Ctrl-C` leaves no trace of a place nobody stood on.
 */

import type { SessionHop } from '../../shared/types';
import { SSH_DEFAULT_PORT } from './nested';

export interface ChainChange {
  /** The chain itself changed. */
  changed: boolean;
  /**
   * The machine under the user changed. Whatever the probe or the banner
   * learned before describes the place we just left, not this one.
   */
  machineChanged: boolean;
}

const UNCHANGED: ChainChange = { changed: false, machineChanged: false };

function topOf(chain: SessionHop[]): SessionHop | undefined {
  return chain[chain.length - 1];
}

/**
 * Pushes the hop a typed command created.
 *
 * A same-host hop (`su`) inherits the machine it happens on, because everything
 * the panel shows about that machine is still true — only the user changed.
 */
export function pushHop(chain: SessionHop[], hop: SessionHop): ChainChange {
  const parent = topOf(chain);
  if (parent && hop.sameHost) {
    hop.host ??= parent.host;
    hop.hostname ??= parent.hostname;
    hop.port ??= parent.port;
  }
  chain.push(hop);
  return { changed: true, machineChanged: hop.sameHost !== true };
}

/**
 * Applies a terminal title (`user@host: cwd`).
 *
 * The title names the machine the user is on, so it improves the current hop —
 * but it is the name the machine uses for itself, not the address the session
 * connects to, and overwriting the address with it loses the only thing that
 * can be dialed again.
 */
export function adoptTitle(
  chain: SessionHop[],
  signal: { host?: string; username?: string; label: string },
): ChainChange {
  const current = topOf(chain);
  if (chain.length <= 1 || !current || !signal.label) return UNCHANGED;
  if (current.detectedBy === 'osc-title' && current.label === signal.label) return UNCHANGED;

  current.label = signal.label;
  if (signal.host) {
    current.hostname = signal.host;
    current.host ??= signal.host;
  }
  if (signal.username) current.username = signal.username;
  current.confidence = 'medium';
  current.detectedBy = 'osc-title';
  return { changed: true, machineChanged: false };
}

/**
 * True when what the shell painted is the place the typed line was aiming at.
 *
 * The typed line knows the account and whatever address it dialed; the prompt
 * knows the account and the name the machine calls itself. The account has to
 * agree, and a name only has to agree when both sides know one — a hop dialed as
 * `ssh alice@203.0.113.4` has no name until the shell on the other side says
 * `alice@host4`.
 */
export function candidateMatches(
  candidate: SessionHop,
  identity: { username: string; hostname: string },
): boolean {
  if (candidate.username !== undefined && candidate.username !== identity.username) return false;
  if (candidate.hostname === undefined) return true;
  return namesAgree(candidate.hostname, identity.hostname);
}

/**
 * Puts the hop a typed line was aiming at on the chain, now that something on
 * the other side has confirmed the user is there.
 *
 * This is the only way a typed `ssh` / `su` / `wsl` becomes a hop. Until a
 * prompt, a title or a login banner says the user arrived, the chain keeps
 * describing the place they are still standing on — which is the truth — and a
 * refused password, an unanswered connection or a `Ctrl-C` leaves no trace of a
 * place nobody stood on.
 */
export function commitHop(
  chain: SessionHop[],
  candidate: SessionHop,
  evidence: { source: 'prompt' | 'osc-title'; hostname?: string; username?: string },
): ChainChange {
  const parent = topOf(chain);
  const sameHost = candidate.sameHost === true;
  const username = evidence.username ?? candidate.username;
  const hostname = evidence.hostname ?? candidate.hostname ?? (sameHost ? parent?.hostname : undefined);
  // A machine dialed by name is reached at that name; one dialed by address got
  // the name it calls itself next to the address, never instead of it.
  const host = candidate.host ?? (sameHost ? parent?.host : undefined) ?? evidence.hostname;
  const port = candidate.port ?? (sameHost ? parent?.port : undefined) ?? SSH_DEFAULT_PORT;
  const name = hostname ?? host;
  return pushHop(chain, {
    ...candidate,
    label: username && name ? `${username}@${name}` : candidate.label,
    username,
    hostname,
    host,
    port,
    sameHost: candidate.sameHost,
    detectedBy: evidence.source === 'osc-title' ? 'osc-title' : 'prompt',
    confidence: evidence.source === 'prompt' ? 'high' : 'medium',
  });
}

/** What a prompt on screen says about the chain. */
export type PromptMove = 'none' | 'renamed' | 'switched' | 'moved' | 'back' | 'entered' | 'cancelled';

export interface PromptAdoption extends ChainChange {
  move: PromptMove;
}

const NO_MOVE: PromptAdoption = { changed: false, machineChanged: false, move: 'none' };
const NOTHING_HAPPENED: PromptAdoption = { changed: false, machineChanged: false, move: 'cancelled' };

/** True when `hop` is the place the prompt describes. */
function hopIs(hop: SessionHop | undefined, identity: { username: string; hostname: string }): boolean {
  if (!hop || hop.username !== identity.username) return false;
  return hop.hostname === undefined || namesAgree(hop.hostname, identity.hostname);
}

/**
 * Applies the `user@host` of the prompt on screen.
 *
 * The shell is the only thing that can say where the user is standing, and it
 * says it in the prompt. Five things can be true of one prompt:
 *
 *   - `entered`: the account and machine of the hop a typed line was aiming at.
 *     That hop is committed here, and only here;
 *   - `cancelled`: a typed line was in flight and this is not where it pointed,
 *     so it never got there;
 *   - `renamed`: the account the top hop already names, on the machine it
 *     already knows. Nothing moved; the name the machine uses for itself is
 *     filled in without touching the address it was dialed on;
 *   - `back`: the account of a hop further down. Stepping out of a nested login
 *     or a user switch is reported by three layers that can all be missed, but
 *     the shell underneath always repaints its own prompt — that prompt is the
 *     step back, so it applies even when no `exit` was seen;
 *   - `switched`: another account on the same machine. Nothing but a user switch
 *     paints that and no login banner announces one, which is why this is the
 *     one move forward that does not wait for a banner;
 *   - `moved`: a prompt for a machine the chain does not know. A nested login
 *     the typed line never reported still becomes a hop here, but only after a
 *     banner said a login happened — a line of text that merely looks like a
 *     prompt is not a machine.
 */
export function adoptPrompt(
  chain: SessionHop[],
  identity: { username: string; hostname: string; at: number; ttlMs: number },
  context: { loggedIn: boolean; candidate?: SessionHop | null },
): PromptAdoption {
  const current = topOf(chain);
  if (!current) return NO_MOVE;
  const label = `${identity.username}@${identity.hostname}`;
  // A hop that only changed the user inherits its machine from the hop below,
  // so the name to compare against may be one hop down.
  const machineName = current.hostname ?? (current.sameHost === true ? chain[chain.length - 2]?.hostname : undefined);
  const hostKnown = machineName !== undefined;
  // With no name to compare and no login banner, a prompt is read as naming the
  // machine underneath: an address cannot become a hostname by itself, and a
  // `su` is far more likely there than a move. A banner says a login happened,
  // which turns the same prompt into another machine.
  const sameMachine = hostKnown ? namesAgree(machineName as string, identity.hostname) : !context.loggedIn;
  const sameAccount = current.username === undefined || identity.username === current.username;

  if (context.candidate) {
    if (!candidateMatches(context.candidate, identity)) return NOTHING_HAPPENED;
    const update = commitHop(chain, context.candidate, {
      source: 'prompt',
      hostname: identity.hostname,
      username: identity.username,
    });
    return { ...update, move: 'entered' };
  }

  if (!sameMachine) {
    // A machine the chain does not know is only believed after a login banner.
    if (!context.loggedIn) return NO_MOVE;
    chain.push({
      label,
      host: identity.hostname,
      hostname: identity.hostname,
      username: identity.username,
      port: SSH_DEFAULT_PORT,
      detectedBy: 'prompt',
      confidence: 'medium',
      at: identity.at,
    });
    return { changed: true, machineChanged: true, move: 'moved' };
  }

  if (!sameAccount) {
    // Without a name on the hop there is nothing that says this prompt is the
    // same machine, and inventing a hop from a line that merely looks like a
    // prompt is exactly what the chain must not do.
    if (!hostKnown) return NO_MOVE;
    // The prompt is a place the chain already knows: the user stepped back out
    // of the hop on top of it.
    let below = -1;
    for (let index = chain.length - 2; index >= 0; index -= 1) {
      if (hopIs(chain[index], identity)) {
        below = index;
        break;
      }
    }
    if (below >= 0) {
      const leaving = current;
      chain.length = below + 1;
      // What the probe learned describes the machine that was just left.
      return { changed: true, machineChanged: leaving.sameHost !== true, move: 'back' };
    }

    chain.push({
      label,
      host: current.host,
      hostname: identity.hostname,
      username: identity.username,
      port: current.port,
      // Same machine, another account: the address, the port and everything
      // probed about it still describe reality.
      sameHost: true,
      detectedBy: 'prompt',
      confidence: 'high',
      at: identity.at,
    });
    return { changed: true, machineChanged: false, move: 'switched' };
  }

  if (current.label === label) return NO_MOVE;
  current.label = label;
  current.hostname = identity.hostname;
  current.port ??= SSH_DEFAULT_PORT;
  current.username ??= identity.username;
  return { changed: true, machineChanged: false, move: 'renamed' };
}

/**
 * Removes the top hop after `exit` / `logout` / a closed connection.
 *
 * Leaving a same-host hop keeps the machine, so the probe results survive it;
 * leaving a machine hop invalidates them.
 */
export function popHop(chain: SessionHop[]): ChainChange {
  if (chain.length <= 1) return UNCHANGED;
  const leaving = chain.pop();
  return { changed: true, machineChanged: leaving?.sameHost !== true };
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** An address is anything that can be dialed without a name server. */
function isAddress(host: string | undefined): boolean {
  if (!host) return false;
  return IPV4.test(host) || host.includes(':');
}

/**
 * The addresses a machine reported about itself, in the order it listed them,
 * without the ones nobody means (loopback, link-local).
 */
function usableAddresses(ips: string[] | undefined): string[] {
  return (ips ?? []).filter(
    (ip) =>
      Boolean(ip) &&
      !ip.startsWith('127.') &&
      !ip.startsWith('169.254.') &&
      !ip.startsWith('fe80:') &&
      ip !== '::1' &&
      (IPV4.test(ip) || ip.includes(':')),
  );
}

/**
 * Two names for the same machine, allowing for the short form on one side and
 * the fully qualified one on the other (`node-01` / `node-01.example.com`).
 */
export function namesAgree(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

/**
 * Writes an address the current machine reported onto the hop the user is on.
 *
 * A nested login is usually dialed by name (`ssh node-01`), so the hop
 * starts with a name and no address: the panel can say where the user is, but
 * not what to dial. The probe and the login banner both learn the addresses
 * the machine holds, so the hop gets one — never in place of an address the
 * session was dialed on, and never in place of the name, which stays in
 * `label` and `hostname`.
 */
export function adoptAddress(
  chain: SessionHop[],
  facts: { hostname?: string; ips?: string[] },
): ChainChange {
  const current = topOf(chain);
  if (!current) return UNCHANGED;

  // The probe and the banner describe the machine the user is on. A name that
  // contradicts the hop means the text is about the machine they just left.
  const reported = facts.hostname?.trim().toLowerCase();
  const known = current.hostname?.trim().toLowerCase();
  if (reported && known && !namesAgree(reported, known)) return UNCHANGED;

  let changed = false;

  if (facts.hostname && !current.hostname) {
    current.hostname = facts.hostname;
    changed = true;
  }

  if (!isAddress(current.host)) {
    const candidates = usableAddresses(facts.ips);
    // A container bridge or a VPN interface is often listed first, so a
    // candidate on the network we dialed from wins: that is the address a
    // person means.
    const below = chain[chain.length - 2]?.host;
    const neighbour = below && IPV4.test(below) ? below.split('.').slice(0, 3).join('.') : null;
    const pick =
      (neighbour ? candidates.find((ip) => ip.startsWith(`${neighbour}.`)) : undefined) ??
      candidates[0];

    if (pick) {
      // The name the session was dialed on is still worth keeping.
      if (current.host && !current.hostname) current.hostname = current.host;
      current.host = pick;
      changed = true;
    }
  }

  return { changed, machineChanged: false };
}

/** Copies the chain fields the endpoint mirrors, so both never disagree. */
export function endpointFromChain(chain: SessionHop[]): {
  displayName: string;
  host?: string;
  hostname?: string;
  port?: number;
  username?: string;
} | null {
  const top = topOf(chain);
  if (!top) return null;
  return {
    displayName: top.label,
    host: top.host,
    hostname: top.hostname,
    port: top.port,
    username: top.username,
  };
}
