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
});

function stubFetchByCursor(pages: Record<string, { data: ReturnType<typeof entry>[]; meta: { has_more: boolean; next_cursor: string | null } }>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const cursor = new URL(url, 'http://localhost').searchParams.get('cursor') ?? '__first__';
    const page = pages[cursor] ?? { data: [], meta: { has_more: false, next_cursor: null } };
    return new Response(JSON.stringify(page), { status: 200, headers: { 'content-type': 'application/json' } });
  }));
}

async function renderSection() {
  await act(async () => { root.render(withIntl(<StandupHistorySection projectId="proj-1" />)); });
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

    expect(container.querySelectorAll('[data-slot="badge"]')[0]?.textContent).toBe('1');

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
  });
});
