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

const NOW = new Date('2026-07-10T12:00:00Z').getTime();

describe('LiveStream (§6 "누가 주어인가" 리트머스 — 이벤트가 주어, 액터 노출 0 · 시간은 성긴 버킷만)', () => {
  it('renders the event copy without ever surfacing an actor name (actor fields are not even accepted)', () => {
    const events: BeActivityLogItem[] = [
      { id: 'a1', actor_type: 'agent', action: 'doc.created', entity_type: 'doc', entity_title: 'C5 handoff', created_at: new Date(NOW).toISOString() },
    ];
    const markup = renderToStaticMarkup(wrap(<LiveStream events={events} now={NOW} />));
    expect(markup).toContain('새 문서 등록');
    expect(markup).toContain('C5 handoff');
  });

  it('renders a vague recency bucket ("방금" 등), never a precise duration string like "3분 경과"', () => {
    const events: BeActivityLogItem[] = [
      { id: 'a1', actor_type: 'agent', action: 'doc.created', entity_type: 'doc', entity_title: 'X', created_at: new Date(NOW - 2 * 60_000).toISOString() },
    ];
    const markup = renderToStaticMarkup(wrap(<LiveStream events={events} now={NOW} />));
    expect(markup).toContain('방금');
    expect(markup).not.toMatch(/\d+\s*분/);
  });

  it('renders a calm "no recent activity" state for an empty stream', () => {
    const markup = renderToStaticMarkup(wrap(<LiveStream events={[]} now={NOW} />));
    expect(markup).toContain('최근 활동이 없습니다');
  });

  it('falls back to a humanized action label for an unmapped action string', () => {
    const events: BeActivityLogItem[] = [
      { id: 'a2', actor_type: 'human', action: 'gate.approved', entity_type: 'gate', entity_title: null, created_at: new Date(NOW).toISOString() },
    ];
    const markup = renderToStaticMarkup(wrap(<LiveStream events={events} now={NOW} />));
    expect(markup).toContain('gate approved');
  });
});
