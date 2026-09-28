// @vitest-environment jsdom
//
// story #3986 CHANGES(페드루 PO C2) — 내보내기(export) markdown은 fetch 응답에만
// 있고 화면 어디에도 안 떠 있다. 클립보드 복사가 실패하면 그 전체 내용을 선택
// 가능한 자리에 노출해야 「직접 선택해 복사해 주세요」 문구가 거짓이 되지 않는다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../../messages/ko.json';

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'session-1' }),
}));
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => ({ currentTeamMemberId: 'member-1' }),
}));
vi.mock('@/components/nav/top-bar-slot', () => ({
  TopBarSlot: ({ title, actions }: { title: React.ReactNode; actions?: React.ReactNode }) => (
    <div>{title}{actions}</div>
  ),
}));
vi.mock('@/components/retro/sprint-close-cockpit', () => ({
  SprintCloseCockpit: () => null,
}));

import { RetroRouteProvider } from '../retro-context';
import { ToastProvider } from '@/components/ui/toast';
import RetroSessionPage from './page';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const RAW_MARKDOWN = '# 회고\n\n- 좋았던 점\n- 개선할 점';

function makeFetch() {
  return vi.fn(async (url: string) => {
    if (url.includes('/api/team-members')) {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    if (url.includes('/api/retro-sessions/session-1/export')) {
      return new Response(JSON.stringify({ data: { markdown: RAW_MARKDOWN } }), { status: 200 });
    }
    if (url.includes('/api/retro-sessions/session-1')) {
      return new Response(JSON.stringify({
        data: {
          id: 'session-1',
          org_id: 'org-1',
          project_id: 'proj-1',
          sprint_id: null,
          title: '테스트 회고',
          phase: 'closed',
          created_by: 'member-1',
          created_at: '2026-09-01T00:00:00Z',
          items: [],
          actions: [],
        },
      }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  });
}

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <ToastProvider>
        <RetroRouteProvider wsSlug="moonklabs" projSlug="sprintable" projectId="proj-1">
          {node}
        </RetroRouteProvider>
      </ToastProvider>
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('RetroSessionPage — story #3986 CHANGES(C2) export copy failure', () => {
  it('클립보드 복사가 실패하면 markdown 원문을 선택 가능한 textarea로 보여준다', async () => {
    global.fetch = makeFetch() as unknown as typeof fetch;
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });

    await act(async () => {
      root.render(wrap(<RetroSessionPage />));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    const exportButton = Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('내보내기'));
    expect(exportButton).toBeTruthy();

    await act(async () => {
      exportButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });

    const raw = container.querySelector('[data-testid="retro-export-copy-failed-raw-markdown"]') as HTMLTextAreaElement | null;
    expect(raw).toBeTruthy();
    expect(raw!.value).toBe(RAW_MARKDOWN);
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe('복사하지 못했어요 — 직접 선택해 복사해 주세요.');
  });

  it('클립보드 복사가 성공하면 원문 노출 없이 성공 토스트만 뜬다', async () => {
    global.fetch = makeFetch() as unknown as typeof fetch;
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
    });

    await act(async () => {
      root.render(wrap(<RetroSessionPage />));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    const exportButton = Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent?.includes('내보내기'));

    await act(async () => {
      exportButton!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });

    expect(container.querySelector('[data-testid="retro-export-copy-failed-raw-markdown"]')).toBeNull();
  });
});
