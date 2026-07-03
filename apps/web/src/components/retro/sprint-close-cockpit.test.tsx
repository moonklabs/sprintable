import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { SprintCloseCockpit } from './sprint-close-cockpit';
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

  it('SOUL-LOCK: falsified renders neutral (info), never destructive/red', () => {
    const markup = renderToStaticMarkup(wrap(
      <SprintCloseCockpit hypotheses={[VERIFIED, FALSIFIED]} synthesis={null} nextHypotheses={[]} onGenerateSynthesis={noop} onAdoptRecommendation={noop} />,
    ));
    expect(markup).toContain('반증됨');
    expect(markup).toContain('학습');
    // the falsified verdict badge/note must never carry a destructive/red treatment
    expect(markup).not.toContain('text-destructive');
    expect(markup).not.toContain('bg-destructive');
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
