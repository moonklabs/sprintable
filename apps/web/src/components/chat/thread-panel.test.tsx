// @vitest-environment jsdom
//
// story #2262 PR②(2026-08-08, 카디르 QA 지적·PR#2911에 곁들임) — ThreadPanel이 자기
// (스레드 답글) messages를 useEntityStatusBatchFetch에 실제로 넘기는지 아무 테스트도
// 안 잡고 있었다. use-entity-status-batch.test.tsx는 훅 자체(순수 harness)만 검증해
// ThreadPanel 컴포넌트가 그 훅을 «제대로 배선했는지»는 뮤테이션으로 배선을 끊어도
// 아무 테스트도 안 걸렸다 — 라이브 코드는 정확했지만 미래 리팩터로 이 배선이 끊기면
// "스레드 고착 스피너"(#2262 PR② 본체가 고친 바로 그 결함)가 조용히 재발해도 CI가
//못 잡는 사각이었다. 이 테스트는 ThreadPanel을 실제로 마운트해 그 배선을 왕복 검증한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ThreadPanel } from './thread-panel';
import type { ChatMessage } from '@/hooks/use-chat-sse';
import type { EntityStatusFetchState } from './entity-status-labels';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/app/dashboard/dashboard-shell', () => ({
  useDashboardContext: () => ({ projectId: 'proj-1', currentTeamMemberId: 'member-1' }),
}));

// story #2671 — 참조 링크 하나뿐인 문단은 EmbedCard(카드)로 렌더된다. EmbedCard doc 클릭
// 핸들러가 useRouter()를 쓰므로 라우터 컨텍스트 없이 렌더하면 죽는다(같은 mock을
// chat-bubble.test.tsx에서도 씀).
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

const TASK_ID = '33333333-3333-3333-3333-333333333333';

const parentMessage: ChatMessage = {
  id: 'parent-1',
  memo_id: 'conv-1',
  created_by: 'agent-1',
  sender_name: '오르테가',
  sender_type: 'agent',
  sender_avatar_url: null,
  content: '원본 메시지',
  attachments: [],
  created_at: '2026-08-08T00:00:00.000Z',
};

// ThreadPanel의 own state(requestedEntityStatusKeysRef·setEntityStatusByKey)를 실제로
// 소유하는 하니스 — chat-view.tsx의 역할을 흉내낸다(props로 내려주는 쪽).
function Harness() {
  const [entityStatusByKey, setEntityStatusByKey] = useState<Record<string, EntityStatusFetchState>>({});
  const requestedKeysRef = useRef<Set<string>>(new Set());
  return (
    <ThreadPanel
      parentMessage={parentMessage}
      conversationId="conv-1"
      currentTeamMemberId="member-1"
      projectId="proj-1"
      onClose={() => {}}
      entityStatusByKey={entityStatusByKey}
      requestedEntityStatusKeysRef={requestedKeysRef}
      setEntityStatusByKey={setEntityStatusByKey}
    />
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // jsdom엔 scrollIntoView 구현이 없다 — ThreadPanel의 "로드 후 바닥 스크롤" 이펙트가
  // 이 테스트의 관심사가 아니므로 무해하게 스텁만 한다.
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

async function flush(times = 6) {
  await act(async () => {
    for (let i = 0; i < times; i++) await Promise.resolve();
  });
}

describe('ThreadPanel — 스레드 답글 전용 참조가 실제로 배치조회 훅에 넘어간다(#2262 PR② 배선 왕복)', () => {
  it('스레드 답글에서만 처음 보이는 참조가 resolved로 채워져 칩에 번역된 상태가 뜬다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/messages?thread_id=')) {
        return {
          ok: true,
          json: async () => ({
            data: [{
              id: 'reply-1',
              created_by: 'agent-2',
              sender: { id: 'agent-2', name: '유나', type: 'agent' },
              content: `[작업 A](entity:task:${TASK_ID})`,
              created_at: '2026-08-08T00:01:00.000Z',
              references: [{ target_type: 'task', target_id: TASK_ID }],
            }],
          }),
        };
      }
      if (url.includes('/api/tasks?ids=')) {
        expect(url).toContain(TASK_ID);
        return { ok: true, json: async () => ({ data: [{ id: TASK_ID, status: 'in-progress' }] }) };
      }
      return { ok: true, json: async () => ({ data: [] }) };
    }));

    await act(async () => {
      root.render(wrap(<Harness />));
    });
    await flush();

    expect(container.textContent).toContain('진행 중');
    expect(container.textContent).not.toContain('아직 모름');
  });
});

// story #2911(S2e①/R4) — 좌측 rail(원 메시지→답글 잇는 시각선) 회귀가드.
describe('ThreadPanel — story #2911 좌측 rail(R4 위계 시각화)', () => {
  it('원본 메시지 블록과 답글 목록 wrapper 둘 다 border-l-2(같은 rail 토큰)를 갖는다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/messages?thread_id=')) {
        return {
          ok: true,
          json: async () => ({
            data: [
              { id: 'reply-1', created_by: 'agent-2', sender: { id: 'agent-2', name: '유나', type: 'agent' }, content: '답글 1', created_at: '2026-08-08T00:01:00.000Z' },
              { id: 'reply-2', created_by: 'agent-2', sender: { id: 'agent-2', name: '유나', type: 'agent' }, content: '답글 2(같은 발신자 — 그룹핑)', created_at: '2026-08-08T00:02:00.000Z' },
            ],
          }),
        };
      }
      return { ok: true, json: async () => ({ data: [] }) };
    }));

    await act(async () => {
      root.render(wrap(<Harness />));
    });
    await flush();

    const railed = container.querySelectorAll('.border-l-2.border-border');
    // 원본 메시지 블록 1 + 답글 목록 wrapper 1 = 최소 2곳(개별 ChatBubble마다 따로 안 생김 —
    // AC3: 그룹핑된 답글이 rail을 분절시키지 않는다는 것 자체가 "wrapper 하나"라는 뜻).
    expect(railed.length).toBeGreaterThanOrEqual(2);
    expect(container.textContent).toContain('답글 1');
    expect(container.textContent).toContain('답글 2(같은 발신자 — 그룹핑)');
  });
});

// story #2911(S2e②③/R4) — 「s2e-thread-depth-grammar」 확定 회귀가드. ThreadPanel 헤더가
// ReadingPanel과 같은 칩 브레드크럼 문법(칩 버튼 + `›` 구분자)으로 통일됐는지, 세그먼트가
// 정확히 2개(대화 › 원 메시지 요약)인지, 원 메시지 칩은 비클릭(span, 버튼 아님)인지 잰다.
describe('ThreadPanel — story #2911(S2e②③) 헤더 칩 브레드크럼(대화 › 원 메시지 요약)', () => {
  async function mountWithNoReplies() {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) })));
    await act(async () => { root.render(wrap(<Harness />)); });
    await flush();
  }

  it('「스레드」 평문 폐기 — 헤더에 그 문구가 없다', async () => {
    await mountWithNoReplies();
    const header = container.querySelector('.border-b.border-border\\/80');
    expect(header?.textContent).not.toContain('스레드');
  });

  it('세그먼트 정확히 2개(대화·원 메시지 요약) — 구분자 `›`가 정확히 1개', async () => {
    await mountWithNoReplies();
    const header = container.querySelector('.border-b.border-border\\/80')!;
    const seps = Array.from(header.querySelectorAll('span')).filter((s) => s.textContent === '›');
    expect(seps).toHaveLength(1);
    expect(header.textContent).toContain('대화');
    expect(header.textContent).toContain('원본 메시지'); // parentMessage.content 그대로(마크다운 없음)
  });

  it('「대화」 칩은 버튼(클릭 시 onClose) — 원 메시지 요약 칩은 span(비클릭, 현재 위치)', async () => {
    const onClose = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) })));
    await act(async () => {
      root.render(wrap(
        <ThreadPanel parentMessage={parentMessage} conversationId="conv-1" currentTeamMemberId="member-1" projectId="proj-1" onClose={onClose} />,
      ));
    });
    await flush();
    const header = container.querySelector('.border-b.border-border\\/80')!;
    const convChip = Array.from(header.querySelectorAll('button')).find((b) => b.textContent?.includes('대화'));
    expect(convChip).toBeTruthy();
    await act(async () => { convChip!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onClose).toHaveBeenCalled();
    // 원 메시지 요약은 버튼이 아니라 span이어야(비클릭) 한다.
    const summarySpan = Array.from(header.querySelectorAll('span')).find((s) => s.textContent?.includes('원본 메시지'));
    expect(summarySpan?.tagName).toBe('SPAN');
  });

  it('원 메시지 요약 칩은 native title로 전문을 갖는다(truncate 대비 접근성 폴백)', async () => {
    const longMessage: ChatMessage = { ...parentMessage, content: '이것은 아주 길어서 truncate가 실제로 적용될 만한 원본 메시지 본문입니다' };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) })));
    await act(async () => {
      root.render(wrap(
        <ThreadPanel parentMessage={longMessage} conversationId="conv-1" currentTeamMemberId="member-1" projectId="proj-1" onClose={() => {}} />,
      ));
    });
    await flush();
    const header = container.querySelector('.border-b.border-border\\/80')!;
    const summarySpan = Array.from(header.querySelectorAll('span')).find((s) => s.getAttribute('title')?.includes('아주 길어서'));
    expect(summarySpan).toBeTruthy();
  });

  it('원 메시지가 마크다운 링크(sole-link 등)면 요약 칩에는 라벨만 남는다(카드/칩 중첩 방지)', async () => {
    const linkMessage: ChatMessage = { ...parentMessage, content: '[작업 A](entity:task:33333333-3333-3333-3333-333333333333)' };
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) })));
    await act(async () => {
      root.render(wrap(
        <ThreadPanel parentMessage={linkMessage} conversationId="conv-1" currentTeamMemberId="member-1" projectId="proj-1" onClose={() => {}} />,
      ));
    });
    await flush();
    const header = container.querySelector('.border-b.border-border\\/80')!;
    expect(header.textContent).toContain('작업 A');
    expect(header.textContent).not.toContain('entity:task:');
    expect(header.querySelector('button[type="button"]')).toBeTruthy(); // 대화 칩만 버튼(요약은 span)
  });
});

// 2026-08-24(선생님 리포트) — 답글을 읽어도 GNB/리스트 unread 배지 (2)가 안 꺼지는 버그 회귀가드.
// 원인: ThreadPanel이 mark-read(POST .../read)를 한 번도 호출하지 않았다(chat-view.tsx#markRead가
// top-level 메시지에만 물려있었음). chat-list-view.tsx#applyConversationMessageUpdate는 parent_id
// 구분 없이 모든 conversation.message_created(스레드 답글 포함)에서 unread_count를 올리므로,
// 답글을 읽어도 내려갈 방법이 없었다.
describe('ThreadPanel — 답글 열람 시 mark-read(onMarkRead) 배선(2026-08-24 뱃지 고착 fix)', () => {
  it('로드 완료 시 최신 답글의 created_at으로 onMarkRead를 호출한다', async () => {
    const onMarkRead = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/messages?thread_id=')) {
        return {
          ok: true,
          json: async () => ({
            data: [
              { id: 'reply-1', created_by: 'agent-2', sender: { id: 'agent-2', name: '유나', type: 'agent' }, content: '답글 1', created_at: '2026-08-08T00:01:00.000Z' },
              { id: 'reply-2', created_by: 'agent-2', sender: { id: 'agent-2', name: '유나', type: 'agent' }, content: '답글 2', created_at: '2026-08-08T00:02:00.000Z' },
            ],
          }),
        };
      }
      return { ok: true, json: async () => ({ data: [] }) };
    }));

    await act(async () => {
      root.render(wrap(
        <ThreadPanel parentMessage={parentMessage} conversationId="conv-1" currentTeamMemberId="member-1" projectId="proj-1" onClose={() => {}} onMarkRead={onMarkRead} />,
      ));
    });
    await flush();

    expect(onMarkRead).toHaveBeenCalledWith('2026-08-08T00:02:00.000Z');
  });

  it('답글이 없으면 parentMessage.created_at으로 onMarkRead를 호출한다(원 메시지만 열람)', async () => {
    const onMarkRead = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) })));

    await act(async () => {
      root.render(wrap(
        <ThreadPanel parentMessage={parentMessage} conversationId="conv-1" currentTeamMemberId="member-1" projectId="proj-1" onClose={() => {}} onMarkRead={onMarkRead} />,
      ));
    });
    await flush();

    expect(onMarkRead).toHaveBeenCalledWith(parentMessage.created_at);
  });

  it('패널이 열린 채로 신규 답글(incomingMessage)이 도착하면 그 created_at으로 onMarkRead를 재호출한다', async () => {
    const onMarkRead = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) })));

    await act(async () => {
      root.render(wrap(
        <ThreadPanel parentMessage={parentMessage} conversationId="conv-1" currentTeamMemberId="member-1" projectId="proj-1" onClose={() => {}} onMarkRead={onMarkRead} />,
      ));
    });
    await flush();
    onMarkRead.mockClear();

    const incoming: ChatMessage = {
      id: 'reply-live',
      memo_id: 'conv-1',
      created_by: 'agent-3',
      sender_name: '카디르',
      sender_type: 'agent',
      sender_avatar_url: null,
      content: '실시간 답글',
      attachments: [],
      created_at: '2026-08-08T00:05:00.000Z',
      parent_id: 'parent-1',
    };

    await act(async () => {
      root.render(wrap(
        <ThreadPanel parentMessage={parentMessage} conversationId="conv-1" currentTeamMemberId="member-1" projectId="proj-1" onClose={() => {}} onMarkRead={onMarkRead} incomingMessage={incoming} />,
      ));
    });
    await flush();

    expect(onMarkRead).toHaveBeenCalledWith('2026-08-08T00:05:00.000Z');
  });
});
