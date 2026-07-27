// @vitest-environment jsdom
//
// story #2192 — 알림벨이 30건에서 조용히 잘리던 결함의 회귀가드. 「더 보기」가 hasMore일 때만
// 뜨고, 누르면 offset을 이어서 다음 페이지를 붙이는지 실 렌더로 검증한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

const { NotificationBell } = await import('./notification-bell');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function withIntl(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

function stubMatchMedia() {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({
    matches: true, // 데스크톱 드롭다운 분기(lg+) — 목록 렌더를 그쪽으로 고정해 테스트를 단순화.
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

function notif(id: string) {
  return {
    id, event_type: 'story_status_changed', source_entity_type: null, source_entity_id: null,
    payload: { summary: `알림 ${id}` }, read_at: '2026-07-27T00:00:00Z', created_at: '2026-07-27T00:00:00Z',
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  stubMatchMedia();
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

// offset 쿼리파라미터로 페이지를 서빙한다(호출 횟수 순서가 아니라) — offsetRef 계산이
// 실제로 틀리면(예: 항상 0을 보내거나 notifications.length를 그대로 씀) 요청한 offset에
// 해당하는 페이지가 없어 빈 배열이 와서 뮤테이션을 잡아낸다.
function stubFetchSequenceByOffset(pagesByOffset: Record<number, { items: ReturnType<typeof notif>[]; hasMore: boolean }>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/event-notifications?')) {
      const offset = Number(new URL(url, 'http://localhost').searchParams.get('offset') ?? '0');
      const page = pagesByOffset[offset] ?? { items: [], hasMore: false };
      return new Response(JSON.stringify({ data: page.items, meta: { hasMore: page.hasMore } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }
    // unread-count 폴링 등 그 외 호출 — 무해한 기본 응답.
    return new Response(JSON.stringify({ count: 0 }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
}

async function openBell() {
  await act(async () => { root.render(withIntl(<NotificationBell />)); });
  const bellButton = container.querySelector('button[aria-expanded]') as HTMLButtonElement;
  await act(async () => { bellButton.click(); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('NotificationBell — 더 보기(story #2192 AC3/AC4)', () => {
  it('hasMore=true면 「더 보기」 버튼이 뜬다(AC3)', async () => {
    stubFetchSequenceByOffset({ 0: { items: Array.from({ length: 30 }, (_, i) => notif(`n${i}`)), hasMore: true } });
    await openBell();

    const loadMoreBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '더 보기');
    expect(loadMoreBtn).toBeDefined();
  });

  it('음성대조 — hasMore=false(30건 이하 계정)면 「더 보기」 버튼이 없다(AC4)', async () => {
    stubFetchSequenceByOffset({ 0: { items: Array.from({ length: 5 }, (_, i) => notif(`n${i}`)), hasMore: false } });
    await openBell();

    const loadMoreBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '더 보기');
    expect(loadMoreBtn).toBeUndefined();
  });

  it('「더 보기」를 연달아 두 번 누르면 offset=30·60으로 누적 요청해 뒤에 붙인다(누적 오프셋 계산 검증)', async () => {
    stubFetchSequenceByOffset({
      0: { items: Array.from({ length: 30 }, (_, i) => notif(`n${i}`)), hasMore: true },
      30: { items: Array.from({ length: 30 }, (_, i) => notif(`n2-${i}`)), hasMore: true },
      60: { items: Array.from({ length: 5 }, (_, i) => notif(`n3-${i}`)), hasMore: false },
    });
    await openBell();

    // jsdom은 Tailwind의 lg:flex/lg:hidden 반응형 클래스를 실제로 평가하지 않아 데스크톱
    // 드롭다운·모바일 오버레이 둘 다 DOM에 동시 존재한다 — 데스크톱 컨테이너(.w-80)로 좁혀서 잰다.
    const desktopPanel = container.querySelector('.w-80')!;
    expect(desktopPanel.querySelectorAll('ul li')).toHaveLength(30);

    const clickLoadMore = async () => {
      const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '더 보기') as HTMLButtonElement;
      await act(async () => { btn.click(); await Promise.resolve(); await Promise.resolve(); });
    };

    await clickLoadMore(); // offset=30 요청 기대
    expect(desktopPanel.querySelectorAll('ul li')).toHaveLength(60); // 30 + 30 — offsetRef가 30으로 안 갱신됐으면 offset=0 재요청이라 여기서 어긋난다

    await clickLoadMore(); // offset=60 요청 기대(누적)
    expect(desktopPanel.querySelectorAll('ul li')).toHaveLength(65); // 60 + 5
    expect(Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '더 보기')).toBeUndefined(); // 3페이지째 hasMore=false
  });
});
