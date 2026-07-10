import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';
import { ActionZone } from './action-zone';
import type { MyActions } from './types';

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

const DATA: MyActions = {
  action_queue: { scope: 'project', items: [] },
  attention: {
    scope: 'project',
    items: [
      { type: 'agent_stuck', severity: 'warn', auto_detected: true, entity_type: 'story', entity_id: 's1', gate_type: '리뷰', stuck_since: '2026-07-10T00:00:00Z' },
    ],
    pending: [],
  },
  is_clear: false,
};

describe('ActionZone attention row (command-center-surveillance-reframe-handoff — "대기는 경보가 아니라 상태")', () => {
  it('renders "게이트 대기 중" copy without a precise elapsed-minutes count or "멈춤" wording', () => {
    const markup = renderToStaticMarkup(wrap(<ActionZone data={DATA} resolveName={() => null} epicTitles={{}} />));
    expect(markup).toContain('리뷰 대기 중');
    expect(markup).not.toContain('멈춤');
    expect(markup).not.toMatch(/\d+\s*분째/);
  });

  it('uses a neutral border/dot tone, never the warning color, for the stuck-item card', () => {
    const markup = renderToStaticMarkup(wrap(<ActionZone data={DATA} resolveName={() => null} epicTitles={{}} />));
    expect(markup).not.toContain('border-warning');
    expect(markup).not.toContain('bg-warning');
    expect(markup).toContain('bg-info/60');
  });

  it('renders the calm "지금 볼 것" section heading, not an alarm framing', () => {
    const markup = renderToStaticMarkup(wrap(<ActionZone data={DATA} resolveName={() => null} epicTitles={{}} />));
    expect(markup).toContain('지금 볼 것');
    expect(markup).not.toContain('주의');
  });
});
