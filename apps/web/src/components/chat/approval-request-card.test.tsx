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

  // story #2905(S2c②) — gate 단건 sole-link 참조(chat-bubble.tsx)는 work_item_type/
  // work_item_id를 모르는 채(빈 문자열 placeholder) target을 넘긴다. fetch된 gate 실물이
  // 그 자리를 대신해 카드가 정상 완결되는지(제목 버튼·크래시 없음) 확인.
  it('target.work_item_type/work_item_id가 빈 문자열(placeholder)이어도 fetch된 gate 실물로 정상 완결된다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/gates/')) {
        return { ok: true, json: async () => ({ data: gate({ work_item_type: 'doc', work_item_id: 'wi-9', work_item_summary: { title: '플레이스홀더 대조', slug: null } }) }) };
      }
      return { ok: true, json: async () => ({}) };
    }));
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <ApprovalRequestCard target={{ work_item_type: '', work_item_id: '', gate_id: 'g-1' }} />
        </NextIntlClientProvider>,
      );
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('플레이스홀더 대조');
    const titleButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('플레이스홀더 대조'));
    expect(titleButton).toBeTruthy(); // doc은 canPreviewEntity 통과 — gate 실물 기준으로 진입점이 뜬다.
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

// story #2982(선생님 실사용 리포트, PO 확定 2026-08-24) — 죽은 버튼 클릭~서버 응답 사이 레이스로
// 다른 채널이 먼저 해소한 게이트를 이 챗 카드에서 승인/반려 시도하면 서버가 409로 거부한다.
// AC1(재조회로 죽은 버튼이 다시 안 뜬다)+AC3(인간 문구)를 검증한다.
describe('ApprovalRequestCard — 409(gate_already_resolved) 거부 처리(story #2982)', () => {
  it('AC1·AC3 — 이미 해소된 게이트 승인 시도는 409로 거부되고, 재조회 後 완료 카드+사람 문구로 전환된다', async () => {
    let getCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') {
        return {
          ok: false, status: 409,
          json: async () => ({
            data: null,
            error: { code: 'gate_already_resolved', message: '이미 처리된 결재입니다. 되돌리려면 PO에게 재검토를 요청해주세요.', current_status: 'approved' },
            meta: null,
          }),
        };
      }
      if (url.includes('/api/gates/')) {
        getCount += 1;
        const status = getCount === 1 ? 'pending' : 'approved';
        return { ok: true, json: async () => ({ data: gate({ status, resolver_id: 'member-2', resolved_at: new Date().toISOString() }) }) };
      }
      return { ok: true, json: async () => ({}) };
    }));
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <ApprovalRequestCard target={{ work_item_type: 'story', work_item_id: 'w-1', gate_id: 'g-1', actions: ['approve', 'reject'] }} />
        </NextIntlClientProvider>,
      );
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const approveBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(koMessages.cage.gateApprove));
    await act(async () => { approveBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    // 「완료」 카드로 재조회 後 전환됐다 — 그 자체가 AC3의 명시 안내다(진짜 상태를 정직하게
    // 보여주는 것으로 답이 된다 — 별도 에러 배너를 겹쳐 보이지 않음).
    expect(container.textContent).toContain(koMessages.chats.approvalRequestResolvedStatus.split('{status}')[0]);
    expect(getCount).toBe(2); // 최초 로드(1) + 409 이후 재조회(2) — 화면이 옛 status에 안 멈춘다.
    const buttonsAfter = [...container.querySelectorAll('button')].map((b) => b.textContent);
    expect(buttonsAfter.some((t) => t?.includes(koMessages.cage.gateApprove))).toBe(false);
  });
});
