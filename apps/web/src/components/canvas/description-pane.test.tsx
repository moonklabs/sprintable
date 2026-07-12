import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { DescriptionPane } from './description-pane';

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

describe('DescriptionPane (C2 §4 — 요소별 "보이는 PRD", 읽기 전용·낙인 문구 금지)', () => {
  it('renders the element label and description together when both are present', () => {
    const markup = renderToStaticMarkup(wrap(<DescriptionPane description="에러 시 재시도 유도" elementLabel="다시 결제하기 버튼" />));
    expect(markup).toContain('다시 결제하기 버튼');
    expect(markup).toContain('에러 시 재시도 유도');
  });

  it('renders the description alone (no stray separator) when elementLabel is omitted', () => {
    const markup = renderToStaticMarkup(wrap(<DescriptionPane description="에러 시 재시도 유도" />));
    expect(markup).toContain('에러 시 재시도 유도');
    expect(markup).not.toContain('·');
  });

  it('renders a neutral empty state (not a prompt/nag) when there is no description', () => {
    const markup = renderToStaticMarkup(wrap(<DescriptionPane description={null} />));
    expect(markup).not.toContain('에러 시 재시도 유도');
  });
});
