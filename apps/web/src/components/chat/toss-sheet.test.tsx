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
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: CONVERSATIONS }) })));
    await mount();
    expect(document.body.textContent).toContain('선생님'); // conv-1(DM, title=null → 상대 이름)
    expect(document.body.textContent).toContain('릴리스 채널'); // conv-3
    expect(document.body.textContent).not.toContain('디자인 스쿼드'); // conv-2(선생님 미참여) 제외
  });

  it('후보가 0건이면 빈 상태 문구가 뜬다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) })));
    await mount();
    expect(document.body.textContent).toContain(koMessages.chats.approvalRequestTossEmptyTitle);
  });

  it('검색어로 후보를 좁힌다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: CONVERSATIONS }) })));
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
      return { ok: true, json: async () => ({ data: CONVERSATIONS }) };
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
      return { ok: true, json: async () => ({ data: CONVERSATIONS }) };
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
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: CONVERSATIONS }) })));
    await mount();
    const sendBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent === koMessages.chats.approvalRequestTossSend);
    expect(sendBtn?.hasAttribute('disabled')).toBe(true);
  });

  it('409(gate_already_resolved) — onAlreadyResolved 호출+시트 닫힘', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: { method?: string }) => {
      if (init?.method === 'POST') {
        return { ok: false, status: 409, json: async () => ({ error: { code: 'gate_already_resolved', message: '이미 처리된 결재입니다.' } }) };
      }
      return { ok: true, json: async () => ({ data: CONVERSATIONS }) };
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
      return { ok: true, json: async () => ({ data: CONVERSATIONS }) };
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

// story #3203(선생님 실사고·2026-08-29) — 참가자 이름 해석 실패(BE orphan 폴백, name=null)
// 시 uuid가 그대로 새던 표시결함 pin. conversationDisplayName의 그룹-무참가자 폴백(conv.id
// 앞 8자)·참가자 이름 폴백('?') 둘 다 사람 언어("알 수 없는 멤버")로 통일했다.
describe('TossSheet — 참가자 이름 해석 실패 폴백(story #3203)', () => {
  it('DM 상대의 name이 null이면 "알 수 없는 멤버"로 뜬다 — uuid도 물음표도 아니다', async () => {
    const convs = [
      { id: 'conv-orphan-1', type: 'dm', title: null, participants: [{ member_id: 'member-9', name: null }, { member_id: 'member-1', name: '나' }] },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: convs }) })));
    await mount();
    expect(document.body.textContent).toContain('알 수 없는 멤버');
    expect(document.body.textContent).not.toContain('conv-orph');
  });
});
