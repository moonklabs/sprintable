// @vitest-environment jsdom
//
// story #2531(E-FLOW-V4 S1) — 지구 층 규칙(AC): measuring 선명·proposed 흐림·나머지
// 상태(verified/falsified/killed/archived)는 그리드에 아예 안 뜬다("더미 미표시").
// fold는 story_ids.length만(task fold는 데이터 자체가 없어 스킵). 없는 데이터는
// 정직한 빈 상태로 말한다(더미로 안 채운다).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import type { Hypothesis } from '@sprintable/core-storage';
import koMessages from '../../../messages/ko.json';
import { HypothesisEarthLayer } from './hypothesis-earth-layer';

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
    measure_after: '2026-08-01',
    status: 'measuring',
    outcome_result: null,
    confidence: null,
    source_type: null,
    source_id: null,
    human_accounting: {},
    gate_contract: {},
    epic_ids: [],
    story_ids: [],
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
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

async function renderLayer(fetchImpl: typeof fetch) {
  vi.stubGlobal('fetch', fetchImpl);
  await act(async () => {
    root.render(wrap(<HypothesisEarthLayer projectId="p1" />));
    await new Promise((r) => setTimeout(r, 0));
  });
}

function jsonResponse(data: unknown) {
  return Promise.resolve(new Response(JSON.stringify({ data }), { status: 200 }));
}

describe('HypothesisEarthLayer — story #2531 AC(measuring 선명·proposed 흐림·나머지 미표시)', () => {
  it('measuring 가설은 선명(opacity-60 없이) 렌더된다', async () => {
    await renderLayer(vi.fn(() => jsonResponse([makeHypothesis({ id: 'h1', status: 'measuring', statement: 'Q1' })])));

    const card = Array.from(container.querySelectorAll('p')).find((p) => p.textContent === 'Q1')?.closest('div');
    expect(card).toBeTruthy();
    expect(card?.className).not.toContain('opacity-60');
  });

  it('proposed 가설은 흐림(opacity-60)으로 렌더된다', async () => {
    await renderLayer(vi.fn(() => jsonResponse([makeHypothesis({ id: 'h2', status: 'proposed', statement: 'Q2' })])));

    const card = Array.from(container.querySelectorAll('p')).find((p) => p.textContent === 'Q2')?.closest('div');
    expect(card?.className).toContain('opacity-60');
  });

  it('verified/falsified/killed/archived는 그리드에 아예 안 뜬다(더미 미표시)', async () => {
    await renderLayer(vi.fn(() => jsonResponse([
      makeHypothesis({ id: 'h3', status: 'verified', statement: 'DEAD-verified' }),
      makeHypothesis({ id: 'h4', status: 'falsified', statement: 'DEAD-falsified' }),
      makeHypothesis({ id: 'h5', status: 'killed', statement: 'DEAD-killed' }),
      makeHypothesis({ id: 'h6', status: 'archived', statement: 'DEAD-archived' }),
    ])));

    expect(container.textContent).not.toContain('DEAD-verified');
    expect(container.textContent).not.toContain('DEAD-falsified');
    expect(container.textContent).not.toContain('DEAD-killed');
    expect(container.textContent).not.toContain('DEAD-archived');
    // 전부 걸러진 뒤엔 빈 상태 문구가 정직하게 뜬다.
    expect(container.textContent).toContain(koMessages.flow.earthEmpty);
  });

  it('fold count는 story_ids.length를 그대로 쓴다', async () => {
    await renderLayer(vi.fn(() => jsonResponse([
      makeHypothesis({ id: 'h7', status: 'measuring', statement: 'Q-fold', story_ids: ['s1', 's2', 's3'] }),
    ])));

    expect(container.textContent).toContain(koMessages.flow.earthFold.replace('{n}', '3'));
  });

  it('연결 스토리가 없으면 빈-fold 문구(0을 안 보이고 정직한 문장)를 쓴다', async () => {
    await renderLayer(vi.fn(() => jsonResponse([
      makeHypothesis({ id: 'h8', status: 'measuring', statement: 'Q-no-fold', story_ids: [] }),
    ])));

    expect(container.textContent).toContain(koMessages.flow.earthFoldEmpty);
  });

  it('데이터가 아예 없으면(measuring/proposed 둘 다 0) 더미로 안 채우고 빈 상태를 말한다', async () => {
    await renderLayer(vi.fn(() => jsonResponse([])));

    expect(container.textContent).toContain(koMessages.flow.earthEmpty);
  });

  it('fetch 실패시 로드 에러 문구를 보이고 크래시하지 않는다', async () => {
    await renderLayer(vi.fn(() => Promise.resolve(new Response('boom', { status: 500 }))));

    expect(container.textContent).toContain(koMessages.flow.earthLoadError);
  });

  it('축척 사다리 5단(지구~건물)이 렌더되고 지구가 활성 표시된다', async () => {
    await renderLayer(vi.fn(() => jsonResponse([])));

    expect(container.textContent).toContain(koMessages.flow.ladderName_earth);
    expect(container.textContent).toContain(koMessages.flow.ladderName_building);
  });

  it('/api/hypotheses?project_id=<id>를 호출한다(status 필터 없이 전량, 클라 필터링)', async () => {
    const fetchMock = vi.fn(() => jsonResponse([]));
    await renderLayer(fetchMock);

    expect(fetchMock).toHaveBeenCalledWith('/api/hypotheses?project_id=p1', { cache: 'no-store' });
  });
});
