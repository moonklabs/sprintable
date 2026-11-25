// story 5009 · PO 11-25 — the runtimes list on the app ↔ web page bridge has ONE contract: contracts/web-bridge-runtimes.json (the mobile repo keeps the same file byte for byte and runs its own vectors).
// This is the web's side: an entry whose runtime NAME the web does not know is left out and the bridge STAYS; every other strictness is as before; and the web asks the app for its names by `accepts`.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetDesktopAppForTest, desktopApp, desktopAppOf, subscribeDesktopApp, type SprintableDesktop } from './desktop-app';

const ROOT = path.resolve(__dirname, '../../../..');
const RAW = readFileSync(path.join(ROOT, 'contracts', 'web-bridge-runtimes.json'));
const SHA = '43c060e065ad247797d4087b93a314f92f0c8a7733e771eda66cf310c25458ad'; // the mobile repository's contracts/web-bridge-runtimes.json — a copy that drifts is a failure, not a quiet divergence
const C = JSON.parse(RAW.toString('utf8')) as {
  legacy: string[]; negotiation: { call: string };
  web_vectors: Array<{ name: string; runtimes: unknown; bridge: 'kept' | 'refused'; visible?: string[] }>;
};

const base = (): SprintableDesktop => ({
  inApp: true, device: { name: 'mac' }, runtimes: [],
  pickFolder: async () => null, startHere: async () => ({ ok: true }), setProjectFolder: async () => ({ ok: true }),
});
afterEach(() => { __resetDesktopAppForTest(); delete (globalThis as { window?: unknown }).window; });

describe('[SID:5009] contracts/web-bridge-runtimes.json — the web reads the app\'s list name by name', () => {
  it('the file is the mobile repository\'s byte for byte', () => { expect(createHash('sha256').update(RAW).digest('hex')).toBe(SHA); });

  for (const v of C.web_vectors) {
    it(`desktopAppOf: ${v.name}`, () => {
      const got = desktopAppOf({ ...base(), runtimes: v.runtimes });
      if (v.bridge === 'refused') { expect(got).toBeUndefined(); return; }
      expect(got).toBeDefined();
      expect(got!.runtimes.map((r) => r.runtime)).toEqual(v.visible);
    });
  }

  it('the update path reads the same way: an unknown name in a pushed list is left out (the list still arrives); a wrong shape of a known name is ignored', () => {
    const cbs = new Set<(r: unknown) => void>();
    const b = { ...base(), subscribeRuntimes: (cb: (r: unknown) => void) => { cbs.add(cb); return () => cbs.delete(cb); } } as unknown as SprintableDesktop;
    (globalThis as { window?: unknown }).window = { sprintableDesktop: b };
    const listen = vi.fn();
    subscribeDesktopApp(listen);
    const push = (l: unknown) => { for (const cb of [...cbs]) cb(l); };
    push([{ runtime: 'claude', version: '1', executable: '/c' }, { runtime: 'future-agent', version: '1', executable: '/f' }]);
    expect(desktopApp()!.runtimes.map((r) => r.runtime)).toEqual(['claude']);
    expect(listen).toHaveBeenCalledTimes(1);
    push([{ runtime: 'claude', version: 7, executable: '/c' }]);
    expect(listen).toHaveBeenCalledTimes(1);
  });

  it('the negotiation line of the contract is what the web calls: subscribeRuntimes(listener, { accepts: [the names it can act on] }) — the legacy names always among them', () => {
    expect(C.negotiation.call).toBe('subscribeRuntimes(listener, { accepts: [names] })');
    const seen: unknown[][] = [];
    const b = { ...base(), subscribeRuntimes: (...a: unknown[]) => { seen.push(a); return () => undefined; } } as unknown as SprintableDesktop;
    (globalThis as { window?: unknown }).window = { sprintableDesktop: b };
    subscribeDesktopApp(vi.fn());
    const accepts = (seen[0]![1] as { accepts: string[] }).accepts;
    for (const l of C.legacy) expect(accepts).toContain(l);
  });
});
