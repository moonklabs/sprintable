// @vitest-environment jsdom
//
// story #3084(2026-08-25, 유나 픽셀 규격 v1 §2) — 토스 시트: 대상 conversation 피커=
// designated 참여 대화만(BE 422 사전 방지)·검색 필터·성공/409/기타 에러 처리.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { TossSheet } from './toss-sheet';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
});

const CONVERSATIONS = [
  { id: 'conv-1', type: 'dm', title: null, participants: [{ member_id: 'member-9', name: '선생님' }, { member_id: 'member-1', name: '나' }] },
  { id: 'conv-2', type: 'group', title: '디자인 스쿼드', participants: [{ member_id: 'member-2', name: '유나' }] },
  { id: 'conv-3', type: 'group', title: '릴리스 채널', participants: [{ member_id: 'member-9', name: '선생님' }] },
];

async function mount(overrides: Partial<Parameters<typeof TossSheet>[0]> = {}) {
  const onTossed = vi.fn();
  const onAlreadyResolved = vi.fn();
  const onOpenChange = vi.fn();
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <TossSheet
          open
          onOpenChange={onOpenChange}
          gateId="gate-1"
          projectId="proj-1"
          currentTeamMemberId="member-1"
          designatedApproverId="member-9"
          designatedApproverName="선생님"
          onTossed={onTossed}
          onAlreadyResolved={onAlreadyResolved}
          {...overrides}
        />
      </NextIntlClientProvider>,
    );
  });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return { onTossed, onAlreadyResolved, onOpenChange };
}

describe('TossSheet — 대상 피커(designated 참여 대화만)', () => {
  it('designated_approver가 참여한 대화만 후보로 남는다(비참여 대화는 제외 — 422 사전방지)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: CONVERSATIONS, total: CONVERSATIONS.length }) })));
    await mount();
    expect(document.body.textContent).toContain('선생님'); // conv-1(DM, title=null → 상대 이름)
    expect(document.body.textContent).toContain('릴리스 채널'); // conv-3
    expect(document.body.textContent).not.toContain('디자인 스쿼드'); // conv-2(선생님 미참여) 제외
  });

  it('후보가 0건이면 빈 상태 문구가 뜬다(total:0 — 완결이 확인된 진짜 빈 목록)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: [], total: 0 }) })));
    await mount();
    expect(document.body.textContent).toContain(koMessages.chats.approvalRequestTossEmptyTitle);
  });

  it('검색어로 후보를 좁힌다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: CONVERSATIONS, total: CONVERSATIONS.length }) })));
    await mount();
    // aria-pressed는 이 컴포넌트에서 피커 행에만 붙는다(Cancel/Send 푸터 버튼과 구분).
    expect(document.body.querySelectorAll('button[aria-pressed]').length).toBe(2);
    const input = document.body.querySelector('input') as HTMLInputElement;
    // React가 native input value setter를 가로채므로, 컨트롤드 인풋 타이핑을 jsdom에서
    // 재현하려면 native setter로 값을 심어야 change 감지가 된다(흔한 RTL 우회 없는 테스트 관례).
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      nativeSetter?.call(input, '릴리스');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const rows = document.body.querySelectorAll('button[aria-pressed]');
    expect(rows.length).toBe(1);
    expect(rows[0]?.textContent).toContain('릴리스 채널');
  });
});

describe('TossSheet — 제출(성공/409/기타 에러)', () => {
  it('선택 후 보내기 — 성공(신규 삽입) 시 onTossed(대상 이름, inserted=true)+onOpenChange(false)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST') {
        expect(url).toContain('/api/gates/gate-1/toss');
        expect(JSON.parse(init.body ?? '{}')).toEqual({ target_conversation_id: 'conv-3' });
        return { ok: true, json: async () => ({ inserted: true }) };
      }
      return { ok: true, json: async () => ({ data: CONVERSATIONS, total: CONVERSATIONS.length }) };
    }));
    const { onTossed, onOpenChange } = await mount();

    const row = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.includes('릴리스 채널'));
    await act(async () => { row?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const sendBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === koMessages.chats.approvalRequestTossSend);
    expect(sendBtn?.hasAttribute('disabled')).toBe(false);
    await act(async () => { sendBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(onTossed).toHaveBeenCalledWith('릴리스 채널', true);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('재토스(멱등 no-op) — onTossed(대상 이름, inserted=false)+재오픈 시 «이미 있음» 칩(story #3094)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === 'POST') {
        expect(url).toContain('/api/gates/gate-1/toss');
        expect(JSON.parse(init.body ?? '{}')).toEqual({ target_conversation_id: 'conv-3' });
        return { ok: true, json: async () => ({ inserted: false }) };
      }
      return { ok: true, json: async () => ({ data: CONVERSATIONS, total: CONVERSATIONS.length }) };
    }));
    const onTossed = vi.fn();
    const onAlreadyResolved = vi.fn();
    let isOpen = true;
    const onOpenChange = vi.fn((next: boolean) => { isOpen = next; });
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <TossSheet
            open={isOpen}
            onOpenChange={onOpenChange}
            gateId="gate-1"
            projectId="proj-1"
            currentTeamMemberId="member-1"
            designatedApproverId="member-9"
            designatedApproverName="선생님"
            onTossed={onTossed}
            onAlreadyResolved={onAlreadyResolved}
          />
        </NextIntlClientProvider>,
      );
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const row = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.includes('릴리스 채널'));
    await act(async () => { row?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const sendBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === koMessages.chats.approvalRequestTossSend);
    await act(async () => { sendBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(onTossed).toHaveBeenCalledWith('릴리스 채널', false);
    expect(onOpenChange).toHaveBeenCalledWith(false);

    // 재오픈(재토스 진입) — 같은 인스턴스가 학습한 «이미 있음» 칩이 그 대상에 사전 표시된다.
    isOpen = true;
    await act(async () => {
      root.render(
        <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
          <TossSheet
            open={isOpen}
            onOpenChange={onOpenChange}
            gateId="gate-1"
            projectId="proj-1"
            currentTeamMemberId="member-1"
            designatedApproverId="member-9"
            designatedApproverName="선생님"
            onTossed={onTossed}
            onAlreadyResolved={onAlreadyResolved}
          />
        </NextIntlClientProvider>,
      );
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const reopenedRow = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.includes('릴리스 채널'));
    expect(reopenedRow?.textContent).toContain(koMessages.chats.approvalRequestTossAlreadyThereChip);
  });

  it('보내기 버튼은 선택 전엔 비활성', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: CONVERSATIONS, total: CONVERSATIONS.length }) })));
    await mount();
    const sendBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === koMessages.chats.approvalRequestTossSend);
    expect(sendBtn?.hasAttribute('disabled')).toBe(true);
  });

  it('409(gate_already_resolved) — onAlreadyResolved 호출+시트 닫힘', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') {
        return { ok: false, status: 409, json: async () => ({ error: { code: 'gate_already_resolved', message: '이미 처리된 결재입니다.' } }) };
      }
      return { ok: true, json: async () => ({ data: CONVERSATIONS, total: CONVERSATIONS.length }) };
    }));
    const { onAlreadyResolved, onTossed, onOpenChange } = await mount();

    const row = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.includes('릴리스 채널'));
    await act(async () => { row?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const sendBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === koMessages.chats.approvalRequestTossSend);
    await act(async () => { sendBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(onAlreadyResolved).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onTossed).not.toHaveBeenCalled();
  });

  it('422(target_approver_not_participant) — 인라인 에러로 표시, 시트는 안 닫힌다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') {
        return { ok: false, status: 422, json: async () => ({ error: { code: 'target_approver_not_participant', message: '대상 대화에 지정 결재자가 참여하고 있지 않습니다.' } }) };
      }
      return { ok: true, json: async () => ({ data: CONVERSATIONS, total: CONVERSATIONS.length }) };
    }));
    const { onOpenChange } = await mount();

    const row = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.includes('릴리스 채널'));
    await act(async () => { row?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const sendBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === koMessages.chats.approvalRequestTossSend);
    await act(async () => { sendBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(document.body.textContent).toContain('대상 대화에 지정 결재자가 참여하고 있지 않습니다.');
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
});

// story #3701 — `/api/conversations`는 has_more/next_cursor가 아니라 offset+total 계약
// (#2231 세 번째 벌)이라, limit=100 한 페이지만 보고 끝내면 참여 대화가 101건을 넘는
// 프로젝트에서 101번째 이후가 토스 대상 후보에서 침묵 절단됐다(designated가 그 대화에만
// 있으면 화면이 "대상 없음"처럼 보임). offset을 밀어 전량을 모으는지 pin.
describe('TossSheet — 완결 로드(story #3701, offset+total 계약 전량 확보)', () => {
  it('참여 대화가 101건(offset+total, 2페이지)이면 101번째도 후보에서 안 빠진다', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: `conv-${i}`, type: 'group' as const, title: `잡담방 ${i}`, participants: [{ member_id: 'member-2', name: '유나' }],
    }));
    const page2Only = {
      id: 'conv-101', type: 'group' as const, title: '101번째 방', participants: [{ member_id: 'member-9', name: '선생님' }],
    };
    const fetchMock = vi.fn(async (url: string) => {
      const offset = Number(new URL(url, 'http://x').searchParams.get('offset') ?? '0');
      if (offset === 0) return { ok: true, json: async () => ({ data: page1, total: 101 }) };
      return { ok: true, json: async () => ({ data: [page2Only], total: 101 }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    await mount(); // designatedApproverId='member-9' — page1엔 아무도 없고 conv-101에만 있다

    expect(document.body.textContent).toContain('101번째 방');
    // page1(offset=0)·page2(offset=100) 두 번 불렀는지 — 첫 페이지만 보고 끝내는 구코드로
    // 되돌리면 호출 1회·"101번째 방" 부재 둘 다로 즉시 실패한다(mutation-kill).
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// story #3701(design CHANGES, 유나 — "완결 못 하면 완결인 척 안 한다") — 전량 로드가
// 끝까지 못 간 3갈래(중간 페이지 !ok·MAX_PAGES 소진·total 부재) 각각이 partial 배너/
// 빈 상태 문구로 정직하게 드러나는지, 그리고 재시도로 회복되는지 pin.
describe('TossSheet — 완결 실패를 완결인 척 안 함(story #3701 partial)', () => {
  it('2페이지째 응답이 !ok면 1페이지 후보는 보여주되 partial 배너가 뜬다', async () => {
    const page1 = [{ id: 'conv-a', type: 'group' as const, title: '보이는 방', participants: [{ member_id: 'member-9', name: '선생님' }] }];
    const fetchMock = vi.fn(async (url: string) => {
      const offset = Number(new URL(url, 'http://x').searchParams.get('offset') ?? '0');
      if (offset === 0) return { ok: true, json: async () => ({ data: page1, total: 2 }) };
      return { ok: false, status: 500, json: async () => null };
    });
    vi.stubGlobal('fetch', fetchMock);
    await mount();

    expect(document.body.textContent).toContain('보이는 방'); // 이미 받은 건 안 버림
    expect(document.body.textContent).toContain(koMessages.chats.approvalRequestTossPartialBanner);
  });

  it('total이 없으면(계약 위반) 완결을 단정하지 않고 partial로 멈춘다', async () => {
    const page1 = [{ id: 'conv-a', type: 'group' as const, title: '방1', participants: [{ member_id: 'member-9', name: '선생님' }] }];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: page1 }) }))); // total 없음
    await mount();

    expect(document.body.textContent).toContain(koMessages.chats.approvalRequestTossPartialBanner);
  });

  it('후보가 0건+partial이면 "대상 없음" 대신 "못 불러옴" 문구+재시도 버튼', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => null })));
    await mount();

    expect(document.body.textContent).not.toContain(koMessages.chats.approvalRequestTossEmptyTitle);
    expect(document.body.textContent).toContain(koMessages.chats.approvalRequestTossPartialEmptyTitle);
    expect(document.body.textContent).toContain(koMessages.chats.approvalRequestTossPartialRetry);
  });

  it('재시도가 성공하면 partial 배너가 사라지고 전량이 보인다', async () => {
    // page1(offset=0)엔 designated 미참여 방 1건뿐(후보 0건으로 걸러짐)+total=2라 다음
    // 페이지(offset=1)를 마저 불러야 하는데, 그게 첫 시도엔 실패 → partial+빈 상태.
    // 재시도에서 그 페이지가 성공하면 conv-101이 후보로 들어와 배너/빈상태 둘 다 걷힌다.
    const nonCandidate = { id: 'conv-x', type: 'group' as const, title: '무관 방', participants: [{ member_id: 'member-2', name: '유나' }] };
    const page2Only = { id: 'conv-101', type: 'group' as const, title: '101번째 방', participants: [{ member_id: 'member-9', name: '선생님' }] };
    let secondCallOk = false;
    const fetchMock = vi.fn(async (url: string) => {
      const offset = Number(new URL(url, 'http://x').searchParams.get('offset') ?? '0');
      if (offset === 0) return { ok: true, json: async () => ({ data: [nonCandidate], total: 2 }) };
      if (!secondCallOk) return { ok: false, status: 500, json: async () => null };
      return { ok: true, json: async () => ({ data: [page2Only], total: 2 }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    await mount();
    expect(document.body.textContent).toContain(koMessages.chats.approvalRequestTossPartialEmptyTitle);

    secondCallOk = true;
    const retryBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === koMessages.chats.approvalRequestTossPartialRetry);
    await act(async () => { retryBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

    expect(document.body.textContent).not.toContain(koMessages.chats.approvalRequestTossPartialBanner);
    expect(document.body.textContent).not.toContain(koMessages.chats.approvalRequestTossPartialEmptyTitle);
    expect(document.body.textContent).toContain('101번째 방');
  });
});

// story #3203(선생님 실사고·2026-08-29) — 참가자 이름 해석 실패(BE orphan 폴백, name=null)
// 시 uuid가 그대로 새던 표시결함 pin. conversationDisplayName의 그룹-무참가자 폴백(conv.id
// 앞 8자)·참가자 이름 폴백('?') 둘 다 사람 언어("알 수 없는 멤버")로 통일했다.
describe('TossSheet — 참가자 이름 해석 실패 폴백(story #3203)', () => {
  it('DM 상대의 name이 null이면 "알 수 없는 멤버"로 뜬다 — uuid도 물음표도 아니다', async () => {
    const convs = [
      { id: 'conv-orphan-1', type: 'dm', title: null, participants: [{ member_id: 'member-9', name: null }, { member_id: 'member-1', name: '나' }] },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: convs, total: convs.length }) })));
    await mount();
    expect(document.body.textContent).toContain('알 수 없는 멤버');
    expect(document.body.textContent).not.toContain('conv-orph');
  });
});
