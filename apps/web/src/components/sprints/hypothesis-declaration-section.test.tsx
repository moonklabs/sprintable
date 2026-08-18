import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { HypothesisDeclarationSection } from './hypothesis-declaration-section';
import { EMPTY_DECLARATION, type HypothesisDeclarationValue } from '@/services/hypothesis-declaration';

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

describe('HypothesisDeclarationSection (E-SPRINT-LOOP sprint-open 278314e9)', () => {
  beforeEach(() => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the "what will this sprint test" question, not an error wall, when 0 declared (AC1 마찰X)', () => {
    const markup = renderToStaticMarkup(wrap(
      <HypothesisDeclarationSection projectId="p1" contextTitle="스프린트 A" declarations={[]} onChange={() => {}} />,
    ));
    expect(markup).toContain('이 스프린트로 무엇을 검증하나요?');
    // gate copy itself must read as an invitation, not an error state — no destructive-variant badge
    // (Badge's own aria-invalid boilerplate carries "border-destructive" unconditionally, so assert
    // on the actual variant attribute instead of grepping for that substring).
    expect(markup).not.toContain('data-variant="destructive"');
  });

  it('renders a declaration card once at least one is added', () => {
    const declarations: HypothesisDeclarationValue[] = [{ ...EMPTY_DECLARATION }];
    const markup = renderToStaticMarkup(wrap(
      <HypothesisDeclarationSection projectId="p1" contextTitle="스프린트 A" declarations={declarations} onChange={() => {}} />,
    ));
    expect(markup).toContain('새로 정의');
    expect(markup).toContain('기존 링크');
    expect(markup).not.toContain('이 스프린트로 무엇을 검증하나요?');
  });

  it('shows the declared count once a complete declaration exists', () => {
    const declarations: HypothesisDeclarationValue[] = [{
      ...EMPTY_DECLARATION,
      statement: '가설',
      metricDefinition: { metric: 'm', source: 'internal_ops', target: 1, direction: 'up' },
      measureAfter: '2026-08-01',
    }];
    const markup = renderToStaticMarkup(wrap(
      <HypothesisDeclarationSection projectId="p1" contextTitle="스프린트 A" declarations={declarations} onChange={() => {}} />,
    ));
    expect(markup).toContain('1 선언됨');
  });

  // story #2760(PO 라이브 실측 2026-08-18) — statement·지표·target을 다 채워도 measureAfter가
  // 비어 있으면 "0 선언됨"으로 조용히 남던 것. 카드가 부족 항목을 명시하는지 실렌더로 확認
  // (소스텍스트 가드만으로는 조건문 오타·잘못된 t() 키를 못 잡는다).
  it('measureAfter만 비어 있으면 카드가 "측정 시점"이 부족하다고 명시한다(재현: PO 실측)', () => {
    const declarations: HypothesisDeclarationValue[] = [{
      ...EMPTY_DECLARATION,
      statement: '가격 페이지 CTA를 바꾸면 전환이 오른다',
      metricDefinition: { metric: '가입 전환율', source: 'internal_ops', target: 4, direction: 'up' },
      measureAfter: '',
    }];
    const markup = renderToStaticMarkup(wrap(
      <HypothesisDeclarationSection projectId="p1" contextTitle="스프린트 A" declarations={declarations} onChange={() => {}} />,
    ));
    expect(markup).toContain('0 선언됨');
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
      <HypothesisDeclarationSection projectId="p1" contextTitle="스프린트 A" declarations={declarations} onChange={() => {}} />,
    ));
    expect(markup).not.toContain('선언되려면 필요');
  });
});
