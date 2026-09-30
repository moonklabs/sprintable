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
  members: { kind: 'agent' | 'human' }[];
}

/** Only an org owner/admin reads the list and disconnects (the backend's gate); a member's page does not ask at all. */
export function canManageDevices(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin';
}

/** The agents this setup made (the person's own human role is not counted). */
export function deviceAgentCount(device: DesktopDevice): number {
  return device.members.filter((m) => m.kind === 'agent').length;
}

/** A disconnected device has nothing left to disconnect. */
export function canDisconnect(device: DesktopDevice): boolean {
  return device.state !== 'disconnected';
}

/** Connected first (newest first as the backend orders them), disconnected last. */
export function orderDevices(devices: readonly DesktopDevice[]): DesktopDevice[] {
  return [...devices.filter((d) => d.state !== 'disconnected'), ...devices.filter((d) => d.state === 'disconnected')];
}

/** After «연결 끊기» answers: that device shows disconnected at once, by the person who pressed it (no refetch needed to be right). */
export function markDisconnected(devices: readonly DesktopDevice[], setupId: string, at: string, byName: string | null): DesktopDevice[] {
  return devices.map((d) => (d.setup_id === setupId
    ? { ...d, state: 'disconnected', revoked_at: d.revoked_at ?? at, revoked_by_name: d.revoked_by_name ?? byName, active_keys: 0 }
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
export function deviceDateOptions(iso: string, now: Date = new Date()): { year?: 'numeric'; month: 'long'; day: 'numeric' } {
  const sameYear = new Date(iso).getFullYear() === now.getFullYear();
  return sameYear ? { month: 'long', day: 'numeric' } : { year: 'numeric', month: 'long', day: 'numeric' };
}
