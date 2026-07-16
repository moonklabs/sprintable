// @vitest-environment jsdom
//
// story 3995840c(doc resource-view-firsttouch-identity-pattern §4 "에픽" 행): 빈 목록
// first-touch가 제네릭 카피 대신 5요소(아이콘+headline+explainer+그룹hint+CTA) 정체성
// explainer로 렌더되는지, 필터 적용 중 결과 0건(진짜 빈 프로젝트 아님)은 별개의 중립 카피를
// 쓰는지(no-fiction), 데이터 있으면 완전 무변화인지 왕복 검증한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('./epics-context', () => ({
  useEpicsRoute: () => ({ wsSlug: 'ws-1', projSlug: 'proj-1' }),
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

function stubFetch(epics: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('/api/epics?')) {
      return { ok: true, json: async () => ({ data: epics }) };
    }
    return { ok: false, json: async () => null };
  }));
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
  vi.resetModules();
});

async function mount() {
  const { EpicsClient } = await import('./epics-client');
  await act(async () => { root.render(wrap(<EpicsClient projectId="proj-1" />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('EpicsClient — 에픽 first-touch 정체성', () => {
  it('진짜 빈 프로젝트(에픽 0건)면 5요소 explainer로 렌더된다 — 구 제네릭 카피 소거', async () => {
    stubFetch([]);
    await mount();
    const html = container.innerHTML;
    expect(html).toContain('아직 시작한 에픽이 없어요');
    expect(html).toContain('에픽은 하나의 큰 목표예요');
    expect(container.querySelectorAll('svg').length).toBeGreaterThan(0); // Flag 아이콘 + 그룹hint
    expect(html).not.toContain('에픽이 없습니다'); // 구 카피(제네릭) 소거
  });

  it('필터로 인한 결과 0건(진짜 빈 프로젝트 아님)은 중립 카피를 쓴다 — "아직 시작 안 함" 오해 방지(no-fiction)', async () => {
    stubFetch([{ id: 'e1', title: 'E-CANVAS', status: 'active', story_count: 3, is_ai_generated: false }]);
    await mount();
    const draftFilterButton = [...container.querySelectorAll('button')].find((b) => b.textContent === 'draft');
    expect(draftFilterButton).not.toBeUndefined();
    await act(async () => { draftFilterButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const html = container.innerHTML;
    expect(html).toContain('이 상태의 에픽이 없습니다.');
    // 정체성 explainer(진짜 빈상태 전용 카피)는 여기 새면 안 됨 — 에픽이 실재하는데 "시작 안 함"은 거짓.
    expect(html).not.toContain('아직 시작한 에픽이 없어요');
  });

  it('데이터 있으면 기존 리스트가 그대로 렌더되고 explainer는 미노출된다(회귀 0)', async () => {
    stubFetch([{ id: 'e1', title: 'E-CANVAS', status: 'active', story_count: 3, is_ai_generated: false }]);
    await mount();
    const html = container.innerHTML;
    expect(html).toContain('E-CANVAS');
    expect(html).not.toContain('아직 시작한 에픽이 없어요');
  });
});
