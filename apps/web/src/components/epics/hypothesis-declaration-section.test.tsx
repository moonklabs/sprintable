import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { EpicHypothesisDeclarationSection } from './hypothesis-declaration-section';
import { EMPTY_DECLARATION, type HypothesisDeclarationValue } from '@/services/hypothesis-declaration';

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

// story #2760 — sprints/hypothesis-declaration-section.test.tsx와 동형(사본 관계 컴포넌트,
// goals 네임스페이스만 다름). measureAfter 부족 캡션이 이 사본에도 실렌더되는지 확認.
describe('EpicHypothesisDeclarationSection (story 671ea3b8 S4)', () => {
  beforeEach(() => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('measureAfter만 비어 있으면 부족 항목을 명시한다', () => {
    const declarations: HypothesisDeclarationValue[] = [{
      ...EMPTY_DECLARATION,
      statement: '온보딩 플로우를 줄이면 활성화가 오른다',
      metricDefinition: { metric: '활성화율', source: 'internal_ops', target: 4, direction: 'up' },
      measureAfter: '',
    }];
    const markup = renderToStaticMarkup(wrap(
      <EpicHypothesisDeclarationSection projectId="p1" contextTitle="에픽 A" declarations={declarations} onChange={() => {}} />,
    ));
    expect(markup).toContain('선언되려면 필요: 측정 시점');
  });

  it('완결된 카드는 부족 항목 캡션이 안 보인다', () => {
    const declarations: HypothesisDeclarationValue[] = [{
      ...EMPTY_DECLARATION,
      statement: '가설',
      metricDefinition: { metric: 'm', source: 'internal_ops', target: 1, direction: 'up' },
      measureAfter: '2026-08-01',
    }];
    const markup = renderToStaticMarkup(wrap(
      <EpicHypothesisDeclarationSection projectId="p1" contextTitle="에픽 A" declarations={declarations} onChange={() => {}} />,
    ));
    expect(markup).not.toContain('선언되려면 필요');
  });
});
