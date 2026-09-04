// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { UnscheduledLane } from './unscheduled-lane';
import type { ChannelPostCalendarItem } from './use-channel-post-calendar-data';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('next/navigation', () => ({ useParams: () => ({}) }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

function wrap(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
}

const ITEM = (id: string): ChannelPostCalendarItem => ({ draft_id: id, connection_id: 'c1', channel: 'threads', body_sha256: 'h1', gate_status: null });

describe('UnscheduledLane — story #3422 doc §11-1', () => {
  it('⭐비어 있으면 레인 자체를 안 그린다(빈 레인이 자리를 먹지 않는다)', async () => {
    await act(async () => {
      root.render(wrap(<UnscheduledLane items={[]} displayTimezone="Asia/Seoul" />));
    });
    expect(container.querySelector('[data-testid="channel-post-unscheduled-lane"]')).toBeNull();
  });

  it('⭐항목이 있으면 개수와 함께 카드들을 그린다', async () => {
    await act(async () => {
      root.render(wrap(<UnscheduledLane items={[ITEM('d1'), ITEM('d2')]} displayTimezone="Asia/Seoul" />));
    });
    const lane = container.querySelector('[data-testid="channel-post-unscheduled-lane"]');
    expect(lane).not.toBeNull();
    expect(lane?.textContent).toContain('2');
    expect(container.querySelectorAll('[data-testid="channel-post-calendar-card"]').length).toBe(2);
  });
});
