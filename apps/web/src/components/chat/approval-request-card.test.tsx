// @vitest-environment jsdom
//
// story #2118(E-DG-REAL) — ApprovalRequestCard가 doc 전용이던 제목 미리보기 진입점을 전
// work_item_type으로 넓혔다. gate_service.py의 "visual_artifact"가 embed-card.tsx의
// entity_type 어휘("artifact")와 갈리는 지점을 toEntityType()으로 변환하는데, 이 변환을
// 놓치면 visual_artifact 게이트만 조용히 제네릭 아이콘/미리보기 없음으로 떨어진다 —
// pure function 대조 + 실 마운트(비-doc 타입도 미리보기 진입점이 뜨는지)로 회귀가드한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ApprovalRequestCard, toEntityType } from './approval-request-card';
import type { GateItem } from '@/components/kanban/types';

describe('toEntityType (story #2118) — Gate.work_item_type ↔ entity_type 어휘 변환', () => {
  it('visual_artifact → artifact(embed-card.tsx 어휘로 변환)', () => {
    expect(toEntityType('visual_artifact')).toBe('artifact');
  });

  it('동일 문자열인 타입(story/doc/task/epic/sprint/hypothesis)은 그대로 통과', () => {
    for (const t of ['story', 'doc', 'task', 'epic', 'sprint', 'hypothesis']) {
      expect(toEntityType(t)).toBe(t);
    }
  });

  it('entity 계열에 없는 타입(loop)도 그대로 흘려보낸다(크래시 없이 하위에서 폴백)', () => {
    expect(toEntityType('loop')).toBe('loop');
  });
});

const useDashboardContextMock = vi.fn();
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => useDashboardContextMock(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

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
  useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'member-1' });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function mount(gateData: GateItem) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/api/gates/')) return { ok: true, json: async () => ({ data: gateData }) };
    return { ok: true, json: async () => ({}) };
  }));
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <ApprovalRequestCard target={{ work_item_type: gateData.work_item_type, work_item_id: gateData.work_item_id, gate_id: gateData.id, actions: ['approve', 'reject'] }} />
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

// story #2118(페드루 리뷰) — "폴백이 정직하다"(크래시 안 남)는 "클릭에 값이 있다"는 뜻이
// 아니다. RICH_PREVIEW/ENTITY_API fetch 전략/own-href 셋 다 없는 타입(loop·wf_line_version)은
// 진입점 자체가 없어야 한다(story #2118 P2.2 AC④ 판정과 동형) — 값 있는 타입(story/task/
// visual_artifact)은 버튼, 값 없는 타입은 기존 평문 <p>로 짝을 이뤄 검증한다.
describe('ApprovalRequestCard — 제목 미리보기 진입점, canPreviewEntity로 값 있는 타입만(story #2118)', () => {
  it.each([
    ['story', '스토리 제목'],
    ['task', '태스크 제목'],
    ['visual_artifact', '비주얼 아티팩트'],
  ])('work_item_type=%s — 미리보기 진입점(제목 버튼)이 뜬다', async (workItemType, title) => {
    await mount(gate({ work_item_type: workItemType, work_item_id: 'w-1', work_item_summary: { title, slug: null } }));
    const titleButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(title));
    expect(titleButton).toBeTruthy();
  });

  it('visual_artifact 클릭 시 크래시 없이 모달이 연다(toEntityType 변환 실사용 경로)', async () => {
    await mount(gate({ work_item_type: 'visual_artifact', work_item_id: 'artifact-1', work_item_summary: { title: '비주얼 아티팩트', slug: null } }));
    const titleButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('비주얼 아티팩트'));
    await act(async () => { titleButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(document.body.querySelector('[data-slot="dialog-content"]')).toBeTruthy();
  });

  it.each([
    ['loop', '루프 제목'],
    ['wf_line_version', '워크플로 버전'],
  ])('work_item_type=%s — RICH_PREVIEW/fetch전략/own-href 셋 다 없어 진입점(버튼) 없이 평문으로만 뜬다', async (workItemType, title) => {
    await mount(gate({ work_item_type: workItemType, work_item_id: 'w-1', work_item_summary: { title, slug: null } }));
    const titleButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(title));
    expect(titleButton).toBeFalsy();
    expect(container.textContent).toContain(title);
  });
});
