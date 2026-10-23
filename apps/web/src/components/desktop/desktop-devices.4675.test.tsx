// @vitest-environment jsdom
//
// story 4675 (UX-1 · F2 · AC3 · Yuna §I ④) — a «연결된 기기» row opens to its agents: one line per agent (name → the workforce
// page · role), an agent holding two stages once; a device with no agent is the row alone; [연결 끊기] inside the row never
// opens or closes it; `/desktop#device=<setup_id>` opens that row.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { DesktopDevices } from './desktop-devices';
import { deviceAgents, linkedSetupId, type DesktopDevice } from '@/lib/desktop-devices';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const AG1 = 'a1111111-0000-4000-8000-000000000001';
const AG2 = 'a1111111-0000-4000-8000-000000000002';
const device = (setup_id: string, device_name: string, members: DesktopDevice['members']): DesktopDevice => ({
  setup_id, device_name, state: 'handed_over', confirmed_at: '2026-09-29T10:00:00Z', confirmed_by_name: '김지우', revoked_at: null, revoked_by_name: null,
  active_keys: 2, members,
});
const WITH_AGENTS = device(A, 'studio mac', [
  { kind: 'agent', member_id: AG1, name: '조사', role: 'Dev' }, { kind: 'agent', member_id: AG1, name: '조사', role: 'Reviewer' },
  { kind: 'agent', member_id: AG2, name: '작성', role: 'Writer' }, { kind: 'human', member_id: 'person', name: '김지우', role: 'direct' },
]);
// story 4734: the list is computers — each device here is a computer of its own with the one setup
const computerOf = (d: DesktopDevice) => ({
  computer_id: d.setup_id.replace(/^\w/, '9'), device_name: d.device_name, state: d.state, confirmed_by_name: d.confirmed_by_name, confirmed_at: d.confirmed_at,
  last_used_at: null, live_setups: 1, active_keys: d.active_keys, setups: [d],
});
const NO_AGENTS = device(B, 'empty mac', [{ kind: 'human', member_id: 'person', name: '김지우', role: 'direct' }]);

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ orgId: 'org-1', orgMemberships: [{ orgId: 'org-1', orgName: '뭉클랩', orgSlug: 'moonklabs', role: 'owner' }], projectMemberships: [], userName: '김지우' });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ computers: [computerOf(WITH_AGENTS), computerOf(NO_AGENTS)], truncated: false }), { status: 200 })));
  window.location.hash = '';
});
afterEach(() => { act(() => root.unmount()); container.remove(); document.body.innerHTML = ''; vi.unstubAllGlobals(); window.location.hash = ''; });

async function render() {
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><DesktopDevices /></NextIntlClientProvider>); });
  await act(async () => { await Promise.resolve(); });
}
const rows = () => [...document.querySelectorAll('[data-testid=desktop-device-row]')] as HTMLElement[];

describe('[SID:4675] deviceAgents · linkedSetupId (pure)', () => {
  it('one line per agent in order · a human is not one · a missing id is kept by its stage index', () => {
    expect(deviceAgents(WITH_AGENTS)).toEqual([{ member_id: AG1, name: '조사', role: 'Dev' }, { member_id: AG2, name: '작성', role: 'Writer' }]);
    expect(deviceAgents(NO_AGENTS)).toEqual([]);
    expect(deviceAgents(device(A, 'x', [{ kind: 'agent' }, { kind: 'agent' }]))).toHaveLength(2);
  });
  it('the hash names a device only in the `device=<uuid>` shape', () => {
    expect(linkedSetupId(`#device=${A}`)).toBe(A);
    expect(linkedSetupId(`#x=1&device=${A}&y=2`)).toBe(A);
    for (const bad of ['', '#device=', '#device=not-a-uuid', `#devices=${A}`, `#device=${A}x`]) expect(linkedSetupId(bad), bad).toBeNull();
  });
});

describe('[SID:4675] DesktopDevices — the row opens to its agents', () => {
  it('a device with agents is a <details>: closed by default · opened, one line per agent with the workforce link and the role word · a device with none is the row alone', async () => {
    await render();
    const [withAgents, noAgents] = rows();
    const details = withAgents.querySelector('details') as HTMLDetailsElement;
    expect(details).not.toBeNull(); // reverted → null
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')?.getAttribute('aria-label')).toMatch(/^studio mac의 설정 에이전트 보기 · \d+월 \d+일$/); // story 4734: dated — the setups of one computer are told apart
    await act(async () => { details.open = true; });
    const lines = [...withAgents.querySelectorAll('[data-testid=desktop-device-agent]')];
    expect(lines.map((l) => l.textContent)).toEqual([`조사 · ${koMessages.organization.stageRoleLabelDev}`, '작성 · Writer']); // a preset → its word · an own role as it is
    expect(lines.map((l) => l.querySelector('a')?.getAttribute('href'))).toEqual([`/organization/workforce/${AG1}`, `/organization/workforce/${AG2}`]);
    expect(noAgents.querySelector('details')).toBeNull();
    expect(document.body.textContent).toContain('empty mac'); // (the computer's line carries the name — the setup row inside it does not repeat it)
  });

  it('[연결 끊기] inside the row opens the dialog and leaves the row as it was', async () => {
    await render();
    const row = rows()[0];
    const details = row.querySelector('details') as HTMLDetailsElement;
    const button = row.querySelector('[data-testid=desktop-device-disconnect]') as HTMLButtonElement;
    await act(async () => { button.click(); });
    expect(details.open).toBe(false);
    expect(document.querySelector('[data-testid=desktop-devices-confirm]')).not.toBeNull();
  });

  it('`#device=<setup_id>` (the workforce detail\'s link) opens that row', async () => {
    window.location.hash = `#device=${A}`;
    await render();
    await act(async () => { await Promise.resolve(); });
    const details = rows()[0].querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(true);
    expect(rows()[1].querySelector('details')).toBeNull();
  });
});
