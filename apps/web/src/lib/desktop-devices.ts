// story #4424 (PO 15:38Z) — the «연결된 기기» list on /desktop: pure rules. The data is GET /api/desktop/setups (4424 BE, org
// owner/admin only); «연결 끊기» is DELETE /api/desktop/setups/{id}.

export type DesktopDeviceState = 'handed_over' | 'waiting_for_app' | 'not_handed_over' | 'disconnected';

export interface DesktopDevice {
  setup_id: string;
  device_name: string;
  state: DesktopDeviceState;
  confirmed_at: string | null;
  confirmed_by_name?: string | null;
  revoked_at: string | null;
  revoked_by_name?: string | null;
  active_keys: number;
  members: { kind: 'agent' | 'human'; member_id?: string }[];
}

/** Only an org owner/admin reads the list and disconnects (the backend's gate); a member's page does not ask at all. */
export function canManageDevices(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

/**
 * The agents this setup made (the person's own human role is not counted). `members` has one entry per stage, so an agent
 * holding four stages appears four times — count distinct members (Qadir 4830 ②).
 */
export function deviceAgentCount(device: DesktopDevice): number {
  const agents = device.members.filter((m) => m.kind === 'agent');
  return new Set(agents.map((m, i) => m.member_id ?? `stage-${i}`)).size;
}

/** A disconnected device has nothing left to disconnect. */
export function canDisconnect(device: DesktopDevice): boolean {
  return device.state !== 'disconnected';
}

/** Connected first (newest first as the backend orders them), disconnected last. */
export function orderDevices(devices: readonly DesktopDevice[]): DesktopDevice[] {
  return [...devices.filter((d) => d.state !== 'disconnected'), ...devices.filter((d) => d.state === 'disconnected')];
}

/** What «연결 끊기» answered: whether the device was already disconnected (another admin first), and the setup's own when · who. */
export interface Revoked {
  already: boolean;
  revokedAt: string;
  revokedByName: string | null;
}

/** The DELETE answer → Revoked; anything unreadable → null (the caller then reads the list again instead of guessing). */
export async function readRevoked(res: Response): Promise<Revoked | null> {
  try {
    const body = (await res.json()) as { already_disconnected?: unknown; revoked_at?: unknown; revoked_by_name?: unknown };
    if (typeof body.already_disconnected !== 'boolean' || typeof body.revoked_at !== 'string') return null;
    return {
      already: body.already_disconnected, revokedAt: body.revoked_at,
      revokedByName: typeof body.revoked_by_name === 'string' ? body.revoked_by_name : null,
    };
  } catch {
    return null;
  }
}

/**
 * After «연결 끊기» answers: that device shows disconnected at once, with the server's own when · who — the person who pressed
 * only when this call was the one that disconnected it (Qadir 4830 ④: another admin first → that admin, not «you»).
 */
export function markDisconnected(devices: readonly DesktopDevice[], setupId: string, revoked: Revoked): DesktopDevice[] {
  return devices.map((d) => (d.setup_id === setupId
    ? { ...d, state: 'disconnected', revoked_at: revoked.revokedAt, revoked_by_name: revoked.revokedByName, active_keys: 0 }
    : d));
}

/** The list answer → devices; a 403 (not an owner/admin) or anything unreadable → null, which hides the section (no error). */
export async function readDevices(res: Response): Promise<DesktopDevice[] | null> {
  if (!res.ok) return null;
  try {
    const body = (await res.json()) as { setups?: unknown };
    return Array.isArray(body.setups) ? (body.setups as DesktopDevice[]) : null;
  } catch {
    return null;
  }
}

/** Yuna 0ebe65ef — dates like the web's notifications: «9월 29일», with the year when it is not this year. */
export function deviceDateOptions(iso: string, now: Date = new Date(), timeZone?: string): { year?: 'numeric'; month: 'long'; day: 'numeric' } {
  // story #4443 — «this year» is the viewer's year (New Year's Eve in UTC is already next year in Seoul)
  const year = (d: Date) => (timeZone ? new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric' }).format(d) : String(d.getFullYear()));
  const sameYear = year(new Date(iso)) === year(now);
  return sameYear ? { month: 'long', day: 'numeric' } : { year: 'numeric', month: 'long', day: 'numeric' };
}
