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

describe('ChatBubble — story #2263 AC6 유령 칩(stored 참조 대조)', () => {
  it('references가 undefined(옛 서버·SSE 디스패치 폴백)면 유령 판정을 안 하고 그대로 그린다', async () => {
    await act(async () => {
      root.render(wrap(<ChatBubble message={{ ...baseMessage, references: undefined }} isMine={false} />));
    });
    const chip = container.querySelector('button');
    expect(chip).not.toBeNull();
    expect(container.textContent).not.toContain('대상이 없습니다');
  });

  it('references가 빈 배열(읽기 경로가 참조 0건을 확認)이면 본문 토큰이 유령으로 그려진다', async () => {
    await act(async () => {
      root.render(wrap(<ChatBubble message={{ ...baseMessage, references: [] }} isMine={false} />));
    });
    // 유령 칩은 버튼(클릭·모달)이 아니라 행동 0의 span이어야 한다.
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toContain('대상이 없습니다');
  });

  it('음성대조 — references에 본문 토큰과 정확히 일치하는 항목이 있으면 정상 칩 그대로다', async () => {
    await act(async () => {
      root.render(wrap(
        <ChatBubble
          message={{ ...baseMessage, references: [{ target_type: 'doc', target_id: DOC_ID }] }}
          isMine={false}
        />,
      ));
    });
    const chip = container.querySelector('button');
    expect(chip).not.toBeNull();
    expect(container.textContent).not.toContain('대상이 없습니다');
    expect(container.textContent).toContain('제안서.md');
  });

  it('asset 토큰은 stored 참조 대조 대상이 아니다(registry 밖 타입 — 유령 오판 방지)', async () => {
    const assetMsg: ChatMessage = {
      ...baseMessage,
      content: `[파일.png](entity:asset:${DOC_ID})`,
      references: [], // 참조 0건이어도 asset은 유령 처리하면 안 된다.
    };
    await act(async () => {
      root.render(wrap(<ChatBubble message={assetMsg} isMine={false} />));
    });
    expect(container.textContent).not.toContain('대상이 없습니다');
  });
});

describe('ChatBubble — story #2319 tombstone(메시지 삭제) 렌더', () => {
  it('deleted_at이 있으면 원문 대신 placeholder를 그린다', async () => {
    const deletedMsg: ChatMessage = { ...baseMessage, content: '', deleted_at: '2026-08-02T00:00:00.000Z' };
    await act(async () => {
      root.render(wrap(<ChatBubble message={deletedMsg} isMine={true} />));
    });
    expect(container.textContent).toContain('삭제된 메시지입니다');
    expect(container.textContent).not.toContain('제안서.md');
  });

  it('음성대조 — deleted_at이 없으면(정상 메시지) placeholder가 안 뜬다', async () => {
    await act(async () => {
      root.render(wrap(<ChatBubble message={{ ...baseMessage, deleted_at: null }} isMine={true} />));
    });
    expect(container.textContent).not.toContain('삭제된 메시지입니다');
  });

  it('본인 메시지도 이미 삭제됐으면 컨텍스트 메뉴에 「삭제」를 다시 제시하지 않는다', async () => {
    const deletedMsg: ChatMessage = { ...baseMessage, content: '', deleted_at: '2026-08-02T00:00:00.000Z' };
    await act(async () => {
      root.render(wrap(<ChatBubble message={deletedMsg} isMine={true} />));
    });
    const bubbleRoot = container.querySelector('[id^="msg-"]');
    expect(bubbleRoot).not.toBeNull();
    await act(async () => {
      bubbleRoot!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    });
    const menuItems = Array.from(document.body.querySelectorAll('[role="menuitem"]')).map((el) => el.textContent);
    expect(menuItems).not.toContain('삭제');
  });

  it('미완 봉합(미르코 dev 실측) — tombstone된 메시지는 attachments가 있어도 첨부 카드를 안 그린다', async () => {
    const deletedMsgWithAttachment: ChatMessage = {
      ...baseMessage,
      content: '',
      deleted_at: '2026-08-02T00:00:00.000Z',
      attachments: [{ url: 'chat/proj/conv/report.pdf', name: 'report.pdf', content_type: 'application/pdf' }],
    };
    await act(async () => {
      root.render(wrap(<ChatBubble message={deletedMsgWithAttachment} isMine={true} />));
    });
    expect(container.textContent).not.toContain('report.pdf');
  });

  it('음성대조 — 안 지워진 메시지는 attachments가 있으면 첨부 카드를 그린다', async () => {
    const liveMsgWithAttachment: ChatMessage = {
      ...baseMessage,
      deleted_at: null,
      attachments: [{ url: 'chat/proj/conv/report.pdf', name: 'report.pdf', content_type: 'application/pdf' }],
    };
    await act(async () => {
      root.render(wrap(<ChatBubble message={liveMsgWithAttachment} isMine={true} />));
    });
    expect(container.textContent).toContain('report.pdf');
  });

  it('음성대조 — 본인 메시지가 안 지워진 상태면 컨텍스트 메뉴에 「삭제」가 뜬다', async () => {
    await act(async () => {
      root.render(wrap(<ChatBubble message={{ ...baseMessage, deleted_at: null }} isMine={true} />));
    });
    const bubbleRoot = container.querySelector('[id^="msg-"]');
    await act(async () => {
      bubbleRoot!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    });
    const menuItems = Array.from(document.body.querySelectorAll('[role="menuitem"]')).map((el) => el.textContent);
    expect(menuItems).toContain('삭제');
  });
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

    // 모달이 열렸다 — 닫기 버튼(aria-label="닫기")으로 확認. story #2061: EntityPreviewModal이
    // 공용 Dialog(base-ui)로 교체되며 document.body로 포탈 렌더된다(내용/동작은 동일).
    expect(document.body.querySelector('button[aria-label="닫기"]')).not.toBeNull();

    // story #2021 재현 지점: presence 폴링이 15s마다 새 presenceById를 흘려 ChatBubble을
    // 리렌더시키는 것과 동형 — 모달 자체와는 무관한 prop만 바뀐 리렌더.
    await act(async () => {
      root.render(wrap(
        <ChatBubble message={baseMessage} isMine={false} presenceStatus="idle" isWorking={false} />,
      ));
    });

    // 회귀 시 여기서 실패한다: components 객체가 매 렌더 재생성되면 `a` 서브트리(EntityChip)가
    // 리마운트되어 showModal이 초기화 — 닫기 버튼이 사라진다.
    expect(document.body.querySelector('button[aria-label="닫기"]')).not.toBeNull();
  });
});

describe('ChatBubble — story #2265(C-7) 인용 범위 선택 배선(props 생략 시 회귀 0)', () => {
  it('isCiteAnchor·isCiteInRange·citeAction을 전부 생략하면 좌측 표시가 안 생긴다(기존 호출부 무변경)', async () => {
    await act(async () => {
      root.render(wrap(<ChatBubble message={baseMessage} isMine={false} />));
    });
    const wrapperDiv = container.querySelector(`#msg-${baseMessage.id}`);
    expect(wrapperDiv?.className).not.toContain('border-l-primary');
  });

  it('isCiteAnchor가 true면 좌측 3px 표시 클래스가 붙는다', async () => {
    await act(async () => {
      root.render(wrap(<ChatBubble message={baseMessage} isMine={false} isCiteAnchor />));
    });
    const wrapperDiv = container.querySelector(`#msg-${baseMessage.id}`);
    expect(wrapperDiv?.className).toContain('border-l-primary');
  });

  it('isCiteInRange가 true면 좌측 3px 표시 클래스가 붙는다', async () => {
    await act(async () => {
      root.render(wrap(<ChatBubble message={baseMessage} isMine={false} isCiteInRange />));
    });
    const wrapperDiv = container.querySelector(`#msg-${baseMessage.id}`);
    expect(wrapperDiv?.className).toContain('border-l-primary');
  });

  it('citeAction을 생략하면(호출부가 아직 안 넘긴 상태) 우클릭 메뉴에 인용 항목이 안 뜬다', async () => {
    await act(async () => {
      root.render(wrap(<ChatBubble message={baseMessage} isMine={false} />));
    });
    const wrapperDiv = container.querySelector(`#msg-${baseMessage.id}`)!;
    await act(async () => {
      wrapperDiv.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
    });
    expect(container.textContent).not.toContain('인용');
    expect(document.body.textContent).not.toContain('인용');
  });

  it('citeAction을 넘기면 우클릭 메뉴에 그 kind에 맞는 인용 항목이 뜬다', async () => {
    const onSelect = () => {};
    await act(async () => {
      root.render(wrap(
        <ChatBubble message={baseMessage} isMine={false} citeAction={{ kind: 'start', onSelect }} />,
      ));
    });
    const wrapperDiv = container.querySelector(`#msg-${baseMessage.id}`)!;
    await act(async () => {
      wrapperDiv.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
    });
    expect(document.body.textContent).toContain('여기부터 인용');
  });
});

describe('ChatBubble — story #2349 사용자 차단 마스킹', () => {
  it('is_blocked_sender가 undefined(판단 재료 없음)면 본문이 그대로 보인다(tombstone과 다른 축)', async () => {
    const msg = { ...baseMessage, content: '일반 텍스트' };
    await act(async () => {
      root.render(wrap(<ChatBubble message={msg} isMine={false} />));
    });
    expect(container.textContent).toContain('일반 텍스트');
    expect(container.textContent).not.toContain('차단한 사용자의 메시지입니다');
  });

  it('is_blocked_sender=true면 본문 대신 마스킹 placeholder + "보기"가 뜬다', async () => {
    const msg = { ...baseMessage, content: '숨겨야 할 내용', is_blocked_sender: true };
    await act(async () => {
      root.render(wrap(<ChatBubble message={msg} isMine={false} />));
    });
    expect(container.textContent).toContain('차단한 사용자의 메시지입니다');
    expect(container.textContent).toContain('보기');
    expect(container.textContent).not.toContain('숨겨야 할 내용');
  });

  it('마스킹 상태에서 "보기"를 누르면 본문이 드러난다(tombstone과 다르다 — 서버는 이미 내려줬다)', async () => {
    const msg = { ...baseMessage, content: '숨겨야 할 내용', is_blocked_sender: true };
    await act(async () => {
      root.render(wrap(<ChatBubble message={msg} isMine={false} />));
    });
    const revealBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '보기');
    expect(revealBtn).not.toBeUndefined();
    await act(async () => { revealBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container.textContent).toContain('숨겨야 할 내용');
    expect(container.textContent).not.toContain('차단한 사용자의 메시지입니다');
  });

  // ⛔tombstone(삭제)이 차단 마스킹보다 우선 — 이미 지운 메시지는 "차단됐다"로 잘못 안내하지 않는다.
  it('deleted_at과 is_blocked_sender=true가 동시에 있으면 삭제 placeholder가 이긴다', async () => {
    const msg = { ...baseMessage, content: '', deleted_at: '2026-08-02T00:00:00.000Z', is_blocked_sender: true };
    await act(async () => {
      root.render(wrap(<ChatBubble message={msg} isMine={false} />));
    });
    expect(container.textContent).toContain('삭제된 메시지입니다');
    expect(container.textContent).not.toContain('차단한 사용자의 메시지입니다');
  });

  it('onBlockUser를 안 주면(기존 호출부) 우클릭 메뉴에 「사용자 차단」이 안 뜬다(회귀 0)', async () => {
    await act(async () => {
      root.render(wrap(<ChatBubble message={baseMessage} isMine={false} />));
    });
    const wrapperDiv = container.querySelector(`#msg-${baseMessage.id}`)!;
    await act(async () => {
      wrapperDiv.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
    });
    expect(document.body.textContent).not.toContain('사용자 차단');
  });

  it('onBlockUser를 주면 우클릭 메뉴에 「사용자 차단」이 뜨고 클릭 시 호출된다', async () => {
    const onBlockUser = vi.fn();
    await act(async () => {
      root.render(wrap(<ChatBubble message={baseMessage} isMine={false} onBlockUser={onBlockUser} />));
    });
    const wrapperDiv = container.querySelector(`#msg-${baseMessage.id}`)!;
    await act(async () => {
      wrapperDiv.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }));
    });
    const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('사용자 차단'));
    expect(btn).not.toBeUndefined();
    await act(async () => { btn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onBlockUser).toHaveBeenCalledTimes(1);
  });

  it('자기 메시지(isMine=true)엔 아바타/이름을 눌러도 상대 프로필 팝오버가 안 뜬다', async () => {
    await act(async () => {
      root.render(wrap(<ChatBubble message={{ ...baseMessage, created_by: 'member-1' }} isMine={true} />));
    });
    const nameSpan = Array.from(container.querySelectorAll('span')).find((s) => s.textContent === '나');
    expect(nameSpan).not.toBeUndefined();
    await act(async () => { nameSpan!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it('남의 메시지(isMine=false) 이름을 누르면 상대 프로필 팝오버가 뜬다', async () => {
    await act(async () => {
      root.render(wrap(<ChatBubble message={baseMessage} isMine={false} />));
    });
    const nameSpan = Array.from(container.querySelectorAll('span')).find((s) => s.textContent === baseMessage.sender_name);
    expect(nameSpan).not.toBeUndefined();
    await act(async () => { nameSpan!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain(baseMessage.sender_name);
  });
});
