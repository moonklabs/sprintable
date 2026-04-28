import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { DecisionsWaiting } from './decisions-waiting';

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

describe('DecisionsWaiting (SSR snapshot)', () => {
  beforeEach(() => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing on first paint while items load (avoids layout shift)', () => {
    const markup = renderToStaticMarkup(wrap(<DecisionsWaiting />));
    // SSR runs the initial render before useEffect — items=[] and loading=true → returns null
    expect(markup).toBe('');
  });
});
