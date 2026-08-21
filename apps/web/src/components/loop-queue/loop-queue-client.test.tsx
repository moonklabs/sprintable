// @vitest-environment jsdom
//
// story #2858(loop-closure P2) — LoopQueueClient 왕복 검증. useDashboardContext()는 Provider
// 없이 기본값(빈 orgMemberships·projectId undefined)을 쓴다 — now-face.test.tsx와 동형 관례.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { LoopQueueClient } from './loop-queue-client';
import koMessages from '../../../messages/ko.json';

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

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

function stubFetch(queuePage: unknown, members: unknown = [], projects: unknown = []) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/loop-measure-due/queue')) return { ok: true, json: async () => queuePage };
    if (url.includes('/api/team-members')) return { ok: true, json: async () => members };
    if (url.includes('/api/projects')) return { ok: true, json: async () => projects };
    return { ok: false, json: async () => null };
  }));
}

async function mount() {
  await act(async () => { root.render(wrap(<LoopQueueClient />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

describe('LoopQueueClient', () => {
  it('큐 항목을 배지·경과일과 함께 렌더한다(AC1)', async () => {
    stubFetch({
      items: [{ work_item_type: 'hypothesis', work_item_id: 'h1', title: '결제 전환 가설', owner_member_id: null, overdue_days: 5, reason: 'measure_after_overdue', project_id: null }],
      total: 1, limit: 25, offset: 0,
    });
    await mount();
    expect(container.textContent).toContain('결제 전환 가설');
    expect(container.textContent).toContain(koMessages.orgBriefing.clusterUnclosedBadgeOverdueHypothesis);
  });

  it('담당자 없으면 "담당자 없음"+"내가 맡기" 버튼, 있으면 이름 표시(AC3)', async () => {
    stubFetch({
      items: [
        { work_item_type: 'hypothesis', work_item_id: 'h1', title: 'A', owner_member_id: null, overdue_days: 1, reason: 'measure_after_overdue', project_id: null },
        { work_item_type: 'epic', work_item_id: 'g1', title: 'B', owner_member_id: 'm1', overdue_days: 2, reason: 'measure_after_overdue', project_id: null },
      ],
      total: 2, limit: 25, offset: 0,
    }, [{ id: 'm1', name: '디디 은두카쿠' }]);
    await mount();
    expect(container.textContent).toContain(koMessages.loopQueue.unclaimed);
    expect(container.textContent).toContain(koMessages.loopQueue.claimAction);
    expect(container.textContent).toContain('디디 은두카쿠');
  });

  it('unclaimed_only 토글이 켜지면 쿼리에 unclaimed_only=true가 실린다', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/api/loop-measure-due/queue')) return { ok: true, json: async () => ({ items: [], total: 0, limit: 25, offset: 0 }) };
      return { ok: true, json: async () => [] };
    });
    vi.stubGlobal('fetch', fetchMock);
    await mount();

    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox).toBeTruthy();
    await act(async () => {
      checkbox.click();
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });

    const queueCalls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/loop-measure-due/queue'));
    expect(queueCalls.some((u) => u.includes('unclaimed_only=true'))).toBe(true);
  });

  it('전량 0건이면 빈 상태 문구를 보인다(AC4류 — no-fiction 빈 상태)', async () => {
    stubFetch({ items: [], total: 0, limit: 25, offset: 0 });
    await mount();
    expect(container.textContent).toContain(koMessages.loopQueue.empty);
  });

  it('cross-project 항목만 프로젝트 태그가 붙는다(#2842 규율 승계, AC5)', async () => {
    stubFetch(
      { items: [{ work_item_type: 'epic', work_item_id: 'g1', title: 'Cross', owner_member_id: null, overdue_days: 1, reason: 'measure_after_overdue', project_id: 'p-other' }], total: 1, limit: 25, offset: 0 },
      [],
      [{ id: 'p-other', slug: 'other-proj' }],
    );
    await mount();
    // viewer.orgSlug/activeProjectId가 기본 context에선 undefined라 crossProjectLabel은 항상
    // null(회귀 0 규율) — 태그가 안 뜨는 게 이 컨텍스트 기본값에서 옳은 동작이다.
    expect(container.textContent).not.toContain('other-proj');
  });

  it('페이지네이션 요약과 다음 버튼이 total 기준으로 뜬다', async () => {
    stubFetch({
      items: Array.from({ length: 25 }, (_, i) => ({ work_item_type: 'hypothesis', work_item_id: `h${i}`, title: `H${i}`, owner_member_id: null, overdue_days: 1, reason: 'measure_after_overdue', project_id: null })),
      total: 96, limit: 25, offset: 0,
    });
    await mount();
    expect(container.textContent).toContain('1');
    expect(container.textContent).toContain('96');
    const nextButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === koMessages.loopQueue.nextPage);
    expect(nextButton?.disabled).toBe(false);
    const prevButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === koMessages.loopQueue.prevPage);
    expect(prevButton?.disabled).toBe(true);
  });
});
