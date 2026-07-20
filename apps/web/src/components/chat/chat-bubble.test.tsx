// @vitest-environment jsdom
//
// story #2021 — 채팅 문서 임베드 미리보기 모달이 폴링 주기마다 닫히던 회귀 재현.
// 근본원인: ChatMarkdown이 매 렌더 `components={{ a: ..., code: ... }}` 객체를 인라인으로 새로
// 만들었고, hast-util-to-jsx-runtime이 이 함수 참조를 그대로 React 엘리먼트 type으로 쓰기 때문에
// (state.components[name]) 무관한 부모 리렌더(presence 폴링 등)마다 `a`(엔티티 칩 포함) 서브트리가
// 타입 불일치로 언마운트→리마운트되고, 그 안의 로컬 state(EntityChip의 showModal)가 초기화됐다.
// 이 테스트는 실제 DOM(createRoot)으로 "열림 → 무관한 prop 변경으로 인한 리렌더 → 여전히 열려
// 있는가"를 왕복 검증한다 — 정적 "이제 안 닫힘" 주장이 아니라 리렌더를 실제로 트리거해 확認한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ChatBubble } from './chat-bubble';
import type { ChatMessage } from '@/hooks/use-chat-sse';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => ({ projectId: 'proj-1', currentTeamMemberId: 'member-1' }),
}));

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

const DOC_ID = '11111111-1111-1111-1111-111111111111';

const baseMessage: ChatMessage = {
  id: 'msg-1',
  memo_id: 'conv-1',
  created_by: 'agent-1',
  sender_name: '오르테가',
  sender_type: 'agent',
  content: `[제안서.md](entity:doc:${DOC_ID})`,
  attachments: [],
  created_at: '2026-07-20T00:00:00.000Z',
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // EntityPreviewModal의 doc 2단계 fetch — 모달이 열려 있는지 자체와는 무관, 실패해도
  // 컴포넌트는 loading→fallback으로 graceful. 회귀 검증에 필요한 건 close 버튼 생존 여부뿐.
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe('ChatBubble 문서 임베드 미리보기 모달 — 폴링 유발 리렌더 생존', () => {
  it('무관한 prop(presenceStatus)이 바뀌어 부모가 리렌더돼도 열린 모달이 유지된다', async () => {
    await act(async () => {
      root.render(wrap(
        <ChatBubble message={baseMessage} isMine={false} presenceStatus="online" isWorking={false} />,
      ));
    });

    const chip = container.querySelector('button');
    expect(chip).not.toBeNull();
    await act(async () => { chip!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    // 모달이 열렸다 — 닫기 버튼(aria-label="닫기")으로 확認.
    expect(container.querySelector('button[aria-label="닫기"]')).not.toBeNull();

    // story #2021 재현 지점: presence 폴링이 15s마다 새 presenceById를 흘려 ChatBubble을
    // 리렌더시키는 것과 동형 — 모달 자체와는 무관한 prop만 바뀐 리렌더.
    await act(async () => {
      root.render(wrap(
        <ChatBubble message={baseMessage} isMine={false} presenceStatus="idle" isWorking={false} />,
      ));
    });

    // 회귀 시 여기서 실패한다: components 객체가 매 렌더 재생성되면 `a` 서브트리(EntityChip)가
    // 리마운트되어 showModal이 초기화 — 닫기 버튼이 사라진다.
    expect(container.querySelector('button[aria-label="닫기"]')).not.toBeNull();
  });
});
