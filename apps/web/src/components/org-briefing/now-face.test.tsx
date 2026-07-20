// @vitest-environment jsdom
//
// story ded31cb3 — NowFace 왕복 검증: 2 BFF(my-actions·notifications) 조합이 실제로 결정대기/이상신호/
// 완료보고 3종 행으로 렌더되는지, 기본 5+"+N 더" 인라인 펼침이 실제로 동작하는지(정적 캡 아님), 이상
// 신호 카피에 경과시간이 새지 않는지(감시 금지) 왕복 검증한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { NowFace } from './now-face';
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

function stubFetch(myActions: unknown, notifications: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/dashboard/my-actions')) return { ok: true, json: async () => myActions };
    if (url.includes('/api/notifications')) return { ok: true, json: async () => notifications };
    return { ok: false, json: async () => null };
  }));
}

async function mount() {
  await act(async () => { root.render(wrap(<NowFace />)); });
  // flush the Promise.all([...]) microtask chain + resulting setState.
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('NowFace', () => {
  it('renders one row per kind (결정 대기/이상 신호/완료 보고) from the two combined BFFs', async () => {
    stubFetch(
      {
        action_queue: { items: [{ type: 'gate_approval', priority: 'warn', context: { kind: 'canonical' } }] },
        attention: { items: [{ type: 'agent_stuck', entity_type: 'story', entity_id: 's1', gate_type: 'merge' }] },
      },
      { data: [{ id: 'n1', title: 'BE 계약 완료', body: '근거 3건 첨부', href: '/inbox' }] },
    );
    await mount();
    const html = container.innerHTML;
    expect(html).toContain('결정 대기');
    expect(html).toContain('이상 신호');
    expect(html).toContain('완료 보고');
    expect(html).toContain('BE 계약 완료');
    // 까심 REQUEST_CHANGES(#2162 축3) — 이 테스트는 이미 원시 슬러그(context.kind='canonical',
    // gate_type='merge')를 입력으로 제공하는데 그 슬러그가 카피에 안 새는지 확인하는 negative
    // 어서션이 없었다 — 카피 스윕이 decideGateContextKind 분기·{gate} 인터폴레이션을 걷어냈어도
    // 이 테스트 자체는 구버전(슬러그 그대로 노출)이 되돌아와도 계속 PASS하는 공허 통과였다
    // (S2/S3와 동형 클래스). 입력에 실제로 준 슬러그가 렌더 결과에 없다는 걸 여기서 직접 검증한다.
    expect(html).not.toContain('canonical'); // context.kind 슬러그 미노출
    expect(html).not.toContain('merge'); // gate_type 슬러그 미노출
  });

  it('renders the calm empty state ("모두 확인했어요") when both sources are empty — no alarming iconography text', async () => {
    stubFetch(
      { action_queue: { items: [] }, attention: { items: [] } },
      { data: [] },
    );
    await mount();
    expect(container.innerHTML).toContain('모두 확인했어요');
  });

  it('caps at 5 rows by default with a "+N 더" toggle, and clicking it reveals the rest in place (no priority cut, no navigation away)', async () => {
    const items = Array.from({ length: 8 }, (_, i) => ({
      type: 'agent_stuck', entity_type: 'story', entity_id: `s${i}`, gate_type: 'merge',
    }));
    stubFetch(
      { action_queue: { items: [] }, attention: { items } },
      { data: [] },
    );
    await mount();
    const rowsBefore = container.querySelectorAll('a').length;
    expect(rowsBefore).toBe(5);
    expect(container.innerHTML).toContain('3개 더 보기');

    const moreButton = container.querySelector('button');
    expect(moreButton).toBeTruthy();
    await act(async () => { moreButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const rowsAfter = container.querySelectorAll('a').length;
    expect(rowsAfter).toBe(8);
    expect(container.innerHTML).not.toContain('3개 더 보기');
  });

  it('never leaks raw elapsed-time digits into the anomaly row copy (surveillance framing ban)', async () => {
    stubFetch(
      { action_queue: { items: [] }, attention: { items: [{ type: 'story_stalled', entity_type: null, entity_id: 's1', gate_type: null }] } },
      { data: [] },
    );
    await mount();
    expect(container.innerHTML).not.toMatch(/\d+\s*(분|시간|일)(?!건)/);
  });

  it('story 64b9a879 — "지금" hero 뱃지가 타이틀 옆에 렌더된다(정보 위계 강조)', async () => {
    stubFetch({ action_queue: { items: [] }, attention: { items: [] } }, { data: [] });
    await mount();
    const badge = [...container.querySelectorAll('span')].find((s) => s.textContent === '지금');
    expect(badge).not.toBeUndefined();
  });
});
