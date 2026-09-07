// @vitest-environment jsdom
//
// story #3638(유나 §8 별건) — exportSession()이 실패해도 "내보내기" 클릭이 아무 일도
// 안 일어난 것처럼 보이던 자리(문구 0, catch { // ignore }). exportCopied와 동형 신규
// exportFailed 키를 배선한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../../messages/ko.json';

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'session-1' }),
}));
vi.mock('@/components/nav/top-bar-slot', () => ({
  TopBarSlot: ({ title, actions }: { title: React.ReactNode; actions?: React.ReactNode }) => (
    <div>{title}{actions}</div>
  ),
}));
const { useDashboardContextMock } = vi.hoisted(() => ({ useDashboardContextMock: vi.fn() }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(RetroRouteProvider: React.ComponentType<{ wsSlug: string; projSlug: string; projectId: string; children: React.ReactNode }>, node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <RetroRouteProvider wsSlug="ws" projSlug="proj" projectId="proj-1">
        {node}
      </RetroRouteProvider>
    </NextIntlClientProvider>
  );
}

const SESSION = {
  id: 'session-1', project_id: 'proj-1', title: '회고 1', phase: 'closed', sprint_id: null,
  items: [], actions: [],
};

function stubFetch(exportOk: boolean) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes(`/api/retro-sessions/${SESSION.id}?project_id=`)) {
      return { ok: true, json: async () => ({ data: SESSION }) };
    }
    if (typeof url === 'string' && url.includes('/export?project_id=')) {
      return exportOk
        ? { ok: true, json: async () => ({ data: { markdown: '# 회고' } }) }
        : { ok: false, json: async () => ({}) };
    }
    if (typeof url === 'string' && url.includes('/api/team-members')) {
      return { ok: true, json: async () => ({ data: [] }) };
    }
    return { ok: false, json: async () => null };
  }));
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useDashboardContextMock.mockReturnValue({ orgId: 'org-1', currentTeamMemberId: 'member-1' });
  Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => undefined) } });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function mount() {
  const { default: RetroSessionPage } = await import('./page');
  const { RetroRouteProvider } = await import('../retro-context');
  await act(async () => { root.render(wrap(RetroRouteProvider, <RetroSessionPage />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('RetroSessionPage — 내보내기 실패 시 문장(story #3638)', () => {
  it('exportSession 실패 시 exportFailed 토스트가 뜬다(구 침묵)', async () => {
    stubFetch(false);
    await mount();
    const exportBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === koMessages.retro.export);
    await act(async () => { exportBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain(koMessages.retro.exportFailed);
  });

  // 뮤테이션 대표 — 성공 시엔 exportCopied만 뜨고 exportFailed는 안 뜬다.
  it('exportSession 성공 시엔 exportCopied만 뜬다', async () => {
    stubFetch(true);
    await mount();
    const exportBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === koMessages.retro.export);
    await act(async () => { exportBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain(koMessages.retro.exportCopied);
    expect(container.textContent).not.toContain(koMessages.retro.exportFailed);
  });
});
