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

// story #2637 — mutable로 둬 EventBlockCard의 human_only/role 게이팅 테스트가 값을 오버라이드
// 할 수 있게 한다(기본값은 기존 50+ 테스트와 동일하게 human/무역할 — 비회귀).
let mockDashboardContext: {
  projectId: string; currentTeamMemberId: string; currentMemberType?: 'human' | 'agent'; role?: string;
  projectMemberships?: { projectId: string; projectName: string }[];
} = {
  projectId: 'proj-1', currentTeamMemberId: 'member-1', currentMemberType: 'human', role: 'member',
  projectMemberships: [],
};
vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => mockDashboardContext,
}));

// story #2037 — 라이트박스 진입점 테스트용. 다른 describe들은 이미지 첨부를 렌더하지 않으므로
// (문서 미리보기·PDF 등) 이 mock이 그쪽 동작에 영향을 안 준다.
vi.mock('next/image', () => ({
  default: ({ src, alt }: { src?: string; alt?: string }) =>
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} data-next-image="true" />,
}));

// story #2671 — EmbedCard(단독 참조 문단 카드 렌더)가 doc 클릭 시 useRouter()를 쓴다.
// 이 스위트의 baseMessage.content 자체가 단독 doc 참조라 라우터 컨텍스트 없이 렌더하면
// "invariant expected app router to be mounted"로 죽는다.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {} }),
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
  sender_avatar_url: null,
  sender_runtime_type: null,
  // story #2671 — 링크 하나뿐인 문단은 이제 EmbedCard(카드)로 렌더된다(신규 기능, 아래
  // 전용 describe에서 검증). 이 파일의 나머지 스위트는 전부 EntityChip 특화 동작(사실성
  // 표기·상태 배지·결재 CTA·모달 재렌더 생존 등)을 재는 게 목적이라 앞에 문맥어를 붙여
  // "단독 문단"이 아니게 만든다 — 카드 스왑에 영향받지 않고 원래 의도 그대로 유지.
  content: `문서 첨부: [제안서.md](entity:doc:${DOC_ID})`,
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
  mockDashboardContext = { projectId: 'proj-1', currentTeamMemberId: 'member-1', currentMemberType: 'human', role: 'member', projectMemberships: [] };
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

describe('ChatBubble — story #2262 AC1(사실성·표면·지점 표기, doc flow-map-blueprint-v1 §2-3)', () => {
  it('stored 참조가 form·referenced_at을 실으면 칩에 "관찰됨 · {표면} · {지점}"이 표기된다', async () => {
    await act(async () => {
      root.render(wrap(
        <ChatBubble
          message={{
            ...baseMessage,
            references: [{ target_type: 'doc', target_id: DOC_ID, form: 'mention', referenced_at: '2026-07-26T00:00:00.000Z' }],
          }}
          isMine={false}
        />,
      ));
    });
    // story #2886(S2b) — 격납 메타는 hover/focus tooltip으로 이동(더는 항상 인라인 표기 안 함).
    // 트리거에 포커스를 줘 tooltip을 열고, base-ui Portal이 document.body에 그리는 내용을 본다.
    await act(async () => { container.querySelector('button')!.focus(); });
    // story #2886(S2b) — 유나군 하이파이 목업 대조: 툴팁은 라벨:값 행 구조(상태·참조 형태·관찰).
    expect(document.body.textContent).toContain('참조 형태');
    expect(document.body.textContent).toContain('멘션');
    expect(document.body.textContent).toContain('관찰');
    expect(document.body.textContent).toContain('7/26');
  });

  it('매칭되는 stored 참조가 있어도 form·referenced_at이 없으면(구서버 폴백) 표기를 지어내지 않는다', async () => {
    await act(async () => {
      root.render(wrap(
        <ChatBubble
          message={{ ...baseMessage, references: [{ target_type: 'doc', target_id: DOC_ID }] }}
          isMine={false}
        />,
      ));
    });
    expect(container.textContent).not.toContain('관찰됨');
  });

  it('유령 칩(매칭 없음)에는 사실성·표면·지점을 표기하지 않는다', async () => {
    await act(async () => {
      root.render(wrap(<ChatBubble message={{ ...baseMessage, references: [] }} isMine={false} />));
    });
    expect(container.textContent).not.toContain('관찰됨');
  });
});

describe('ChatBubble — story #2262 AC2 PR② 1단계(2026-08-07 유나양 카피 판정, BE 배치조회 前 하드코딩)', () => {
  it('has-status 타입(doc) 칩은 실 배치조회가 없는 오늘은 "아직 모름"을 보인다', async () => {
    await act(async () => {
      root.render(wrap(<ChatBubble message={{ ...baseMessage, references: undefined }} isMine={false} />));
    });
    // story #2886(S2b) — 상태 라벨은 격납(hover/focus tooltip)으로 이동. 포커스로 열고 확認.
    await act(async () => { container.querySelector('button')!.focus(); });
    expect(document.body.textContent).toContain('아직 모름');
    expect(document.body.textContent).not.toContain('상태 없음');
  });

  it('no-status-concept 타입(hypothesis) 칩은 "상태 없음"을 보인다(로딩이 아니라 구조적 부재)', async () => {
    const hypothesisId = '22222222-2222-2222-2222-222222222222';
    await act(async () => {
      root.render(wrap(
        <ChatBubble
          message={{ ...baseMessage, content: `가설 첨부: [가설 A](entity:hypothesis:${hypothesisId})`, references: undefined }}
          isMine={false}
        />,
      ));
    });
    await act(async () => { container.querySelector('button')!.focus(); });
    expect(document.body.textContent).toContain('상태 없음');
    expect(document.body.textContent).not.toContain('아직 모름');
  });

  it('유령 칩에는 상태 라벨을 안 보인다(대상 자체가 없는데 상태를 말할 수 없다)', async () => {
    await act(async () => {
      root.render(wrap(<ChatBubble message={{ ...baseMessage, references: [] }} isMine={false} />));
    });
    expect(container.textContent).not.toContain('아직 모름');
    expect(container.textContent).not.toContain('상태 없음');
  });
});

describe('ChatBubble — story #2262 AC2 PR② 2단계(chat-view.tsx 실 배치조회 결과 prop 소비)', () => {
  it('entityStatusByKey에 resolved 항목이 있으면 하드코딩 loading 대신 번역된 실 상태를 보인다', async () => {
    await act(async () => {
      root.render(wrap(
        <ChatBubble
          message={{ ...baseMessage, references: undefined }}
          isMine={false}
          entityStatusByKey={{ [`doc:${DOC_ID}`]: { kind: 'resolved', raw: 'confirmed' } }}
        />,
      ));
    });
    // story #2886(S2b) — 상태 라벨은 격납(hover/focus tooltip)으로 이동. 포커스로 열고 확認.
    await act(async () => { container.querySelector('button')!.focus(); });
    expect(document.body.textContent).toContain('확定');
    expect(document.body.textContent).not.toContain('아직 모름');
  });

  it('entityId가 대문자 UUID 토큰이어도 소문자로 정규화해 캐시 키와 매칭한다', async () => {
    await act(async () => {
      root.render(wrap(
        <ChatBubble
          message={{ ...baseMessage, content: `[제안서.md](entity:doc:${DOC_ID.toUpperCase()})`, references: undefined }}
          isMine={false}
          entityStatusByKey={{ [`doc:${DOC_ID}`]: { kind: 'resolved', raw: 'draft' } }}
        />,
      ));
    });
    expect(container.textContent).toContain('초안');
  });

  it('entityStatusByKey에 그 키가 아직 없으면(다른 타입 fetch 진행 중) 폴백과 동일하게 "아직 모름"이다', async () => {
    await act(async () => {
      root.render(wrap(
        <ChatBubble
          message={{ ...baseMessage, references: undefined }}
          isMine={false}
          entityStatusByKey={{ 'story:다른-엔티티': { kind: 'resolved', raw: 'done' } }}
        />,
      ));
    });
    await act(async () => { container.querySelector('button')!.focus(); });
    expect(document.body.textContent).toContain('아직 모름');
  });

  it('배치조회가 error로 끝나면 loading과 같은 급인 "아직 모름"을 보인다(가짜 "확認 중" 아님)', async () => {
    await act(async () => {
      root.render(wrap(
        <ChatBubble
          message={{ ...baseMessage, references: undefined }}
          isMine={false}
          entityStatusByKey={{ [`doc:${DOC_ID}`]: { kind: 'error' } }}
        />,
      ));
    });
    await act(async () => { container.querySelector('button')!.focus(); });
    expect(document.body.textContent).toContain('아직 모름');
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

  // 유나 design:changes(2026-08-03) — "보기"가 한 방향이면 누르는 문턱이 생긴다(되돌릴 수
  // 없다고 여기면 확인하고 싶어도 안 누른다). 되돌릴 수 있어야 눌러 볼 수 있다.
  it('펼친 뒤 "숨기기"를 누르면 다시 마스킹 placeholder로 돌아간다', async () => {
    const msg = { ...baseMessage, content: '숨겨야 할 내용', is_blocked_sender: true };
    await act(async () => {
      root.render(wrap(<ChatBubble message={msg} isMine={false} />));
    });
    const revealBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '보기');
    await act(async () => { revealBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container.textContent).toContain('숨겨야 할 내용');

    const hideBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '숨기기');
    expect(hideBtn).not.toBeUndefined();
    await act(async () => { hideBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container.textContent).toContain('차단한 사용자의 메시지입니다');
    expect(container.textContent).toContain('보기');
    expect(container.textContent).not.toContain('숨겨야 할 내용');
  });

  it('마스킹 안 된 일반 메시지엔 "숨기기" 버튼이 안 뜬다', async () => {
    const msg = { ...baseMessage, content: '일반 텍스트' };
    await act(async () => {
      root.render(wrap(<ChatBubble message={msg} isMine={false} />));
    });
    expect(container.textContent).not.toContain('숨기기');
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

describe('ChatBubble — story #2572 HITL 승인 요청 버튼 카드', () => {
  const HITL_CONTENT = '🔒 승인 요청: `Bash`\n입력: {"command":"rm -rf /tmp/x"}\n\n「allow」 또는 「deny <사유>」로 답해주세요 (600초 내 무응답 시 자동 거부).';
  const hitlMessage: ChatMessage = {
    ...baseMessage,
    content: HITL_CONTENT,
    sender_type: 'agent',
    created_at: new Date().toISOString(),
  };

  it('에이전트 발신 + 고정 포맷 매칭이면 버튼 카드로 렌더된다', async () => {
    await act(async () => {
      root.render(wrap(<ChatBubble message={hitlMessage} isMine={false} onRespondHitl={async () => {}} />));
    });
    expect(container.textContent).toContain('승인 요청');
    expect(container.textContent).toContain('Bash');
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === '허용')).toBe(true);
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === '거부')).toBe(true);
  });

  it('PO 가드① — 사람이 같은 텍스트를 쳐도(sender_type=human) 카드화되지 않는다', async () => {
    const humanMsg = { ...hitlMessage, sender_type: 'human' };
    await act(async () => {
      root.render(wrap(<ChatBubble message={humanMsg} isMine={false} onRespondHitl={async () => {}} />));
    });
    // 카드였다면 있었을 「허용」/「거부」 버튼이 없다 — 원문 그대로 일반 텍스트로만 렌더된다.
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === '허용')).toBe(false);
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === '거부')).toBe(false);
    expect(container.textContent).toContain('승인 요청');
  });

  it('PO 가드② — 문구가 살짝 어긋나면(플러그인 드리프트) 일반 텍스트로 폴백한다(깨진 카드 금지)', async () => {
    const driftedMsg = { ...hitlMessage, content: HITL_CONTENT.replace('🔒 승인 요청', '🔒 승인요청') };
    await act(async () => {
      root.render(wrap(<ChatBubble message={driftedMsg} isMine={false} onRespondHitl={async () => {}} />));
    });
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === '허용')).toBe(false);
    expect(container.textContent).toContain('승인요청');
  });

  it('onRespondHitl을 안 주면(호출부가 아직 안 넘긴 화면) 카드 대신 일반 텍스트로 폴백한다', async () => {
    await act(async () => {
      root.render(wrap(<ChatBubble message={hitlMessage} isMine={false} />));
    });
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === '허용')).toBe(false);
  });

  it('AC2 — 「허용」 클릭 시 onRespondHitl이 규약 문자열 "allow"로 호출된다', async () => {
    const onRespondHitl = vi.fn(async () => {});
    await act(async () => {
      root.render(wrap(<ChatBubble message={hitlMessage} isMine={false} onRespondHitl={onRespondHitl} />));
    });
    const allowBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '허용')!;
    await act(async () => { allowBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onRespondHitl).toHaveBeenCalledWith('allow');
  });

  it('AC2 — 「거부」 클릭 → 사유 입력 → 「거부 전송」 시 onRespondHitl이 "deny <사유>"로 호출된다', async () => {
    const onRespondHitl = vi.fn(async () => {});
    await act(async () => {
      root.render(wrap(<ChatBubble message={hitlMessage} isMine={false} onRespondHitl={onRespondHitl} />));
    });
    const denyBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '거부')!;
    await act(async () => { denyBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const input = container.querySelector('input') as HTMLInputElement;
    expect(input).not.toBeNull();
    const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      nativeSetter.call(input, '위험한 명령');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const submitBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '거부 전송')!;
    await act(async () => { submitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onRespondHitl).toHaveBeenCalledWith('deny 위험한 명령');
  });

  it('AC3 — hitlAnswer가 있으면(다른 기기 포함) 버튼 대신 상태만 보이고 재클릭이 불가하다', async () => {
    const onRespondHitl = vi.fn(async () => {});
    await act(async () => {
      root.render(wrap(
        <ChatBubble message={hitlMessage} isMine={false} onRespondHitl={onRespondHitl} hitlAnswer={{ decision: 'allow' }} />,
      ));
    });
    expect(container.textContent).toContain('허용됨');
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === '허용')).toBe(false);
    expect(onRespondHitl).not.toHaveBeenCalled();
  });

  it('AC3 — 타임아웃 경과 후엔 "만료됨"이 뜨고 버튼이 사라진다', async () => {
    const expiredMsg = { ...hitlMessage, created_at: new Date(Date.now() - 700_000).toISOString() };
    await act(async () => {
      root.render(wrap(<ChatBubble message={expiredMsg} isMine={false} onRespondHitl={async () => {}} />));
    });
    expect(container.textContent).toContain('만료됨');
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === '허용')).toBe(false);
  });
});

describe('ChatBubble — story #2604 P2 결재 요청(approval_target) 카드', () => {
  const GATE_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
  const approvalMessage: ChatMessage = {
    ...baseMessage,
    content: "'제안서.md' 문서 결재 요청",
    sender_type: 'agent',
    approval_target: { work_item_type: 'doc', work_item_id: DOC_ID, gate_id: GATE_ID, actions: ['approve', 'reject'] },
  };

  function stubGate(overrides: Partial<{ status: string; can_approve: boolean; risk_grade: 'low' | 'high' | null; title: string; resolution_note: string | null }>) {
    // 상태를 가진 mock — POST .../transition 뒤에 컴포넌트가 다시 GET하는 fetchGate()
    // refetch가 "바뀐 값"을 보게 하려면 gate 자체가 그 사이에 갱신돼야 한다(실 BE 동작 미러).
    const gate = {
      id: GATE_ID,
      work_item_id: DOC_ID,
      work_item_type: 'doc',
      gate_type: 'doc_approval',
      status: overrides.status ?? 'pending',
      can_approve: overrides.can_approve ?? true,
      risk_grade: overrides.risk_grade ?? 'low',
      resolver_id: null,
      resolved_at: null,
      resolution_note: overrides.resolution_note ?? null,
      neutral_facts: null,
      work_item_summary: { title: overrides.title ?? '제안서.md', slug: null },
      created_at: '2026-08-13T00:00:00.000Z',
      updated_at: '2026-08-13T00:00:00.000Z',
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: { method?: string; body?: string }) => {
      if (typeof url === 'string' && url.startsWith(`/api/gates/${GATE_ID}/transition`) && opts?.method === 'POST') {
        const { status } = JSON.parse(opts.body as string) as { status: string };
        gate.status = status;
        return { ok: true, json: async () => ({ data: gate }) };
      }
      if (typeof url === 'string' && url === `/api/gates/${GATE_ID}`) {
        return { ok: true, json: async () => ({ data: gate }) };
      }
      // story #2627 — 카드 제목 클릭 시 EntityPreviewModal(embed-card.tsx)이 doc 2단계
      // fetch를 시도한다 — 그 경로도 여기서 같이 응답한다.
      if (typeof url === 'string' && url.startsWith('/api/docs/preview')) {
        return { ok: true, json: async () => ({ data: { slug: 'proposal', projectId: 'proj-1', orgSlug: 'org', projectSlug: 'proj' } }) };
      }
      if (typeof url === 'string' && url.startsWith('/api/docs?')) {
        return { ok: true, json: async () => ({ data: { content: '# 제안서 본문\n\n승인 근거가 여기 있습니다.' } }) };
      }
      return { ok: false, json: async () => ({}) };
    }));
    return gate;
  }

  it('일반 메시지(approval_target 없음)는 카드 대신 기존 텍스트 렌더 그대로다', async () => {
    await act(async () => {
      root.render(wrap(<ChatBubble message={baseMessage} isMine={false} />));
    });
    expect(container.textContent).not.toContain('결재 요청');
  });

  it('pending + can_approve=true — 제목·승인/반려 버튼이 렌더된다', async () => {
    stubGate({});
    await act(async () => {
      root.render(wrap(<ChatBubble message={approvalMessage} isMine={false} />));
    });
    // story #2926(P0-F F1) — 「결재 요청」 정적 라벨 행은 ProofCapsule 셸로 전환되며
    // 빠졌다(카드 정체성은 이제 컷코너+레일 모양이 진다). 대신 stateLabel(pending=
    // 「결재 대기」)이 그 자리를 잇는다 — 텍스트 내용은 더 구체적으로 유지.
    expect(container.textContent).toContain('결재 대기');
    expect(container.textContent).toContain('제안서.md');
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent?.includes('승인'))).toBe(true);
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent?.includes('반려'))).toBe(true);
  });

  it('승인 클릭 시 POST .../transition이 status:"approved"로 호출되고 결과가 처리됨 상태로 갱신된다', async () => {
    stubGate({});
    await act(async () => {
      root.render(wrap(<ChatBubble message={approvalMessage} isMine={false} />));
    });
    const approveBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('승인'))!;
    await act(async () => { approveBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    // onClick은 transition()을 await하지 않는 fire-and-forget이라(HitlApprovalCard와 동일
    // 관례) 그 안의 await fetchGate() 재조회가 끝날 시점까지 한 번 더 flush가 필요하다.
    await act(async () => {});

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const transitionCall = fetchMock.mock.calls.find((call: unknown[]) => (call[0] as string).includes('/transition'));
    expect(transitionCall).toBeDefined();
    expect(JSON.parse((transitionCall![1] as { body: string }).body)).toEqual({ status: 'approved', note: null, evidence_viewed: false, reviewed_head_sha: null });
    expect(container.textContent).toContain('처리됨');
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent?.includes('승인'))).toBe(false);
  });

  it('can_approve=false — 버튼 없이 무권한 사유 문구만 보인다(fail-closed, gates/[id]/page.tsx와 동일 규칙)', async () => {
    stubGate({ can_approve: false });
    await act(async () => {
      root.render(wrap(<ChatBubble message={approvalMessage} isMine={false} />));
    });
    expect(container.textContent).toContain('승인할 권한이 없습니다');
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent?.includes('승인'))).toBe(false);
  });

  it('story #2625 — 고위험(risk_grade=high)도 챗 안에서 서명 플로우로 완결된다(링크 위임 아님)', async () => {
    stubGate({ risk_grade: 'high' });
    await act(async () => {
      root.render(wrap(<ChatBubble message={approvalMessage} isMine={false} />));
    });
    // 링크 위임 UX는 선생님 실사용 판정으로 폐기됐다(gate 34af76dc) — 더 이상 없어야 한다.
    expect(container.querySelector(`a[href="/gates/${GATE_ID}"]`)).toBeNull();
    // GateSignatureApproval이 그대로(사본 아님) 얹힌다 — 근거 확인 체크박스+사유 textarea.
    expect(container.textContent).toContain('위 근거를 확인했습니다');
    const signBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('승인하고 서명'))!;
    expect(signBtn).not.toBeUndefined();
    // 카디르 QA(320/375px 실측) 재발방지 — compact=true가 실제로 전달돼 버튼이 세로 스택
    // full-width로 렌더되는지(가로 2버튼이면 라벨이 좁은 챗 폭에서 잘린다, 재발가드).
    expect(signBtn.className).toContain('w-full');
    expect(signBtn.parentElement?.className).toContain('flex-col');
    // AC: 근거 확인+사유 전에는 서명 비활성(gate-signature-approval.tsx의 canSign 그대로 상속).
    expect(signBtn.hasAttribute('disabled')).toBe(true);
  });

  it('story #2625 — 근거 확인+사유 입력 후 «승인하고 서명»이 transition POST에 사유를 note로 싣는다', async () => {
    stubGate({ risk_grade: 'high' });
    await act(async () => {
      root.render(wrap(<ChatBubble message={approvalMessage} isMine={false} />));
    });
    const checkbox = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      checkbox.click();
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      nativeSetter.call(textarea, '근거 확인함, 승인');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const signBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('승인하고 서명'))!;
    expect(signBtn.hasAttribute('disabled')).toBe(false);
    await act(async () => { signBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => {});

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const transitionCall = fetchMock.mock.calls.find((call: unknown[]) => (call[0] as string).includes('/transition'));
    expect(JSON.parse((transitionCall![1] as { body: string }).body)).toEqual({ status: 'approved', note: '근거 확인함, 승인', evidence_viewed: true, reviewed_head_sha: null });
  });

  it('이미 처리된 게이트(status=approved)는 버튼 없이 처리됨 상태만 보인다', async () => {
    stubGate({ status: 'approved' });
    await act(async () => {
      root.render(wrap(<ChatBubble message={approvalMessage} isMine={false} />));
    });
    expect(container.textContent).toContain('처리됨');
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent?.includes('승인'))).toBe(false);
  });

  it('story #2624 — 처리됨 상태에 raw 영문 토큰 대신 한글 라벨이 보인다(승인됨/반려됨)', async () => {
    stubGate({ status: 'rejected' });
    await act(async () => {
      root.render(wrap(<ChatBubble message={approvalMessage} isMine={false} />));
    });
    expect(container.textContent).toContain('반려됨');
    expect(container.textContent).not.toContain('rejected');
  });

  it('story #2624 — resolution_note가 있으면 처리됨 상태 아래 사유가 렌더된다("사유는 남겨놨는데" 인시던트 대응)', async () => {
    stubGate({ status: 'rejected', resolution_note: '근거가 불충분합니다' });
    await act(async () => {
      root.render(wrap(<ChatBubble message={approvalMessage} isMine={false} />));
    });
    expect(container.textContent).toContain('근거가 불충분합니다');
  });

  it('story #2624 — resolution_note가 없으면(승인·사유 미기재) 사유 줄 자체를 안 그린다(지어내지 않음)', async () => {
    stubGate({ status: 'approved', resolution_note: null });
    await act(async () => {
      root.render(wrap(<ChatBubble message={approvalMessage} isMine={false} />));
    });
    expect(container.textContent).not.toContain('사유:');
  });

  it('게이트 404(삭제 등) — 조용히 죽지 않고 정직한 미발견 문구를 보인다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })));
    await act(async () => {
      root.render(wrap(<ChatBubble message={approvalMessage} isMine={false} />));
    });
    expect(container.textContent).toContain('찾을 수 없습니다');
  });

  it('story #2627 — 카드 제목 클릭 시 doc 본문이 챗 안 모달로 열린다(기존 EntityPreviewModal 재사용)', async () => {
    stubGate({ risk_grade: 'high' });
    await act(async () => {
      root.render(wrap(<ChatBubble message={approvalMessage} isMine={false} />));
    });
    const titleBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.includes('제안서.md'))!;
    await act(async () => { titleBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => {});
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.body.textContent).toContain('승인 근거가 여기 있습니다');
  });

  it('story #2627 AC③ — 모달 열람 후 닫아도 서명 플로우에 입력 중이던 근거확인·사유가 유실되지 않는다', async () => {
    stubGate({ risk_grade: 'high' });
    await act(async () => {
      root.render(wrap(<ChatBubble message={approvalMessage} isMine={false} />));
    });
    // 서명 플로우에 먼저 입력한다.
    const checkbox = document.body.querySelector('input[type="checkbox"]') as HTMLInputElement;
    const textarea = document.body.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      checkbox.click();
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
      nativeSetter.call(textarea, '본문 확인, 승인');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    // 모달을 열었다 닫는다.
    const titleBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.includes('제안서.md'))!;
    await act(async () => { titleBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => {});
    const closeBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.querySelector('svg') && b.getAttribute('aria-label') === null && b.closest('[role="dialog"]'));
    // Dialog의 닫기(X) 대신 Escape로 확실히 닫는다(base-ui Dialog가 내장 처리).
    await act(async () => {
      document.body.querySelector('[role="dialog"]')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await act(async () => {});
    void closeBtn;
    // 체크박스·textarea 값이 그대로다 — 서명 플로우 컴포넌트가 언마운트되지 않았다.
    expect((document.body.querySelector('input[type="checkbox"]') as HTMLInputElement).checked).toBe(true);
    expect((document.body.querySelector('textarea') as HTMLTextAreaElement).value).toBe('본문 확인, 승인');
    const signBtn = Array.from(document.body.querySelectorAll('button')).find((b) => b.textContent?.includes('승인하고 서명'))!;
    expect(signBtn.hasAttribute('disabled')).toBe(false);
  });

  // story #2631(FE 계약 doc bb733f26, AC4) — 챗 카드도 결재함/상세와 동일하게 undo·discuss를
  // 노출한다. stubGate()를 그대로 재사용하되 /discuss·/undo 응답만 추가로 얹는다(다른 테스트의
  // stubGate 시그니처는 안 건드림 — 이 describe 안에서만 로컬 확장).
  function stubGateWithMutations(overrides: Parameters<typeof stubGate>[0]) {
    const gate = stubGate(overrides) as Omit<ReturnType<typeof stubGate>, 'resolver_id' | 'resolved_at'> & { resolver_id: string | null; resolved_at: string | null };
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: { method?: string; body?: string }) => {
      if (typeof url === 'string' && url.startsWith(`/api/gates/${GATE_ID}/transition`) && opts?.method === 'POST') {
        const { status } = JSON.parse(opts.body as string) as { status: string };
        gate.status = status;
        // stubGate() 자체는 resolver_id/resolved_at을 안 채운다(그 describe의 기존 테스트가
        // 필요로 하지 않았으므로) — undo 배선은 이 둘이 있어야 isUndoEligible이 true가 된다.
        gate.resolver_id = mockDashboardContext.currentTeamMemberId;
        gate.resolved_at = new Date().toISOString();
        return { ok: true, json: async () => ({ data: gate }) };
      }
      if (typeof url === 'string' && url === `/api/gates/${GATE_ID}/discuss` && opts?.method === 'POST') {
        return { ok: true, json: async () => ({ data: gate }) };
      }
      if (typeof url === 'string' && url === `/api/gates/${GATE_ID}/undo` && opts?.method === 'POST') {
        gate.status = 'pending';
        gate.resolver_id = null;
        gate.resolved_at = null;
        return { ok: true, json: async () => ({ data: gate }) };
      }
      if (typeof url === 'string' && url === `/api/gates/${GATE_ID}`) {
        return { ok: true, json: async () => ({ data: gate }) };
      }
      return { ok: false, json: async () => ({}) };
    }));
    return gate;
  }

  it('story #2631 — pending 카드에 「보류(논의 필요)」 버튼이 뜨고, 사유 제출 시 POST /discuss를 호출한다', async () => {
    stubGateWithMutations({});
    await act(async () => {
      root.render(wrap(<ChatBubble message={approvalMessage} isMine={false} />));
    });
    const discussTrigger = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(koMessages.cage.gateDiscussSubmit))!;
    expect(discussTrigger).not.toBeUndefined();
    await act(async () => { discussTrigger.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const textarea = document.body.querySelector('[data-slot="dialog-content"] textarea') as HTMLTextAreaElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(textarea, '더 확인하고 판단하겠습니다');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const submitBtn = Array.from(document.body.querySelectorAll('[data-slot="dialog-content"] button')).find((b) => b.textContent === koMessages.cage.gateDiscussSubmit) as HTMLButtonElement;
    await act(async () => { submitBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const discussCall = fetchMock.mock.calls.find((call: unknown[]) => (call[0] as string).includes('/discuss'));
    expect(discussCall).toBeDefined();
    expect(JSON.parse((discussCall![1] as { body: string }).body)).toEqual({ reason: '더 확인하고 판단하겠습니다' });
  });

  it('story #2631 — 승인 직후(본인·5분 이내) 취소 버튼이 뜨고, 클릭 시 POST /undo 호출 후 승인/반려 버튼으로 되돌아간다', async () => {
    stubGateWithMutations({});
    await act(async () => {
      root.render(wrap(<ChatBubble message={approvalMessage} isMine={false} />));
    });
    const approveBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('승인'))!;
    await act(async () => { approveBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => {});
    expect(container.textContent).toContain('처리됨');

    const undoBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(koMessages.cage.gateUndo));
    expect(undoBtn).not.toBeUndefined();
    await act(async () => { undoBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => {});

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock.mock.calls.some((call: unknown[]) => (call[0] as string).includes('/undo') && (call[1] as { method?: string })?.method === 'POST')).toBe(true);
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent?.includes('승인'))).toBe(true);
  });

  describe('story #2637 AC4(PO 08-14 확定) — resolved 분기 preset.gate.verdict block_template 부분 소비', () => {
    // 0251 마이그(develop 상륙) 실물 그대로 — 대상 필드 value가 work_item_title로 정정된 것.
    const GATE_VERDICT_TEMPLATE = {
      blocks: [
        { type: 'header', text: '게이트 판정' },
        { type: 'text', text: '**{{payload.gate_type}}** 게이트 — **{{payload.verdict}}**' },
        { type: 'fields', fields: [
          { label: '대상', value: '{{payload.work_item_title}}' },
          { label: '사유', value: '{{payload.resolution_note}}' },
        ] },
      ],
    };
    const withGateVerdictCatalog = { 'preset.gate.verdict': { key: 'preset.gate.verdict', org_id: null, payload_schema: {}, routing: {}, block_template: GATE_VERDICT_TEMPLATE, enabled: true, version: 2 } };

    it('resolved + 카탈로그에 템플릿 있음 — 대상은 UUID가 아니라 fetched title, 사유는 fields로, 상태는 한글 verdict 라벨로 렌더된다(header는 부분소비 제외)', async () => {
      stubGate({ status: 'approved', title: '제안서.md', resolution_note: '근거가 충분합니다' });
      await act(async () => {
        root.render(wrap(<ChatBubble message={approvalMessage} isMine={false} eventDefinitionsByKey={withGateVerdictCatalog} />));
      });
      // story #2926(P0-F F1) — Q3(카드 라벨은 그대로)의 실현 방식이 바뀌었다: 정적 「결재
      // 요청」 텍스트 행 대신 ProofCapsule stateLabel(resolved="승인됨", 아래서 검증)이
      // 카드 정체성을 잇는다 — 카드 자체가 사라지거나 라벨 없이 뜨는 게 아니라는 Q3 취지는
      // 유지, 표현 수단만 shape+stateLabel로 옮겨갔다.
      expect(container.textContent).not.toContain('게이트 판정'); // header는 부분소비 제외.
      expect(container.textContent).not.toContain(DOC_ID); // Q2 — UUID 노출 금지.
      expect(container.textContent).toContain('doc_approval');
      expect(container.textContent).toContain('승인됨'); // verdict 합성값 = 현행 한글 라벨.
      expect(container.textContent).toContain('근거가 충분합니다');
      // '제안서.md'는 카드 상단 제목(기존)과 fields 대상 값(신규) 둘 다에 나타난다 — 중복 등장 자체가
      // 정상(같은 개념 두 자리 표시), 최소 1회 이상만 확認.
      expect(container.textContent).toContain('제안서.md');
    });

    it('PO 리뷰(head 81f7e4a7e) — resolved + 템플릿 있음 + resolution_note 없음(승인·사유 미기재) — 사유 행 자체가 안 뜬다(⟨missing⟩ 마커 노출 금지, 기존 카드와 동형 비회귀)', async () => {
      stubGate({ status: 'approved', title: '제안서.md', resolution_note: null });
      await act(async () => {
        root.render(wrap(<ChatBubble message={approvalMessage} isMine={false} eventDefinitionsByKey={withGateVerdictCatalog} />));
      });
      expect(container.textContent).toContain('승인됨');
      expect(container.textContent).not.toContain('⟨missing');
      expect(container.textContent).not.toContain('사유:');
    });

    it('resolved + 카탈로그에 preset.gate.verdict 없음(구정의·미시딩) — 기존 하드코딩 렌더로 폴백(비회귀)', async () => {
      stubGate({ status: 'rejected', resolution_note: '근거가 불충분합니다' });
      await act(async () => {
        root.render(wrap(<ChatBubble message={approvalMessage} isMine={false} eventDefinitionsByKey={{}} />));
      });
      expect(container.textContent).toContain('반려됨');
      expect(container.textContent).toContain('근거가 불충분합니다');
      expect(container.textContent).not.toContain('게이트 판정');
    });

    it('Q1 — pending 상태는 카탈로그에 템플릿이 있어도 영향받지 않는다(제목·뱃지·버튼 그대로)', async () => {
      stubGate({});
      await act(async () => {
        root.render(wrap(<ChatBubble message={approvalMessage} isMine={false} eventDefinitionsByKey={withGateVerdictCatalog} />));
      });
      expect(container.textContent).toContain('제안서.md');
      expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent?.includes('승인'))).toBe(true);
      expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent?.includes('반려'))).toBe(true);
      expect(container.textContent).not.toContain('게이트 판정');
    });
  });
});

describe('ChatBubble — story #2637 event_definitions block_template 카드', () => {
  const EVENT_MESSAGE: ChatMessage = {
    ...baseMessage,
    content: '[이벤트] preset.work.status_changed\n- work_item_type: story\n- from_status: in-progress\n- to_status: in-review',
    sender_type: 'agent',
    event: {
      event_key: 'preset.work.status_changed',
      payload: { work_item_type: 'story', from_status: 'in-progress', to_status: 'in-review', work_item_id: 'S-42' },
    },
  };

  const VALID_TEMPLATE = {
    blocks: [
      { type: 'header', text: '작업 상태 변경' },
      { type: 'text', text: '**{{payload.work_item_type}}** `{{payload.from_status}}` → `{{payload.to_status}}`' },
      { type: 'fields', fields: [{ label: '대상', value: '{{payload.work_item_id}}' }, { label: '메모', value: '{{payload.note}}' }] },
      { type: 'actions', actions: [{ label: '확認', action: 'publish', definition_key: 'preset.work.escalate', auth: { human_only: true } }] },
    ],
  };

  it('event 필드 없는 일반 메시지는 카드가 안 뜬다(비회귀)', async () => {
    await act(async () => {
      root.render(wrap(<ChatBubble message={baseMessage} isMine={false} />));
    });
    expect(container.textContent).not.toContain('작업 상태 변경');
  });

  it('eventDefinitionsByKey 미제공(undefined) — 제네릭 폴백 content 그대로(AC2 비회귀)', async () => {
    await act(async () => {
      root.render(wrap(<ChatBubble message={EVENT_MESSAGE} isMine={false} />));
    });
    expect(container.textContent).toContain('[이벤트] preset.work.status_changed');
  });

  it('PO 리뷰(head 80319636c ①) — 폴백은 EventBlockCard 자체 렌더가 아니라 기존 ChatMarkdown 경로를 그대로 탄다("- " 목록이 <li> 불릿으로 렌더, 하이픈 리터럴로 후퇴 안 함)', async () => {
    await act(async () => {
      root.render(wrap(<ChatBubble message={EVENT_MESSAGE} isMine={false} />));
    });
    const items = Array.from(container.querySelectorAll('li')).map((li) => li.textContent);
    expect(items).toEqual(expect.arrayContaining([
      expect.stringContaining('work_item_type: story'),
      expect.stringContaining('from_status: in-progress'),
      expect.stringContaining('to_status: in-review'),
    ]));
  });

  it('event_key가 카탈로그에 없으면(구 정의 삭제 등) 제네릭 폴백', async () => {
    await act(async () => {
      root.render(wrap(<ChatBubble message={EVENT_MESSAGE} isMine={false} eventDefinitionsByKey={{}} />));
    });
    expect(container.textContent).toContain('[이벤트] preset.work.status_changed');
  });

  it('정의는 있으나 block_template이 null이면 제네릭 폴백', async () => {
    await act(async () => {
      root.render(wrap(
        <ChatBubble
          message={EVENT_MESSAGE} isMine={false}
          eventDefinitionsByKey={{ 'preset.work.status_changed': { key: 'preset.work.status_changed', org_id: null, payload_schema: {}, routing: {}, block_template: null, enabled: true, version: 1 } }}
        />,
      ));
    });
    expect(container.textContent).toContain('[이벤트] preset.work.status_changed');
  });

  it('block_template이 있으면 header/text/fields를 payload로 치환해 렌더한다(제네릭 텍스트 대신)', async () => {
    await act(async () => {
      root.render(wrap(
        <ChatBubble
          message={EVENT_MESSAGE} isMine={false}
          eventDefinitionsByKey={{ 'preset.work.status_changed': { key: 'preset.work.status_changed', org_id: null, payload_schema: {}, routing: {}, block_template: VALID_TEMPLATE, enabled: true, version: 1 } }}
        />,
      ));
    });
    expect(container.textContent).not.toContain('[이벤트] preset.work.status_changed');
    expect(container.textContent).toContain('작업 상태 변경');
    expect(container.textContent).toContain('story');
    expect(container.textContent).toContain('in-progress');
    expect(container.textContent).toContain('in-review');
    expect(container.textContent).toContain('S-42');
    // note는 payload에 없다 — 명시 플레이스홀더(조용한 공백 금지, AC0-b).
    expect(container.textContent).toContain('⟨missing: payload.note⟩');
  });

  it('유나 design 스티어 2차 — text 블록의 AC0-b 인라인 마크다운(**굵게**·`코드`)이 별표/백틱 리터럴이 아니라 실제 <strong>/<code>로 렌더된다', async () => {
    await act(async () => {
      root.render(wrap(
        <ChatBubble
          message={EVENT_MESSAGE} isMine={false}
          eventDefinitionsByKey={{ 'preset.work.status_changed': { key: 'preset.work.status_changed', org_id: null, payload_schema: {}, routing: {}, block_template: VALID_TEMPLATE, enabled: true, version: 1 } }}
        />,
      ));
    });
    expect(container.textContent).not.toContain('**story**');
    expect(container.textContent).not.toContain('`in-progress`');
    const strongEl = Array.from(container.querySelectorAll('strong')).find((e) => e.textContent === 'story');
    expect(strongEl).not.toBeUndefined();
    expect(strongEl!.className).toContain('font-semibold');
    const codeEls = Array.from(container.querySelectorAll('code')).map((e) => e.textContent);
    expect(codeEls).toEqual(expect.arrayContaining(['in-progress', 'in-review']));
  });

  it('PO 리뷰(head 57316d4e7) — 단일 토큰(백틱 전체일치) 조각이 같은 렌더 패스에 연속으로 와도 둘 다 <code>로 렌더된다(공유 /g 정규식 lastIndex 회귀)', async () => {
    const consecutiveTemplate = {
      blocks: [
        { type: 'fields', fields: [{ label: 'A', value: '`onlyA`' }, { label: 'B', value: '`onlyB`' }] },
      ],
    };
    await act(async () => {
      root.render(wrap(
        <ChatBubble
          message={EVENT_MESSAGE} isMine={false}
          eventDefinitionsByKey={{ 'preset.work.status_changed': { key: 'preset.work.status_changed', org_id: null, payload_schema: {}, routing: {}, block_template: consecutiveTemplate, enabled: true, version: 1 } }}
        />,
      ));
    });
    expect(container.textContent).not.toContain('`onlyA`');
    expect(container.textContent).not.toContain('`onlyB`');
    const codeEls = Array.from(container.querySelectorAll('code')).map((e) => e.textContent);
    expect(codeEls).toEqual(expect.arrayContaining(['onlyA', 'onlyB']));
  });

  it('story #2637 유나 design 스티어 — ⟨missing⟩ 마커는 콘텐츠와 구분되는 에러 상태 스타일(solid text-warning-strong, 알파·빨강 금지)로 렌더된다', async () => {
    await act(async () => {
      root.render(wrap(
        <ChatBubble
          message={EVENT_MESSAGE} isMine={false}
          eventDefinitionsByKey={{ 'preset.work.status_changed': { key: 'preset.work.status_changed', org_id: null, payload_schema: {}, routing: {}, block_template: VALID_TEMPLATE, enabled: true, version: 1 } }}
        />,
      ));
    });
    const markerEl = Array.from(container.querySelectorAll('em')).find((e) => e.textContent === '⟨missing: payload.note⟩');
    expect(markerEl).not.toBeUndefined();
    expect(markerEl!.className).toContain('text-warning-strong');
    expect(markerEl!.className).not.toContain('text-destructive');
  });

  it('human_only 액션 — human 뷰어면 발행 버튼이 보인다', async () => {
    mockDashboardContext = { ...mockDashboardContext, currentMemberType: 'human' };
    await act(async () => {
      root.render(wrap(
        <ChatBubble
          message={EVENT_MESSAGE} isMine={false}
          eventDefinitionsByKey={{ 'preset.work.status_changed': { key: 'preset.work.status_changed', org_id: null, payload_schema: {}, routing: {}, block_template: VALID_TEMPLATE, enabled: true, version: 1 } }}
        />,
      ));
    });
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent?.includes('확認'))).toBe(true);
  });

  it('human_only 액션 — agent 뷰어면 버튼은 disabled로 보이고 보조문구로 이유를 노출한다(무음 회색 버튼 금지, UX 안내·실 보안경계는 BE)', async () => {
    mockDashboardContext = { ...mockDashboardContext, currentMemberType: 'agent' };
    await act(async () => {
      root.render(wrap(
        <ChatBubble
          message={EVENT_MESSAGE} isMine={false}
          eventDefinitionsByKey={{ 'preset.work.status_changed': { key: 'preset.work.status_changed', org_id: null, payload_schema: {}, routing: {}, block_template: VALID_TEMPLATE, enabled: true, version: 1 } }}
        />,
      ));
    });
    const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('확認'));
    expect(btn).not.toBeUndefined();
    expect(btn!.hasAttribute('disabled')).toBe(true);
    expect(container.textContent).toContain('권한이 없습니다');
  });

  it('발행 버튼 클릭 시 POST /api/events/publish가 definition_key+payload로 호출되고 완료 표시로 바뀐다', async () => {
    const fetchMock = vi.fn(async (_url: string, _opts?: { method?: string; body?: string }) => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    await act(async () => {
      root.render(wrap(
        <ChatBubble
          message={EVENT_MESSAGE} isMine={false}
          eventDefinitionsByKey={{ 'preset.work.status_changed': { key: 'preset.work.status_changed', org_id: null, payload_schema: {}, routing: {}, block_template: VALID_TEMPLATE, enabled: true, version: 1 } }}
        />,
      ));
    });
    const btn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('확認'))!;
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => {});

    expect(fetchMock).toHaveBeenCalledWith('/api/events/publish', expect.objectContaining({ method: 'POST' }));
    const call = fetchMock.mock.calls[0]!;
    expect(JSON.parse((call[1] as { body: string }).body)).toEqual({
      definition_key: 'preset.work.escalate',
      payload: { work_item_type: 'story', from_status: 'in-progress', to_status: 'in-review', work_item_id: 'S-42' },
    });
    expect(container.textContent).toContain('완료했습니다');
  });
});

// story #2037 — 이미지 첨부 클릭 → 라이트박스 진입점 배선. 비-이미지 첨부가 섞여 있어도
// 이미지끼리의 상대 순번(imageIndex)이 정확한지가 이 통합의 핵심 회귀 지점(off-by-one 위험).
describe('ChatBubble — story #2037 이미지 라이트박스 진입점', () => {
  let ioCallbacks: Array<(entries: Array<{ isIntersecting: boolean }>) => void>;

  beforeEach(() => {
    ioCallbacks = [];
    class FakeIntersectionObserver {
      constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
        ioCallbacks.push(cb);
      }
      observe = vi.fn();
      disconnect = vi.fn();
    }
    (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeIntersectionObserver;

    vi.stubGlobal('fetch', vi.fn(async (input: string) => {
      const url = new URL(String(input), 'http://localhost');
      const path = url.searchParams.get('path') ?? '';
      return { ok: true, status: 200, json: async () => ({ data: { url: `https://signed/${path}` } }) };
    }));
  });

  const twoImagesAndAFile: ChatMessage = {
    ...baseMessage,
    content: '스크린샷 두 장',
    attachments: [
      { url: 'report.pdf', name: 'report.pdf', content_type: 'application/pdf' },
      { url: 'shot-1.png', name: 'shot-1.png', content_type: 'image/png' },
      { url: 'shot-2.png', name: 'shot-2.png', content_type: 'image/png' },
    ],
  };

  it('두 번째 이미지(비-이미지 첨부가 앞에 섞여 있음)를 클릭하면 라이트박스가 "2 / 2"로 그 이미지를 연다', async () => {
    await act(async () => {
      root.render(wrap(<ChatBubble message={twoImagesAndAFile} isMine={false} />));
    });
    // 두 이미지 썸네일 모두 뷰포트 진입 → 서명 fetch 완료.
    await act(async () => {
      ioCallbacks.forEach((cb) => cb([{ isIntersecting: true }]));
      await Promise.resolve(); await Promise.resolve();
    });

    const thumbButtons = container.querySelectorAll('button');
    // shot-2.png 썸네일(두 번째 이미지)을 alt로 식별해 클릭.
    const secondThumb = Array.from(thumbButtons).find((b) => b.getAttribute('aria-label') === 'shot-2.png');
    expect(secondThumb).toBeDefined();
    await act(async () => {
      secondThumb!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve(); await Promise.resolve();
    });

    expect(document.body.textContent).toContain('2 / 2');
    const openedImg = document.querySelector('img[data-next-image="true"][alt="shot-2.png"]');
    expect(openedImg?.getAttribute('src')).toBe('https://signed/shot-2.png');
  });
});

// story #2669(B2) — 문서 참조 칩(EntityChip)에 상태별 결재 CTA 상시 부착. PO 근거: 챗에
// 문서를 임베드하고 "승인 주시면"이라 말로 때움 — 기제가 «찾아가야 있는 것»이면 안 쓰인다.
describe('ChatBubble — story #2669(B2) doc 칩 결재 CTA', () => {
  const DOC_STATUS_KEY = `doc:${DOC_ID.toLowerCase()}`;

  it('story #3004(선생님 정책 확定) — draft + project 멤버는 "결재자 지정하고 올리기" 링크가 뜨고 문서 페이지로 딥링크한다(직접 제출 없음)', async () => {
    mockDashboardContext.projectMemberships = [{ projectId: 'doc-proj-1', projectName: 'Doc Project' }];
    const calls: { url: string; method?: string; body?: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      calls.push({ url, method: init?.method, body: init?.body });
      if (url.startsWith('/api/docs/preview')) return { ok: true, json: async () => ({ data: { projectId: 'doc-proj-1' } }) };
      return { ok: false, json: async () => ({}) };
    }));
    await act(async () => {
      root.render(wrap(
        <ChatBubble
          message={{ ...baseMessage, references: [{ target_type: 'doc', target_id: DOC_ID }] }}
          isMine={false}
          entityStatusByKey={{ [DOC_STATUS_KEY]: { kind: 'resolved', raw: 'draft' } }}
        />,
      ));
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });

    // story #3004 — approver_member_id가 서버 필수가 되며 이 인라인 칩은 더 이상 직접
    // 제출하지 않는다(픽커를 놓을 공간이 없다 — Pedro 리뷰 PR #3435). 문서 페이지
    // (doc-gate-section.tsx, 픽커 실물 보유)로 route-first 딥링크한다.
    const goToDocLink = Array.from(container.querySelectorAll('a')).find((a) => a.textContent === '결재자 지정하고 올리기');
    expect(goToDocLink).toBeDefined();
    expect(goToDocLink!.getAttribute('href')).toBe(`/docs?id=${DOC_ID}`);
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === '결재로 올리기')).toBe(false);
    expect(calls.some((c) => c.url === `/api/docs/${DOC_ID}/transition`)).toBe(false);
  });

  it('draft지만 doc의 project 멤버가 아니면 "결재자 지정하고 올리기" 링크가 안 뜬다(fail-closed)', async () => {
    mockDashboardContext.projectMemberships = [{ projectId: 'other-proj', projectName: 'Other' }];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/docs/preview')) return { ok: true, json: async () => ({ data: { projectId: 'doc-proj-1' } }) };
      return { ok: false, json: async () => ({}) };
    }));
    await act(async () => {
      root.render(wrap(
        <ChatBubble
          message={{ ...baseMessage, references: [{ target_type: 'doc', target_id: DOC_ID }] }}
          isMine={false}
          entityStatusByKey={{ [DOC_STATUS_KEY]: { kind: 'resolved', raw: 'draft' } }}
        />,
      ));
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    expect(Array.from(container.querySelectorAll('a')).some((a) => a.textContent === '결재자 지정하고 올리기')).toBe(false);
  });

  it('draft + 권한조회(preview) 실패 — 조용히 무권한 취급(링크 노출 안 함, 카드 자체는 안 죽음)', async () => {
    mockDashboardContext.projectMemberships = [{ projectId: 'doc-proj-1', projectName: 'Doc Project' }];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    await act(async () => {
      root.render(wrap(
        <ChatBubble
          message={{ ...baseMessage, references: [{ target_type: 'doc', target_id: DOC_ID }] }}
          isMine={false}
          entityStatusByKey={{ [DOC_STATUS_KEY]: { kind: 'resolved', raw: 'draft' } }}
        />,
      ));
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    expect(Array.from(container.querySelectorAll('a')).some((a) => a.textContent === '결재자 지정하고 올리기')).toBe(false);
    expect(container.textContent).toContain('제안서.md');
  });

  it('pending — "결재함에서 보기" 딥링크가 /inbox?tab=gates로 간다(상신 버튼은 안 뜸)', async () => {
    await act(async () => {
      root.render(wrap(
        <ChatBubble
          message={{ ...baseMessage, references: [{ target_type: 'doc', target_id: DOC_ID }] }}
          isMine={false}
          entityStatusByKey={{ [DOC_STATUS_KEY]: { kind: 'resolved', raw: 'pending' } }}
        />,
      ));
      await Promise.resolve(); await Promise.resolve();
    });
    const link = Array.from(container.querySelectorAll('a')).find((a) => a.textContent === '결재함에서 보기');
    expect(link?.getAttribute('href')).toBe('/inbox?tab=gates');
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === '결재로 올리기')).toBe(false);
  });

  it('denied — 배지가 "반려됨"으로 정직하게 뜨고 CTA는 없다', async () => {
    await act(async () => {
      root.render(wrap(
        <ChatBubble
          message={{ ...baseMessage, references: [{ target_type: 'doc', target_id: DOC_ID }] }}
          isMine={false}
          entityStatusByKey={{ [DOC_STATUS_KEY]: { kind: 'resolved', raw: 'denied' } }}
        />,
      ));
      await Promise.resolve(); await Promise.resolve();
    });
    // story #2886(S2b) — 상태 배지는 격납(hover/focus tooltip)으로 이동.
    await act(async () => { container.querySelectorAll('button')[0]!.focus(); });
    expect(document.body.textContent).toContain('반려됨');
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === '결재로 올리기')).toBe(false);
    expect(Array.from(container.querySelectorAll('a')).some((a) => a.textContent === '결재함에서 보기')).toBe(false);
  });

  it('confirmed — 배지가 "확定"으로 뜨고 CTA는 없다', async () => {
    await act(async () => {
      root.render(wrap(
        <ChatBubble
          message={{ ...baseMessage, references: [{ target_type: 'doc', target_id: DOC_ID }] }}
          isMine={false}
          entityStatusByKey={{ [DOC_STATUS_KEY]: { kind: 'resolved', raw: 'confirmed' } }}
        />,
      ));
      await Promise.resolve(); await Promise.resolve();
    });
    // story #2886(S2b) — 상태 배지는 격납(hover/focus tooltip)으로 이동.
    await act(async () => { container.querySelectorAll('button')[0]!.focus(); });
    expect(document.body.textContent).toContain('확定');
    expect(Array.from(container.querySelectorAll('button')).some((b) => b.textContent === '결재로 올리기')).toBe(false);
  });

  // story #3004 — 이 인라인 칩은 더 이상 직접 transition을 쏘지 않는다(위 route-first 테스트
  // 참조) — "상신 실패(transition 500)" 시나리오 자체가 이 컴포넌트에서 도달 불가가 됐다.
  // 실패 처리 책임은 doc-gate-section.tsx(문서 페이지, 실제 제출 지점)로 옮겨갔다.
});

// story #2671 — EmbedCard(ME-S5 원조 카드, "메모 기능 퇴역" PR#924 이후 실 렌더 경로 0건이던
// built-but-nowhere-to-run)를 되살린 지점. 참조 링크 하나뿐인 문단만 카드로 바뀐다 — 본문에
// 섞인 인라인 참조는 위 스위트 전부가 그대로 증명하듯 EntityChip 그대로다(회귀 0).
describe('ChatBubble — story #2671 EmbedCard 단독 참조 문단 카드 렌더', () => {
  it('참조 링크 하나뿐인 문단(doc)은 EmbedCard로 렌더된다(카드 전용 미리보기 아이콘 버튼 존재)', async () => {
    await act(async () => {
      root.render(wrap(
        <ChatBubble
          message={{ ...baseMessage, content: `[제안서.md](entity:doc:${DOC_ID})`, references: [{ target_type: 'doc', target_id: DOC_ID }] }}
          isMine={false}
        />,
      ));
    });
    // EmbedCard doc 분기 전용 마커 — EntityChip엔 이 아이콘 버튼이 없다.
    expect(container.querySelector('button[aria-label="미리보기"]')).not.toBeNull();
    // 카드(block, rounded-md) — 칩(inline, rounded)과 다른 시각 클래스.
    expect(container.querySelector('.rounded-md')).not.toBeNull();
    expect(container.textContent).toContain('제안서.md');
  });

  it('참조 링크 하나뿐인 문단(story·non-doc)도 EmbedCard로 렌더된다', async () => {
    const storyId = '33333333-3333-3333-3333-333333333333';
    await act(async () => {
      root.render(wrap(
        <ChatBubble
          message={{ ...baseMessage, content: `[스토리 제목](entity:story:${storyId})`, references: [{ target_type: 'story', target_id: storyId }] }}
          isMine={false}
        />,
      ));
    });
    expect(container.querySelector('.rounded-md')).not.toBeNull();
    // non-doc 분기엔 미리보기 아이콘이 없다(doc 전용) — 카드 자체를 눌러 모달을 연다.
    expect(container.querySelector('button[aria-label="미리보기"]')).toBeNull();
    expect(container.textContent).toContain('스토리 제목');
  });

  // story #2905(#3322 QA 채무, 카디르 지적 2026-08-21) — 「open-panel 클릭 왕복이 레포 전체에서
  // 테스트 0건(어댑터를 no-op으로 무력화해도 전부 통과)」의 정확한 처방. sole-link EmbedCard를
  // 실제로 클릭해 onOpenReadingPanel prop이 올바른 ReadingPanelTarget 값으로 호출되는지 잰다
  // — 이 테스트가 없던 시절엔 toEmbedCardOpenPanel을 no-op으로 바꿔도 위 두 렌더 테스트는
  // 여전히 그린이었다(클릭 자체를 아무도 안 눌렀으므로).
  it('sole-link EmbedCard를 클릭하면 onOpenReadingPanel이 올바른 ReadingPanelTarget으로 호출된다(open-panel 왕복 회귀가드)', async () => {
    const storyId = '55555555-5555-5555-5555-555555555556';
    const onOpenReadingPanel = vi.fn();
    await act(async () => {
      root.render(wrap(
        <ChatBubble
          message={{ ...baseMessage, content: `[스토리 제목](entity:story:${storyId})`, references: [{ target_type: 'story', target_id: storyId }] }}
          isMine={false}
          onOpenReadingPanel={onOpenReadingPanel}
        />,
      ));
    });
    const cardButton = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('스토리 제목'));
    expect(cardButton).toBeTruthy();
    await act(async () => { cardButton!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onOpenReadingPanel).toHaveBeenCalledTimes(1);
    expect(onOpenReadingPanel).toHaveBeenCalledWith({
      kind: 'entity',
      entityType: 'story',
      entityId: storyId,
      title: '스토리 제목',
      status: null,
      href: '/board?story=' + storyId,
    });
  });

  // story #2905(S2c②) — gate 단건 sole-link 참조는 EmbedCard 대신 approval-request-card.tsx가
  // 그대로 뜬다(§8 "표면은 둘·실체는 하나", 승인 로직 사본 분화 금지 — PO 판정).
  it('참조 링크 하나뿐인 문단(gate)은 EmbedCard가 아니라 ApprovalRequestCard(결재 요청 카드)로 렌더된다', async () => {
    const gateId = '44444444-4444-4444-4444-444444444444';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === `/api/gates/${gateId}`) {
        return {
          ok: true,
          json: async () => ({
            data: {
              id: gateId, status: 'pending', gate_type: 'doc_approval', risk_grade: 'low',
              work_item_type: 'doc', work_item_id: 'wi-1', can_approve: true,
              work_item_summary: { title: '기획안 v2', slug: null },
              resolver_id: null, resolved_at: null, resolution_note: null, neutral_facts: null,
            },
          }),
        };
      }
      return { ok: false, json: async () => ({}) };
    }));
    await act(async () => {
      root.render(wrap(
        <ChatBubble
          message={{ ...baseMessage, content: `[결재 요청](entity:gate:${gateId})`, references: [{ target_type: 'gate', target_id: gateId }] }}
          isMine={false}
        />,
      ));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    // ApprovalRequestCard 전용 마커 — "결재 요청" 라벨은 EmbedCard엔 없다.
    expect(container.textContent).toContain('기획안 v2');
    expect(container.querySelector('button[aria-label="미리보기"]')).toBeNull(); // EmbedCard doc 전용 마커 아님
  });

  it('참조가 유령(stored 참조에 없음)이면 단독 문단이어도 카드가 아니라 유령 칩(행동 0)이다', async () => {
    await act(async () => {
      root.render(wrap(
        <ChatBubble
          message={{ ...baseMessage, content: `[제안서.md](entity:doc:${DOC_ID})`, references: [] }}
          isMine={false}
        />,
      ));
    });
    expect(container.querySelector('.rounded-md')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toContain('대상이 없습니다');
  });

  it('asset 토큰은 단독 문단이어도 기존 AssetEmbedCard 그대로다(EmbedCard로 안 새어간다)', async () => {
    // 카디르군 QA 지적(PR#3086) — references:[](유령)를 쓰면 유령가드가 먼저 막아버려서
    // asset 제외 분기(`m[1] !== 'asset'`) 자체는 한 번도 안 거친 채로 그린이 뜬다(뮤테이션
    // 해서 그 분기를 지워도 이 테스트는 안 빨개짐). 실제 asset 제외를 재는 재현은 asset이
    // «유령이 아닌» 상태여야 한다 — stored 참조에 asset 엔트리를 실어 ghost가 false가 되게
    // 하고, AssetEmbedCard 전용 렌더(자산 조회 실패 폴백 문구)로 「EmbedCard로 안 갔다」를
    // 직접 확認한다(부재 아닌 양성 마커).
    await act(async () => {
      root.render(wrap(
        <ChatBubble
          message={{ ...baseMessage, content: `[파일.png](entity:asset:${DOC_ID})`, references: [{ target_type: 'asset', target_id: DOC_ID }] }}
          isMine={false}
        />,
      ));
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    expect(container.querySelector('button[aria-label="미리보기"]')).toBeNull();
    expect(container.querySelector('.rounded-md')).not.toBeNull();
    // AssetEmbedCard의 실 렌더 마커(자산 조회 실패 폴백 문구) — EmbedCard로 샜다면 절대 안 뜬다.
    expect(container.textContent).toContain('자산을 찾을 수 없습니다');
  });

  it('같은 문단에 참조 외 텍스트가 섞여 있으면(단독 아님) 카드가 아니라 인라인 칩이다(회귀 0)', async () => {
    await act(async () => {
      root.render(wrap(
        <ChatBubble
          message={{ ...baseMessage, content: `참고: [제안서.md](entity:doc:${DOC_ID})`, references: [{ target_type: 'doc', target_id: DOC_ID }] }}
          isMine={false}
        />,
      ));
    });
    expect(container.querySelector('.rounded-md')).toBeNull();
    expect(container.querySelector('button[aria-label="미리보기"]')).toBeNull();
    expect(container.textContent).toContain('참고:');
    expect(container.textContent).toContain('제안서.md');
  });
});

// story #2905(S2c③④ 착수 전 안전망 — 페드루 지시 2026-08-21) — 「연속 sole-link 문단
// 그룹핑(캐러셀/간결리스트/접힌 헤더)」은 ChatMarkdown 진입점 자체를 바꾸는 축이라(전 메시지
// 렌더 경로) 회귀 반경이 넓다. 시안(유나양) 착지 전까지 지금 "그룹핑 미착수" 상태의 실제
// 동작을 characterization test로 고정해 둔다 — ③④ 구현 시 이 스위트가 "의도한 대로 바뀐
// 지점"과 "실수로 깨진 지점"을 가른다.
// story #2905 S2c③④(#3310 베이스라인 → 그룹핑 착지 후 rebase, 2026-08-22) — 이 스위트가
// «오늘은 그룹핑 없음»으로 고정해 둔 4건 중 2건(같은 타입 연속)의 기대값이 실제로 뒤집혔다.
// 페드루 지시: 그 뒤집힘이 diff에 명시적으로 드러나야 이 그물의 원 설계 취지(#3310의
// "③④ 구현 시 이 스위트가 의도한 변경과 실수를 가른다")가 선다 — .rounded-md 카운트만
// 보는 낡은 단언은 EmbedGroup(ConciseList/ArtifactCarousel)이 내부적으로도 EmbedCard를
// 재사용하는 바람에 숫자가 우연히 그대로 맞아 "말없이 통과"할 뻔했다(실측으로 확認) — 그룹
// wrapper(.space-y-1.5·overflow-x-auto) 존재 여부로 뮤테이션 감지력을 되살린다. 그대로 남는
// 2건(다른 타입 섞임·산문 단절)은 §3 delta의 두 불변식을 재확認하는 자리로 성격이 바뀐다.
describe('ChatBubble — story #2905 S2c③④ 다중 sole-link 문단(그룹핑 착지 후, #3310 베이스라인 뒤집힘 명시)', () => {
  it('연속된 같은 타입(story) sole-link 문단 2개 — 이제 EmbedGroup(간결 리스트)으로 묶여 렌더된다(베이스라인 뒤집힘)', async () => {
    const idA = '55555555-5555-5555-5555-555555555551';
    const idB = '55555555-5555-5555-5555-555555555552';
    await act(async () => {
      root.render(wrap(
        <ChatBubble
          message={{
            ...baseMessage,
            content: `[스토리 A](entity:story:${idA})\n\n[스토리 B](entity:story:${idB})`,
            references: [{ target_type: 'story', target_id: idA }, { target_type: 'story', target_id: idB }],
          }}
          isMine={false}
        />,
      ));
    });
    // 간결 리스트 그룹 wrapper(embed-group.tsx ConciseList)가 정확히 1개 — 개별 <p> 2개로
    // 흩어지지 않고 하나의 그룹으로 묶였다는 것 자체가 이 테스트의 요지.
    expect(container.querySelectorAll('.space-y-1\\.5')).toHaveLength(1);
    const cards = container.querySelectorAll('.rounded-md');
    expect(cards).toHaveLength(2);
    expect(container.textContent).toContain('스토리 A');
    expect(container.textContent).toContain('스토리 B');
    // 그룹 안에서도 렌더 순서=본문 순서는 유지된다.
    expect(container.textContent!.indexOf('스토리 A')).toBeLessThan(container.textContent!.indexOf('스토리 B'));
  });

  it('연속된 서로 다른 타입(doc·story) sole-link 문단 2개 — §3 delta 「타입별 서브그룹」 불변식대로 여전히 각자 독립 렌더된다(그룹 대상 아님)', async () => {
    const docId = DOC_ID;
    const storyId = '55555555-5555-5555-5555-555555555553';
    await act(async () => {
      root.render(wrap(
        <ChatBubble
          message={{
            ...baseMessage,
            content: `[문서](entity:doc:${docId})\n\n[스토리](entity:story:${storyId})`,
            references: [{ target_type: 'doc', target_id: docId }, { target_type: 'story', target_id: storyId }],
          }}
          isMine={false}
        />,
      ));
    });
    expect(container.querySelectorAll('.rounded-md')).toHaveLength(2);
    // doc 전용 마커(미리보기 버튼)가 정확히 doc 카드에만 붙는다 — 타입별 폼이 안 섞였는지.
    expect(container.querySelectorAll('button[aria-label="미리보기"]')).toHaveLength(1);
    // 그룹 조건(같은 타입+2개↑)을 각자 1개씩만 채워 미달 — EmbedGroup wrapper가 안 생긴다.
    expect(container.querySelectorAll('.space-y-1\\.5')).toHaveLength(0);
  });

  it('산문으로 떨어진(연속 아닌) 같은 타입 sole-link 문단 2개 — §3 delta 「산문 문단만 run을 끊는다」 불변식대로 오늘도 앞으로도 그룹핑 영구 비대상(각자 독립)', async () => {
    const idA = '55555555-5555-5555-5555-555555555554';
    const idB = '55555555-5555-5555-5555-555555555555';
    await act(async () => {
      root.render(wrap(
        <ChatBubble
          message={{
            ...baseMessage,
            content: `[스토리 A](entity:story:${idA})\n\n중간에 낀 산문 한 줄.\n\n[스토리 B](entity:story:${idB})`,
            references: [{ target_type: 'story', target_id: idA }, { target_type: 'story', target_id: idB }],
          }}
          isMine={false}
        />,
      ));
    });
    expect(container.querySelectorAll('.rounded-md')).toHaveLength(2);
    expect(container.textContent).toContain('중간에 낀 산문 한 줄.');
    // 산문이 run을 끊어 그룹 wrapper 자체가 안 생긴다(공백줄과 달리 산문은 진짜 단절).
    expect(container.querySelectorAll('.space-y-1\\.5')).toHaveLength(0);
  });

  it('sole-link 문단 3개 연속(artifact) — 이제 가로 캐러셀(overflow-x-auto)로 격납돼 렌더된다(카드 홍수 베이스라인 뒤집힘)', async () => {
    const ids = ['66666666-6666-6666-6666-666666666661', '66666666-6666-6666-6666-666666666662', '66666666-6666-6666-6666-666666666663'];
    await act(async () => {
      root.render(wrap(
        <ChatBubble
          message={{
            ...baseMessage,
            content: ids.map((id, i) => `[아티팩트 ${i + 1}](entity:artifact:${id})`).join('\n\n'),
            references: ids.map((id) => ({ target_type: 'artifact', target_id: id })),
          }}
          isMine={false}
        />,
      ));
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    // 캐러셀 wrapper(embed-group.tsx ArtifactCarousel)가 정확히 1개 — 3장이 세로로 벽처럼
    // 흩어지지 않고 가로 스크롤 한 자리로 격납됐다는 것 자체가 이 테스트의 요지(§3 「풍부
    // 하되 격납」 불변식).
    expect(container.querySelectorAll('.overflow-x-auto')).toHaveLength(1);
    expect(container.querySelectorAll('.rounded-md')).toHaveLength(3);
  });
});

describe('ChatBubble — story #2921 S4(유나 확定, 버블·아바타 Proofline 재도장)', () => {
  const plainMessage: ChatMessage = {
    ...baseMessage,
    content: '안녕한 일반 텍스트 메시지인 — 참조 없음',
  };

  it('버블=무채 panel(내 메시지=blue-soft) — isMine이면 bg-proof-blue-soft, 아니면 bg-proof-panel', async () => {
    // ⛔bg-proof-blue-soft는 에이전트 아바타(ProofAvatar isAgent)에도 붙어 셀렉터가 겹친다 —
    // 버블 고유 모서리 클래스(rounded-tr-sm/rounded-tl-sm)와 함께 잡아 버블 자신만 특정한다.
    await act(async () => {
      root.render(wrap(<ChatBubble message={{ ...plainMessage, references: [], sender_type: 'human' }} isMine />));
    });
    expect(container.querySelector('.rounded-tr-sm.bg-proof-blue-soft')).toBeTruthy();
    expect(container.querySelector('.rounded-tr-sm.bg-proof-panel')).toBeNull();
    // 옛 solid 배경+흰 글자 조합이 안 남아있다(눈에 안 보이는 흰 글자 회귀 방지).
    expect(container.querySelector('.bg-primary.text-primary-foreground')).toBeNull();

    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await act(async () => {
      root.render(wrap(<ChatBubble message={{ ...plainMessage, references: [], sender_type: 'human' }} isMine={false} />));
    });
    expect(container.querySelector('.rounded-tl-sm.bg-proof-panel')).toBeTruthy();
    expect(container.querySelector('.rounded-tl-sm.bg-proof-blue-soft')).toBeNull();
  });

  // story #2921 S4 후속(2026-08-22, 유나 합성 5규칙 확定·avatar-unification-design-memo-2921) —
  // ProofAvatar가 폐기되고 Avatar(components/shared/avatar.tsx)로 통합됐다 — 형태(circle/
  // square)·idle blue 링·human 테두리는 이제 Avatar 내부가 결정한다. 아래 2건은 그 통합
  // 결과를 잰다(옛 ProofAvatar 전용 클래스 대신 Avatar의 실 출력 클래스로 갱신).
  it('에이전트 아바타=circle+idle blue 링(Avatar 통합, 사본 분화 금지)', async () => {
    await act(async () => {
      root.render(wrap(<ChatBubble message={{ ...plainMessage, references: [], sender_type: 'agent' }} isMine={false} />));
    });
    const avatar = container.querySelector('.ring-proof-blue');
    expect(avatar).toBeTruthy();
    expect(avatar?.className).toContain('rounded-full');
    expect(avatar?.className).not.toContain('rounded-md');
  });

  it('human 아바타=square+무채 테두리(본인·상대 공통) — 에이전트만 circle+링이다', async () => {
    await act(async () => {
      root.render(wrap(<ChatBubble message={{ ...plainMessage, references: [], sender_type: 'human' }} isMine={false} />));
    });
    const avatar = container.querySelector('.border-proof-line');
    expect(avatar).toBeTruthy();
    expect(avatar?.className).toContain('rounded-md');
    expect(avatar?.className).not.toContain('rounded-full');
    expect(avatar?.className).not.toContain('ring-proof-blue');

    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await act(async () => {
      root.render(wrap(<ChatBubble message={{ ...plainMessage, references: [], sender_type: 'human' }} isMine />));
    });
    const mineAvatar = container.querySelector('.border-proof-line');
    expect(mineAvatar).toBeTruthy();
    expect(mineAvatar?.className).toContain('rounded-md');
  });
});

// story #3000 로드맵 PR-B(L5) — Bot 배지 배경은 정적(비-pulse) 정체성 마킹이라 citron이 아니라
// proof-blue-soft여야 한다(story-card 아바타·avatar.tsx idle 링과 정합).
describe('ChatBubble — 로드맵 PR-B L5(Bot 배지 배경 proof-blue-soft)', () => {
  it('story #3049(2984-S1) — agent 발신 메시지의 Bot 배지가 AgentIdentity(헤어라인+신호 dot)를 쓰고 soft-fill은 안 쓴다', async () => {
    const plainMessage: ChatMessage = { ...baseMessage, content: '봇 메시지', sender_type: 'agent' };
    await act(async () => {
      root.render(wrap(<ChatBubble message={{ ...plainMessage, references: [] }} isMine={false} />));
    });
    const badge = container.querySelector('.border-proof-line');
    expect(badge).toBeTruthy();
    expect(badge?.textContent).toBe('Bot');
    expect(badge?.className).not.toContain('bg-proof-blue-soft');
    expect(badge?.className).not.toContain('accent-claim');
    expect(badge?.querySelector('.bg-proof-blue')).toBeTruthy();
  });
});

// story #ec57c80c(v2 3호, 아티팩트 2fdc81aa) — report성 메시지 밀도 재설계(kicker+리드+
// 최상위 목록+전문 보기). 발동은 에이전트의 긴 report성 메시지만(AC1), 짧은 대화·human
// 메시지는 무변경(회귀 가드), kicker 오분류는 안전측으로 미표시(AC2, 강제 테스트).
describe('ChatBubble — story #ec57c80c report성 메시지 밀도(kicker+리드+최상위 목록+전문 보기)', () => {
  const REPORT_CONTENT = [
    '**전체 판정 — PASS**',
    '오늘 배포한 3개 표면 전부 실측 완료했는.',
    '**① 3009 — PASS**',
    '- 인라인 카드 elev-card 토큰 확認.',
    '**② 3010 — PASS**',
    '- inbox Bot칩 확認.',
    '**③ 3011 — PASS**',
    '- Workcell 잘림 fix 확認.',
  ].join('\n');

  const AMBIGUOUS_LONG_CONTENT = [
    '**진행 상황 업데이트**',
    '오늘 작업한 내용을 정리해서 공유하는.',
    '**작업 1**',
    '- 세부 내용 1',
    '**작업 2**',
    '- 세부 내용 2',
    '**작업 3**',
    '- 세부 내용 3',
  ].join('\n');

  it('짧은 agent 메시지는 무변경 — kicker/전문보기 UI 자체가 없다(AC1 회귀 가드)', async () => {
    await act(async () => {
      root.render(wrap(<ChatBubble message={{ ...baseMessage, content: '고맙는!', references: [] }} isMine={false} />));
    });
    expect(container.textContent).not.toContain('전문 보기');
    expect(container.textContent).toContain('고맙는!');
  });

  it('긴 report성 agent 메시지 + message_kind="result" — kicker "판정"+리드+최상위 목록+전문보기가 뜬다', async () => {
    await act(async () => {
      root.render(wrap(
        <ChatBubble message={{ ...baseMessage, content: REPORT_CONTENT, message_kind: 'result', references: [] }} isMine={false} />,
      ));
    });
    expect(container.textContent).toContain('판정');
    // 실렌더 harness로 적발된 회귀 — 첫 줄이 리드로도 목록 첫 항목으로도 중복 노출됐었다.
    // "전체 판정 — PASS"는 리드 한 번만 나와야 한다(목록엔 중복 제거).
    expect(container.textContent!.split('전체 판정 — PASS').length - 1).toBe(1);
    expect(container.textContent).toContain('① 3009 — PASS');
    expect(container.textContent).toContain('전문 보기');
    // 접힌 상태에선 하위 상세("인라인 카드 elev-card 토큰 확認")는 안 보여야 한다(폴딩).
    expect(container.textContent).not.toContain('인라인 카드 elev-card 토큰 확認');
  });

  // story #3052(2984-S4) — kicker는 MaterialChip(S1, 헤어라인+fill 0)을 쓴다. 옛
  // bg-proof-blue-soft 채움은 폐지.
  it('story #3052 — kicker가 MaterialChip(헤어라인)을 쓰고 bg-proof-blue-soft는 안 쓴다', async () => {
    await act(async () => {
      root.render(wrap(
        <ChatBubble message={{ ...baseMessage, content: REPORT_CONTENT, message_kind: 'result', references: [] }} isMine={false} />,
      ));
    });
    const kicker = Array.from(container.querySelectorAll('span')).find((s) => s.textContent === '판정');
    expect(kicker).toBeTruthy();
    expect(kicker?.className).toContain('border-proof-line');
    expect(kicker?.className).not.toContain('bg-proof-blue-soft');
  });

  it('「전문 보기」 클릭 시 실제로 펼쳐져 하위 상세까지 전부 보인다(정보 소실 0) — 실 클릭 시뮬레이션', async () => {
    await act(async () => {
      root.render(wrap(
        <ChatBubble message={{ ...baseMessage, content: REPORT_CONTENT, message_kind: 'result', references: [] }} isMine={false} />,
      ));
    });
    const viewFullBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('전문 보기'));
    expect(viewFullBtn).toBeTruthy();
    await act(async () => { viewFullBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    // 펼친 뒤엔 하위 상세 원문이 실제로 나타난다(폴딩 이전엔 없었던 텍스트).
    expect(container.textContent).toContain('인라인 카드 elev-card 토큰 확認');
    expect(container.textContent).toContain('접기');

    const collapseBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '접기');
    expect(collapseBtn).toBeTruthy();
    await act(async () => { collapseBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    // 다시 접으면 하위 상세가 사라지고 요약 뷰로 돌아온다.
    expect(container.textContent).not.toContain('인라인 카드 elev-card 토큰 확認');
    expect(container.textContent).toContain('전문 보기');
  });

  it('message_kind 없고 패턴도 불확실하면 — 발동은 하되(길이 조건 충족) kicker는 미표시(AC2 강제 테스트, 오분류 방지)', async () => {
    await act(async () => {
      root.render(wrap(
        <ChatBubble message={{ ...baseMessage, content: AMBIGUOUS_LONG_CONTENT, message_kind: null, references: [] }} isMine={false} />,
      ));
    });
    expect(container.textContent).toContain('전문 보기');
    expect(container.textContent).toContain('진행 상황 업데이트');
    expect(container.textContent).not.toContain('판정');
  });

  it('human 발신 메시지는 아무리 길어도 report 밀도 처리 대상이 아니다(범위=에이전트 메시지만)', async () => {
    await act(async () => {
      root.render(wrap(
        <ChatBubble
          message={{ ...baseMessage, content: REPORT_CONTENT, message_kind: 'result', sender_type: 'human', references: [] }}
          isMine={false}
        />,
      ));
    });
    expect(container.textContent).not.toContain('전문 보기');
    // 원문(하위 상세 포함)이 그대로 렌더돼야 한다 — 접힘 없음.
    expect(container.textContent).toContain('인라인 카드 elev-card 토큰 확認');
  });

  // 카디르 QA(#3448) 적출 — 첫 줄 문장 경계가 볼드 스팬 중간에 떨어지면(마침표가 "**" 안에
  // 있으면) 리드가 "**Summary."처럼 닫는 마커 없이 잘려 화면에 미완성 ** 문자가 그대로
  // 노출됐다(dedup도 이 변형에서 무력화). 실렌더로 미완성 마커 부재를 직접 확認한다.
  it('첫 줄이 볼드 스팬 중간에서 잘리는 경우에도 미완성 마커(**)가 화면에 안 샌다', async () => {
    const raw = [
      '**Summary. Done**',
      '오늘 배포한 3개 표면 전부 실측 완료했는.',
      '**① 3009 — PASS**',
      '- 인라인 카드 elev-card 토큰 확認.',
      '**② 3010 — PASS**',
      '- inbox Bot칩 확認.',
      '**③ 3011 — PASS**',
      '- Workcell 잘림 fix 확認.',
    ].join('\n');
    await act(async () => {
      root.render(wrap(<ChatBubble message={{ ...baseMessage, content: raw, message_kind: 'result', references: [] }} isMine={false} />));
    });
    expect(container.textContent).not.toContain('**');
    expect(container.textContent).toContain('Summary. Done');
    // "Summary. Done"이 리드 한 번만 나와야 한다(목록에 중복 노출 금지).
    expect(container.textContent!.split('Summary. Done').length - 1).toBe(1);
  });
});

// story #3106(#3092 후속·선생님 실화면 지적, 2026-08-26) — sender.runtime_type이 BE payload에
// 실려도 chat-bubble이 Avatar에 안 넘기면 여전히 "Agent" 폴백에 머문다. runtimeType="claude-code"
// 는 #3511(선생님 상표 확定, 이 PR과 같은 날 develop 착지)부로 아이콘 승인 커넥터라 아바타≥28
// (버블 size=28)에서 공식 아이콘 디스크로 렌더된다(avatar.test.tsx 「claude-code는 아이콘
// 승인 커넥터로 스왑됐다」 스위트와 동형 — 여기선 배지 로직이 아니라 배선만 재확인).
describe('ChatBubble — story #3106 sender_runtime_type → Avatar 배선', () => {
  it('agent sender_runtime_type이 있으면 아바타에 커넥터 공식 아이콘이 뜬다', async () => {
    await act(async () => {
      root.render(wrap(
        <ChatBubble message={{ ...baseMessage, sender_runtime_type: 'claude-code' }} isMine={false} />,
      ));
    });
    const disk = container.querySelector('.rounded-full.ring-2.ring-background');
    expect(disk?.querySelector('img')?.getAttribute('src')).toBe('/connector-icons/claude-code.jpg');
  });

  it('agent sender_runtime_type이 null(구서버·미배선)이면 여전히 "Agent" 텍스트 폴백이다(회귀 없음)', async () => {
    await act(async () => {
      root.render(wrap(
        <ChatBubble message={{ ...baseMessage, sender_runtime_type: null }} isMine={false} />,
      ));
    });
    expect(container.querySelector('.rounded-full.ring-2.ring-background')).toBeNull();
    expect(container.textContent).toContain('Agent');
  });
});
