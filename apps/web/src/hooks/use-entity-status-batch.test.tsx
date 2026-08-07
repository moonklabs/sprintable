// @vitest-environment jsdom
//
// story #2262 PR②(2026-08-08, PO 지적) — chat-view.tsx와 thread-panel.tsx가 「같은
// requestedKeysRef·같은 setEntityStatusByKey」를 공유하며 이 훅을 각자의 messages로
// 부르는 계약을 고정한다. 이전엔 스레드 답글에서만 처음 보이는 참조가 chat-view의
// messages(루트 메시지만)에 한 번도 안 잡혀 영원히 "아직 모름"에 고착됐다 — 이 훅을
// 두 번째 messages 목록으로 한 번 더 부르면 그 참조도 정확히 잡힌다는 것을 직접
// 렌더로 검증한다(정적 로직 주장이 아니라 실제 effect 왕복).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useEntityStatusBatchFetch } from './use-entity-status-batch';
import type { EntityStatusFetchState } from '@/components/chat/entity-status-labels';

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

type Ref = { target_type: string; target_id: string };
type Msg = { references?: Ref[] };

function Harness({ mainMessages, threadMessages }: { mainMessages: Msg[]; threadMessages: Msg[] }) {
  const [entityStatusByKey, setEntityStatusByKey] = useState<Record<string, EntityStatusFetchState>>({});
  const requestedKeysRef = useRef<Set<string>>(new Set());
  // chat-view.tsx 역할
  useEntityStatusBatchFetch(mainMessages, requestedKeysRef, setEntityStatusByKey);
  // thread-panel.tsx 역할 — 같은 ref·같은 setter를 공유
  useEntityStatusBatchFetch(threadMessages, requestedKeysRef, setEntityStatusByKey);
  return <div data-testid="dump">{JSON.stringify(entityStatusByKey)}</div>;
}

async function flush(times = 4) {
  await act(async () => {
    for (let i = 0; i < times; i++) await Promise.resolve();
  });
}

describe('useEntityStatusBatchFetch — 메인+스레드 두 messages를 같은 캐시로 공유(#2262 PR②)', () => {
  it('스레드 답글 전용 참조(메인 messages엔 없음)도 잡혀 resolved로 채워진다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      expect(url).toContain('/api/tasks?ids=thread-only-1');
      return { ok: true, json: async () => ({ data: [{ id: 'thread-only-1', status: 'done' }] }) };
    }));

    await act(async () => {
      root.render(
        <Harness
          mainMessages={[]}
          threadMessages={[{ references: [{ target_type: 'task', target_id: 'thread-only-1' }] }]}
        />,
      );
    });
    await flush();

    expect(container.querySelector('[data-testid="dump"]')?.textContent).toContain('"task:thread-only-1":{"kind":"resolved","raw":"done"}');
  });

  it('메인·스레드 양쪽이 같은 엔티티를 참조해도 fetch는 한 번만 나간다(공유 requestedKeysRef)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ data: [{ id: 's1', status: 'done' }] }) }));
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(
        <Harness
          mainMessages={[{ references: [{ target_type: 'story', target_id: 's1' }] }]}
          threadMessages={[{ references: [{ target_type: 'story', target_id: 's1' }] }]}
        />,
      );
    });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
