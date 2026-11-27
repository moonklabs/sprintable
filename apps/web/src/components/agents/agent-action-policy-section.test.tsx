// @vitest-environment jsdom
//
// story 5041 ② (web) — «에이전트가 혼자 해도 되는 일»: one agent, one project, a level per action. Red when: a change is sent for the wrong agent / project · a locked row can be changed · an action with no «늘 허용» slot offers it ·
// the page draws anything when the server says 403 · a failed save is drawn as saved · the section writes without a press.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { AgentActionPolicySection } from './agent-action-policy-section';
import { parsePolicy } from '@/lib/agent-action-policy';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AGENT = 'a1a1a1a1-0000-4000-8000-000000000001';
const P1 = 'b1b1b1b1-0000-4000-8000-000000000001';
const P2 = 'b2b2b2b2-0000-4000-8000-000000000002';
let container: HTMLDivElement;
let root: Root;
let log: { method: string; url: string; body?: unknown }[];
const json = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const entry = (key: string, level: string, source = 'default', over: Record<string, unknown> = {}) => ({ action_key: key, level, source, locked: false, auto_allowed: true, ...over });
const WORLD = {
  actions: [
    entry('story.delete', 'ask'),
    entry('doc.delete', 'auto', 'project_agent'),
    entry('goal.delete', 'ask', 'default', { auto_allowed: false }),
    entry('gate.approve', 'block', 'floor', { locked: true, auto_allowed: false }),
  ],
};

function stub(w: { read?: () => Response; put?: () => Response; del?: () => Response } = {}) {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input); const method = init?.method ?? 'GET';
    log.push({ method, url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (method === 'GET' && url.startsWith('/api/agent-action-policy?')) return (w.read ? w.read() : json(200, WORLD)).clone();
    if (method === 'PUT' && url === '/api/agent-action-policy') return w.put ? w.put() : json(200, {});
    if (method === 'DELETE' && url.startsWith('/api/agent-action-policy?')) return w.del ? w.del() : json(200, { removed: true });
    return json(404);
  }));
}
async function show(projects = [{ id: P1, name: '프로젝트 하나' }, { id: P2, name: '프로젝트 둘' }]) {
  await act(async () => { root.render(null); }); // a fresh mount: the same props would not read again
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><AgentActionPolicySection agentId={AGENT} projects={projects} /></NextIntlClientProvider>); });
  for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
}
const row = (key: string) => container.querySelector(`[data-testid="action-policy-row-${key}"]`) as HTMLElement | null;
const levelBtn = (key: string, label: string) => Array.from(row(key)!.querySelectorAll('button')).find((b) => b.textContent === label) as HTMLButtonElement | undefined;
const writes = () => log.filter((c) => c.method !== 'GET');
async function click(el: HTMLElement) { await act(async () => { el.click(); }); for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); }); }

beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); log = []; });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

describe('the settings of one agent in one project', () => {
  it('reads THIS agent in the FIRST project, draws a row per adjustable action and the locked ones apart — and sends no write', async () => {
    stub(); await show();
    expect(log[0]).toEqual({ method: 'GET', url: `/api/agent-action-policy?project_id=${P1}&agent_id=${AGENT}` });
    expect(row('story.delete')).toBeTruthy();
    expect(row('gate.approve')).toBeNull();
    expect(container.querySelector('[data-testid="action-policy-locked"]')!.textContent).toContain('결재 승인·반려');
    expect(levelBtn('story.delete', '물어봄')!.getAttribute('aria-pressed')).toBe('true');
    expect(levelBtn('doc.delete', '늘 허용')!.getAttribute('aria-pressed')).toBe('true');
    expect(row('doc.delete')!.textContent).toContain('이 에이전트 · 이 프로젝트 설정');
    expect(writes()).toEqual([]);
  });

  it('a press sends exactly ONE change for this agent and this project, then reads again', async () => {
    stub(); await show();
    await click(levelBtn('story.delete', '늘 허용')!);
    expect(writes()).toEqual([{ method: 'PUT', url: '/api/agent-action-policy', body: { action_key: 'story.delete', level: 'auto', project_id: P1, agent_id: AGENT } }]);
    expect(log.filter((c) => c.method === 'GET').length).toBe(2);
  });

  it('another project is read when it is chosen, and a change then names THAT project', async () => {
    stub(); await show();
    const select = container.querySelector('[data-testid="action-policy-project"]') as HTMLSelectElement;
    await act(async () => { select.value = P2; select.dispatchEvent(new Event('change', { bubbles: true })); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    expect(log.filter((c) => c.method === 'GET').pop()!.url).toContain(`project_id=${P2}`);
    await click(levelBtn('story.delete', '막음')!);
    expect(writes()[0].body).toMatchObject({ project_id: P2, agent_id: AGENT, level: 'block' });
  });

  it('an action with no «늘 허용» slot cannot be set to it, and says why; the current level is not re-sent', async () => {
    stub(); await show();
    expect(levelBtn('goal.delete', '늘 허용')!.disabled).toBe(true);
    expect(row('goal.delete')!.textContent).toContain('«늘 허용»이 없어요');
    await click(levelBtn('goal.delete', '늘 허용')!);
    await click(levelBtn('story.delete', '물어봄')!); // already the level
    expect(writes()).toEqual([]);
  });

  it('«기본값으로» (only on this agent\'s own setting) takes it back with ONE delete', async () => {
    stub(); await show();
    expect(row('story.delete')!.textContent).not.toContain('기본값으로');
    const reset = Array.from(row('doc.delete')!.querySelectorAll('button')).find((b) => b.textContent === '기본값으로') as HTMLButtonElement;
    await click(reset);
    expect(writes()).toEqual([{ method: 'DELETE', url: `/api/agent-action-policy?action_key=doc.delete&project_id=${P1}&agent_id=${AGENT}` }]);
  });

  it('a refused save is told, never drawn as saved (the list is not read again)', async () => {
    stub({ put: () => json(500) }); await show();
    await click(levelBtn('story.delete', '막음')!);
    expect(container.textContent).toContain('저장하지 못했어요');
    expect(log.filter((c) => c.method === 'GET').length).toBe(1);
  });

  it('the server says 403 → nothing is drawn; a broken answer → «불러오지 못했어요» with a way to try again; no project → nothing', async () => {
    stub({ read: () => json(403) }); await show();
    expect(container.textContent).toBe('');
    stub({ read: () => json(200, { actions: [{ action_key: 'x', level: 'maybe', source: 'default' }] }) }); await show();
    expect(container.textContent).toContain('설정을 불러오지 못했어요');
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === '다시 불러오기')).toBe(true);
    await show([]);
    expect(container.textContent).toBe('');
  });

  it('a slow answer for the project left behind is dropped — never drawn under the project now shown (codex)', async () => {
    let releaseFirst: (r: Response) => void = () => {};
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? 'GET';
      log.push({ method, url });
      if (method === 'GET') {
        call += 1;
        if (call === 1) return new Promise<Response>((resolve) => { releaseFirst = resolve; }); // project one answers LAST
        return json(200, { actions: [entry('story.delete', 'block', 'project_agent')] });
      }
      return json(404);
    }));
    await show();
    const select = container.querySelector('[data-testid="action-policy-project"]') as HTMLSelectElement;
    await act(async () => { select.value = P2; select.dispatchEvent(new Event('change', { bubbles: true })); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    expect(levelBtn('story.delete', '막음')!.getAttribute('aria-pressed')).toBe('true'); // project two is drawn
    await act(async () => { releaseFirst(json(200, { actions: [entry('story.delete', 'auto', 'default')] })); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    expect(levelBtn('story.delete', '막음')!.getAttribute('aria-pressed')).toBe('true'); // the late answer for project one did not overwrite it
    expect(levelBtn('story.delete', '늘 허용')!.getAttribute('aria-pressed')).toBe('false');
  });

  it('while a save and its read are in flight a second press and a project switch are refused (the selector and the buttons are disabled)', async () => {
    let releaseRead: (r: Response) => void = () => {};
    let reads = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); const method = init?.method ?? 'GET';
      log.push({ method, url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (method === 'GET') { reads += 1; return reads === 2 ? new Promise<Response>((resolve) => { releaseRead = resolve; }) : json(200, WORLD).clone(); }
      return json(200, {});
    }));
    await show();
    await act(async () => { levelBtn('story.delete', '막음')!.click(); });
    for (let i = 0; i < 3; i++) await act(async () => { await Promise.resolve(); });
    // the save went out; the follow-up read is pending → everything is held
    expect(writes().length).toBe(1);
    expect((container.querySelector('[data-testid="action-policy-project"]') as HTMLSelectElement).disabled).toBe(true);
    await act(async () => { releaseRead(json(200, WORLD)); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    expect((container.querySelector('[data-testid="action-policy-project"]') as HTMLSelectElement).disabled).toBe(false);
    expect(writes().length).toBe(1);
  });

  it('a project list that arrives after the first render is read at once — an empty first choice does not stick (codex)', async () => {
    stub();
    await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><AgentActionPolicySection agentId={AGENT} projects={[]} /></NextIntlClientProvider>); });
    await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><AgentActionPolicySection agentId={AGENT} projects={[{ id: P1, name: 'One' }]} /></NextIntlClientProvider>); });
    for (let i = 0; i < 4; i++) await act(async () => { await Promise.resolve(); });
    expect(log.some((c) => c.method === 'GET' && c.url.includes(P1))).toBe(true);
    expect(container.querySelector('[data-testid="action-policy-rows"]')).not.toBeNull();
  });

  it('parsePolicy reads only a well-formed list (a literal true for locked / auto_allowed)', () => {
    expect(parsePolicy({ actions: [entry('story.delete', 'ask')] })).toEqual([{ actionKey: 'story.delete', level: 'ask', source: 'default', locked: false, autoAllowed: true }]);
    expect(parsePolicy({ actions: [entry('x', 'ask', 'default', { locked: 'yes', auto_allowed: 1 })] })).toEqual([{ actionKey: 'x', level: 'ask', source: 'default', locked: false, autoAllowed: false }]);
    for (const bad of [null, {}, { actions: 'x' }, { actions: [entry('x', 'ask', 'elsewhere')] }, { actions: [{ level: 'ask', source: 'default' }] }]) expect(parsePolicy(bad)).toBeNull();
  });
});
