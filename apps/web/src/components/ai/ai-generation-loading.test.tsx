import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { AiGenerationLoading } from './ai-generation-loading';

const SYNTHESIS_STEPS = [
  { label: '과거 루프에서 유사 선례 회수', desc: '비슷한 가설·결정·성과를 조직 기억에서 찾음' },
  { label: '이번 스프린트 결과 종합', desc: '가설별 검증/반증 + 상위 회고 신호에서 배운 것 도출' },
  { label: '다음 검증 가설 도출', desc: '다음 스프린트에서 검증해볼 만한 방향 제안' },
];

describe('AiGenerationLoading (E-SPRINT-LOOP 81b0d17e — honest indeterminate)', () => {
  it('renders the brand header, all step labels, and the transparency line', () => {
    const markup = renderToStaticMarkup(
      <AiGenerationLoading headline="가 이번 스프린트를 훑는 중…" steps={SYNTHESIS_STEPS} activeIndex={1} skeleton="synthesis" transline="판단은 당신이 합니다." />,
    );
    expect(markup).toContain('Sprintable AI');
    expect(markup).toContain('가 이번 스프린트를 훑는 중…');
    for (const step of SYNTHESIS_STEPS) expect(markup).toContain(step.label);
    expect(markup).toContain('판단은 당신이 합니다.');
  });

  it('never renders a fake percentage as visible text (CSS width utilities like w-[36%] are fine — only text nodes matter)', () => {
    const markup = renderToStaticMarkup(
      <AiGenerationLoading headline="h" steps={SYNTHESIS_STEPS} activeIndex={1} skeleton="synthesis" transline="t" />,
    );
    // honest-indeterminate contract: no rendered text node is a bare "NN%" progress readout
    expect(markup).not.toMatch(/>\s*\d+\s*%\s*</);
  });

  it('renders exactly one active step (indeterminate bar) even mid-sequence — steps before are done, after are pending', () => {
    const markup = renderToStaticMarkup(
      <AiGenerationLoading headline="h" steps={SYNTHESIS_STEPS} activeIndex={1} skeleton="synthesis" transline="t" />,
    );
    const barCount = (markup.match(/animate-ai-loading-indeterminate/g) ?? []).length;
    expect(barCount).toBe(1);
  });

  it('the last step keeps its indeterminate bar at the final index (never fake-completes before the caller flips activeIndex away)', () => {
    const markup = renderToStaticMarkup(
      <AiGenerationLoading headline="h" steps={SYNTHESIS_STEPS} activeIndex={SYNTHESIS_STEPS.length - 1} skeleton="synthesis" transline="t" />,
    );
    expect(markup).toContain('animate-ai-loading-indeterminate');
    expect(markup.match(/✓/g)?.length).toBe(2); // first two steps done, last one still active/shimmering
  });

  it('a single-step surface (sprint-open L3 draft) renders one active node with no connector line', () => {
    const markup = renderToStaticMarkup(
      <AiGenerationLoading headline="가 초안을 짓는 중…" steps={[{ label: '가설 초안 짓는 중', desc: '한 번에 제안' }]} activeIndex={0} skeleton="draft" transline="확정은 당신이." />,
    );
    expect(markup).toContain('가설 초안 짓는 중');
    expect(markup).not.toContain('✓'); // nothing "done" yet in a 1-step pipeline
  });

  it('SOUL-LOCK: never renders destructive styling regardless of skeleton variant', () => {
    const synth = renderToStaticMarkup(
      <AiGenerationLoading headline="h" steps={SYNTHESIS_STEPS} activeIndex={0} skeleton="synthesis" transline="t" />,
    );
    const draft = renderToStaticMarkup(
      <AiGenerationLoading headline="h" steps={[{ label: 's' }]} activeIndex={0} skeleton="draft" transline="t" />,
    );
    for (const markup of [synth, draft]) {
      expect(markup).not.toContain('data-variant="destructive"');
      // 까심 QA 적출(2026-07-03): 시맨틱 destructive 토큰(text-destructive/bg-destructive)은
      // 별도 assert 필요 — red-* 유틸/data-variant 체크가 이 시맨틱 클래스명을 못 잡는다.
      expect(markup).not.toMatch(/\btext-destructive\b/);
      expect(markup).not.toMatch(/\bbg-destructive\b/);
      expect(markup).not.toMatch(/\btext-red-\d|\bbg-red-\d|\bborder-red-\d/);
    }
  });

  it('synthesis and draft skeletons render distinct placeholder shapes', () => {
    const synth = renderToStaticMarkup(
      <AiGenerationLoading headline="h" steps={SYNTHESIS_STEPS} activeIndex={0} skeleton="synthesis" transline="t" />,
    );
    const draft = renderToStaticMarkup(
      <AiGenerationLoading headline="h" steps={[{ label: 's' }]} activeIndex={0} skeleton="draft" transline="t" />,
    );
    expect(synth).toContain('곧 나올 종합');
    expect(draft).toContain('곧 나올 초안');
  });
});
