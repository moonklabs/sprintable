// @vitest-environment jsdom
//
// story 5e229540(doc resource-view-firsttouch-identity-pattern §4 "스프린트" 행): 빈 목록
// first-touch가 밋밋한 "스프린트가 없습니다." 대신 5요소(아이콘+headline+explainer+기간bar+
// CTA+hint) 정체성 explainer로 렌더되는지, CTA가 기존 생성 폼(setShowCreate)을 재사용하는지,
// 데이터 있으면 완전 무변화인지 왕복 검증한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../../../messages/ko.json';

vi.mock('next/navigation', () => ({
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

function stubFetch(sprints: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('/api/sprints?project_id=')) {
      return { ok: true, json: async () => ({ data: sprints }) };
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
  const { SprintsClient } = await import('./sprints-client');
  await act(async () => { root.render(wrap(<SprintsClient projectId="proj-1" orgId="org-1" />)); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('SprintsClient — 스프린트 first-touch 정체성', () => {
  it('빈 목록이 5요소 explainer(headline+설명+기간bar+CTA+hint)로 렌더된다 — 구 "스프린트가 없습니다." 소거', async () => {
    stubFetch([]);
    await mount();
    const html = container.innerHTML;
    expect(html).toContain('아직 시작한 스프린트가 없어요');
    expect(html).toContain('스프린트는 한 번의 집중 사이클이에요');
    expect(html).toContain('첫 스프린트 시작하기');
    expect(html).toContain('시작할 때 가설 하나만 선언하면 돼요');
    expect(html).not.toContain('스프린트가 없습니다.'); // 구 카피 소거
  });

  it('빈 상태 CTA 클릭 시 기존 생성 폼이 열린다(신규 다이얼로그 없음)', async () => {
    stubFetch([]);
    await mount();
    const ctaButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('첫 스프린트 시작하기'));
    expect(ctaButton).not.toBeUndefined();
    await act(async () => { ctaButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    // 생성 폼 오픈 시 노출되는 필드 라벨로 폼이 실제 열렸는지 확인.
    expect(container.textContent).toContain('스프린트 이름');
  });

  it('스프린트 데이터가 있으면 기존 리스트가 그대로 렌더되고 explainer는 미노출된다(회귀 0)', async () => {
    stubFetch([{ id: 's1', title: 'Sprint 1', status: 'planning', start_date: '2026-07-01', end_date: '2026-07-14' }]);
    await mount();
    const html = container.innerHTML;
    expect(html).toContain('Sprint 1');
    expect(html).not.toContain('아직 시작한 스프린트가 없어요');
    expect(html).not.toContain('첫 스프린트 시작하기');
  });
});
