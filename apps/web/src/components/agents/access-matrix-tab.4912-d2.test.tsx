// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import koMessages from '../../../messages/ko.json';
import { AccessMatrixTab } from './access-matrix-tab';

// story 4912 (D) — the access matrix on the ds parts, `wide`: PageFrame + PageHead (description + the admin-only hint as its meta line) + one DetailCard (title · the «n / m 팀에 들어감» counter on its right) holding the table
// (first column sticky · project columns scroll sideways · one cell toggles at a time — the structure is unchanged), cells = ds Button (aria-pressed · the granted tint), the message = ds Banner, loading = Skeleton, a failed load = Banner + [다시 시도].
// A REJECTED toggle request (the network went away) used to say nothing — the cell just came back; it says the same sentence as an HTTP error answer.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const A = koMessages.agents;
const S = koMessages.settings;
let container: HTMLDivElement; let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });

const AGENTS = [{ id: 'a1', name: '알파', runtime_type: 'claude-code' }, { id: 'a2', name: '베타', runtime_type: 'claude-code' }];
const PROJECTS = [{ id: 'p1', name: '프로젝트 A' }, { id: 'p2', name: '프로젝트 B' }, { id: 'p3', name: '프로젝트 C' }];
const ok = (data: unknown) => ({ ok: true, json: async () => ({ data }) });
let loadFail: 'none' | 'matrix500';
let writeMode: 'ok' | 'reject' | 'http500';

function stub() {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      if (writeMode === 'reject') throw new TypeError('network down');
      if (writeMode === 'http500') return { ok: false, status: 500, json: async () => ({}) };
      return method === 'POST' ? { ok: true, status: 201, json: async () => ({ data: { id: 'rec-new' } }) } : { ok: true, status: 200, json: async () => ({}) };
    }
    if (url.startsWith('/api/team-members?type=agent')) return ok(AGENTS);
    if (url === '/api/projects') return ok(PROJECTS);
    if (url === '/api/agents/access-matrix') return loadFail === 'matrix500' ? { ok: false, status: 500, json: async () => ({}) } : ok([{ agent_member_id: 'a1', project_id: 'p1', record_id: 'r-1' }]);
    return { ok: false, json: async () => null };
  }));
}
async function mount() {
  stub();
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><AccessMatrixTab /></NextIntlClientProvider>); });
  await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); });
}
beforeEach(() => { loadFail = 'none'; writeMode = 'ok'; });
const card = () => container.querySelector('[data-testid="access-matrix-card"]') as HTMLElement;
const cells = () => [...card().querySelectorAll('tbody button')] as HTMLButtonElement[];
const banner = () => card().querySelector('[data-slot="ds-banner"]') as HTMLElement | null;

describe('AccessMatrixTab — 4912 D: the ds face', () => {
  it('⭐wide 틀 · 쪽 머리(설명 + «관리자만» 보조줄) · DetailCard 한 장(머리 오른쪽 «1 / 6 팀에 들어감») · 표 구조 그대로(첫 열 고정 · 가로 스크롤 · 프로젝트 열)', async () => {
    await mount();
    expect(container.querySelector('[data-slot="ds-page-frame"]')?.getAttribute('data-width')).toBe('wide');
    const head = container.querySelector('[data-slot="ds-page-head"]')!;
    expect(head.textContent).toContain(A.matrixDescription);
    expect(head.textContent).toContain(A.matrixAdminOnlyHint);
    expect(card().getAttribute('data-slot')).toBe('ds-card');
    expect(card().querySelector('[data-slot="detail-card-header"]')?.textContent).toContain('1 / 6');
    expect(card().querySelector('[data-slot="detail-card-header"]')?.textContent).toContain(A.matrixGrantedCount);
    const wrap = card().querySelector('table')!.parentElement!;
    expect(wrap.className).toContain('overflow-x-auto');
    expect(wrap.className).toContain('scrollbar-visible'); // #2165 — a cut-off column must be visible
    expect([...card().querySelectorAll('thead th')].map((th) => th.textContent)).toEqual([A.matrixAgentColumn, '프로젝트 A', '프로젝트 B', '프로젝트 C']);
    expect(card().querySelector('tbody td')!.className).toContain('sticky');
    expect(cells()).toHaveLength(6);
  });

  it('⭐칸 = ds Button — 들어감은 done 틴트 + aria-pressed=true · 안 들어감은 중립 + aria-pressed=false · 접근 이름은 그대로(들어감/안 들어감 — 눌러서 …)', async () => {
    await mount();
    const granted = cells()[0]!;
    const blocked = cells()[1]!;
    expect(granted.getAttribute('aria-pressed')).toBe('true');
    expect(granted.className).toContain('bg-ds-done-soft');
    expect(granted.getAttribute('aria-label')).toBe(A.matrixCellGranted);
    expect(granted.querySelector('svg')).not.toBeNull(); // the check
    expect(blocked.getAttribute('aria-pressed')).toBe('false');
    expect(blocked.className).not.toContain('bg-ds-done-soft');
    expect(blocked.getAttribute('aria-label')).toBe(A.matrixCellBlocked);
    expect(blocked.querySelector('svg')).toBeNull();
  });

  it('⭐안 들어간 칸을 누르면 POST로 넣고(한 번에 한 칸) 카운터가 올라간다 · 눌러 뺄 땐 DELETE', async () => {
    await mount();
    await act(async () => { cells()[1]!.click(); });
    await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); });
    const calls = (fetch as unknown as { mock: { calls: [string, RequestInit?][] } }).mock.calls;
    expect(calls.filter(([, i]) => i?.method === 'POST').map(([u]) => u)).toEqual(['/api/projects/p2/access']);
    expect(cells()[1]!.getAttribute('aria-pressed')).toBe('true');
    expect(card().querySelector('[data-slot="detail-card-header"]')?.textContent).toContain('2 / 6');
    await act(async () => { cells()[0]!.click(); });
    await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); });
    expect(calls.filter(([, i]) => i?.method === 'DELETE').map(([u]) => u)).toEqual(['/api/projects/p1/access/r-1']);
    expect(cells()[0]!.getAttribute('aria-pressed')).toBe('false');
  });

  it('⭐목록을 못 읽으면(500) 실패 띠(role=alert) + [다시 시도] — 표를 «없음»으로 그리지 않는다 · 누르면 다시 읽고 표가 선다', async () => {
    loadFail = 'matrix500';
    await mount();
    const err = container.querySelector('[data-testid="access-matrix-load-error"] [data-slot="ds-banner"]') as HTMLElement;
    expect(err.getAttribute('role')).toBe('alert');
    expect(err.textContent).toContain(A.matrixLoadError);
    expect(container.querySelector('table')).toBeNull();
    expect(container.textContent).not.toContain(A.matrixEmpty);
    loadFail = 'none';
    await act(async () => { ([...err.querySelectorAll('button')].find((b) => b.textContent === A.matrixRetry) as HTMLElement).click(); });
    await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); });
    expect(container.querySelector('[data-testid="access-matrix-load-error"]')).toBeNull();
    expect(container.querySelector('table')).not.toBeNull();
  });

  it('⭐쓰기 요청이 HTTP 오류로 끝나도 · 요청 자체가 거절돼도(네트워크 끊김) 같은 실패 띠(role=alert) · 칸은 그대로이고 다시 눌린다 — catch를 걷으면 RED (PO 11-13)', async () => {
    await mount();
    for (const mode of ['http500', 'reject'] as const) {
      writeMode = mode;
      await act(async () => { cells()[1]!.click(); });
      await act(async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); });
      expect(banner(), mode).not.toBeNull();
      expect(banner()!.getAttribute('role')).toBe('alert');
      expect(banner()!.textContent).toContain(S.agentActionFailed);
      expect(cells()[1]!.getAttribute('aria-pressed')).toBe('false');
      expect(cells()[1]!.disabled).toBe(false);
      expect(cells()[1]!.hasAttribute('aria-busy')).toBe(false);
    }
  });

  it('⭐소스: ui/* · lucide · SectionCard · 손으로 짠 단추 · 옛 글자 크기 · 색 토큰이 없다 — 되돌리면 RED', () => {
    const src = readFileSync(join(__dirname, 'access-matrix-tab.tsx'), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    expect(src).not.toMatch(/from '@\/components\/ui\//);
    expect(src).not.toContain('lucide-react');
    expect(src).not.toMatch(/<button\b/);
    for (const bad of ['SectionCard', 'animate-pulse', 'text-muted-foreground', 'text-sm', 'text-xs', 'text-success', 'text-destructive', 'bg-muted', 'border-border', 'text-foreground']) expect(src, bad).not.toContain(bad);
  });
});
