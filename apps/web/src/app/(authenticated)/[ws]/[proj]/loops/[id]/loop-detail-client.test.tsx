// @vitest-environment jsdom
//
// story #3946(규칙: 「TopBarSlot 제목은 그 화면에 다른 제목이 없을 때만 h1」) — 이 화면은
// 로딩/notFound 분기엔 본문 마스트헤드가 없어 TopBarSlot의 칩 h1이 유일한 h1이고(3946
// AC1 실측), 로디드 분기엔 TopBarSlot이 이미 <button>(뒤로가기)이라 h1이 아니며 본문
// loop.title h1(:170)만 유일하다 — 세 상태 각각 이미 정답이라(과거 결함 0) 가드만 새로
// 둔다. 이 컴포넌트엔 아직 전용 렌더 테스트가 없다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { TopBarProvider, useTopBar } from '@/components/nav/top-bar-context';
import { LoopDetailClient } from './loop-detail-client';
import koMessages from '../../../../../../../messages/ko.json';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));
// ContextPackPanel/VariantGallery는 이 화면의 h1 불변식과 무관한 별도 컴포넌트 몫이라
// (각자 자기 테스트 有) 얕게 스텁 — data 계약이 없는 이 자리에서 그 내부를 재현할
// 이유가 없다.
vi.mock('@/components/loops/context-pack-panel', () => ({ ContextPackPanel: () => null }));
vi.mock('@/components/loops/variant-gallery', () => ({ VariantGallery: () => null }));

const fetchWithAuthMock = vi.fn();
vi.mock('@/lib/db/client', () => ({
  fetchWithAuth: (...args: Parameters<typeof fetchWithAuthMock>) => fetchWithAuthMock(...args),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function TopBarTitleProbe() {
  const { title } = useTopBar();
  return <div>{title}</div>;
}

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      <TopBarProvider>
        <TopBarTitleProbe />
        {node}
      </TopBarProvider>
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetchWithAuthMock.mockReset();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

const LOOP = {
  id: 'loop-1', project_id: 'p1', parent_loop_id: null, hypothesis_id: null,
  brief_doc_id: null, recipe_slug: null, title: '루프A', goal_tags: [], status: 'active',
  outcome_snapshot: null,
};

async function mountProps() {
  await act(async () => {
    root.render(wrap(<LoopDetailClient loopId="loop-1" wsSlug="ws1" projSlug="proj1" projectId="p1" />));
  });
}

describe('LoopDetailClient — 페이지 h1 1개(story #3946)', () => {
  it('⭐로딩 상태에도 h1이 정확히 1개다(TopBarSlot 칩 제목)', async () => {
    fetchWithAuthMock.mockReturnValue(new Promise(() => {}));
    await mountProps();
    expect(container.querySelectorAll('h1')).toHaveLength(1);
  });

  it('⭐notFound 상태에도 h1이 정확히 1개다(TopBarSlot 칩 제목)', async () => {
    fetchWithAuthMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    await mountProps();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(container.querySelectorAll('h1')).toHaveLength(1);
  });

  it('⭐로디드 상태엔 h1이 정확히 1개다(TopBarSlot은 <button>으로 낮아짐, 본문 loop.title만 h1)', async () => {
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/loops/loop-1/artifacts')) return { ok: true, json: async () => [] };
      if (url.includes('/api/me')) return { ok: true, json: async () => ({ data: { type: 'human' } }) };
      if (url.includes('/api/loops/loop-1')) return { ok: true, json: async () => LOOP };
      return { ok: false, status: 404, json: async () => ({}) };
    });
    await mountProps();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    const h1s = [...container.querySelectorAll('h1')];
    expect(h1s).toHaveLength(1);
    expect(h1s[0]!.textContent).toBe('루프A');
    expect(container.querySelector('button')).toBeTruthy();
  });
});
