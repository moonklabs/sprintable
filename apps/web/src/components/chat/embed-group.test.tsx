// @vitest-environment jsdom
//
// story #2905(S2c③④) — EmbedGroup 렌더 회귀가드. delta 시안 §② collapsed/expanded 픽셀
// 대신(HTML 아티팩트 대조는 별건) 구조/문구/카운트 정확성만 잰다: 간결 리스트 3행+더보기·
// gate 헤더 정직 라벨(pending만 vs 「N·대기 M」)·caroulsel(artifact) 항목 수.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { EmbedGroup } from './embed-group';
import type { GateItem } from '@/components/kanban/types';

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => ({ projectMemberships: [] }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function gate(overrides: Partial<GateItem> = {}): GateItem {
  return {
    id: 'g-1', org_id: 'org-1', work_item_id: 'w-1', work_item_type: 'story',
    gate_type: 'merge_gate', status: 'pending', resolver_id: null, resolved_at: null,
    resolution_note: null, neutral_facts: null, created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(), can_approve: true, risk_grade: 'low',
    work_item_summary: { title: '스토리 제목', slug: null },
    ...overrides,
  };
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

const REFS_3 = [
  { entityId: 's-1', label: '스토리 하나' },
  { entityId: 's-2', label: '스토리 둘' },
  { entityId: 's-3', label: '스토리 셋' },
];
const REFS_5 = [...REFS_3, { entityId: 's-4', label: '스토리 넷' }, { entityId: 's-5', label: '스토리 다섯' }];

describe('EmbedGroup — 간결 리스트(story 등 텍스트류)', () => {
  it('3개 이하면 더보기 버튼 없이 전부 보인다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    await act(async () => {
      root.render(<EmbedGroup entityType="story" refs={REFS_3} />);
    });
    expect(container.textContent).toContain('스토리 하나');
    expect(container.textContent).toContain('스토리 셋');
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent?.includes('더보기'))).toBe(false);
  });

  it('5개면 기본 3행만 보이고 「+2 더보기」가 뜬다 — 클릭하면 전체+「접기」로 바뀐다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    await act(async () => {
      root.render(<EmbedGroup entityType="story" refs={REFS_5} />);
    });
    expect(container.textContent).toContain('스토리 하나');
    expect(container.textContent).toContain('스토리 셋');
    expect(container.textContent).not.toContain('스토리 넷');
    const moreBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '+2 더보기');
    expect(moreBtn).toBeTruthy();
    await act(async () => { moreBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container.textContent).toContain('스토리 넷');
    expect(container.textContent).toContain('스토리 다섯');
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === '접기')).toBe(true);
  });
});

describe('EmbedGroup — artifact 캐러셀', () => {
  it('artifact 타입은 가로 스크롤 컨테이너(overflow-x-auto)로 항목 수만큼 렌더된다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    const refs = [{ entityId: 'a-1', label: '목업 하나' }, { entityId: 'a-2', label: '목업 둘' }];
    await act(async () => {
      root.render(<EmbedGroup entityType="artifact" refs={refs} />);
    });
    const scroller = container.querySelector('.overflow-x-auto');
    expect(scroller).toBeTruthy();
    expect(container.textContent).toContain('목업 하나');
    expect(container.textContent).toContain('목업 둘');
  });
});

describe('EmbedGroup — gate 그룹(collapsed/expanded + 헤더 라벨 정직성)', () => {
  it('전부 pending — 「결재 대기 N건」으로 접힌 채 시작한다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/gates/')) return { ok: true, json: async () => ({ data: gate({ status: 'pending' }) }) };
      return { ok: true, json: async () => ({}) };
    }));
    await act(async () => {
      root.render(<EmbedGroup entityType="gate" refs={[{ entityId: 'g-1', label: 'G1' }, { entityId: 'g-2', label: 'G2' }]} />);
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('결재 대기 2건');
    // 접힌 상태 — ApprovalRequestCard(개별 gate fetch로 제목 등을 그리는 카드)의 몸통이 아직 안 보인다.
    expect(container.querySelector('[data-slot="dialog-content"]')).toBeNull();
  });

  it('pending/resolved 섞이면 「결재 N건 · 대기 M건」으로 정직하게 요약한다(pending만 세지 않는다)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/gates/g-1')) return { ok: true, json: async () => ({ data: gate({ id: 'g-1', status: 'pending' }) }) };
      if (url.includes('/api/gates/g-2')) return { ok: true, json: async () => ({ data: gate({ id: 'g-2', status: 'approved' }) }) };
      return { ok: true, json: async () => ({}) };
    }));
    await act(async () => {
      root.render(<EmbedGroup entityType="gate" refs={[{ entityId: 'g-1', label: 'G1' }, { entityId: 'g-2', label: 'G2' }]} />);
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('결재 2건 · 대기 1건');
    expect(container.textContent).not.toContain('결재 대기 2건');
  });

  it('헤더 클릭 시 펼쳐져 각 gate가 ApprovalRequestCard(제목 텍스트)로 뜬다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/gates/g-1')) return { ok: true, json: async () => ({ data: gate({ id: 'g-1', status: 'pending', work_item_summary: { title: '게이트 하나', slug: null } }) }) };
      if (url.includes('/api/gates/g-2')) return { ok: true, json: async () => ({ data: gate({ id: 'g-2', status: 'pending', work_item_summary: { title: '게이트 둘', slug: null } }) }) };
      return { ok: true, json: async () => ({}) };
    }));
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <EmbedGroup entityType="gate" refs={[{ entityId: 'g-1', label: 'G1' }, { entityId: 'g-2', label: 'G2' }]} />
        </NextIntlClientProvider>,
      );
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const headerBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('결재 대기 2건'));
    expect(headerBtn).toBeTruthy();
    await act(async () => { headerBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('게이트 하나');
    expect(container.textContent).toContain('게이트 둘');
  });
});
