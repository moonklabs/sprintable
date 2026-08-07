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
