import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { OpenLoopCockpit } from './open-loop-cockpit';
import type { RetroHypothesisResult } from '@/services/retro-session';

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

describe('OpenLoopCockpit (E-SPRINT-LOOP sprint-open 278314e9, §10 P0)', () => {
  it('renders nothing when no hypotheses are linked (additive, zero visual diff pre-BE)', () => {
    const markup = renderToStaticMarkup(wrap(<OpenLoopCockpit hypotheses={[]} storyTitles={[]} />));
    expect(markup).toBe('');
  });

  it('renders a measuring hypothesis with metric + experiment chips, no verdict color', () => {
    const h: RetroHypothesisResult = {
      id: 'h1', statement: '체크아웃 단계를 줄이면 결제 완료율이 오른다', status: 'measuring',
      metric: '결제 완료율', measure_after: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    };
    const markup = renderToStaticMarkup(wrap(<OpenLoopCockpit hypotheses={[h]} storyTitles={['CTA A/B 배선']} />));
    expect(markup).toContain('체크아웃 단계를 줄이면 결제 완료율이 오른다');
    expect(markup).toContain('결제 완료율');
    expect(markup).toContain('CTA A/B 배선');
    expect(markup).toContain('측정 중');
  });

  it('SOUL-LOCK: a falsified/killed hypothesis in the open cockpit never renders destructive', () => {
    const h: RetroHypothesisResult = { id: 'h2', statement: '예전 실험', status: 'falsified' };
    const markup = renderToStaticMarkup(wrap(<OpenLoopCockpit hypotheses={[h]} storyTitles={[]} />));
    expect(markup).not.toContain('text-destructive');
    expect(markup).not.toContain('bg-destructive');
    expect(markup).not.toMatch(/\btext-red-\d/);
  });

  // story fbf1c14b: GET /{id}/hypotheses가 BE HYPOTHESIS_STATUSES 전체를 정직하게 반환 —
  // sprint-open 직후 선언된 가설은 proposed/active가 정상 케이스라 verdict 4종만으로는
  // VERDICT_KEY[status]가 undefined였다(PO crux — VERDICT_KEY 확장 확정).
  // 까심 QA 정정(2026-07-03): next-intl의 tr(undefined)는 크래시가 아니라 graceful
  // fallback으로 이상한 텍스트를 냈던 것 — 첫 구현은 "크래시 방지"만 assert해 VERDICT_KEY서
  // 해당 키를 빼도 통과하는 tautological 테스트였다. 이제 실 라벨 문자열을 직접 assert해
  // fallback 텍스트가 아니라 정확한 번역이 나오는지 실증(회귀 시 이 assertion이 먼저 깨짐).
  it.each([
    ['proposed', '제안됨'],
    ['active', '진행 중'],
    ['archived', '보관됨'],
  ] as const)('renders a %s hypothesis with the honest "%s" label (not a fallback), no destructive color', (status, label) => {
    const h: RetroHypothesisResult = { id: `h-${status}`, statement: `${status} 가설`, status };
    const markup = renderToStaticMarkup(wrap(<OpenLoopCockpit hypotheses={[h]} storyTitles={[]} />));
    expect(markup).toContain(`${status} 가설`);
    expect(markup).toContain(label);
    expect(markup).not.toContain('text-destructive');
    expect(markup).not.toContain('bg-destructive');
    expect(markup).not.toMatch(/\btext-red-\d/);
  });
});
