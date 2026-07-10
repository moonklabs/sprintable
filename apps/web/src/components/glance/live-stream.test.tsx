import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { LiveStream } from './live-stream';
import type { BeActivityLogItem } from '@/services/glance';

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

describe('LiveStream (§6 "누가 주어인가" 리트머스 — 이벤트가 주어, 액터/시간 노출 0)', () => {
  it('renders the event copy without ever surfacing an actor name (actor fields are not even accepted)', () => {
    const events: BeActivityLogItem[] = [
      { id: 'a1', actor_type: 'agent', action: 'doc.created', entity_type: 'doc', entity_title: 'C5 handoff', created_at: '2026-07-10T00:00:00Z' },
    ];
    const markup = renderToStaticMarkup(wrap(<LiveStream events={events} />));
    expect(markup).toContain('새 문서 등록');
    expect(markup).toContain('C5 handoff');
  });

  it('renders a calm "no recent activity" state for an empty stream', () => {
    const markup = renderToStaticMarkup(wrap(<LiveStream events={[]} />));
    expect(markup).toContain('최근 활동이 없습니다');
  });

  it('falls back to a humanized action label for an unmapped action string', () => {
    const events: BeActivityLogItem[] = [
      { id: 'a2', actor_type: 'human', action: 'gate.approved', entity_type: 'gate', entity_title: null, created_at: '2026-07-10T00:00:00Z' },
    ];
    const markup = renderToStaticMarkup(wrap(<LiveStream events={events} />));
    expect(markup).toContain('gate approved');
  });
});
