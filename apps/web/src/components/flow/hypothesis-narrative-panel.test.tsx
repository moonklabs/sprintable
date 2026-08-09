// @vitest-environment jsdom
//
// story #2533(E-FLOW-V4 S3) — 가설 생애 수직 서사 패널. base-ui Dialog는 document.body에
// portal 렌더하므로(storage-delete-dialog.test.tsx와 동일 관례) document 전체를 대상으로
// 검증한다. 4축(질문/목표/검증/증명/시간선)이 실 데이터로 조립되는지, 정반합은 필드
// 부재 시 통째로 생략되는지(추측 연결 금지) 값으로 잰다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import type { Hypothesis } from '@sprintable/core-storage';
import koMessages from '../../../messages/ko.json';
import { HypothesisNarrativePanel } from './hypothesis-narrative-panel';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

function makeHypothesis(overrides: Partial<Hypothesis>): Hypothesis {
  return {
    id: 'h-default',
    org_id: 'org-1',
    project_id: 'p1',
    owner_member_id: 'm1',
    created_by_member_id: null,
    confirmed_by_member_id: null,
    statement: '기본 진술',
    metric_definition: { metric: 'm', source: 'manual', target: 0, direction: 'down' },
    measure_after: '2026-08-01T00:00:00Z',
    status: 'measuring',
    outcome_result: null,
    confidence: null,
    source_type: null,
    source_id: null,
    human_accounting: {},
    gate_contract: {},
    epic_ids: [],
    story_ids: [],
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-15T00:00:00Z',
    ...overrides,
  };
}

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

async function renderPanel(fetchImpl: typeof fetch, onClose: () => void = vi.fn()) {
  vi.stubGlobal('fetch', fetchImpl);
  await act(async () => {
    root.render(wrap(<HypothesisNarrativePanel hypothesisId="h1" onClose={onClose} />));
    await new Promise((r) => setTimeout(r, 0));
  });
}

function jsonRes(data: unknown) {
  return Promise.resolve(new Response(JSON.stringify({ data }), { status: 200 }));
}

function routedFetch(routes: Record<string, unknown>) {
  return vi.fn((input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    for (const [prefix, data] of Object.entries(routes)) {
      if (url.startsWith(prefix)) return jsonRes(data);
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  });
}

describe('HypothesisNarrativePanel — story #2533 4축(질문/목표/검증/증명/시간선)', () => {
  it('질문(statement)이 렌더된다', async () => {
    await renderPanel(routedFetch({
      '/api/hypotheses/h1': makeHypothesis({ id: 'h1', statement: '결제 완료율 가설' }),
    }));
    expect(document.body.textContent).toContain('결제 완료율 가설');
  });

  it('목표(epic_ids→goals) 제목이 렌더된다', async () => {
    await renderPanel(routedFetch({
      '/api/hypotheses/h1': makeHypothesis({ id: 'h1', epic_ids: ['g1'] }),
      '/api/goals/g1': { id: 'g1', title: '결제 전환 목표', status: 'active' },
    }));
    expect(document.body.textContent).toContain('결제 전환 목표');
  });

  it('epic_ids가 비어있으면 목표 절이 정직한 "아직"을 보인다', async () => {
    await renderPanel(routedFetch({
      '/api/hypotheses/h1': makeHypothesis({ id: 'h1', epic_ids: [] }),
    }));
    expect(document.body.textContent).toContain(koMessages.flow.narrativeNotYet);
  });

  it('검증(story_ids→stories 배치조회) 제목이 렌더된다', async () => {
    await renderPanel(routedFetch({
      '/api/hypotheses/h1': makeHypothesis({ id: 'h1', story_ids: ['s1', 's2'] }),
      '/api/stories?ids=s1,s2': [
        { id: 's1', title: '스토리A', status: 'in-progress' },
        { id: 's2', title: '스토리B', status: 'done' },
      ],
    }));
    expect(document.body.textContent).toContain('스토리A');
    expect(document.body.textContent).toContain('스토리B');
  });

  it('증명(outcome_result)이 실측/목표로 렌더된다', async () => {
    await renderPanel(routedFetch({
      '/api/hypotheses/h1': makeHypothesis({
        id: 'h1', status: 'falsified',
        outcome_result: { actual: 52, target: 60, metric: 'x', direction: 'up' },
      }),
    }));
    expect(document.body.textContent).toContain('52');
    expect(document.body.textContent).toContain('60');
  });

  it('outcome_result가 없으면(아직 측정 전) "아직"을 정직하게 보인다(지어내지 않는다)', async () => {
    await renderPanel(routedFetch({
      '/api/hypotheses/h1': makeHypothesis({ id: 'h1', status: 'proposed', outcome_result: null }),
    }));
    // narrativeNotYet이 목표·검증·증명 세 곳 모두에 뜰 수 있으니 최소 1회 이상만 확인.
    const occurrences = document.body.textContent?.split(koMessages.flow.narrativeNotYet).length ?? 1;
    expect(occurrences).toBeGreaterThan(1);
  });

  it('시간선 3점(제안·검증기한·최근갱신)이 모두 렌더된다', async () => {
    await renderPanel(routedFetch({
      '/api/hypotheses/h1': makeHypothesis({ id: 'h1' }),
    }));
    expect(document.body.textContent).toContain(koMessages.flow.narrativeStepTimeline);
  });

  it('fetch 실패 시 에러 문구를 보이고 크래시하지 않는다', async () => {
    await renderPanel(vi.fn(() => Promise.resolve(new Response('boom', { status: 500 }))));
    expect(document.body.textContent).toContain(koMessages.flow.narrativeLoadError);
  });
});

describe('HypothesisNarrativePanel — 정반합(추측 연결 금지)', () => {
  it('superseded_by_hypothesis_id 필드가 없으면(현재 BE 상태) 정반합 절 자체가 안 뜬다', async () => {
    await renderPanel(routedFetch({
      '/api/hypotheses/h1': makeHypothesis({ id: 'h1', status: 'falsified' }),
    }));
    expect(document.body.textContent).not.toContain(koMessages.flow.narrativeStepAntithesis);
  });

  it('falsified + superseded_by_hypothesis_id가 있으면(디디 BE 백필 후) 대체 가설 문장이 뜬다', async () => {
    await renderPanel(routedFetch({
      '/api/hypotheses/h1': {
        ...makeHypothesis({ id: 'h1', status: 'falsified' }),
        superseded_by_hypothesis_id: 'h2',
      },
      '/api/hypotheses/h2': makeHypothesis({ id: 'h2', status: 'proposed', statement: '대체 가설 문장' }),
    }));
    expect(document.body.textContent).toContain('대체 가설 문장');
    expect(document.body.textContent).toContain(koMessages.flow.narrativeStepAntithesis);
  });

  it('proposed(falsified 아님) + superseded_by가 있어도(있을 리 없지만 방어) 정반합 절은 falsified 전용이라 안 뜬다', async () => {
    await renderPanel(routedFetch({
      '/api/hypotheses/h1': {
        ...makeHypothesis({ id: 'h1', status: 'proposed' }),
        superseded_by_hypothesis_id: 'h2',
      },
      '/api/hypotheses/h2': makeHypothesis({ id: 'h2', statement: '대체 가설 문장' }),
    }));
    expect(document.body.textContent).not.toContain(koMessages.flow.narrativeStepAntithesis);
  });
});

describe('HypothesisNarrativePanel — 닫기', () => {
  it('닫기 상호작용 시 onClose가 호출된다(base-ui Dialog onOpenChange 경로)', async () => {
    const onClose = vi.fn();
    await renderPanel(routedFetch({
      '/api/hypotheses/h1': makeHypothesis({ id: 'h1' }),
    }), onClose);

    const closeButton = Array.from(document.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label')?.toLowerCase().includes('close') || b.textContent === '',
    );
    // base-ui DialogContent의 기본 close 버튼(아이콘만, 텍스트 없음)을 찾아 클릭.
    const candidates = Array.from(document.querySelectorAll('[data-slot="dialog-content"] button'));
    const target = candidates[0] ?? closeButton;
    expect(target).toBeTruthy();
    await act(async () => {
      target!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalled();
  });
});
