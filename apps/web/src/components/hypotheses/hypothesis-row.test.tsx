// @vitest-environment jsdom
//
// story #2053 — active 가설에서 measuring으로 옮기는 동선이 화면에 없어(⋯ 메뉴엔 "스토리
// 연결"/"검증 중단" 둘뿐) measuring 전용 종결 메뉴(#2036이 연 달성/반증)에 도달할 수 없던
// 결함. active 상태일 때 인라인 [측정 시작] 버튼이 뜨고 클릭 시 onStartMeasuring이 호출되는
// 것을 실제 DOM(createRoot)으로 왕복 검증한다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { HypothesisRow, type HypothesisRowActions } from './hypothesis-row';
import type { Hypothesis } from '@sprintable/core-storage';
import koMessages from '../../../messages/ko.json';

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

function hypothesis(overrides: Partial<Hypothesis>): Hypothesis {
  return {
    id: 'h1',
    org_id: 'org-1',
    project_id: 'proj-1',
    owner_member_id: 'm1',
    created_by_member_id: null,
    confirmed_by_member_id: null,
    statement: '테스트 가설',
    metric_definition: { metric: 'activation', target: 10, direction: 'up' } as never,
    measure_after: '2026-08-01T00:00:00Z',
    status: 'active',
    outcome_result: null,
    confidence: null,
    source_type: null,
    source_id: null,
    human_accounting: {},
    gate_contract: {},
    epic_ids: [],
    story_ids: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function noopActions(): HypothesisRowActions {
  return {
    onConfirmDraft: vi.fn(),
    onActivate: vi.fn(),
    onLinkStory: vi.fn(),
    onKill: vi.fn(),
    onResolve: vi.fn(),
    onStartMeasuring: vi.fn(),
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
});

describe('HypothesisRow — story #2053 active→measuring 동선', () => {
  it('active 가설이면 인라인 [측정 시작] 버튼이 렌더된다', async () => {
    await act(async () => {
      root.render(wrap(<HypothesisRow hypothesis={hypothesis({ status: 'active' })} actions={noopActions()} />));
    });
    const button = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('측정 시작'));
    expect(button).not.toBeUndefined();
  });

  it('[측정 시작] 클릭 시 onStartMeasuring이 해당 가설로 호출된다', async () => {
    const actions = noopActions();
    const hyp = hypothesis({ status: 'active' });
    await act(async () => {
      root.render(wrap(<HypothesisRow hypothesis={hyp} actions={actions} />));
    });
    const button = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('측정 시작'));
    await act(async () => { button?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(actions.onStartMeasuring).toHaveBeenCalledWith(hyp);
  });

  it('measure_after가 있으면 자동 전이 시점을 안내하는 문구가 뜬다(AC2)', async () => {
    await act(async () => {
      root.render(wrap(<HypothesisRow hypothesis={hypothesis({ status: 'active', measure_after: '2026-08-01T00:00:00Z' })} actions={noopActions()} />));
    });
    expect(container.textContent).toContain('2026-08-01');
  });

  it('proposed 가설이면 [측정 시작]이 안 뜬다([활성화]만)', async () => {
    await act(async () => {
      root.render(wrap(<HypothesisRow hypothesis={hypothesis({ status: 'proposed' })} actions={noopActions()} />));
    });
    const startButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('측정 시작'));
    expect(startButton).toBeUndefined();
    const activateButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('활성화'));
    expect(activateButton).not.toBeUndefined();
  });

  it('measuring 가설이면 [측정 시작]이 안 뜬다(이미 측정 중)', async () => {
    await act(async () => {
      root.render(wrap(<HypothesisRow hypothesis={hypothesis({ status: 'measuring' })} actions={noopActions()} />));
    });
    const startButton = [...container.querySelectorAll('button')].find((b) => b.textContent?.includes('측정 시작'));
    expect(startButton).toBeUndefined();
  });

  it('measuring 가설의 ⋯ 메뉴엔 달성/반증 종결 항목이 뜬다(#2036 경로 유지 회귀가드)', async () => {
    await act(async () => {
      root.render(wrap(<HypothesisRow hypothesis={hypothesis({ status: 'measuring' })} actions={noopActions()} />));
    });
    const trigger = container.querySelector('[aria-label]');
    await act(async () => { trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    // dropdown 콘텐츠가 렌더되면 텍스트로 확認(라디언트 UI 포탈 여부와 무관하게 document 전체를 본다).
    expect(document.body.textContent).toContain('달성');
  });
});
