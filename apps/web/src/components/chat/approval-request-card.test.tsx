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
import { ReadingPanelProvider } from '@/components/chat/reading-panel-context';

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

// story #2985 AC2 — useSseMultiplexerContext() 훅 자체를 모킹해 subscribe 핸들러를 테스트가
// 직접 잡아 fire할 수 있게 한다(RealtimeProvider+실 EventSource 전체를 띄우는 무거운 경로
// 대신, use-team-presence.test.tsx와 다른 더 가벼운 단위테스트 전략).
const muxSubscribeMock = vi.fn((_eventName: string, _handler: (raw: string, eventId?: string) => void) => () => {});
vi.mock('@/components/realtime-provider', () => ({
  useSseMultiplexerContext: () => ({ subscribe: muxSubscribeMock }),
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
  muxSubscribeMock.mockClear();
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

// story #461e9a54(P0) — 채팅 컨텍스트(ReadingPanelProvider 하위)에서는 제목 클릭이 Dialog
// 모달이 아니라 우측 ReadingPanel을 연다. approvals-queue.tsx(인박스, 채팅 밖)는 Provider가
// 없어 기존 Dialog 모달 그대로(위 "visual_artifact 클릭 시... 모달이 연다" 테스트가 이미
// 그 폴백을 고정한다 — 회귀 0).
describe('ApprovalRequestCard — story #461e9a54 ReadingPanel 라우팅(채팅 컨텍스트)', () => {
  it('ReadingPanelProvider 하위에서 제목 클릭 시 open()이 정확한 target으로 불리고, Dialog는 안 뜬다', async () => {
    const open = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/gates/')) {
        return { ok: true, json: async () => ({ data: gate({ work_item_type: 'story', work_item_id: 'story-9', work_item_summary: { title: '패널 라우팅 대조', slug: null } }) }) };
      }
      return { ok: true, json: async () => ({}) };
    }));
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <ReadingPanelProvider value={{ open, close: vi.fn(), navigateTo: vi.fn() }}>
            <ApprovalRequestCard target={{ work_item_type: 'story', work_item_id: 'story-9', gate_id: 'g-panel' }} />
          </ReadingPanelProvider>
        </NextIntlClientProvider>,
      );
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const titleButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('패널 라우팅 대조'));
    await act(async () => { titleButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ kind: 'entity', entityType: 'story', entityId: 'story-9', title: '패널 라우팅 대조' }));
    expect(document.body.querySelector('[data-slot="dialog-content"]')).toBeNull();
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

describe('ApprovalRequestCard — 실시간 해소 반영(story #2985 AC2)', () => {
  it('mux가 conversation.gate_resolved(같은 gate_id)를 쏘면 fetchGate가 재호출된다', async () => {
    let getCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/gates/')) {
        getCount += 1;
        return { ok: true, json: async () => ({ data: gate({ status: 'pending' }) }) };
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
    expect(getCount).toBe(1); // 마운트 1회 fetch.

    // 카드가 실제로 'conversation.gate_resolved'로 구독했는지 + 그 핸들러를 잡아 직접 fire.
    const call = muxSubscribeMock.mock.calls.find(([eventName]) => eventName === 'conversation.gate_resolved');
    expect(call).toBeTruthy();
    const handler = call![1] as (raw: string, eventId?: string) => void;
    await act(async () => { handler(JSON.stringify({ gate_id: 'g-1', status: 'approved' })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(getCount).toBe(2); // 새로고침 없이 재조회.
  });

  it('다른 gate_id의 이벤트는 무시한다(내 카드가 아닌 해소로 불필요 재조회 안 함)', async () => {
    let getCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/gates/')) {
        getCount += 1;
        return { ok: true, json: async () => ({ data: gate({ status: 'pending' }) }) };
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
    expect(getCount).toBe(1);

    const call = muxSubscribeMock.mock.calls.find(([eventName]) => eventName === 'conversation.gate_resolved');
    const handler = call![1] as (raw: string, eventId?: string) => void;
    await act(async () => { handler(JSON.stringify({ gate_id: 'other-gate', status: 'approved' })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(getCount).toBe(1); // 무관한 게이트 — 재조회 안 함.
  });

  it('malformed payload는 크래시 없이 무시한다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/gates/')) return { ok: true, json: async () => ({ data: gate({ status: 'pending' }) }) };
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

    const call = muxSubscribeMock.mock.calls.find(([eventName]) => eventName === 'conversation.gate_resolved');
    const handler = call![1] as (raw: string, eventId?: string) => void;
    expect(() => handler('not-json{')).not.toThrow();
  });
});

describe('ApprovalRequestCard — 결재선 위임(story #3001, 선생님 정책 확定)', () => {
  async function mountWithDesignated(designatedApproverId: string | null | undefined) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/gates/')) {
        return { ok: true, json: async () => ({ data: gate({ status: 'pending', designated_approver_id: designatedApproverId ?? null }) }) };
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
  }

  it('내가 지정 결재자다(designated_approver_id===currentTeamMemberId) — 액션+「위임」트리거 둘 다 뜬다', async () => {
    await mountWithDesignated('member-1');
    const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons.some((t) => t?.includes(koMessages.cage.gateApprove))).toBe(true);
    expect(buttons.some((t) => t?.includes(koMessages.chats.approvalRequestDelegate))).toBe(true);
  });

  it('다른 사람에게 위임됨(designated_approver_id!==currentTeamMemberId) — 액션·위임 버튼 없이 "위임됨" 문구만', async () => {
    await mountWithDesignated('member-2');
    const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons.some((t) => t?.includes(koMessages.cage.gateApprove))).toBe(false);
    expect(buttons.some((t) => t?.includes(koMessages.chats.approvalRequestDelegate))).toBe(false);
    expect(container.textContent).toContain(koMessages.chats.approvalRequestDelegatedAway);
  });

  it('미지정(broadcast, designated_approver_id=null) — 액션은 뜨되 위임 버튼은 없다(회귀 0)', async () => {
    await mountWithDesignated(null);
    const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons.some((t) => t?.includes(koMessages.cage.gateApprove))).toBe(true);
    expect(buttons.some((t) => t?.includes(koMessages.chats.approvalRequestDelegate))).toBe(false);
    expect(container.textContent).not.toContain(koMessages.chats.approvalRequestDelegatedAway);
  });

  it('mux가 conversation.gate_delegated(같은 gate_id)를 쏘면 fetchGate가 재호출된다', async () => {
    let getCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/gates/')) {
        getCount += 1;
        return { ok: true, json: async () => ({ data: gate({ status: 'pending', designated_approver_id: 'member-2' }) }) };
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
    expect(getCount).toBe(1);

    const call = muxSubscribeMock.mock.calls.find(([eventName]) => eventName === 'conversation.gate_delegated');
    expect(call).toBeTruthy();
    const handler = call![1] as (raw: string, eventId?: string) => void;
    await act(async () => { handler(JSON.stringify({ gate_id: 'g-1', new_approver_id: 'member-3' })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(getCount).toBe(2);
  });

  it('「위임」 클릭 시 /api/org-members를 불러와 owner/admin·본인 제외로 좁힌 피커를 연다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/org-members')) {
        return {
          ok: true,
          json: async () => ({
            data: [
              { id: 'member-1', user_id: 'u-1', name: '나', role: 'owner' }, // 본인 — 제외돼야
              { id: 'member-2', user_id: 'u-2', name: '올리베이라군', role: 'admin' },
              { id: 'member-3', user_id: 'u-3', name: '멤버', role: 'member' }, // member — 제외돼야
            ],
          }),
        };
      }
      if (url.includes('/api/gates/')) return { ok: true, json: async () => ({ data: gate({ status: 'pending', designated_approver_id: 'member-1' }) }) };
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

    const delegateBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes(koMessages.chats.approvalRequestDelegate),
    );
    await act(async () => { delegateBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    // 취소 버튼이 뜬 것 자체가 피커가 열렸다는 증거(fetch 완료 後 로딩 placeholder→선택 UI 전환).
    const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons.some((t) => t?.includes(koMessages.chats.approvalRequestDelegateCancel))).toBe(true);
  });

  // story #3040 v3(선생님 확定, 2026-08-25) — 동명 표시이름 오지정 실사고(선생님 실계정 vs
  // PO 대행 계정, 둘 다 "송윤재") 재발 방지. AC2 — 동명 실재 시에만 경고.
  async function renderDelegatePickerWithOrgMembers(members: Array<{ id: string; user_id: string; name: string; role: string }>) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/org-members')) return { ok: true, json: async () => ({ data: members }) };
      if (url.includes('/api/gates/')) return { ok: true, json: async () => ({ data: gate({ status: 'pending', designated_approver_id: 'member-1' }) }) };
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

    const delegateBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes(koMessages.chats.approvalRequestDelegate),
    );
    await act(async () => { delegateBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  }

  it('실사고 재현 — 위임 대상 후보군에 동명 2계정(선생님 실계정 vs PO 대행 계정)이 있으면 경고가 뜬다', async () => {
    await renderDelegatePickerWithOrgMembers([
      { id: 'member-1', user_id: 'u-1', name: '나', role: 'owner' },
      { id: 'e75ca548', user_id: 'aac01791', name: '송윤재', role: 'owner' },
      { id: '2fd14616', user_id: 'd3ed4ed8', name: '송윤재', role: 'admin' },
    ]);
    expect(container.textContent).toContain(koMessages.chats.approvalRequestDelegateDuplicateWarning);
  });

  it('음성대조 — 동명이 없는 org는 경고가 안 뜬다', async () => {
    await renderDelegatePickerWithOrgMembers([
      { id: 'member-1', user_id: 'u-1', name: '나', role: 'owner' },
      { id: 'member-2', user_id: 'u-2', name: '올리베이라군', role: 'admin' },
    ]);
    expect(container.textContent).not.toContain(koMessages.chats.approvalRequestDelegateDuplicateWarning);
  });

  // story #3231 2라운드(카디르 QA) — /api/org-members가 admin 전용 403으로 잠기면서
  // 이 위임 픽커가 doc-gate-section.tsx와 동일하게 후보 0명으로 파손됐다. 전용
  // 엔드포인트(/api/org-members/eligible-approvers)로 교체 + res.ok 미확인(403이어도
  // 조용히 빈 배열로 저하되던 결함)도 같이 고쳤다.
  it('전용 eligible-approvers 엔드포인트를 호출한다(원 roster 엔드포인트 아님)', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes('/api/org-members')) {
        return { ok: true, json: async () => ({ data: [{ id: 'member-2', user_id: 'u-2', name: '올리베이라군', role: 'admin' }] }) };
      }
      if (url.includes('/api/gates/')) return { ok: true, json: async () => ({ data: gate({ status: 'pending', designated_approver_id: 'member-1' }) }) };
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
    const delegateBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes(koMessages.chats.approvalRequestDelegate),
    );
    await act(async () => { delegateBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(calls.some((u) => u.includes('/api/org-members/eligible-approvers'))).toBe(true);
  });

  it('403(res.ok=false) — 조용히 빈 배열로 저하되지 않고 에러 문구가 뜬다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/org-members')) return { ok: false, status: 403, json: async () => ({ error: { code: 'FORBIDDEN' } }) };
      if (url.includes('/api/gates/')) return { ok: true, json: async () => ({ data: gate({ status: 'pending', designated_approver_id: 'member-1' }) }) };
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
    const delegateBtn = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent?.includes(koMessages.chats.approvalRequestDelegate),
    );
    await act(async () => { delegateBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(container.textContent).toContain(koMessages.chats.hitlSendFailed);
  });
});

// story #3084(2026-08-25, 유나 픽셀 규격 부록A — 상태 파생표) — 카드 5상태 중 pending 3분기
// (designated/requester/관찰자)의 FE 분기. requesterId는 gate.neutral_facts.
// requested_by_member_id에서 온다(BE #3084 doc 그라운딩 — merge/story/doc/loop 게이트 공용
// 관례, gates.py can_approve_doc_gate_reason과 동일 소스).
describe('ApprovalRequestCard — 토스(story #3084) pending 3분기 + 토스 트리거', () => {
  async function mountWithRoles(designatedApproverId: string | null, requesterId: string | null) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/gates/')) {
        return {
          ok: true,
          json: async () => ({
            data: gate({
              status: 'pending',
              designated_approver_id: designatedApproverId,
              neutral_facts: requesterId ? { requested_by_member_id: requesterId } : null,
            }),
          }),
        };
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
  }

  it('대기·designated — 승인/반려 버튼 + 토스 트리거(⋯)가 뜬다', async () => {
    await mountWithRoles('member-1', 'member-2');
    const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons.some((t) => t?.includes(koMessages.cage.gateApprove))).toBe(true);
    expect(buttons.some((t) => t?.includes(koMessages.chats.approvalRequestTossTrigger))).toBe(true);
  });

  it('대기·requester — 승인/반려는 없고, 「대기 중」 문구 + 토스 버튼만 뜬다', async () => {
    await mountWithRoles('member-2', 'member-1');
    const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons.some((t) => t?.includes(koMessages.cage.gateApprove))).toBe(false);
    expect(buttons.some((t) => t?.includes(koMessages.chats.approvalRequestTossTrigger))).toBe(true);
    expect(container.textContent).toContain('결재를 기다리는 중');
    expect(container.textContent).not.toContain(koMessages.chats.approvalRequestDelegatedAway);
  });

  it('대기·관찰자(requester도 designated도 아님) — 「대기 중」 문구만, 토스·승인 버튼 없음', async () => {
    await mountWithRoles('member-2', 'member-3');
    const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons.some((t) => t?.includes(koMessages.cage.gateApprove))).toBe(false);
    expect(buttons.some((t) => t?.includes(koMessages.chats.approvalRequestTossTrigger))).toBe(false);
    expect(container.textContent).toContain('결재를 기다리는 중');
    // 진짜 위임(#3001)이 아니므로 "위임됨" 문구는 부정확 — 안 뜬다.
    expect(container.textContent).not.toContain(koMessages.chats.approvalRequestDelegatedAway);
  });

  it('requesterId를 모르는(legacy) 게이트는 기존 「위임됨」 문구로 안전 폴백한다(회귀 0)', async () => {
    await mountWithRoles('member-2', null);
    expect(container.textContent).toContain(koMessages.chats.approvalRequestDelegatedAway);
  });

  it('토스 트리거 클릭 시 토스 시트가 열린다(projectId 있을 때)', async () => {
    useDashboardContextMock.mockReturnValue({ currentTeamMemberId: 'member-1', projectId: 'proj-1' });
    await mountWithRoles('member-1', 'member-2');
    const tossBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(koMessages.chats.approvalRequestTossTrigger));
    await act(async () => { tossBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(document.body.textContent).toContain(koMessages.chats.approvalRequestTossSheetTitle);
  });

  it('「남이 처리」 — 처리자 이름이 붙는다(gateDetailResolvedByStatus 재사용)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/team-members')) {
        return { ok: true, json: async () => ({ data: [{ id: 'member-9', name: '올리베이라군' }] }) };
      }
      if (url.includes('/api/gates/')) {
        return { ok: true, json: async () => ({ data: gate({ status: 'approved', resolver_id: 'member-9' }) }) };
      }
      return { ok: true, json: async () => ({}) };
    }));
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <ApprovalRequestCard target={{ work_item_type: 'story', work_item_id: 'w-1', gate_id: 'g-1' }} />
        </NextIntlClientProvider>,
      );
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('올리베이라군');
  });

  it('「내가 처리」 — 처리자 이름 줄이 안 붙는다(자명하므로)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/gates/')) {
        return { ok: true, json: async () => ({ data: gate({ status: 'approved', resolver_id: 'member-1' }) }) };
      }
      return { ok: true, json: async () => ({}) };
    }));
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <ApprovalRequestCard target={{ work_item_type: 'story', work_item_id: 'w-1', gate_id: 'g-1' }} />
        </NextIntlClientProvider>,
      );
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).not.toContain('님이 처리');
  });

  it('mux가 conversation.gate_tossed(같은 gate_id)를 쏘면 fetchGate가 재호출된다', async () => {
    let getCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/gates/')) {
        getCount += 1;
        return { ok: true, json: async () => ({ data: gate({ status: 'pending' }) }) };
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
    expect(getCount).toBe(1);

    const call = muxSubscribeMock.mock.calls.find(([eventName]) => eventName === 'conversation.gate_tossed');
    expect(call).toBeTruthy();
    const handler = call![1] as (raw: string, eventId?: string) => void;
    await act(async () => { handler(JSON.stringify({ gate_id: 'g-1', target_conversation_id: 'conv-9' })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(getCount).toBe(2);
  });
});

// story #3151(선생님 실기기 발견) — agent_decision 결재 카드가 「결재 대기 / #해시 / 버튼」만
// 보이고 결정 재료(질문·선택지·요청자)가 전무했다. neutral_facts.question/options/assumption
// (backend/app/routers/gates.py::DecisionRequestCreate)을 카드가 한 번도 안 읽던 것이 원인.
describe('ApprovalRequestCard — story #3151 agent_decision 결정 재료(질문·선택지·전제·요청자)', () => {
  async function mountDecision(neutralFacts: Record<string, unknown> | null, statusOverrides: Partial<GateItem> = {}) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/team-members')) {
        return { ok: true, json: async () => ({ data: [{ id: 'member-7', name: '페드루 올리베이라' }] }) };
      }
      if (url.includes('/api/gates/')) {
        return {
          ok: true,
          json: async () => ({
            data: gate({
              work_item_type: 'agent_decision', work_item_summary: null, neutral_facts: neutralFacts,
              ...statusOverrides,
            }),
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    }));
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <ApprovalRequestCard target={{ work_item_type: 'agent_decision', work_item_id: 'w-1', gate_id: 'g-1', actions: ['approve', 'reject'] }} />
        </NextIntlClientProvider>,
      );
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  }

  it('질문 전문+선택지+전제+요청자 전부 렌더된다 — 「#해시」뿐이던 회귀가드', async () => {
    await mountDecision({
      question: 'A/B 실험을 새 알고리즘으로 즉시 전환할까요, 아니면 1주 더 관찰할까요?',
      options: ['즉시 전환', '1주 더 관찰'],
      assumption: '현재 표본 수가 유의성 판정에 충분하지 않을 수 있음',
      requested_by_member_id: 'member-7',
    });
    expect(container.textContent).toContain('A/B 실험을 새 알고리즘으로 즉시 전환할까요, 아니면 1주 더 관찰할까요?');
    expect(container.textContent).toContain('즉시 전환');
    expect(container.textContent).toContain('1주 더 관찰');
    expect(container.textContent).toContain('현재 표본 수가 유의성 판정에 충분하지 않을 수 있음');
    expect(container.textContent).toContain('페드루 올리베이라');
  });

  it('options 없으면 선택지 목록 자체가 안 뜬다(no-fiction — 지어내지 않음)', async () => {
    await mountDecision({ question: '이대로 진행해도 될까요?', assumption: null, requested_by_member_id: null });
    expect(container.textContent).toContain('이대로 진행해도 될까요?');
    expect(container.querySelector('ul')).toBeNull();
  });

  it('question이 없으면(비-agent_decision 등 재료 자체가 없는 케이스) 결정 재료 블록이 통째로 생략된다', async () => {
    await mountDecision(null);
    expect(container.querySelector('ul')).toBeNull();
    // 기존 「#해시」 폴백 자체는 이 스토리의 스코프 밖(work_item_summary 없는 agent_decision의
    // claim 표기는 BE에 대응 엔티티가 없어 불가피 — 이 스토리는 그 아래 결정 재료를 채운다).
  });

  it('resolved(회신) 상태에서도 결정 재료가 그대로 보인다(뷰어 역할·상태와 무관 — AC1)', async () => {
    await mountDecision(
      { question: '배포를 지금 진행할까요?', options: ['진행', '보류'], requested_by_member_id: 'member-7' },
      { status: 'approved', resolver_id: 'member-1' },
    );
    expect(container.textContent).toContain('배포를 지금 진행할까요?');
    expect(container.textContent).toContain('진행');
  });

  it('기존 액션 버튼(승인/반려)은 결정 재료 블록 추가 후에도 회귀 없이 그대로 뜬다', async () => {
    await mountDecision({ question: '진행할까요?', options: ['예', '아니오'] });
    const buttons = Array.from(container.querySelectorAll('button')).map((b) => b.textContent);
    expect(buttons.some((t) => t?.includes(koMessages.cage.gateApprove))).toBe(true);
  });
});

// story #3263(지원v1·5에스컬레이션) AC1 — 페드루 PO 조건② "카드 본문에 요약·org·reason이
// 실물로 실려야"(스텁 금지). docSummary/decisionQuestion과 동일 회귀가드 패턴 — no-fiction
// (neutral_facts에 실린 값만 그대로).
describe('ApprovalRequestCard — story #3263 support_escalation 카드 본문(요약·org·reason)', () => {
  async function mountEscalation(neutralFacts: Record<string, unknown> | null) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/team-members')) {
        return { ok: true, json: async () => ({ data: [] }) };
      }
      if (url.includes('/api/gates/')) {
        return {
          ok: true,
          json: async () => ({
            data: gate({ work_item_type: 'support_escalation', work_item_summary: null, neutral_facts: neutralFacts }),
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    }));
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <ApprovalRequestCard target={{ work_item_type: 'support_escalation', work_item_id: 'w-1', gate_id: 'g-1', actions: ['approve', 'reject'] }} />
        </NextIntlClientProvider>,
      );
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  }

  it('org명·reason·detail·conversation_summary 전부 실물로 렌더된다 — "가서 보라" 스텁 회귀가드', async () => {
    await mountEscalation({
      support_escalation_id: 'esc-123',
      customer_org_name: '고객사 A',
      reason: 'classifier',
      detail: '인입 분류기가 사람 필요로 판정',
      conversation_summary: '고객: 결제가 안 돼요\n에이전트: 담당자에게 연결해 드릴게요',
    });
    expect(container.textContent).toContain('고객사 A');
    expect(container.textContent).toContain('classifier');
    expect(container.textContent).toContain('인입 분류기가 사람 필요로 판정');
    expect(container.textContent).toContain('고객: 결제가 안 돼요');
    // 페드루 PO 확定 — escalation_id는 상세추적용, 사람이 읽는 카드 본문엔 안 보인다.
    expect(container.textContent).not.toContain('esc-123');
  });

  it('neutral_facts가 없으면(비-support_escalation 등) 블록 자체가 안 뜬다(no-fiction)', async () => {
    await mountEscalation(null);
    expect(container.textContent).not.toContain('고객사');
  });

  it('resolved(회신) 상태에서도 카드 본문이 그대로 보인다(docSummary·decisionQuestion과 동일 계약)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/api/team-members')) return { ok: true, json: async () => ({ data: [] }) };
      if (url.includes('/api/gates/')) {
        return {
          ok: true,
          json: async () => ({
            data: gate({
              work_item_type: 'support_escalation', work_item_summary: null, status: 'approved', resolver_id: 'member-1',
              neutral_facts: { customer_org_name: '고객사 B', reason: 'cost_cap', detail: 'd', conversation_summary: 's' },
            }),
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    }));
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <ApprovalRequestCard target={{ work_item_type: 'support_escalation', work_item_id: 'w-1', gate_id: 'g-1', actions: ['approve', 'reject'] }} />
        </NextIntlClientProvider>,
      );
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('고객사 B');
  });
});

// story #5ace2e84 — 채팅 결재카드 N+1 처방. chat-view.tsx가 대화 단위로 배치조회한 gate를
// gateByKey 맵으로 물려받으면 이 카드는 독립 GET /api/gates/{id}를 안 태워야 한다(PO
// 실측: 대화 진입당 최대 51발 N+1의 직접 원인). use-gate-batch.ts는 별도 단위테스트로
// 순수함수(collectUnrequestedGateIds)를 커버하므로, 여기서는 소비부(카드)가 gateByKey를
// 실제로 존중하는지만 값으로 단언한다.
//
// ⚠️2026-08-28 라이브 재측(AC4)에서 구판(단건 initialGate lookup)의 첫 마운트 레이스를
// 실측으로 적발했다 — 자식(카드) effect가 부모(useGateBatchFetch) effect보다 먼저 돌아,
// 맵이 아직 `{}`인 첫 렌더에 모든 카드가 "커버 안 됨"으로 오판해 개별 fetchGate()를 전원
// 발사했다(대화당 여전히 ~50발, 배치 자체는 정확히 1콜로 묶였는데도). 아래 두 번째 테스트
// (`gateByKey={{}}`)가 바로 그 레이스의 회귀가드 — 맵 객체가 정의돼 있으면(빈 값이라도)
// 항목이 아직 없어도 기다려야 한다.
describe('ApprovalRequestCard — gateByKey 배치조회 소비(story #5ace2e84)', () => {
  it('gateByKey에 이 gate_id가 {kind:ready}로 있으면 독립 fetchGate()를 안 태우고 그 값으로 바로 렌더된다', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    const gateData = gate({ work_item_summary: { title: '배치조회 대조', slug: null } });
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <ApprovalRequestCard
            target={{ work_item_type: gateData.work_item_type, work_item_id: gateData.work_item_id, gate_id: gateData.id, actions: ['approve', 'reject'] }}
            gateByKey={{ [gateData.id]: { kind: 'ready', gate: gateData } }}
          />
        </NextIntlClientProvider>,
      );
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('배치조회 대조');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('«첫 마운트 레이스» 회귀가드 — gateByKey={{}}(맵은 있으나 이 gate_id 항목이 아직 없음)여도 독립 fetchGate()를 안 태운다', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <ApprovalRequestCard
            target={{ work_item_type: 'story', work_item_id: 'w-1', gate_id: 'g-1', actions: ['approve', 'reject'] }}
            gateByKey={{}}
          />
        </NextIntlClientProvider>,
      );
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('gateByKey에 이 gate_id가 {kind:loading}으로 있으면(배치 진행 중) 완료를 기다리고 독립 fetchGate()도 안 태운다', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <ApprovalRequestCard
            target={{ work_item_type: 'story', work_item_id: 'w-1', gate_id: 'g-1', actions: ['approve', 'reject'] }}
            gateByKey={{ 'g-1': { kind: 'loading' } }}
          />
        </NextIntlClientProvider>,
      );
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('gateByKey 자체가 미지정(배치 컨텍스트 없음 — approvals-queue.tsx 등)이면 기존처럼 개별 fetchGate()로 폴백한다(회귀 0)', async () => {
    const gateData = gate({ work_item_summary: { title: '개별폴백 대조', slug: null } });
    await mount(gateData);
    expect(container.textContent).toContain('개별폴백 대조');
  });
});

// story #3258(customer-zero 2차) — 결재 카드가 채팅에 «스텁»으로만 게시되던 결함(선생님
// 실사용 v0.1/v0.2 Blueprint 결재 왕복). BE(doc.py transition_doc)가 이미 심어주는
// gate.neutral_facts.doc_summary/doc_diff와 request_gate_discussion()의
// discussion_requested를 이 카드가 실제로 읽어 렌더하는지 검증한다.
describe('ApprovalRequestCard — story #3258 doc 요약/diff+논의요청 지속 배너(customer-zero 2차)', () => {
  it('AC1 — doc 결재 카드는 gate.neutral_facts.doc_summary를 그대로 본문에 싣는다(채팅 밖 안 나가고 결정)', async () => {
    const gateData = gate({
      work_item_type: 'doc', work_item_summary: { title: 'Blueprint v0.1', slug: 'bp' },
      neutral_facts: { doc_summary: '제목 본문은 굵게와 링크를 포함한다.' },
    });
    await mount(gateData);
    expect(container.textContent).toContain('제목 본문은 굵게와 링크를 포함한다.');
  });

  it('doc_summary가 없으면(비-doc 타입 등) 요약 블록 자체가 생략된다(no-fiction)', async () => {
    const gateData = gate({ work_item_type: 'story', neutral_facts: null });
    await mount(gateData);
    expect(container.textContent).not.toContain('undefined');
  });

  it('AC4 — 재상신 카드는 gate.neutral_facts.doc_diff를 ProofCapsule evidence.diff로 노출한다(사본 분화 금지)', async () => {
    const gateData = gate({
      work_item_type: 'doc', work_item_summary: { title: 'Blueprint v0.2', slug: 'bp' },
      neutral_facts: { doc_summary: '개정본', doc_diff: { add: 2, del: 1 } },
    });
    await mount(gateData);
    expect(container.textContent).toContain('+2');
  });

  it('AC3 — discussion_requested가 있으면 pending 동안 지속 배너로 사유가 남는다(3연발 클릭의 근본 처방)', async () => {
    const gateData = gate({
      neutral_facts: {
        discussion_requested: { reason: '예산 재확인 필요', requested_by_member_id: 'member-1', requested_at: new Date().toISOString() },
      },
    });
    await mount(gateData);
    expect(container.textContent).toContain('예산 재확인 필요');
  });

  it('AC3 — 논의 요청 성공 시 토스트가 뜨고, 재조회된 gate의 discussion_requested가 배너로 지속된다', async () => {
    let getCount = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string }) => {
      if (init?.method === 'POST' && url.includes('/discuss')) {
        return { ok: true, json: async () => ({ data: null }) };
      }
      if (url.includes('/api/gates/')) {
        getCount += 1;
        const neutral_facts = getCount === 1 ? null : {
          discussion_requested: { reason: '기한 조정 논의', requested_by_member_id: 'member-1', requested_at: new Date().toISOString() },
        };
        return { ok: true, json: async () => ({ data: gate({ neutral_facts }) }) };
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

    const discussOpenBtn = Array.from(container.querySelectorAll('button'))
      .find((b) => b.textContent?.includes(koMessages.cage.gateDiscussSubmit));
    await act(async () => { discussOpenBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); });

    const textarea = document.getElementById('gate-discuss-reason') as HTMLTextAreaElement | null;
    expect(textarea).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(textarea, '기한 조정 논의');
      textarea?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const submitBtn = Array.from(document.querySelectorAll('button'))
      .find((b) => b.textContent === koMessages.cage.gateDiscussSubmit && !discussOpenBtn?.isSameNode(b));
    await act(async () => { submitBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    // 즉시 신호(토스트) — «눌러도 반응이 안 보임» 3연발 재현의 직접 처방.
    expect(document.body.textContent).toContain(koMessages.chats.approvalRequestDiscussSuccessToast);
    // 지속 신호(배너) — fetchGate() 재조회로 받은 discussion_requested가 그대로 남는다.
    expect(container.textContent).toContain('기한 조정 논의');
  });
});

// story #3334(페드루 PO 리뷰 적출) — 이 카드의 저위험 반려 버튼(gateReject)이 예전엔
// onReject()를 사유 없이 즉시 호출했다(gates/[id]/page.tsx·approvals-queue.tsx에 이미 적용한
// "반려는 사유 필수" 처방이 이 세 번째 표면엔 빠져 있었다 — 채팅 결재 카드는 선생님이 가장
// 많이 쓰는 표면). 클릭은 이제 서명 패널(GateSignatureApproval, 사유 textarea 보유)을 열
// 뿐이고, 사유를 채워야만 그 안의 「변경 요청」이 풀린다.
describe('ApprovalRequestCard — 저위험 반려는 사유 패널을 거친다(story #3334)', () => {
  it('저위험 반려 클릭 → 즉시 POST 0 → 사유 입력 後에만 POST 1(status=rejected)', async () => {
    const calls: { url: string; method?: string; body?: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method, body: init?.body as string | undefined });
      if (init?.method === 'POST' && url.includes('/transition')) return { ok: true, json: async () => ({}) };
      if (url.includes('/api/gates/')) {
        return { ok: true, json: async () => ({ data: gate({ id: 'g-low-reject', can_approve: true, risk_grade: 'low' }) }) };
      }
      return { ok: true, json: async () => ({}) };
    }));

    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <ApprovalRequestCard target={{ work_item_type: 'story', work_item_id: 'w-1', gate_id: 'g-low-reject', actions: ['approve', 'reject'] }} />
        </NextIntlClientProvider>,
      );
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const rejectBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(koMessages.cage.gateReject)) as HTMLButtonElement;
    expect(rejectBtn).toBeTruthy();
    await act(async () => { rejectBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    // 클릭 직후 — 패널만 열렸다, 아직 POST 0건. 이 패널은 다이얼로그가 아니라 카드 안
    // 인라인 렌더(container 안)라 document.body 포탈 스코프가 불요.
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    const panelRejectBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(koMessages.cage.sigRequestChanges)) as HTMLButtonElement;
    expect(panelRejectBtn).toBeTruthy();
    expect(panelRejectBtn.disabled).toBe(true); // AC — 사유 입력 前 비활성.

    const textarea = document.getElementById('gate-sig-reason') as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(textarea, '스키마 필드명이 기존 컨벤션과 다릅니다');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(panelRejectBtn.disabled).toBe(false);

    await act(async () => { panelRejectBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const postCall = calls.find((c) => c.method === 'POST');
    expect(postCall?.url).toBe('/api/gates/g-low-reject/transition');
    expect(JSON.parse(postCall?.body ?? '{}')).toMatchObject({ status: 'rejected', note: '스키마 필드명이 기존 컨벤션과 다릅니다' });
  });
});
