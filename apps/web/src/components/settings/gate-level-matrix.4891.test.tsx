// @vitest-environment jsdom
//
// story 4891 (UI-8 · the notifications tab on ds parts) — the gate level table was rebuilt on ds parts (SettingsSection · ListRow · Button · Chip · Banner); this pins what it DOES (it had no test of its own): the cells it reads, the
// pressed level, the merge floor (merge can never be «auto»), a press sends the PUT and moves the pressed state, a failed save rolls back and says so (role=alert), an overridden cell shows its tag and ↺ (DELETE), a reader without the right sees a read-only tag.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { GateLevelMatrix } from './gate-level-matrix';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
type Call = { url: string; method: string; body?: Record<string, unknown> };
let calls: Call[];
let putOk = true;

const ENTRIES = [
  { work_type: 'done', actor_type: 'agent', level: 'ask', source: 'org_default' },
  { work_type: 'done', actor_type: 'human', level: 'auto', source: 'override' },
  { work_type: 'merge', actor_type: 'agent', level: 'block', source: 'org_default' },
  { work_type: 'merge', actor_type: 'human', level: 'ask', source: 'org_default' },
];

beforeEach(() => {
  calls = []; putOk = true;
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === 'GET') return { ok: true, json: async () => ({ data: ENTRIES }) };
    if (method === 'DELETE') return { ok: true, json: async () => ({ data: { work_type: 'done', actor_type: 'human', level: 'ask', source: 'org_default' } }) };
    return { ok: putOk, json: async () => ({ data: JSON.parse(String(init?.body)) }) };
  }));
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

async function draw(props: { canEdit: boolean; surface?: 'org' | 'project' }) {
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><GateLevelMatrix surface={props.surface ?? 'project'} projectId="p1" orgId="o1" canEdit={props.canEdit} /></NextIntlClientProvider>); });
  for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
}
const group = (label: string) => [...container.querySelectorAll('[role="group"]')].find((g) => g.getAttribute('aria-label') === label)!;
const rowsOf = () => [...container.querySelectorAll('[data-slot="ds-list-row"]')];
const press = async (el: Element | undefined) => { expect(el).toBeTruthy(); await act(async () => { (el as HTMLElement).click(); }); for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); }); };
const pressedIn = (g: Element) => [...g.querySelectorAll('button')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent?.trim());

describe('[SID:4891] GateLevelMatrix on ds parts — what it does', () => {
  it('while the table is being read it draws a ds SkeletonGroup named «불러오는 중…» (one voice, decorative bars) and no level buttons', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {}))); // the read never answers → the loading branch stays
    await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><GateLevelMatrix surface="project" projectId="p1" canEdit /></NextIntlClientProvider>); });
    const g = container.querySelector('[data-slot="ds-skeleton-group"]');
    expect(g?.getAttribute('role')).toBe('status');
    expect(g?.getAttribute('aria-label')).toBe(koMessages.common.loading);
    expect(g?.querySelectorAll('[data-slot="ds-skeleton"]').length).toBe(8);
    expect(g?.querySelectorAll('[data-slot="ds-skeleton"][aria-hidden="true"]').length).toBe(8);
    expect(container.querySelector('[role="group"] button')).toBeNull();
  });

  it('reads the four cells into four ds list rows; the pressed level of each row is its level; an overridden cell shows its tag and ↺', async () => {
    await draw({ canEdit: true });
    expect(rowsOf()).toHaveLength(4);
    const levelLabel = (l: string) => (koMessages.gateConfig as Record<string, string>)[`level${l[0]!.toUpperCase()}${l.slice(1)}`];
    const doneAgent = [...container.querySelectorAll('[role="group"]')][0]!;
    expect(pressedIn(doneAgent).map((x) => x)).toEqual([levelLabel('ask')]);
    expect(container.textContent).toContain(koMessages.gateConfig.sourceOverride);
    expect(container.querySelectorAll('button[aria-label="' + koMessages.gateConfig.revertToDefault + '"]')).toHaveLength(1);
    expect(container.textContent).toContain(koMessages.gateConfig.sourceInherited);
  });

  it('⭐the merge floor: «auto» is off in both merge rows (and on in the done rows) — the server floor, shown', async () => {
    await draw({ canEdit: true });
    const groups = [...container.querySelectorAll('[role="group"]')];
    const autoOf = (g: Element) => [...g.querySelectorAll('button')].find((b) => b.textContent?.includes(koMessages.gateConfig.levelAuto)) as HTMLButtonElement;
    expect(groups).toHaveLength(4);
    expect(groups.map((g) => autoOf(g).disabled)).toEqual([false, false, true, true]);
  });

  it('⭐a press sends the PUT (project: scope=project) and moves the pressed level; a failed save rolls it back and says so (role=alert)', async () => {
    await draw({ canEdit: true });
    const g = [...container.querySelectorAll('[role="group"]')][0]!;
    const block = [...g.querySelectorAll('button')].find((b) => b.textContent?.includes(koMessages.gateConfig.levelBlock));
    await press(block);
    expect(calls.at(-1)).toMatchObject({ method: 'PUT', url: '/api/projects/p1/gate-config', body: { scope: 'project', work_type: 'done', actor_type: 'agent', level: 'block' } });
    expect(pressedIn([...container.querySelectorAll('[role="group"]')][0]!)).toEqual([koMessages.gateConfig.levelBlock]);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(koMessages.gateConfig.saved);
    putOk = false;
    const ask = [...[...container.querySelectorAll('[role="group"]')][0]!.querySelectorAll('button')].find((b) => b.textContent?.includes(koMessages.gateConfig.levelAsk));
    await press(ask);
    expect(pressedIn([...container.querySelectorAll('[role="group"]')][0]!)).toEqual([koMessages.gateConfig.levelBlock]); // rolled back to what it was
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(koMessages.gateConfig.saveFailed);
  });

  it('⭐↺ on an overridden cell sends the DELETE and the tag goes away', async () => {
    await draw({ canEdit: true });
    await press(container.querySelector('button[aria-label="' + koMessages.gateConfig.revertToDefault + '"]')!);
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: '/api/projects/p1/gate-config?work_type=done&actor_type=human' });
    expect(container.textContent).not.toContain(koMessages.gateConfig.sourceOverride);
  });

  it('⭐a reader without the right sees read-only tags — no level buttons, no ↺', async () => {
    await draw({ canEdit: false });
    expect(container.querySelectorAll('[role="group"]')).toHaveLength(0);
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(rowsOf()).toHaveLength(4);
    expect(container.textContent).toContain(koMessages.gateConfig.levelAsk);
  });

  it('the org surface: no source tags and the PUT goes to the organization (no scope)', async () => {
    await draw({ canEdit: true, surface: 'org' });
    expect(container.textContent).not.toContain(koMessages.gateConfig.sourceInherited);
    const g = [...container.querySelectorAll('[role="group"]')][0]!;
    await press([...g.querySelectorAll('button')].find((b) => b.textContent?.includes(koMessages.gateConfig.levelBlock)));
    expect(calls.at(-1)).toMatchObject({ method: 'PUT', url: '/api/organizations/o1/gate-config', body: { work_type: 'done', actor_type: 'agent', level: 'block' } });
    expect(calls.at(-1)!.body).not.toHaveProperty('scope');
  });
});
