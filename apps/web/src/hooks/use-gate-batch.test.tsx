// @vitest-environment jsdom
//
// story #5ace2e84 — 채팅 결재카드 N+1 처방. use-entity-status-batch.test.tsx(#2262 PR②)와
// 동일 정신·동일 하네스 구조 — chat-view.tsx(메인)와 thread-panel.tsx(스레드)가 같은
// requestedIdsRef·같은 setGateByKey를 공유해 부르는 계약을 실제 렌더로 고정한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useGateBatchFetch } from './use-gate-batch';
import type { CardState } from '@/components/chat/approval-request-card';
import type { GateItem } from '@/components/kanban/types';

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

type Msg = { approval_target?: { gate_id: string } | null };

function Harness({ mainMessages, threadMessages }: { mainMessages: Msg[]; threadMessages: Msg[] }) {
  const [gateByKey, setGateByKey] = useState<Record<string, CardState>>({});
  const requestedIdsRef = useRef<Set<string>>(new Set());
  // chat-view.tsx 역할
  useGateBatchFetch(mainMessages, requestedIdsRef, setGateByKey);
  // thread-panel.tsx 역할 — 같은 ref·같은 setter를 공유
  useGateBatchFetch(threadMessages, requestedIdsRef, setGateByKey);
  return <div data-testid="dump">{JSON.stringify(gateByKey)}</div>;
}

async function flush(times = 4) {
  await act(async () => {
    for (let i = 0; i < times; i++) await Promise.resolve();
  });
}

function gateStub(id: string): GateItem {
  return {
    id, org_id: 'org-1', work_item_id: 'w-1', work_item_type: 'story',
    gate_type: 'merge_gate', status: 'pending', resolver_id: null, resolved_at: null,
    resolution_note: null, neutral_facts: null, created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(), can_approve: true, risk_grade: 'low',
    work_item_summary: null,
  };
}

describe('useGateBatchFetch — 메인+스레드 두 messages를 같은 캐시로 공유(story #5ace2e84)', () => {
  it('approval_target.gate_id들을 ?ids= 배치 하나로 모아 GET /api/gates에 실어보낸다(BE list_gates 배열 계약)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain('/api/gates?ids=');
      expect(url).toContain('gate-1');
      expect(url).toContain('gate-2');
      return { ok: true, json: async () => [gateStub('gate-1'), gateStub('gate-2')] };
    });
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(
        <Harness
          mainMessages={[{ approval_target: { gate_id: 'gate-1' } }, { approval_target: { gate_id: 'gate-2' } }]}
          threadMessages={[]}
        />,
      );
    });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const dump = container.querySelector('[data-testid="dump"]')?.textContent ?? '';
    expect(dump).toContain('"gate-1":{"kind":"ready"');
    expect(dump).toContain('"gate-2":{"kind":"ready"');
  });

  it('메인·스레드 양쪽이 같은 gate_id를 참조해도 fetch는 한 번만 나간다(공유 requestedIdsRef)', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => [gateStub('shared-gate')] }));
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => {
      root.render(
        <Harness
          mainMessages={[{ approval_target: { gate_id: 'shared-gate' } }]}
          threadMessages={[{ approval_target: { gate_id: 'shared-gate' } }]}
        />,
      );
    });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('BE가 project 접근권 없어 조용히 뺀 gate(응답 배열에 없음)는 not-found로 떨어진다(#2042 authz 필터와 대칭)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [] })));

    await act(async () => {
      root.render(<Harness mainMessages={[{ approval_target: { gate_id: 'no-access-gate' } }]} threadMessages={[]} />);
    });
    await flush();

    const dump = container.querySelector('[data-testid="dump"]')?.textContent ?? '';
    expect(dump).toContain('"no-access-gate":{"kind":"not-found"}');
  });
});
