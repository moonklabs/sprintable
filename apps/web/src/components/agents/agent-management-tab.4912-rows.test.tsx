// @vitest-environment jsdom
//
// story 4912 (PR A1) — the agent list as RowList rows: Enter / double click open the detail, the «⋯» menu and the right-click menu are ONE array (same items), deactivating still goes through the confirm
// dialog, a selected count shows in a selection bar, and a non-admin sees no actions. The behaviour tests of the old markup (chips · buttons) live in the other agent-management-tab files, adapted.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { EmbeddedServerProvider } from '@/components/embedded-server-context';

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, replace: vi.fn() }) }));
vi.mock('@/hooks/use-agent-states', () => ({ useAgentStates: () => ({ rows: [], loaded: true, readAt: Date.now() }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const patches: Array<{ url: string; body: string }> = [];
beforeEach(() => { push.mockClear(); patches.length = 0; container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); document.body.innerHTML = ''; vi.unstubAllGlobals(); });

function stubFetch(role: 'admin' | 'member') {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/me') return new Response(JSON.stringify({ data: { role } }), { status: 200 });
    if (url === '/api/projects') return new Response(JSON.stringify({ data: [] }), { status: 200 });
    if (url.startsWith('/api/team-members?')) {
      return new Response(JSON.stringify({ data: [
        { id: 'a1', name: '조사', role: 'member', is_active: true, runtime_type: 'claude-code', verified: false },
        { id: 'a2', name: '작성', role: 'member', is_active: true, runtime_type: 'codex' },
      ] }), { status: 200 });
    }
    if (url.startsWith('/api/team-members/') && init?.method === 'PATCH') { patches.push({ url, body: String(init.body) }); return new Response('{}', { status: 200 }); }
    return new Response('{}', { status: 404 });
  }));
}
async function mount(role: 'admin' | 'member' = 'admin') {
  stubFetch(role);
  const { AgentManagementTab } = await import('./agent-management-tab');
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><AgentManagementTab /></NextIntlClientProvider>); });
  await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); });
}
const row = (id: string) => container.querySelector(`[data-testid="agent-row-${id}"]`)!;
const rowMain = (id: string) => row(id).querySelector('[data-row-main]') as HTMLElement;
const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((e) => e.textContent);
const settle = () => act(async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); });

describe('에이전트 목록 줄(story 4912 · PR A1)', () => {
  it('⭐Enter = 상세 열기 · 더블클릭 = 같은 일 · 이름 링크는 단일 클릭 이동 그대로(링크 주소)', async () => {
    await mount();
    expect(row('a1').querySelector('a')?.getAttribute('href')).toContain('/organization/workforce/a1');
    rowMain('a1').focus();
    await act(async () => { rowMain('a1').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); });
    expect(push).toHaveBeenLastCalledWith(expect.stringContaining('/organization/workforce/a1'));
    await act(async () => { rowMain('a2').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })); });
    expect(push).toHaveBeenLastCalledWith(expect.stringContaining('/organization/workforce/a2'));
    expect(push).toHaveBeenCalledTimes(2);
  });

  it('⭐줄 안의 체크 · «⋯» 단추를 더블클릭한 것은 상세를 열지 않는다', async () => {
    await mount();
    const check = row('a1').querySelector('[role="checkbox"]')!;
    const more = row('a1').querySelector('[data-slot="ds-row-actions-trigger"]')!;
    await act(async () => { check.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })); });
    await act(async () => { more.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })); });
    expect(push).not.toHaveBeenCalled();
  });

  it('⭐우클릭 메뉴 = «⋯» 메뉴와 같은 항목(같은 배열): 연결 안 된 에이전트는 «연결 설정 보기 · 비활성화»', async () => {
    await mount();
    const ctx = row('a1').querySelector('[data-slot="ds-row-context-trigger"]')!;
    await act(async () => { ctx.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20, button: 2 })); });
    const viaContext = items();
    expect(viaContext).toEqual(['연결 설정 보기', '비활성화']);
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await act(async () => { (row('a1').querySelector('[data-slot="ds-row-actions-trigger"]') as HTMLElement).click(); });
    expect(items()).toEqual(viaContext);
  });

  it('⭐메뉴의 «비활성화»는 확인창부터 연다(요청은 [비활성화]를 누를 때까지 안 나간다) — 확인하면 PATCH {is_active:false}', async () => {
    await mount();
    await act(async () => { (row('a2').querySelector('[data-slot="ds-row-actions-trigger"]') as HTMLElement).click(); });
    const deactivate = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((e) => e.textContent === '비활성화')!;
    await act(async () => { deactivate.click(); });
    await settle();
    expect(document.body.textContent).toContain(koMessages.settings.deactivateAgentDialogBody);
    expect(patches).toHaveLength(0);
    const confirm = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === koMessages.settings.deactivateAgentDialogConfirm)!;
    await act(async () => { confirm.click(); });
    await settle();
    expect(patches).toHaveLength(1);
    expect(patches[0]!.url).toBe('/api/team-members/a2');
    expect(JSON.parse(patches[0]!.body)).toEqual({ is_active: false });
  });

  it('⭐줄 앞 체크를 고르면 선택 줄에 «n개 골랐어요» + «실행 설정 바꾸기»가 선다(고른 것이 없으면 줄 자체가 없다)', async () => {
    await mount();
    expect(container.querySelector('[data-testid="agent-selection-bar"]')).toBeNull();
    await act(async () => { (row('a1').querySelector('[role="checkbox"]') as HTMLElement).click(); });
    const bar = container.querySelector('[data-testid="agent-selection-bar"]');
    expect(bar?.textContent).toContain(koMessages.agents.runProfileChosenCount.replace('{count}', '1'));
    expect(bar?.textContent).toContain(koMessages.agents.runProfileBulkOpen);
  });

  it('⭐관리자가 아니면: 체크 · 선택 줄 · «+ 에이전트 추가» · 활성/비활성 항목이 없다(연결 안 된 줄의 «연결 설정 보기»만 남는다)', async () => {
    await mount('member');
    expect(container.querySelector('[role="checkbox"]')).toBeNull();
    expect(container.textContent).not.toContain(koMessages.agents.manageAddAgent);
    expect(row('a2').querySelector('[data-slot="ds-row-actions-trigger"]')).toBeNull(); // nothing to offer → no «⋯»
    await act(async () => { (row('a1').querySelector('[data-slot="ds-row-actions-trigger"]') as HTMLElement).click(); });
    expect(items()).toEqual(['연결 설정 보기']);
  });

  it('⭐실행 설정 일괄 창에는 «고른 줄만» 간다 — 하나 고르면 «에이전트 1개에 적용»(둘 다가 아니다)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/me') return new Response(JSON.stringify({ data: { role: 'admin' } }), { status: 200 });
      if (url === '/api/projects') return new Response(JSON.stringify({ data: [] }), { status: 200 });
      if (url.startsWith('/api/team-members?')) return new Response(JSON.stringify({ data: [
        { id: 'a1', name: '조사', role: 'member', is_active: true, runtime_type: 'claude-code' },
        { id: 'a2', name: '작성', role: 'member', is_active: true, runtime_type: 'codex' },
      ] }), { status: 200 });
      if (url === '/api/agent-run-profile/options') return new Response(JSON.stringify({ data: { runtimes: [] } }), { status: 200 });
      return new Response('{}', { status: 404 });
    }));
    const { AgentManagementTab } = await import('./agent-management-tab');
    await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><AgentManagementTab /></NextIntlClientProvider>); });
    await settle();
    await act(async () => { (row('a1').querySelector('[role="checkbox"]') as HTMLElement).click(); });
    const bulk = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(koMessages.agents.runProfileBulkOpen))!;
    await act(async () => { bulk.click(); });
    await settle();
    expect(document.body.textContent).toContain(koMessages.agents.runProfileBulkApply.replace('{count}', '1'));
    expect(document.body.textContent).not.toContain(koMessages.agents.runProfileBulkApply.replace('{count}', '2'));
  });

  it('⭐컴퓨터 이름은 둘째 줄에 있다 — 컴퓨터가 하나뿐인 자리(내장 서버)에서는 안 그린다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/me') return new Response(JSON.stringify({ data: { role: 'admin' } }), { status: 200 });
      if (url === '/api/projects') return new Response(JSON.stringify({ data: [] }), { status: 200 });
      if (url.startsWith('/api/team-members?')) return new Response(JSON.stringify({ data: [{ id: 'a1', name: '조사', role: 'member', is_active: true, runtime_type: 'claude-code', device_name: '스튜디오 맥' }] }), { status: 200 });
      return new Response('{}', { status: 404 });
    }));
    const { AgentManagementTab } = await import('./agent-management-tab');
    const render = (embedded: boolean) => act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><EmbeddedServerProvider embedded={embedded}><AgentManagementTab /></EmbeddedServerProvider></NextIntlClientProvider>); });
    await render(false);
    await settle();
    expect(row('a1').textContent).toContain('스튜디오 맥');
    await render(true);
    await settle();
    expect(row('a1').textContent).not.toContain('스튜디오 맥');
  });

  it('⭐줄 오른쪽 상태 칩은 «폭이 묶이고 줄바꿈»한다 — 402폭에서 줄이 화면보다 넓어지지 않게(클래스 계약 · 실제 폭은 402 가로 넘침 e2e가 잰다)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/me') return new Response(JSON.stringify({ data: { role: 'admin' } }), { status: 200 });
      if (url === '/api/projects') return new Response(JSON.stringify({ data: [] }), { status: 200 });
      if (url.startsWith('/api/team-members?')) return new Response(JSON.stringify({ data: [{ id: 'a1', name: '조사', role: 'member', is_active: false, runtime_type: 'claude-code', verified: false, needs_restart: true }] }), { status: 200 });
      return new Response('{}', { status: 404 });
    }));
    const { AgentManagementTab } = await import('./agent-management-tab');
    await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><AgentManagementTab /></NextIntlClientProvider>); });
    await settle();
    const wrap = row('a1').querySelector('[data-slot="ds-chip"]')!.parentElement!;
    expect(wrap.querySelectorAll('[data-slot="ds-chip"]')).toHaveLength(3); // inactive · not connected · restart needed
    expect(wrap.className.split(/\s+/)).toEqual(expect.arrayContaining(['flex-wrap', 'max-w-56']));
  });
});

