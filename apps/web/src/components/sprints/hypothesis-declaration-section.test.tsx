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
});
