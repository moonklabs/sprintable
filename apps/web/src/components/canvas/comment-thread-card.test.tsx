import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { CommentThreadCard } from './comment-thread-card';
import { MOCK_MEMBERS } from '@/services/canvas';
import { MOCK_THREADS } from '@/services/canvas-comments';

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

describe('CommentThreadCard', () => {
  it('shows the resolved-by note and dims the card once resolved', () => {
    const resolved = MOCK_THREADS.find((t) => t.rollup === 'resolved')!;
    const markup = renderToStaticMarkup(wrap(<CommentThreadCard thread={resolved} memberMap={MOCK_MEMBERS} />));
    expect(markup).toContain('opacity-70');
    expect(markup).toContain('해결됨');
    expect(markup).toContain('미르코 페트로비치가 해결함');
  });

  it('hides the reply/resolve controls once a thread is resolved (no false affordance)', () => {
    const resolved = MOCK_THREADS.find((t) => t.rollup === 'resolved')!;
    const markup = renderToStaticMarkup(wrap(<CommentThreadCard thread={resolved} memberMap={MOCK_MEMBERS} />));
    expect(markup).not.toContain('답글…');
  });

  it('shows reply/resolve controls for an open thread', () => {
    const open = MOCK_THREADS.find((t) => t.rollup === 'open')!;
    const markup = renderToStaticMarkup(wrap(<CommentThreadCard thread={open} memberMap={MOCK_MEMBERS} />));
    expect(markup).toContain('답글…');
    expect(markup).toContain('해결');
  });

  it('never uses surveillance vocabulary anywhere in the rendered markup (리트머스 회귀가드)', () => {
    const markup = MOCK_THREADS.map((t) => renderToStaticMarkup(wrap(<CommentThreadCard thread={t} memberMap={MOCK_MEMBERS} />))).join('');
    for (const forbidden of ['방치', '무시', '늦음', '감점', '응답률', '미처리']) {
      expect(markup).not.toContain(forbidden);
    }
  });
});
