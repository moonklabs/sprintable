// @vitest-environment jsdom
//
// story #2248 — standup-history-section.tsx의 "더 보기"가 실제로 다음 페이지를 이어 붙이는지
// 검증한다. hasMore=false(음성대조)일 때 버튼 자체가 안 뜨는 것도 함께 확認.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { StandupHistorySection } from './standup-history-section';
import { ORG_NAMES_URL, resetOrgMembersCacheForTests } from '@/hooks/use-member-name-fallback';

// [SID:4300] 기본 org 없음(조직 보충 안 함 — 기존 테스트 그대로). 보충 테스트만 orgId를 채운다.
const dashCtx = vi.hoisted(() => ({ value: {} as { orgId?: string } }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useDashboardContext: () => dashCtx.value }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function withIntl(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

function entry(id: string, date: string) {
  return { id, date, author_id: `member-${id}`, done: `done-${id}`, plan: null, blockers: null };
}

let container: HTMLDivElement;
let root: Root;

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
  dashCtx.value = {};
  resetOrgMembersCacheForTests();
});

function stubFetchByCursor(pages: Record<string, { data: ReturnType<typeof entry>[]; meta: { has_more: boolean; next_cursor: string | null } }>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const cursor = new URL(url, 'http://localhost').searchParams.get('cursor') ?? '__first__';
    const page = pages[cursor] ?? { data: [], meta: { has_more: false, next_cursor: null } };
    return new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
}

async function renderSection() {
  await act(async () => { root.render(withIntl(<StandupHistorySection projectId="proj-1" memberNamesLoaded />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('StandupHistorySection — 더 보기(story #2248)', () => {
  it('has_more:true면 「더 보기」 버튼이 뜬다', async () => {
    stubFetchByCursor({
      __first__: { data: [entry('1', '2026-07-27')], meta: { has_more: true, next_cursor: '2026-07-27T00:00:00Z' } },
    });
    await renderSection();

    const loadMoreBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '더 보기');
    expect(loadMoreBtn).toBeDefined();
  });

  it('음성대조 — has_more:false면 「더 보기」 버튼이 없다', async () => {
    stubFetchByCursor({
      __first__: { data: [entry('1', '2026-07-27')], meta: { has_more: false, next_cursor: null } },
    });
    await renderSection();

    const loadMoreBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '더 보기');
    expect(loadMoreBtn).toBeUndefined();
  });

  it('「더 보기」를 누르면 cursor를 실어 다음 페이지를 이어 붙인다(page1과 다른 행)', async () => {
    stubFetchByCursor({
      __first__: {
        data: [entry('1', '2026-07-27')],
        meta: { has_more: true, next_cursor: '2026-07-27T00:00:00Z' },
      },
      '2026-07-27T00:00:00Z': {
        data: [entry('2', '2026-07-26')],
        meta: { has_more: false, next_cursor: null },
      },
    });
    await renderSection();

    // story #4302 — 더 남았으니 불러온 수는 한계 표기(«1+»).
    expect(container.querySelectorAll('[data-slot="badge"]')[0]?.textContent).toBe('1+');

    const clickLoadMore = async () => {
      const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '더 보기') as HTMLButtonElement;
      await act(async () => { btn.click(); await Promise.resolve(); await Promise.resolve(); });
    };
    await clickLoadMore();

    // 두 날짜(27일·26일) 모두 렌더돼야 한다 — page2가 page1과 다른 행을 반환한 것의 증거.
    expect(container.textContent).toContain('2026-07-27');
    expect(container.textContent).toContain('2026-07-26');
    // 3페이지째 has_more:false라 버튼이 사라진다.
    expect(Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '더 보기')).toBeUndefined();
    // story #4302 — 다 불러왔으면 맨 수(`+` 없음).
    expect(container.querySelectorAll('[data-slot="badge"]')[0]?.textContent).toBe('2');
  });
});

// [SID:4300] 지난 기록 작성자 — 부모 표(활성만)에 없는 작성자(비활성 에이전트의 옛 기록)를 비활성까지 싣는 조직 원천으로 보충.
describe('StandupHistorySection — 작성자 이름 조직 보충([SID:4300])', () => {
  it('부모 표에 없는 작성자 → 조직 원천 이름 · 표에 있는 작성자는 그대로 · 조직에도 없으면 «알 수 없는 구성원»', async () => {
    dashCtx.value = { orgId: 'org-1' };
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      if (url === ORG_NAMES_URL) {
        return new Response(JSON.stringify({ data: [{ id: 'member-2', name: '쉬는봇', type: 'agent' }] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ data: [entry('1', '2026-09-24'), entry('2', '2026-09-23'), entry('3', '2026-09-22')], meta: { has_more: false, next_cursor: null } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    await act(async () => {
      root.render(withIntl(<StandupHistorySection projectId="proj-1" memberNameById={{ 'member-1': '안나' }} memberNamesLoaded />));
    });
    for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const text = container.textContent ?? '';
    expect(text).toContain('안나');
    expect(text).toContain('쉬는봇');
    expect(text).toContain('알 수 없는 구성원');
    expect(calls.filter((u) => u === ORG_NAMES_URL)).toHaveLength(1);
  });
});

// [SID:4300 · PO 06:37Z] 같은 폴백 글자가 서로 다른 작성자 둘 이상에 서면 그 폴백에만 id 앞 8자 꼬리(#4284 · 겹칠 때만).
describe('StandupHistorySection — 겹치는 폴백에만 꼬리([SID:4300])', () => {
  it('명단에 없는 서로 다른 두 작성자 → «알 수 없는 구성원 · member-3» · «… · member-4»', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [entry('1', '2026-09-24'), entry('3', '2026-09-23'), entry('4', '2026-09-22')], meta: { has_more: false, next_cursor: null } }), { status: 200, headers: { 'content-type': 'application/json' } })));
    await act(async () => {
      root.render(withIntl(<StandupHistorySection projectId="proj-1" memberNameById={{ 'member-1': '안나' }} memberNamesLoaded />));
    });
    for (let i = 0; i < 4; i += 1) await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const text = container.textContent ?? '';
    expect(text).toContain('안나');
    expect(text).toContain('알 수 없는 구성원 · member-3');
    expect(text).toContain('알 수 없는 구성원 · member-4');
  });
});

