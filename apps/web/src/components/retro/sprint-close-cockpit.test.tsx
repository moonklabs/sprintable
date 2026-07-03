import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { createHeuristicStepSchedule, SprintCloseCockpit } from './sprint-close-cockpit';
import { EvidenceStrip } from './evidence-strip';
import type { RetroHypothesisResult, RetroNextHypothesis, RetroSynthesis } from '@/services/retro-session';

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

const noop = async () => false;

const VERIFIED: RetroHypothesisResult = {
  id: 'h1', statement: '가격 CTA 문구를 바꾸면 전환이 오른다', status: 'verified',
  metric: '가입 전환율', target: 4.0, direction: 'up', actual: 4.6,
};
const FALSIFIED: RetroHypothesisResult = {
  id: 'h2', statement: '온보딩 이메일 제목 A/B가 D1 리텐션을 올린다', status: 'falsified',
  metric: 'D1 리텐션', target: 32, direction: 'up', actual: 29,
};
const MEASURING: RetroHypothesisResult = {
  id: 'h3', statement: '결정 게이트 UI가 승인 리드타임을 줄인다', status: 'measuring',
  measure_after: '2026-07-09T00:00:00Z',
};

describe('SprintCloseCockpit (E-SPRINT-LOOP 1b9f4ecb)', () => {
  it('renders the graceful empty state when no hypotheses are linked (0-cardinality, AC1)', () => {
    const markup = renderToStaticMarkup(wrap(
      <SprintCloseCockpit hypotheses={[]} synthesis={null} nextHypotheses={[]} onGenerateSynthesis={noop} onAdoptRecommendation={noop} />,
    ));
    expect(markup).toContain('이번 스프린트에 연결된 가설이 없습니다');
    expect(markup).not.toContain('hcard');
  });

  it('renders the measuring-only graceful state without a stray hit/miss verdict', () => {
    const markup = renderToStaticMarkup(wrap(
      <SprintCloseCockpit hypotheses={[MEASURING]} synthesis={null} nextHypotheses={[]} onGenerateSynthesis={noop} onAdoptRecommendation={noop} />,
    ));
    expect(markup).toContain('아직 측정 중입니다');
  });

  it('SOUL-LOCK: falsified renders neutral (info), never destructive/red in any form', () => {
    const markup = renderToStaticMarkup(wrap(
      <SprintCloseCockpit hypotheses={[VERIFIED, FALSIFIED]} synthesis={null} nextHypotheses={[]} onGenerateSynthesis={noop} onAdoptRecommendation={noop} />,
    ));
    expect(markup).toContain('반증됨');
    expect(markup).toContain('학습');
    // 까심 codex QA — destructive 외 다른 경로(raw red-* 유틸, border-red-*, inline color)로
    // red-leak이 새는지까지 넓게 가드(회귀 시 이 assertion이 먼저 깨진다).
    expect(markup).not.toContain('text-destructive');
    expect(markup).not.toContain('bg-destructive');
    expect(markup).not.toMatch(/\btext-red-\d/);
    expect(markup).not.toMatch(/\bbg-red-\d/);
    expect(markup).not.toMatch(/\bborder-red-\d/);
    expect(markup).not.toMatch(/color:\s*#?(red|f00)/i);
  });

  // story fbf1c14b: 늦게 declare된 가설이 sprint-close 시점에도 아직 measuring 전(proposed/
  // active)일 수 있다 — verdict 4종만 처리하던 VERDICT_KEY가 tr(undefined)를 냈다(PO crux
  // 확정). 까심 QA 정정(2026-07-03): next-intl이 이걸 크래시 아닌 graceful fallback으로
  // 흡수해 "폴백 텍스트" 버그였던 것 — 첫 구현의 "크래시 없음"만 보는 assertion은
  // VERDICT_KEY서 키를 빼도 통과하는 tautological 테스트였다. 실 라벨을 직접 assert.
  it.each([
    ['proposed', '제안됨'],
    ['active', '진행 중'],
    ['archived', '보관됨'],
  ] as const)('renders a %s hypothesis with the honest "%s" label (not a fallback), no destructive color', (status, label) => {
    const h: RetroHypothesisResult = { id: `h-${status}`, statement: `${status} 가설`, status };
    const markup = renderToStaticMarkup(wrap(
      <SprintCloseCockpit hypotheses={[h]} synthesis={null} nextHypotheses={[]} onGenerateSynthesis={noop} onAdoptRecommendation={noop} />,
    ));
    expect(markup).toContain(`${status} 가설`);
    expect(markup).toContain(label);
    expect(markup).not.toContain('text-destructive');
    expect(markup).not.toContain('bg-destructive');
    expect(markup).not.toMatch(/\btext-red-\d/);
  });

  it('tallies verified/falsified/measuring counts correctly', () => {
    const markup = renderToStaticMarkup(wrap(
      <SprintCloseCockpit hypotheses={[VERIFIED, FALSIFIED, MEASURING]} synthesis={null} nextHypotheses={[]} onGenerateSynthesis={noop} onAdoptRecommendation={noop} />,
    ));
    expect(markup).toContain('가설 3');
    expect(markup).toContain('검증 1');
    expect(markup).toContain('반증 1');
    expect(markup).toContain('측정중 1');
  });

  it('shows the "generate synthesis" CTA when synthesis is null (nullable graceful, AC4)', () => {
    const markup = renderToStaticMarkup(wrap(
      <SprintCloseCockpit hypotheses={[VERIFIED]} synthesis={null} nextHypotheses={[]} onGenerateSynthesis={noop} onAdoptRecommendation={noop} />,
    ));
    expect(markup).toContain('종합 생성');
    expect(markup).not.toContain('AI 초안');
  });

  it('renders the AI synthesis block with "AI 초안" attribution once synthesis exists', () => {
    const synthesis: RetroSynthesis = {
      learned: [{ text: '카피 레버가 전환에 즉효다', source: '가설 1 검증' }],
      generated_at: '2026-07-02T00:00:00Z',
      source: 'ai_draft',
    };
    const markup = renderToStaticMarkup(wrap(
      <SprintCloseCockpit hypotheses={[VERIFIED]} synthesis={synthesis} nextHypotheses={[]} onGenerateSynthesis={noop} onAdoptRecommendation={noop} />,
    ));
    expect(markup).toContain('이번 스프린트에서 배운 것');
    expect(markup).toContain('카피 레버가 전환에 즉효다');
    expect(markup).toContain('AI 초안');
  });

  it('renders next-hypothesis recommendations with HITL adopt gate + confidence bucket, only once synthesis exists', () => {
    const synthesis: RetroSynthesis = { learned: [{ text: '학습' }], generated_at: '2026-07-02T00:00:00Z', source: 'ai_draft' };
    const rec: RetroNextHypothesis = {
      statement: '온보딩 첫 화면에 가이드를 넣으면 리텐션이 오를 것이다',
      metric_definition: { metric: 'D1 리텐션', target: 32, direction: 'up' },
      measure_after: '2026-07-16T00:00:00Z',
      confidence: 0.55,
      rationale: '가설 2 반증에서 — 레버는 첫 경험',
      requires_confirmation: true,
    };
    const markup = renderToStaticMarkup(wrap(
      <SprintCloseCockpit hypotheses={[VERIFIED]} synthesis={synthesis} nextHypotheses={[rec]} onGenerateSynthesis={noop} onAdoptRecommendation={noop} />,
    ));
    expect(markup).toContain('다음 스프린트에서 검증할 것');
    expect(markup).toContain('온보딩 첫 화면에 가이드를 넣으면 리텐션이 오를 것이다');
    expect(markup).toContain('채택');
    expect(markup).toContain('추천일 뿐이다');
    expect(markup).toContain('중'); // 0.55 → mid bucket
  });

  it('does not crash when a recommendation is missing metric_definition (까심 QA 적출 회귀 가드)', () => {
    const synthesis: RetroSynthesis = { learned: [{ text: '학습' }], generated_at: '2026-07-02T00:00:00Z', source: 'ai_draft' };
    const recWithoutMetric: RetroNextHypothesis = {
      statement: '체크아웃 흐름을 모바일에도 적용하면 완료율이 오를 것이다',
      metric_definition: null,
      requires_confirmation: true,
    };
    expect(() => renderToStaticMarkup(wrap(
      <SprintCloseCockpit hypotheses={[VERIFIED]} synthesis={synthesis} nextHypotheses={[recWithoutMetric]} onGenerateSynthesis={noop} onAdoptRecommendation={noop} />,
    ))).not.toThrow();
  });

  it('does not crash on the closed stage when hypotheses/synthesis/next_hypotheses are all empty (nullable graceful floor)', () => {
    expect(() => renderToStaticMarkup(wrap(
      <SprintCloseCockpit hypotheses={[]} synthesis={null} nextHypotheses={[]} onGenerateSynthesis={noop} onAdoptRecommendation={noop} />,
    ))).not.toThrow();
  });
});

describe('EvidenceStrip (thin in-progress-stage strip)', () => {
  it('renders nothing when there are no linked hypotheses (additive, zero visual diff pre-BE)', () => {
    const markup = renderToStaticMarkup(wrap(<EvidenceStrip hypotheses={[]} />));
    expect(markup).toBe('');
  });

  it('renders dot counts once hypotheses are linked', () => {
    const markup = renderToStaticMarkup(wrap(<EvidenceStrip hypotheses={[VERIFIED, FALSIFIED, MEASURING]} />));
    expect(markup).toContain('가설 현황');
  });
});

// ---------------------------------------------------------------------------
// createHeuristicStepSchedule — 까심 QA 적출 test-gap fold(2026-07-03). honest
// indeterminate 계약의 핵심 회귀막: 6초를 넘겨도 마지막 스텝(stepCount-1)에서 캡되고,
// 그 이상은 절대 진행하지 않는다(거짓 완료 방지). createAutosaveScheduler(use-doc-sync.ts)와
// 동형의 순수 스케줄 팩토리 패턴 — React 렌더 없이 fake timer로 직접 검증.
// ---------------------------------------------------------------------------
describe('createHeuristicStepSchedule (honest indeterminate 타이머 캡)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('advances to index 1 at 1.2s, then to the last index at 6s (3-step retro synthesis)', () => {
    const onAdvance = vi.fn();
    createHeuristicStepSchedule(3, onAdvance);

    vi.advanceTimersByTime(1199);
    expect(onAdvance).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onAdvance).toHaveBeenCalledTimes(1);
    expect(onAdvance).toHaveBeenCalledWith(1);

    vi.advanceTimersByTime(6000 - 1200 - 1);
    expect(onAdvance).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect(onAdvance).toHaveBeenNthCalledWith(2, 2); // stepCount-1 = 2
  });

  it('never advances past the last index — no third call even far beyond 6s (거짓 완료 방지, honest 계약 핵심)', () => {
    const onAdvance = vi.fn();
    createHeuristicStepSchedule(3, onAdvance);

    vi.advanceTimersByTime(60_000);
    expect(onAdvance).toHaveBeenCalledTimes(2);
    expect(onAdvance).toHaveBeenLastCalledWith(2);
  });

  it('schedules no timers at all for a 1-step surface (sprint-open draft) — stays active immediately, no fake "done" step', () => {
    const onAdvance = vi.fn();
    createHeuristicStepSchedule(1, onAdvance);

    vi.advanceTimersByTime(60_000);
    expect(onAdvance).not.toHaveBeenCalled();
  });

  it('cancel() stops any pending advance', () => {
    const onAdvance = vi.fn();
    const schedule = createHeuristicStepSchedule(3, onAdvance);
    schedule.cancel();

    vi.advanceTimersByTime(60_000);
    expect(onAdvance).not.toHaveBeenCalled();
  });
});
