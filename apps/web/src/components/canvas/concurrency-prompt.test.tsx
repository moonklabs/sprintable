import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ConcurrencyPrompt } from './concurrency-prompt';

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

describe('ConcurrencyPrompt (C3 §3 — 파괴적 덮어쓰기 금지, "뺏김/경쟁" 톤 금지)', () => {
  it('renders the arrival copy and both non-destructive choices (view / merge-over), never a forced overwrite', () => {
    const markup = renderToStaticMarkup(
      wrap(<ConcurrencyPrompt authorName="유나 홀름" version={5} onView={vi.fn()} onMergeOver={vi.fn()} />),
    );
    expect(markup).toContain('유나 홀름');
    expect(markup).toContain('v5');
    expect(markup).toContain('보기');
    expect(markup).toContain('내 편집 위에 병합');
  });

  it('uses the calm info tone class, not a destructive/warning class', () => {
    const markup = renderToStaticMarkup(
      wrap(<ConcurrencyPrompt authorName="디디 은와추쿠" version={2} onView={vi.fn()} onMergeOver={vi.fn()} />),
    );
    expect(markup).toContain('border-info');
    expect(markup).not.toContain('destructive');
    expect(markup).not.toContain('warning');
  });
});
