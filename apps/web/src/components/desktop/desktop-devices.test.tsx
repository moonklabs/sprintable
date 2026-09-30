// @vitest-environment jsdom
//
// story #4424 (PO 15:38Z · 15:39Z) — «연결된 기기» on /desktop: a member's page asks nothing and shows nothing (no error); an
// owner/admin sees the org's devices and «연결 끊기» revokes only that setup (4424 AC5 from the screen).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { DesktopDevices } from './desktop-devices';

const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => useDashboardContextMock() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ORG_ID = 'org-1';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const device = (setup_id: string, device_name: string, state = 'handed_over') => ({
  setup_id, device_name, state, confirmed_at: '2026-09-29T10:00:00Z', confirmed_by_name: '김지우',
  revoked_at: state === 'disconnected' ? '2026-09-29T12:00:00Z' : null, revoked_by_name: state === 'disconnected' ? '박서연' : null,
  active_keys: 2,
  // one entry per stage: agent-1 holds two stages — still two agents (Qadir 4830 ②)
  members: [{ kind: 'agent', member_id: 'agent-1' }, { kind: 'agent', member_id: 'agent-1' }, { kind: 'agent', member_id: 'agent-2' }, { kind: 'human', member_id: 'person' }],
});
const revoked = (already: boolean, by: string | null) => ({ revoked_keys: already ? 0 : 2, already_disconnected: already, revoked_at: '2026-09-30T05:00:00Z', revoked_by_name: by });

let container: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;

function asRole(role: 'owner' | 'admin' | 'member', orgId = ORG_ID) {
  useDashboardContextMock.mockReturnValue({
    orgId,
    orgMemberships: [{ orgId: ORG_ID, orgName: '뭉클랩', orgSlug: 'moonklabs', role }, { orgId: 'org-2', orgName: '둘째 조직', orgSlug: 'second', role }],
    projectMemberships: [], userName: '김지우',
  });
}

async function render() {
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><DesktopDevices /></NextIntlClientProvider>);
  });
  await act(async () => { await Promise.resolve(); });
}

const q = (id: string) => document.querySelectorAll(`[data-testid="${id}"]`);
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); };

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') return new Response(JSON.stringify(revoked(false, '김지우')), { status: 200 });
    return new Response(JSON.stringify({ setups: [device(B, 'old laptop', 'disconnected'), device(A, 'studio mac')] }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('DesktopDevices (Yuna 0ebe65ef)', () => {
  it('a member: the heading and one line; the list is never asked for (no 403, no error)', async () => {
    asRole('member');
    await render();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(q('desktop-devices-member')[0].textContent).toBe('이 조직의 데스크톱 연결은 조직 관리자가 관리해요.');
    expect(q('desktop-device-row')).toHaveLength(0);
    expect(q('desktop-device-disconnect')).toHaveLength(0);
  });

  it('an unreadable list is one line in the section with «다시 시도» (no error screen); retrying reads again', async () => {
    asRole('admin');
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 500 }));
    await render();
    expect(q('desktop-devices-load-failed')[0].textContent).toContain('목록을 불러오지 못했어요');
    await click([...document.querySelectorAll('button')].find((b) => b.textContent === '다시 시도')!);
    await act(async () => { await Promise.resolve(); });
    expect(q('desktop-device-row')).toHaveLength(2);
  });

  it('an admin with no device: the empty box', async () => {
    asRole('owner');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ setups: [] }), { status: 200 }));
    await render();
    expect(q('desktop-devices-empty')[0].textContent).toContain('아직 연결된 기기가 없어요');
  });

  it('an admin: connected first, state in words, «에이전트 N개 · 날짜 연결 · 연결한 사람»; disconnected last with no button', async () => {
    asRole('admin');
    await render();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/desktop/setups');
    expect([...q('desktop-device-name')].map((n) => n.textContent)).toEqual(['studio mac', 'old laptop']);
    expect([...q('desktop-device-state')].map((n) => n.textContent)).toEqual(['연결됨', '연결 끊김']);
    expect(q('desktop-device-meta')[0].textContent).toMatch(/^에이전트 2개 · \d+월 \d+일 연결 · 연결한 사람 김지우$/);
    expect(q('desktop-device-meta')[1].textContent).toMatch(/^에이전트 2개 · \d+월 \d+일 연결 끊음 · 끊은 사람 박서연$/);
    expect(q('desktop-device-disconnect')).toHaveLength(1);
    expect(container.textContent).not.toContain('뭉클랩'); // no org column (Yuna: the list is this org's only)
  });

  it('«연결 끊기» asks once, deletes only that setup, says so in one line and moves it down disconnected — the other device untouched', async () => {
    asRole('owner');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ setups: [device(A, 'studio mac'), device(B, 'office mac')] }), { status: 200 }));
    await render();
    await click(q('desktop-device-disconnect')[0]);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(0); // nothing before the confirmation
    expect(document.body.textContent).toContain('studio mac 연결을 끊을까요?');
    expect(document.body.textContent).toContain('에이전트 2개가 더는 Sprintable 일감을 받지 못해요');
    await click(q('desktop-devices-confirm')[0]);
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE').map(([url]) => url)).toEqual([`/api/desktop/setups/${A}`]);
    expect([...q('desktop-device-name')].map((n) => n.textContent)).toEqual(['office mac', 'studio mac']);
    expect([...q('desktop-device-state')].map((n) => n.textContent)).toEqual(['연결됨', '연결 끊김']);
    expect(q('desktop-devices-done')[0].textContent).toBe('studio mac 연결을 끊었어요');
    // who disconnected it shows at once (the person pressing), not only after a reload
    expect(q('desktop-device-meta')[1].textContent).toMatch(/끊은 사람 김지우$/);
    expect(q('desktop-device-disconnect')).toHaveLength(1);
    expect(document.activeElement?.id).toBe('desktop-devices-heading');
    expect(q('desktop-devices-confirm')).toHaveLength(0); // the dialog closed
  });

  it('while disconnecting, both buttons are locked and the action reads «끊는 중…»', async () => {
    asRole('admin');
    await render();
    let answer!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => { answer = r; }));
    await click(q('desktop-device-disconnect')[0]);
    await click(q('desktop-devices-confirm')[0]);
    const confirm = q('desktop-devices-confirm')[0] as HTMLButtonElement;
    const cancel = [...document.querySelectorAll('button')].find((b) => b.textContent === '취소') as HTMLButtonElement;
    expect([confirm.textContent, confirm.disabled, cancel.disabled]).toEqual(['끊는 중…', true, true]);
    await act(async () => { answer(new Response(JSON.stringify(revoked(false, '김지우')), { status: 200 })); });
    await act(async () => { await Promise.resolve(); });
    expect(q('desktop-devices-confirm')).toHaveLength(0);
  });

  it('a failed disconnect keeps the device, says so inside the dialog and leaves it open', async () => {
    asRole('admin');
    await render();
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 500 }));
    await click(q('desktop-device-disconnect')[0]);
    await click(q('desktop-devices-confirm')[0]);
    await act(async () => { await Promise.resolve(); });
    expect(q('desktop-devices-failed')[0].textContent).toBe('연결을 끊지 못했어요 — 다시 시도해 주세요');
    expect(q('desktop-devices-confirm')).toHaveLength(1);
    expect(q('desktop-device-state')[0].textContent).toBe('연결됨');
  });

  // Qadir 4830 ④ — another admin disconnected it first: the line says so and the row shows that admin, not the person pressing
  it('a device another admin already disconnected: «이미 끊겨 있었어요» and that admin\'s name, not «you»', async () => {
    asRole('owner');
    await render();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(revoked(true, '박서연')), { status: 200 }));
    await click(q('desktop-device-disconnect')[0]);
    await click(q('desktop-devices-confirm')[0]);
    await act(async () => { await Promise.resolve(); });
    expect(q('desktop-devices-done')[0].textContent).toBe('studio mac 연결은 이미 끊겨 있었어요');
    const metas = [...q('desktop-device-meta')].map((n) => n.textContent);
    expect(metas.filter((m) => m?.endsWith('끊은 사람 박서연'))).toHaveLength(2); // studio mac now, old laptop before
    expect(metas.some((m) => m?.endsWith('끊은 사람 김지우'))).toBe(false);
  });

  it('an answer that cannot be read: the list is read again instead of guessing who disconnected it', async () => {
    asRole('owner');
    await render();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ revoked_keys: 2 }), { status: 200 }));
    await click(q('desktop-device-disconnect')[0]);
    await click(q('desktop-devices-confirm')[0]);
    await act(async () => { await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    expect(fetchMock.mock.calls.filter(([url, init]) => url === '/api/desktop/setups' && !init?.method)).toHaveLength(2);
    // Qadir 4839 T1 ① — the result is unknown, so the list says what happened; the line never claims «연결을 끊었어요»
    expect(q('desktop-devices-done')[0].textContent).toBe('');
  });

  // Qadir 4839 T1 ② — a list read started before an org switch (the retry button, or the re-read after an unreadable
  // disconnect answer) answers after the switch: that late answer is the previous org's and is dropped
  it('a late list answer from before an org switch (the retry path) is dropped — the new org\'s rows stay', async () => {
    asRole('admin');
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 500 }));
    await render();
    let late!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => { late = r; }));
    await click([...document.querySelectorAll('button')].find((b) => b.textContent === '다시 시도')!);
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ setups: [device(A.replace('1', '3'), 'second org mac')] }), { status: 200 }));
    asRole('admin', 'org-2');
    await render();
    expect([...q('desktop-device-name')].map((n) => n.textContent)).toEqual(['second org mac']);
    await act(async () => { late(new Response(JSON.stringify({ setups: [device(A, 'studio mac')] }), { status: 200 })); });
    await act(async () => { await Promise.resolve(); });
    expect([...q('desktop-device-name')].map((n) => n.textContent)).toEqual(['second org mac']);
  });

  it('a late list answer from before an org switch (the re-read after an unreadable disconnect answer) is dropped', async () => {
    asRole('owner');
    await render();
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ revoked_keys: 2 }), { status: 200 }));
    let late!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => { late = r; }));
    await click(q('desktop-device-disconnect')[0]);
    await click(q('desktop-devices-confirm')[0]);
    await act(async () => { await Promise.resolve(); });
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ setups: [device(A.replace('1', '3'), 'second org mac')] }), { status: 200 }));
    asRole('owner', 'org-2');
    await render();
    expect([...q('desktop-device-name')].map((n) => n.textContent)).toEqual(['second org mac']);
    await act(async () => { late(new Response(JSON.stringify({ setups: [device(A, 'studio mac'), device(B, 'old laptop', 'disconnected')] }), { status: 200 })); });
    await act(async () => { await Promise.resolve(); });
    expect([...q('desktop-device-name')].map((n) => n.textContent)).toEqual(['second org mac']);
  });

  // Qadir 4830 ① — a client-side org switch keeps /desktop mounted: the list is read again for the new org, and nothing of
  // the previous org (its rows, its «연결을 끊었어요» line) stays on screen
  it('switching org reads the new org\'s list and drops the previous org\'s rows and line', async () => {
    asRole('admin');
    await render();
    await click(q('desktop-device-disconnect')[0]);
    await click(q('desktop-devices-confirm')[0]);
    await act(async () => { await Promise.resolve(); });
    expect(q('desktop-devices-done')[0].textContent).toBe('studio mac 연결을 끊었어요');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ setups: [device(A.replace('1', '3'), 'second org mac')] }), { status: 200 }));
    asRole('admin', 'org-2');
    await render();
    expect([...q('desktop-device-name')].map((n) => n.textContent)).toEqual(['second org mac']);
    expect(q('desktop-devices-done')[0].textContent).toBe('');
    expect(fetchMock.mock.calls.filter(([url, init]) => url === '/api/desktop/setups' && !init?.method)).toHaveLength(2);
  });
});
