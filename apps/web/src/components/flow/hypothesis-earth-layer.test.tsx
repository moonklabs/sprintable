// @vitest-environment jsdom
//
// story #2531(E-FLOW-V4 S1) — 지구 층 규칙(AC): measuring 선명·proposed 흐림·archived는
// 그리드에 아예 안 뜬다("더미 미표시"). fold는 story_ids.length만(task fold는 데이터
// 자체가 없어 스킵). 없는 데이터는 정직한 빈 상태로 말한다(더미로 안 채운다).
//
// ⛔카디르 재QA HIGH(2026-08-09, #2930) — verified/falsified/killed("결론난 가설")도
// 처음엔 이 필터에 걸려 지구층에서 완전히 사라졌었다. measuring이 나중에 falsified로
// 넘어가면 그 카드가 없어져 정반합 서사를 열 클릭 경로가 없었다(story #2533 헤드라인
// 실사용 도달 0). 결론난 가설은 기본 접힘 섹션으로 남아, 펼치면 여전히 클릭 가능하다.
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

async function renderLayer(fetchImpl: typeof fetch, onSelectHypothesis: (id: string) => void = vi.fn()) {
  vi.stubGlobal('fetch', fetchImpl);
  await act(async () => {
    root.render(wrap(<HypothesisEarthLayer projectId="p1" onSelectHypothesis={onSelectHypothesis} />));
    await new Promise((r) => setTimeout(r, 0));
  });
}

function jsonResponse(data: unknown) {
  return Promise.resolve(new Response(JSON.stringify({ data }), { status: 200 }));
}

// story #2534(S4) 머지 후 — HypothesisEarthLayer가 UnattachedBucket(자기 own <details>)도
// 함께 렌더하므로, «결론난 가설» 섹션의 <details>는 querySelector('details')로 첫 매치를
// 우연에 기대지 말고 summary 텍스트로 정확히 찾는다(그 details만 대상으로 검증).
function findConcludedDetails() {
  return Array.from(container.querySelectorAll('details')).find(
    (d) => d.querySelector('summary')?.textContent?.includes(koMessages.flow.earthConcludedHeading),
  );
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

  it('archived는 그리드·결론난 섹션 어디에도 안 뜬다(더미 미표시)', async () => {
    await renderLayer(vi.fn(() => jsonResponse([
      makeHypothesis({ id: 'h6', status: 'archived', statement: 'DEAD-archived' }),
    ])));

    expect(container.textContent).not.toContain('DEAD-archived');
    // measuring/proposed 둘 다 0이니 지구층 그리드는 빈 상태 문구를 정직하게 뜬다.
    expect(container.textContent).toContain(koMessages.flow.earthEmpty);
  });

  it('verified/falsified/killed는 «결론난 가설» 접힘 섹션에 최근 결론순으로 뜨고, 소계·클릭이 동작한다(유나 design 규격, 2026-08-09)', async () => {
    const onSelect = vi.fn();
    await renderLayer(
      vi.fn(() => jsonResponse([
        makeHypothesis({ id: 'h3', status: 'verified', statement: 'CONCLUDED-verified', updated_at: '2026-08-01T00:00:00Z' }),
        makeHypothesis({ id: 'h4', status: 'falsified', statement: 'CONCLUDED-falsified', updated_at: '2026-08-05T00:00:00Z' }),
        makeHypothesis({ id: 'h5', status: 'killed', statement: 'CONCLUDED-killed', updated_at: '2026-08-03T00:00:00Z' }),
      ])),
      onSelect,
    );

    expect(container.textContent).toContain('CONCLUDED-verified');
    expect(container.textContent).toContain('CONCLUDED-falsified');
    expect(container.textContent).toContain('CONCLUDED-killed');
    expect(container.textContent).toContain(koMessages.flow.earthConcludedHeading);
    // 소계 «✓X ✕Y ⊘Z» — 접힌 채로도 무엇이 결론났나 읽힌다.
    expect(container.textContent).toContain('✓1 ✕1 ⊘1');

    const details = findConcludedDetails();
    expect(details).toBeTruthy();
    expect(details?.hasAttribute('open')).toBe(false); // 기본 접힘(카드 폭발 회피 유지)

    // 최근 결론순: falsified(08-05) → killed(08-03) → verified(08-01).
    const rowTexts = Array.from(details!.querySelectorAll('[role="button"]')).map((el) => el.textContent ?? '');
    const falsifiedIdx = rowTexts.findIndex((t) => t.includes('CONCLUDED-falsified'));
    const killedIdx = rowTexts.findIndex((t) => t.includes('CONCLUDED-killed'));
    const verifiedIdx = rowTexts.findIndex((t) => t.includes('CONCLUDED-verified'));
    expect(falsifiedIdx).toBeLessThan(killedIdx);
    expect(killedIdx).toBeLessThan(verifiedIdx);

    const row = Array.from(container.querySelectorAll('[role="button"]')).find(
      (el) => el.textContent?.includes('CONCLUDED-falsified'),
    );
    expect(row).toBeTruthy();
    await act(async () => {
      row!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledWith('h4');
  });

  it('falsified가 대체 가설(superseded_by_hypothesis_id)이 있으면 «→ 대체» 힌트가 접힌 섹션에서도 보인다', async () => {
    await renderLayer(vi.fn(() => jsonResponse([
      makeHypothesis({ id: 'h4', status: 'falsified', statement: 'Q-superseded', superseded_by_hypothesis_id: 'h-next' }),
    ])));

    expect(container.textContent).toContain(koMessages.flow.earthSupersededHint);
  });

  it('falsified인데 대체 가설이 없으면 «→ 대체» 힌트가 안 뜬다', async () => {
    await renderLayer(vi.fn(() => jsonResponse([
      makeHypothesis({ id: 'h4', status: 'falsified', statement: 'Q-not-superseded', superseded_by_hypothesis_id: null }),
    ])));

    expect(container.textContent).not.toContain(koMessages.flow.earthSupersededHint);
  });

  it('verified/killed는 대체가 있어도(오배선 방어) «→ 대체» 힌트가 안 뜬다(falsified 전용)', async () => {
    await renderLayer(vi.fn(() => jsonResponse([
      makeHypothesis({ id: 'h3', status: 'verified', statement: 'Q-verified', superseded_by_hypothesis_id: 'h-next' }),
    ])));

    expect(container.textContent).not.toContain(koMessages.flow.earthSupersededHint);
  });

  it('결론난 가설이 없으면 «결론난 가설» 섹션 자체를 안 그린다', async () => {
    await renderLayer(vi.fn(() => jsonResponse([
      makeHypothesis({ id: 'h1', status: 'measuring', statement: 'Q1' }),
    ])));

    expect(findConcludedDetails()).toBeFalsy();
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

  it('카드를 클릭하면 onSelectHypothesis(id)가 호출된다(story #2533 서사 패널 진입점)', async () => {
    const onSelect = vi.fn();
    await renderLayer(
      vi.fn(() => jsonResponse([makeHypothesis({ id: 'h-click', status: 'measuring', statement: 'Q-click' })])),
      onSelect,
    );

    const card = Array.from(container.querySelectorAll('[role="button"]')).find(
      (el) => el.textContent?.includes('Q-click'),
    );
    expect(card).toBeTruthy();
    await act(async () => {
      card!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onSelect).toHaveBeenCalledWith('h-click');
  });
});

// story #2545(카디르 라이브 재QA 2단계) — DashboardShell의 자동 org 재발급(switch-org)이
// 이 fetch *後*에 성공하면(같은 ms대 레이스로 이 fetch가 먼저 옛 org 403을 이미 확定한 경우),
// projectId는 안 바뀌므로 예전엔 재요청 트리거가 전혀 없었다(RED — 카디르 실측: 8초 관측·
// hypotheses fetch 총 1회뿐). bumpOrgSyncVersion()이 이걸 구독하는 컴포넌트만 재요청시키는지
// 고정한다.
describe('HypothesisEarthLayer — org-sync 성공 後 재요청 (story #2545)', () => {
  it('bumpOrgSyncVersion() 호출 時 projectId가 그대로여도 재요청되고, 새 결과로 갱신된다', async () => {
    const { bumpOrgSyncVersion } = await import('@/lib/project-context-client');
    let hypothesesCalls = 0;
    // 컴포넌트가 UnattachedBucket(자기 own /api/stories fetch)도 함께 렌더하므로 URL로
    // hypotheses 호출만 골라 센다 — 그 형제 fetch의 호출 횟수는 이 회귀가드 대상이 아니다.
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/hypotheses')) {
        hypothesesCalls += 1;
        // 1차 = switch-org 前(옛 org 403 확定 상황을 빈 목록으로 모사) · 2차 = switch-org
        // 성공 後(진짜 데이터).
        return hypothesesCalls === 1
          ? jsonResponse([])
          : jsonResponse([makeHypothesis({ id: 'h-recovered', status: 'measuring', statement: 'Q-recovered' })]);
      }
      return jsonResponse([]); // UnattachedBucket의 /api/stories — 이 테스트와 무관, 빈 목록.
    });
    await renderLayer(fetchMock);
    expect(hypothesesCalls).toBe(1);
    expect(container.textContent).toContain(koMessages.flow.earthEmpty);

    await act(async () => {
      bumpOrgSyncVersion();
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(hypothesesCalls).toBe(2);
    expect(container.textContent).toContain('Q-recovered');
    expect(container.textContent).not.toContain(koMessages.flow.earthEmpty);
  });
});
