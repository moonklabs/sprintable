// story 4734 — «연결된 기기» is one line per COMPUTER (one Mac · one person · one organization), its setups inside the fold. The data is
// GET /api/desktop/computers (the server groups the setups; a computer's id is derived there, never stored); «이 컴퓨터 모두 끊기» is
// DELETE /api/desktop/computers/{id} (all or none). Pure rules only — the screen's words are Yuna's sheet 4734-pairing-unit-copy-1020.md.
import { canDisconnect, deviceAgents, type DesktopDevice, type DesktopDeviceState } from './desktop-devices';

/** a setup of a computer: today's device item + how many phones hold a live pair with it (the server's `paired_phones`) */
export interface ComputerSetup extends DesktopDevice { paired_phones?: number }

export interface DesktopComputer {
  computer_id: string;
  device_name: string;
  /** as alive as its best setup */
  state: DesktopDeviceState;
  confirmed_by_name?: string | null;
  confirmed_at: string | null;
  last_used_at?: string | null;
  live_setups: number;
  active_keys: number;
  /** newest first, as the server sends them */
  setups: ComputerSetup[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The list answer → computers; a 403 (not an owner/admin) or anything unreadable → null, which hides the section (no error). A row without its ids is dropped. */
export async function readComputers(res: Response): Promise<{ computers: DesktopComputer[]; truncated: boolean } | null> {
  if (!res.ok) return null;
  try {
    const body = (await res.json()) as { computers?: unknown; truncated?: unknown };
    if (!Array.isArray(body.computers)) return null;
    const computers = (body.computers as Array<Partial<DesktopComputer>>).filter(
      (c): c is DesktopComputer => !!c && typeof c.computer_id === 'string' && UUID.test(c.computer_id) && typeof c.device_name === 'string'
        && Array.isArray(c.setups) && c.setups.every((s) => !!s && typeof s.setup_id === 'string' && Array.isArray(s.members)),
    );
    return { computers, truncated: body.truncated === true };
  } catch {
    return null;
  }
}

/** the setups that are still connected (the ones «모두 끊기» ends) */
export const liveSetups = (c: DesktopComputer): ComputerSetup[] => c.setups.filter(canDisconnect);

/** the agents of the computer (distinct across its setups) — of the connected setups while any is connected (they are the ones that stop), else of all */
export function computerAgents(c: DesktopComputer): { member_id: string; name: string | null; role: string | null }[] {
  const live = liveSetups(c);
  const seen = new Set<string>();
  const out: { member_id: string; name: string | null; role: string | null }[] = [];
  for (const s of live.length > 0 ? live : c.setups) {
    for (const a of deviceAgents(s)) {
      if (seen.has(a.member_id)) continue;
      seen.add(a.member_id);
      out.push(a);
    }
  }
  return out;
}

/** «설정 {n}곳»: the connected ones while any is connected, else all that are listed */
export const computerSetupCount = (c: DesktopComputer): number => (liveSetups(c).length > 0 ? liveSetups(c).length : c.setups.length);

/** A disconnected computer has nothing left to disconnect. */
export const canDisconnectComputer = (c: DesktopComputer): boolean => c.state !== 'disconnected' && liveSetups(c).length > 0;

/** Connected first (newest first as the server orders them), disconnected last. */
export function orderComputers(list: readonly DesktopComputer[]): DesktopComputer[] {
  return [...list.filter((c) => c.state !== 'disconnected'), ...list.filter((c) => c.state === 'disconnected')];
}

/** the computer that holds a setup (a `#device=<setup_id>` link opens this one) */
export const computerOfSetup = (list: readonly DesktopComputer[], setupId: string | null): DesktopComputer | undefined => (
  setupId ? list.find((c) => c.setups.some((s) => s.setup_id === setupId)) : undefined
);

/**
 * The computer-wide disconnect's answer. `already`: nothing of it was connected before this call (another admin first) · `setups`: how many setups this call
 * disconnected. Anything unreadable → null (the caller reads the list again instead of guessing).
 */
export interface ComputerRevoked { already: boolean; setups: number; revokedAt: string | null; revokedByName: string | null }
export async function readComputerRevoked(res: Response): Promise<ComputerRevoked | null> {
  try {
    const body = (await res.json()) as { setups_disconnected?: unknown; already_disconnected?: unknown; revoked_at?: unknown; revoked_by_name?: unknown };
    if (typeof body.already_disconnected !== 'boolean' || typeof body.setups_disconnected !== 'number') return null;
    return {
      already: body.already_disconnected, setups: body.setups_disconnected,
      revokedAt: typeof body.revoked_at === 'string' ? body.revoked_at : null,
      revokedByName: typeof body.revoked_by_name === 'string' ? body.revoked_by_name : null,
    };
  } catch {
    return null;
  }
}

/** After the computer-wide disconnect answers: every connected setup of it shows disconnected at once, with the server's own when · who. */
export function markComputerDisconnected(list: readonly DesktopComputer[], computerId: string, revoked: ComputerRevoked): DesktopComputer[] {
  return list.map((c) => (c.computer_id !== computerId ? c : {
    ...c,
    state: 'disconnected' as const,
    live_setups: 0,
    active_keys: 0,
    setups: c.setups.map((s) => (!canDisconnect(s) ? s : { ...s, state: 'disconnected' as const, revoked_at: revoked.revokedAt, revoked_by_name: revoked.revokedByName, active_keys: 0 })),
  }));
}

/** After one setup's disconnect: that setup shows disconnected; the computer's state follows its best setup. */
export function markSetupDisconnected(list: readonly DesktopComputer[], setupId: string, revokedAt: string, revokedByName: string | null): DesktopComputer[] {
  return list.map((c) => {
    if (!c.setups.some((s) => s.setup_id === setupId)) return c;
    const setups = c.setups.map((s) => (s.setup_id === setupId ? { ...s, state: 'disconnected' as const, revoked_at: revokedAt, revoked_by_name: revokedByName, active_keys: 0 } : s));
    const live = setups.filter(canDisconnect);
    const best = (['handed_over', 'waiting_for_app', 'not_handed_over'] as const).map((st) => live.find((s) => s.state === st)).find(Boolean); // the best that is left, in the order the server ranks
    return { ...c, setups, live_setups: live.filter((s) => s.state === 'handed_over').length, state: best ? best.state : 'disconnected', active_keys: setups.reduce((n, s) => n + (s.active_keys ?? 0), 0) };
  });
}

/**
 * A-5 (the in-between line): while some connected setups of a computer hold fewer phone pairs than others — an app that is not yet on the build that gives a new
 * setup the computer's phones — `{n}` connected setups, `{k}` of them with the most. Null when they all hold the same number (or none is known, or no phone is paired).
 * EXPIRES when every app is on the new build: delete this with the line.
 */
export function pairedPhoneGap(c: DesktopComputer): { n: number; k: number } | null {
  const counts = liveSetups(c).map((s) => s.paired_phones).filter((x): x is number => typeof x === 'number');
  const live = liveSetups(c);
  if (live.length < 2 || counts.length !== live.length) return null;
  const max = Math.max(...counts);
  if (max === 0 || counts.every((x) => x === max)) return null;
  return { n: live.length, k: counts.filter((x) => x === max).length };
}
