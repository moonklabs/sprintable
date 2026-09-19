// @vitest-environment jsdom
//
// story #4057(E-RECIPE-1 ③, 유나 작업대 시안 v1 위) — gate-evidence.tsx 하네스와 동일 구조.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { ProductionWorkbenchEvidencePanel } from './production-workbench-evidence';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
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

async function flush(times = 4) {
  await act(async () => {
    for (let i = 0; i < times; i++) await Promise.resolve();
  });
}

const BASE_EVIDENCE = {
  source: null, note: null, created_by: 'agent-1', created_at: '2026-09-18T14:31:00Z',
  org_id: 'org-1', work_item_id: 'story-1', work_item_type: 'story' as const,
  artifact_version_id: null, artifact_id: null, artifact_version_number: 2,
};

describe('ProductionWorkbenchEvidencePanel', () => {
  it('산출물이 0건이면 패널 자체를 안 그린다(없으면 비운다 — gate-evidence.tsx 규율)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [] })));
    await act(async () => { root.render(wrap(<ProductionWorkbenchEvidencePanel workItemId="story-1" workItemType="story" currentStage={null} />)); });
    await flush();
    expect(container.querySelector('[data-testid="production-workbench-evidence"]')).toBeNull();
  });

  it('실패 시에도 조용히 비운다(카드 붕괴 방지, GithubRependingReason과 동형)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    await act(async () => { root.render(wrap(<ProductionWorkbenchEvidencePanel workItemId="story-1" workItemType="story" currentStage={null} />)); });
    await flush();
    expect(container.querySelector('[data-testid="production-workbench-evidence"]')).toBeNull();
  });

  it('스토리보드·애니매틱·검증시트가 있으면 §3(#4041) 순서(컨셉→스토리보드→애니매틱→검증)로 렌더한다', async () => {
    const evidenceRows = [
      {
        id: 'e-storyboard', type: 'report', ref: 'storyboard', ...BASE_EVIDENCE,
        payload: {
          kind: 'storyboard',
          shot_list: [{ shot_no: 1, angle: '와이드', duration_sec: 1.2, desc: '오프닝' }],
          emotion_beats: [{ beat_no: 1, shot_no: 1, emotion: '호기심' }],
        },
      },
      {
        id: 'e-animatic', type: 'report', ref: 'animatic', ...BASE_EVIDENCE,
        payload: { kind: 'animatic', artifact_id: 'artifact-uuid-1', cost_tier: 'no_charge', duration_sec: 9.5 },
      },
      {
        id: 'e-verify', type: 'report', ref: 'verify', ...BASE_EVIDENCE,
        payload: { kind: 'verification_sheet', items: [{ name: '자막 싱크', verdict: 'pass' }, { name: '길이 규격', verdict: 'fail' }] },
      },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => evidenceRows })));

    await act(async () => { root.render(wrap(<ProductionWorkbenchEvidencePanel workItemId="story-1" workItemType="story" currentStage={null} />)); });
    await flush();

    const panel = container.querySelector('[data-testid="production-workbench-evidence"]')!;
    expect(panel).not.toBeNull();
    const text = panel.textContent ?? '';
    // 순서: 스토리보드 관련 텍스트가 애니매틱보다 먼저, 애니매틱이 검증보다 먼저.
    expect(text.indexOf('오프닝')).toBeLessThan(text.indexOf('무과금'));
    expect(text.indexOf('무과금')).toBeLessThan(text.indexOf('자막 싱크'));
    // 실 데이터 값 확認(지어낸 값 아님).
    expect(text).toContain('와이드');
    expect(text).toContain('호기심');
    expect(text).toContain('9.5초');
    expect(text).toContain('자막 싱크');
    expect(text).toContain('길이 규격');
  });

  it('#4041 범위 밖 kind(generation_cost 등)는 섞이지 않는다', async () => {
    const evidenceRows = [
      { id: 'e1', type: 'report', ref: 'r', ...BASE_EVIDENCE, payload: { kind: 'generation_cost', amount: 100 } },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => evidenceRows })));
    await act(async () => { root.render(wrap(<ProductionWorkbenchEvidencePanel workItemId="story-1" workItemType="story" currentStage={null} />)); });
    await flush();
    expect(container.querySelector('[data-testid="production-workbench-evidence"]')).toBeNull();
  });

  it('story #4433 qa:changes — cost_tier=paid 배지는 secondary(neutral)+비용 아이콘, warning 색 아님', async () => {
    const evidenceRows = [
      { id: 'e-paid', type: 'report', ref: 'animatic', ...BASE_EVIDENCE, payload: { kind: 'animatic', artifact_id: 'artifact-uuid-3', cost_tier: 'paid', duration_sec: 6 } },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => evidenceRows })));
    await act(async () => { root.render(wrap(<ProductionWorkbenchEvidencePanel workItemId="story-1" workItemType="story" currentStage={null} />)); });
    await flush();

    const panel = container.querySelector('[data-testid="production-workbench-evidence"]')!;
    expect(panel.textContent).toContain('실탄');
    expect(panel.querySelector('svg.lucide-circle-dollar-sign')).not.toBeNull();
    // warning variant는 bg-warning-tint 클래스를 낸다 — 그 클래스가 이 배지엔 없어야 한다.
    const badges = [...panel.querySelectorAll('[class*="bg-warning-tint"]')];
    expect(badges).toHaveLength(0);
  });

  it('story #4433 qa:changes 2차 — 같은 kind가 1건뿐이면 "현재" 배지·이전 기록 섹션 둘 다 없다', async () => {
    const evidenceRows = [
      { id: 'e1', type: 'report', ref: 'r', ...BASE_EVIDENCE, payload: { kind: 'verification_sheet', items: [{ name: '자막 싱크', verdict: 'pass' }] } },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => evidenceRows })));
    await act(async () => { root.render(wrap(<ProductionWorkbenchEvidencePanel workItemId="story-1" workItemType="story" currentStage={null} />)); });
    await flush();

    const panel = container.querySelector('[data-testid="production-workbench-evidence"]')!;
    expect(panel.textContent).not.toContain('현재');
    expect(panel.textContent).not.toContain('이전 기록');
  });

  it('story #4433 qa:changes round-3 — payload.stage가 gate.neutral_facts.stage와 일치하는 evidence만 "현재"로, 나머지는 접힌 「이전 기록」 섹션에 분리된다', async () => {
    const evidenceRows = [
      { id: 'e-old-stage', type: 'report', ref: 'r', ...BASE_EVIDENCE, created_at: '2026-09-18T00:00:00Z', payload: { kind: 'verification_sheet', stage: 'concept_confirmed', items: [{ name: '자막 싱크', verdict: 'fail' }] } },
      { id: 'e-new-stage', type: 'report', ref: 'r', ...BASE_EVIDENCE, created_at: '2026-09-19T00:00:00Z', payload: { kind: 'verification_sheet', stage: 'structure_approval', items: [{ name: '자막 싱크', verdict: 'pass' }] } },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => evidenceRows })));
    await act(async () => { root.render(wrap(<ProductionWorkbenchEvidencePanel workItemId="story-1" workItemType="story" currentStage="structure_approval" />)); });
    await flush();

    const panel = container.querySelector('[data-testid="production-workbench-evidence"]')!;
    // 지금 게이트가 보는 stage(structure_approval)와 일치하는 e-new-stage가 열린 카드로, 「현재」 배지가 뜬다.
    expect(panel.textContent).toContain('현재');
    // 다른 stage의 e-old-stage는 <details> 안(닫힌 상태 기본)에 있다.
    expect(panel.textContent).toContain('이전 기록 · 1건');
    const details = panel.querySelector('details')!;
    expect(details).not.toBeNull();
    expect(details.open).toBe(false);
    expect(details.textContent).toContain('실패'); // e-old-stage(fail)의 verdict 라벨도 접힌 안에 존재.
  });

  it('story #4433 qa:changes round-3 — 새 컨셉 등록 직후(신규 stage에 검증 없음) 구 컨셉의 pass가 «현재»로 오도되지 않는다(핵심 회귀)', async () => {
    // 카디르 지적 그대로 재현: 시간상 가장 최신인 evidence가 «구 컨셉»의 pass다(새 컨셉은
    // 아직 검증 자체가 없다) — 둘 다 지금 게이트가 보는 stage(structure_approval)가 아니다.
    // round-2(시간축 최신=현재)였다면 e-old-concept-pass를 현재로 잘못 승격했을 자리 — 그
    // 결함을 관측 가능하게 하려면 evidence가 2건 이상이어야 한다(1건뿐이면 "현재" 배지
    // 자체를 안 다는 게 이 화면의 기존 규율이라 신구 로직이 우연히 같은 결과를 낸다).
    const evidenceRows = [
      { id: 'e-even-older', type: 'report', ref: 'r', ...BASE_EVIDENCE, created_at: '2026-09-17T00:00:00Z', payload: { kind: 'verification_sheet', stage: 'material_collection', items: [{ name: '자막 싱크', verdict: 'pass' }] } },
      { id: 'e-old-concept-pass', type: 'report', ref: 'r', ...BASE_EVIDENCE, created_at: '2026-09-19T00:00:00Z', payload: { kind: 'verification_sheet', stage: 'concept_confirmed', items: [{ name: '자막 싱크', verdict: 'pass' }] } },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => evidenceRows })));
    // 게이트는 이미 다음 stage(structure_approval)로 넘어갔다 — 새 컨셉엔 아직 evidence가 없다.
    await act(async () => { root.render(wrap(<ProductionWorkbenchEvidencePanel workItemId="story-1" workItemType="story" currentStage="structure_approval" />)); });
    await flush();

    const panel = container.querySelector('[data-testid="production-workbench-evidence"]')!;
    // 구 컨셉의 pass가 "현재"로 뜨면 안 된다 — 매칭 신호가 없으니 아무것도 승격하지 않는다.
    expect(panel.textContent).not.toContain('현재');
    // 그래도 그 evidence 둘 다 숨기지 않는다(정직하게 중립 나열, 접힌 이전 기록도 아니다).
    expect(panel.textContent).toContain('자막 싱크');
    expect(panel.querySelector('details')).toBeNull();
  });
});
