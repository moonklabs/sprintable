// @vitest-environment jsdom
//
// story 4912 (C2c) — the detail's «접근» card: DetailCard (ds Card), the message as a ds Banner (failure = alert · success = status), ds Skeleton while loading, one ds ListRow per project and ds Buttons for the toggle / retry.
// The calls, the states (allowed · blocked · read-denied · error + retry) and the words are untouched.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { AgentProjectAccessSection } from './agent-project-access-section';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const S = koMessages.settings;
const PROJECTS = [{ id: 'p-1', name: '알파' }, { id: 'p-2', name: '베타' }, { id: 'p-3', name: '감마' }, { id: 'p-4', name: '델타' }];

let container: HTMLDivElement;
let root: Root;
let answers: Record<string, () => Response | Promise<Response>>;
let postAnswer: () => Response | Promise<Response>;
beforeEach(() => {
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  answers = {
    'p-1': () => new Response(JSON.stringify({ data: [{ id: 'r-1', member_id: 'a-1' }] }), { status: 200 }), // allowed
    'p-2': () => new Response(JSON.stringify({ data: [] }), { status: 200 }), // blocked
    'p-3': () => new Response('{}', { status: 403 }), // read denied
    'p-4': () => new Response('{}', { status: 500 }), // transient error → retry
  };
  postAnswer = () => new Response(JSON.stringify({ data: { id: 'r-9' } }), { status: 201 });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const m = String(input).match(/^\/api\/projects\/(p-\d)\/access(?:\/(.+))?$/);
    if (m && !init?.method) return answers[m[1]!]!();
    if (m && init?.method === 'DELETE') return new Response('{}', { status: 500 });
    if (m && init?.method === 'POST') return postAnswer();
    return new Response('{}', { status: 404 });
  }));
});
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); vi.unstubAllGlobals(); });
const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); }); };
async function mount(canEdit = true, projects = PROJECTS) {
  await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><AgentProjectAccessSection agentMemberId="a-1" projects={projects} canEdit={canEdit} /></NextIntlClientProvider>); });
  await settle();
}
const card = () => container.querySelector('[data-testid="agent-detail-card-project-access"]') as HTMLElement;
const rows = () => [...card().querySelectorAll<HTMLElement>('[data-slot="ds-list-row"]')];
const rowOf = (name: string) => rows().find((r) => r.textContent?.includes(name))!;

describe('AgentProjectAccessSection — ds 한 층(story 4912 · C2c)', () => {
  it('⭐카드는 DetailCard(ds Card · bg-ds-surface) · 머리 오른쪽 «n / m» 카운터 · 프로젝트마다 ds ListRow 한 줄', async () => {
    await mount();
    expect(card().getAttribute('data-slot')).toBe('ds-card');
    expect(card().className).toContain('bg-ds-surface');
    expect(card().querySelector('[data-slot="detail-card-header"]')?.textContent).toContain('1 / 4');
    expect(rows()).toHaveLength(4);
  });

  it('⭐네 상태가 그대로 — 허용 · 차단은 누를 수 있는 단추 · 읽기 거부는 글 · 일시 오류는 «다시 시도» 단추(role=alert)', async () => {
    await mount();
    expect(rowOf('알파').querySelector('button')?.textContent).toContain(S.projectAccessAllowed);
    expect(rowOf('베타').querySelector('button')?.textContent).toContain(S.projectAccessBlocked);
    expect(rowOf('감마').querySelector('button')).toBeNull();
    expect(rowOf('감마').textContent).toContain(S.readAccessDenied);
    const retry = rowOf('델타').querySelector('button') as HTMLButtonElement;
    expect(retry.textContent).toBe(S.loadFailedRetry);
    expect(retry.getAttribute('role')).toBe('alert');
  });

  it('⭐읽기만 하는 사람(canEdit 아님)은 단추가 아니라 글만 본다(허용 · 차단)', async () => {
    await mount(false, PROJECTS.slice(0, 2));
    expect(card().querySelectorAll('button')).toHaveLength(0);
    expect(rowOf('알파').textContent).toContain(S.projectAccessAllowed);
    expect(rowOf('베타').textContent).toContain(S.projectAccessBlocked);
  });

  it('⭐실패 메시지는 ds Banner failed = role=alert · 성공 메시지는 info = role=status(전엔 옛 Alert)', async () => {
    await mount();
    await act(async () => { (rowOf('알파').querySelector('button') as HTMLElement).click(); }); // DELETE → 500 → failure
    await settle();
    const banner = card().querySelector('[data-slot="ds-banner"]') as HTMLElement;
    expect(banner.getAttribute('role')).toBe('alert');
    expect(banner.getAttribute('data-tone')).toBe('failed');
    expect(banner.textContent).toContain('알파');
    expect(banner.querySelector('[aria-live], [role]'), 'ONE live region: the Banner\'s own role, no nested aria-live / role inside').toBeNull();
  });

  it('⭐성공 메시지는 ds Banner info = role=status(옛 Alert success · polite) — 겹친 live 영역 없이 겉 role 하나 · 눌러 «허용»으로 바뀐다', async () => {
    await mount();
    await act(async () => { (rowOf('베타').querySelector('button') as HTMLElement).click(); }); // POST → 201 → allowed
    await settle();
    const banner = card().querySelector('[data-slot="ds-banner"]') as HTMLElement;
    expect(banner.getAttribute('role')).toBe('status');
    expect(banner.getAttribute('data-tone')).toBe('info');
    expect(banner.textContent).toContain('베타');
    expect(banner.querySelector('[aria-live], [role]')).toBeNull();
    expect(rowOf('베타').querySelector('button')?.textContent).toContain(S.projectAccessAllowed);
  });

  it('⭐누른 줄의 토글은 요청이 나가 있는 동안 disabled(다른 줄은 그대로 — 한 번에 하나) · 허용 줄은 done 틴트 클래스, 차단 줄은 중립', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    postAnswer = async () => { await gate; return new Response(JSON.stringify({ data: { id: 'r-9' } }), { status: 201 }); };
    await mount();
    const allowed = rowOf('알파').querySelector('button') as HTMLButtonElement;
    const blocked = rowOf('베타').querySelector('button') as HTMLButtonElement;
    expect(allowed.className).toContain('bg-ds-done-soft');
    expect(blocked.className).not.toContain('bg-ds-done-soft');
    expect(blocked.className).toContain('min-w-[72px]');
    await act(async () => { blocked.click(); });
    expect((rowOf('베타').querySelector('button') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { release(); }); await settle();
    expect((rowOf('베타').querySelector('button') as HTMLButtonElement).disabled).toBe(false);
  });

  it('⭐읽는 동안은 ds Skeleton 묶음(손으로 그린 animate-pulse 아님)이고, 프로젝트가 없으면 점선 빈 칸 글', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    answers['p-1'] = async () => { await gate; return new Response(JSON.stringify({ data: [] }), { status: 200 }); };
    await act(async () => { root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><AgentProjectAccessSection agentMemberId="a-1" projects={[PROJECTS[0]!]} canEdit /></NextIntlClientProvider>); });
    expect(card().querySelector('[data-slot="ds-skeleton-group"]')).not.toBeNull();
    expect(card().innerHTML).not.toContain('animate-pulse');
    await act(async () => { release(); }); await settle();
    expect(card().querySelector('[data-slot="ds-skeleton-group"]')).toBeNull();
    await mount(true, []);
    expect(card().textContent).toContain(S.noAccessibleProjects);
  });

  it('⭐소스: 옛 ui/ 부품(alert · button · section-card) · 손으로 그린 animate-pulse · 옛 글자 · 색 토큰이 없다 — 되돌리면 RED', () => {
    const src = readFileSync(join(__dirname, 'agent-project-access-section.tsx'), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
    expect([...src.matchAll(/from '@\/components\/ui\/([\w-]+)'/g)].map((m) => m[1])).toEqual([]);
    expect(src).not.toContain('animate-pulse');
    expect(src).not.toMatch(/text-(muted-foreground|foreground|destructive|success|xs|sm|base)\b|border-border|bg-muted|variant="glass"|<button[\s>]/);
    expect(src).toContain('<DetailCard');
  });
});
