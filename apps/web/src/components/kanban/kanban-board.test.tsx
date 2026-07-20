// @vitest-environment jsdom
//
// story bb78f14b(doc resource-view-firsttouch-identity-pattern §4 "보드" 행 — ⚠️과함 주의): 진짜
// 빈 보드(stories.length===0, unfiltered)에 절제된 3요소 배너(아이콘+headline+CTA)가 컬럼 그리드
// "위"에 뜨는지(대체 아님 — 백로그 컬럼이 계속 마운트돼 있어야 CTA의 autoComposeSignal이
// 실제로 컴포저를 연다), 데이터 있으면 배너가 안 뜨는지 왕복 검증한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock('@/components/nav/top-bar-slot', () => ({
  TopBarSlot: ({ title, actions }: { title: React.ReactNode; actions?: React.ReactNode }) => (
    <div>{title}{actions}</div>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

function stubFetch(stories: Array<Record<string, unknown> & { status: string }>) {
  // CB-S4: 보드는 status별 5회 독립 호출(/api/stories?...&status=<col>) — 각 호출에 해당
  // status만 필터링해 {data:[...]} 형태(meta 포함)로 응답해야 실제 파싱 경로(json.data ?? [])와 맞는다.
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.startsWith('/api/stories?')) {
      const status = new URL(url, 'http://localhost').searchParams.get('status');
      const matched = stories.filter((s) => s.status === status);
      return { ok: true, json: async () => ({ data: matched, meta: { total: matched.length, nextCursor: null } }) };
    }
    // 나머지(sprints/epics/members/workflow-executions/labels/gates 등)는 그레이스풀 폴백 경로만
    // 타면 되므로 실패 응답으로 충분(코드베이스 전반의 try/catch·optional-chaining 관례).
    return { ok: false, json: async () => null };
  }));
}

function stubLocalStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => { store.clear(); },
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  stubLocalStorage();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function mount() {
  const { KanbanBoard } = await import('./kanban-board');
  await act(async () => { root.render(wrap(<KanbanBoard projectId="proj-1" wsSlug="ws-1" projSlug="proj-1" />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('KanbanBoard — 보드 first-touch 절제된 배너', () => {
  it('진짜 빈 보드면 3요소 배너(headline+설명+CTA)가 렌더된다 — 컬럼 그리드는 대체 아닌 유지', async () => {
    stubFetch([]);
    await mount();
    const html = container.innerHTML;
    expect(html).toContain('아직 움직이는 일이 없어요');
    expect(html).toContain('보드는 사람과 AI가 맡은 일이 지금 흐르는 곳이에요');
    expect(html).toContain('첫 스토리 만들기');
    // 컬럼 그리드가 대체가 아니라 유지된다 — 기존 per-column "스토리가 없습니다" 플레이스홀더도 여전히 존재.
    expect(html).toContain('스토리가 없습니다');
  });

  it('배너 CTA 클릭 시 백로그 컬럼의 인라인 컴포저(제목 입력 필드)가 열린다', async () => {
    stubFetch([]);
    await mount();
    const ctaButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('첫 스토리 만들기'));
    expect(ctaButton).not.toBeUndefined();
    await act(async () => { ctaButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    // 컴포저가 열리면 입력 필드(placeholder 또는 textbox role)가 나타난다.
    expect(container.querySelector('input, textarea')).not.toBeNull();
  });

  it('스토리 데이터가 있으면 배너가 렌더되지 않는다(회귀 0)', async () => {
    stubFetch([{ id: 's1', title: 'S1', status: 'backlog', priority: 'medium' }]);
    await mount();
    const html = container.innerHTML;
    expect(html).not.toContain('아직 움직이는 일이 없어요');
  });
});
