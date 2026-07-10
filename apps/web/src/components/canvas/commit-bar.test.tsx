import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { CommitBar } from './commit-bar';

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

describe('CommitBar (C3 §2 — 개별 딸깍은 버전 아님, 빈 커밋 방지)', () => {
  it('disables the save button and input when there are no pending changes', () => {
    const markup = renderToStaticMarkup(wrap(<CommitBar changeCount={0} onCommit={vi.fn()} />));
    expect(markup).toContain('변경 0건');
    // 실제 boolean disabled 속성만 검사(tailwind class의 "disabled:opacity-40" 문자열과 혼동 방지).
    expect(markup).toContain('disabled=""');
  });

  it('enables the save button when there are pending changes', () => {
    const markup = renderToStaticMarkup(wrap(<CommitBar changeCount={3} onCommit={vi.fn()} />));
    expect(markup).toContain('변경 3건');
    expect(markup).not.toContain('disabled=""');
  });

  it('renders the done-to-viewer action only when onDone is provided', () => {
    const withDone = renderToStaticMarkup(wrap(<CommitBar changeCount={1} onCommit={vi.fn()} onDone={vi.fn()} />));
    const withoutDone = renderToStaticMarkup(wrap(<CommitBar changeCount={1} onCommit={vi.fn()} />));
    expect(withDone).toContain('완료 → 뷰어');
    expect(withoutDone).not.toContain('완료 → 뷰어');
  });
});
