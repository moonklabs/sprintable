// @vitest-environment jsdom
//
// story #3637(유나 silent-failure-sweep-3632, doc 자리 ③ console만 2) — handleAssignStory/
// handleUnassignStory가 실패해도 console.error만 찍고 화면은 아무 일도 없던 것처럼 보이던
// 자리. activateError/closeError와 동형 페이지 배너(actionError)로 승격.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/components/nav/top-bar-slot', () => ({
  TopBarSlot: ({ title, actions }: { title: React.ReactNode; actions?: React.ReactNode }) => (
    <div>{title}{actions}</div>
  ),
}));
vi.mock('@/components/workspace/workspace-frame-tabs', () => ({
  WorkspaceFrameTabs: () => null,
}));
const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

const SPRINT = { id: 'sp-1', title: '스프린트 1', status: 'planning', start_date: '2026-09-01', end_date: '2026-09-14' };
const BACKLOG_STORY = { id: 's1', title: '백로그 스토리', status: 'backlog', priority: 'medium' };
const SPRINT_STORY = { id: 's2', title: '스프린트 스토리', status: 'todo', priority: 'medium' };

function stubFetch(patchOk: boolean) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (typeof url === 'string' && url.includes('/api/sprints?project_id=')) {
      return { ok: true, json: async () => ({ data: [SPRINT] }) };
    }
    if (typeof url === 'string' && url.includes('/burndown')) {
      return { ok: false, json: async () => null };
    }
    if (typeof url === 'string' && url.includes('/api/stories/backlog')) {
      return { ok: true, json: async () => ({ data: [BACKLOG_STORY] }) };
    }
    if (typeof url === 'string' && url.includes('/api/stories?')) {
      return { ok: true, json: async () => ({ data: [SPRINT_STORY] }) };
    }
    if (typeof url === 'string' && /\/api\/stories\/s[12]$/.test(url) && init?.method === 'PATCH') {
      return { ok: patchOk, json: async () => ({}) };
    }
    return { ok: false, json: async () => null };
  }));
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ currentMemberType: 'human' });
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
  consoleErrorSpy.mockRestore();
});

async function mountAndSelect() {
  const { SprintsClient } = await import('./sprints-client');
  await act(async () => { root.render(wrap(<SprintsClient projectId="proj-1" orgId="org-1" />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const titleSpan = Array.from(container.querySelectorAll('span')).find((el) => el.textContent === SPRINT.title);
  const sprintRow = titleSpan?.closest('li');
  await act(async () => { sprintRow!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('SprintsClient — 배정/해제 실패 시 문장(story #3637)', () => {
  it('handleAssignStory 실패 시 assignError 배너가 뜬다(구 console-only)', async () => {
    stubFetch(false);
    await mountAndSelect();
    const assignBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === koMessages.sprints.assign);
    await act(async () => { assignBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain(koMessages.sprints.assignError);
  });

  it('handleUnassignStory 실패 시 unassignError 배너가 뜬다(구 console-only)', async () => {
    stubFetch(false);
    await mountAndSelect();
    const unassignBtn = container.querySelector(`button[title="${koMessages.sprints.unassign}"]`) as HTMLButtonElement;
    await act(async () => { unassignBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain(koMessages.sprints.unassignError);
  });

  // 뮤테이션 대표 — 성공 시엔 배너가 안 뜬다(과보고 방지).
  it('handleAssignStory 성공 시엔 배너가 안 뜬다', async () => {
    stubFetch(true);
    await mountAndSelect();
    const assignBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === koMessages.sprints.assign);
    await act(async () => { assignBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).not.toContain(koMessages.sprints.assignError);
  });
});
