import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { PropagationStrip } from './propagation-strip';
import { MOCK_MEMBERS } from '@/services/canvas';

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

describe('PropagationStrip (§3-7 감시-게이트 회귀가드)', () => {
  it('renders nothing when there are no recipients', () => {
    const markup = renderToStaticMarkup(wrap(<PropagationStrip recipients={[]} memberMap={MOCK_MEMBERS} />));
    expect(markup).toBe('');
  });

  it('renders a calm "delivering to" sentence for a single pending recipient — not an alarm', () => {
    const markup = renderToStaticMarkup(
      wrap(<PropagationStrip recipients={[{ member_id: 'm1', state: 'pending' }]} memberMap={MOCK_MEMBERS} />),
    );
    expect(markup).toContain('미르코 페트로비치에게 전달 중');
  });

  it('surfaces the most-advanced recipient and aggregates the rest as "+N 도달"', () => {
    const markup = renderToStaticMarkup(
      wrap(<PropagationStrip recipients={[{ member_id: 'm5', state: 'read' }, { member_id: 'm1', state: 'delivered' }]} memberMap={MOCK_MEMBERS} />),
    );
    expect(markup).toContain('담롱 온찬');
    expect(markup).toContain('열람');
    expect(markup).toContain('+1 도달');
  });

  it('renders the linked-version result line when a comment produced a new version', () => {
    const markup = renderToStaticMarkup(
      wrap(<PropagationStrip recipients={[{ member_id: 'm1', state: 'responded' }]} memberMap={MOCK_MEMBERS} linkedVersion={4} />),
    );
    expect(markup).toContain('v4 생성');
  });

  it('never emits destructive/warning color classes — pending stays calm muted (감시-게이트)', () => {
    const markup = renderToStaticMarkup(
      wrap(<PropagationStrip recipients={[{ member_id: 'm1', state: 'pending' }]} memberMap={MOCK_MEMBERS} />),
    );
    expect(markup).not.toContain('text-destructive');
    expect(markup).not.toContain('text-warning');
  });
});
