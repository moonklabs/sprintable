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

const { NotificationBell, getEntityHref } = await import('./notification-bell');
import type { EventNotification } from './notification-bell';

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

// story #2192 — "더 보기" 클릭 사이에 SSE로 실시간 알림이 목록 앞에 끼어들어도(prepend)
// offsetRef(API로 실제 받은 건수만 누적)가 오염되지 않는지 재현한다. 오르테가군이 "이 PR에서
// 제일 깨지기 쉬운 자리"로 지목한 곳 — notifications.length를 직접 offset으로 썼다면 SSE
// prepend가 1건 생길 때마다 다음 "더 보기" 요청의 offset이 실제보다 하나씩 밀린다.
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners: Record<string, Array<(e: { data: string; lastEventId?: string }) => void>> = {};
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string; lastEventId?: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeEventSource.instances.push(this); }
  addEventListener(type: string, cb: (e: { data: string; lastEventId?: string }) => void) {
    (this.listeners[type] ??= []).push(cb);
  }
  close() { /* no-op */ }
  emit(type: string, data: unknown) {
    for (const cb of this.listeners[type] ?? []) cb({ data: JSON.stringify(data) });
  }
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

  it('더 보기 사이에 SSE 실시간 알림이 앞에 끼어들어도 다음 페이지 offset이 안 밀린다(오르테가군 지적 — 제일 깨지기 쉬운 자리)', async () => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    stubFetchSequenceByOffset({
      0: { items: Array.from({ length: 30 }, (_, i) => notif(`n${i}`)), hasMore: true },
      30: { items: Array.from({ length: 5 }, (_, i) => notif(`n2-${i}`)), hasMore: false },
    });
    await openBell();

    const desktopPanel = container.querySelector('.w-80')!;
    expect(desktopPanel.querySelectorAll('ul li')).toHaveLength(30);

    // SSE로 실시간 알림 1건이 목록 맨 앞에 끼어든다 — API로 받은 게 아니므로 offsetRef는 그대로 30이어야.
    const es = FakeEventSource.instances[0]!;
    await act(async () => {
      es.emit('notification', { id: 'live-1', event_type: 'story_status_changed', source_entity_type: null, source_entity_id: null, payload: {}, read_at: null, created_at: '2026-07-27T01:00:00Z' });
    });
    expect(desktopPanel.querySelectorAll('ul li')).toHaveLength(31); // 30(API) + 1(SSE)

    // "더 보기"를 누르면 offsetRef(30)를 그대로 써서 offset=30을 요청해야 한다 — SSE로 31개가
    // 됐다고 offset=31을 보내면 실제 30번째 API 항목을 건너뛰게 된다(중복/누락의 정확한 형태).
    const loadMoreBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '더 보기') as HTMLButtonElement;
    await act(async () => { loadMoreBtn.click(); await Promise.resolve(); await Promise.resolve(); });

    expect(desktopPanel.querySelectorAll('ul li')).toHaveLength(36); // 30(API) + 1(SSE) + 5(API 2페이지)
  });
});

// story #2201 — BE(PR #2554)가 emit하는 `sync_status` 프레임을 받아 배너를 띄우는지 검증.
// AC5(회귀 가드): 커서가 무효/캡에 걸린 상태(complete:false, reason≠no_cursor)를 재현했을 때만
// 배너가 뜨는 것 — 정상 커서로만 도는 테스트는 이 결함을 못 잡는다(AC5 명시 요구사항).
describe('NotificationBell — sync_status 배너(story #2201)', () => {
  function emitSyncStatus(data: { complete: boolean; reason: string | null; returned: number }) {
    const es = FakeEventSource.instances[0]!;
    return act(async () => { es.emit('sync_status', data); });
  }

  it('강등(cursor_stale)이면 배너가 뜬다', async () => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    stubFetchSequenceByOffset({ 0: { items: [], hasMore: false } });
    await openBell();

    await emitSyncStatus({ complete: false, reason: 'cursor_stale', returned: 5 });

    expect(container.textContent).toContain('일부 지난 알림은 표시되지 않았습니다');
  });

  it('강등(cursor_not_found)이면 배너가 뜬다', async () => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    stubFetchSequenceByOffset({ 0: { items: [], hasMore: false } });
    await openBell();

    await emitSyncStatus({ complete: false, reason: 'cursor_not_found', returned: 50 });

    expect(container.textContent).toContain('일부 지난 알림은 표시되지 않았습니다');
  });

  it('음성대조 — no_cursor(최초 연결)는 배너가 안 뜬다(오르테가군 확定: 강등이 아니라 정상 최초상태)', async () => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    stubFetchSequenceByOffset({ 0: { items: [], hasMore: false } });
    await openBell();

    await emitSyncStatus({ complete: false, reason: 'no_cursor', returned: 0 });

    expect(container.textContent).not.toContain('일부 지난 알림은 표시되지 않았습니다');
  });

  it('음성대조 — complete:true(정상 완결)면 배너가 안 뜬다', async () => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    stubFetchSequenceByOffset({ 0: { items: [], hasMore: false } });
    await openBell();

    await emitSyncStatus({ complete: true, reason: null, returned: 12 });

    expect(container.textContent).not.toContain('일부 지난 알림은 표시되지 않았습니다');
  });

  it('강등 배너가 뜬 뒤 재연결로 정상 sync_status가 오면 자동으로 걷힌다(별도 dismiss 없음, 스펙 그대로)', async () => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    stubFetchSequenceByOffset({ 0: { items: [], hasMore: false } });
    await openBell();

    await emitSyncStatus({ complete: false, reason: 'cursor_stale', returned: 5 });
    expect(container.textContent).toContain('일부 지난 알림은 표시되지 않았습니다');

    await emitSyncStatus({ complete: true, reason: null, returned: 8 });
    expect(container.textContent).not.toContain('일부 지난 알림은 표시되지 않았습니다');
  });
});

// story #2686(축D) — 채팅 mark-read가 그 대화의 event-notification read_at을 BE에서
// 동기(디디 계약)하는데, 벨이 그걸 "즉시" 반영하려면 conversation.read SSE 수신 시 unread-count를
// 재fetch해야 한다(기존 30초 폴링만으론 AC①의 "즉시" 성립이 늦다). 30초를 기다리지 않고도
// 반영되는지를 정확히 그 축으로 고정한다 — 폴링이 언젠가 따라잡는 것과는 다른 결함 클래스.
describe('NotificationBell — conversation.read SSE 즉시 unread-count 재fetch(story #2686)', () => {
  it('conversation.read를 받으면 폴링(30초)을 기다리지 않고 unread-count를 다시 fetch해 배지를 갱신한다', async () => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    let unreadCountCallCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/event-notifications/unread-count')) {
        unreadCountCallCount += 1;
        // 두 번째 호출(=conversation.read 이후 재fetch)부터 감소된 값을 준다 — 재fetch가
        // "실제로" 일어났는지(단순 로컬 감산이 아니라 서버 truth 재조회인지)까지 구분한다.
        return new Response(JSON.stringify({ count: unreadCountCallCount === 1 ? 3 : 1 }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('/api/event-notifications?')) {
        return new Response(JSON.stringify({ data: [], meta: { hasMore: false } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ count: 0 }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));

    await openBell();
    await act(async () => { await Promise.resolve(); });
    const bellButton = container.querySelector('button[aria-expanded]') as HTMLButtonElement;
    expect(bellButton.getAttribute('aria-label')).toContain('3');

    const beforeCount = unreadCountCallCount;
    const es = FakeEventSource.instances[0]!;
    await act(async () => {
      es.emit('conversation.read', { conversation_id: 'conv-1', member_id: 'me-1', last_read_at: '2026-08-16T00:00:00Z', unread_count: 0 });
    });
    await act(async () => { await Promise.resolve(); });

    expect(unreadCountCallCount).toBe(beforeCount + 1);
    expect(bellButton.getAttribute('aria-label')).toContain('1');
  });

  it('sync_status 등 다른 extra 이벤트는 unread-count를 재fetch하지 않는다(과잉살상 금지 음성대조)', async () => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    stubFetchSequenceByOffset({ 0: { items: [], hasMore: false } });
    await openBell();

    const es = FakeEventSource.instances[0]!;
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const beforeCalls = fetchMock.mock.calls.length;
    await act(async () => { es.emit('sync_status', { complete: true, reason: null, returned: 0 }); });
    await act(async () => { await Promise.resolve(); });

    expect(fetchMock.mock.calls.length).toBe(beforeCalls);
  });
});

// ⚠️QA changes(PR#3381, 카디르+codex, 2026-08-23) — story #2956이 지운 RENAMED_RESOURCES
// (epics→goals) 301에 이 딥링크가 얹혀 살고 있었다(테스트 0건이었음). `/epics/{id}`는
// bare 승격(MIGRATED_RESOURCES) 後 `/{ws}/{proj}/epics/{id}`가 됐다가 옛 rename이 다시
// `/{ws}/{proj}/goals/{id}`로 옮겨줬는데, 신 `[ws]/[proj]/epics/`엔 목록(`page.tsx`)만
// 있고 `[id]` 서브라우트가 없어(#3377 스코프에 상세 페이지 없음) rename 제거로 404가
// 됐다. 회귀가드: 이 딥링크 계약(entity_type='epic' → 유효한 상세 라우트)을 명시로 고정.
function baseNotification(overrides: Partial<EventNotification>): EventNotification {
  return {
    id: 'n1', event_type: 'story.status_changed', source_entity_type: null, source_entity_id: null,
    payload: null, read_at: null, created_at: '2026-08-23T00:00:00Z',
    ...overrides,
  };
}

describe('getEntityHref — 딥링크 계약(story #2956 QA changes)', () => {
  it("entity_type='epic' → /goals/{id}(Goal=Epic, goals/[id]가 에픽 상세 정본 — /epics/{id} 아님)", () => {
    const href = getEntityHref(baseNotification({ source_entity_type: 'epic', source_entity_id: 'e-123' }));
    expect(href).toBe('/goals/e-123');
  });

  it('source_entity_id가 없으면 null(다른 타입도 동형)', () => {
    expect(getEntityHref(baseNotification({ source_entity_type: 'epic', source_entity_id: null }))).toBeNull();
  });
});
