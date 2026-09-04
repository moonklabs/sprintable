// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ChannelPostCard } from './channel-post-card';
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

const BASE_ITEM: ChannelPostCalendarItem = {
  draft_id: 'd1', connection_id: 'c1', channel: 'threads', body_sha256: 'h1',
};

describe('ChannelPostCard — story #3422, 격자·레인 공용 렌더 단위', () => {
  it('⭐deriveChannelPostView를 재사용해 칩을 그린다(새 파생 없음) — gate_status=null(진짜 게이트 없음)이면 draft 칩', async () => {
    await act(async () => {
      root.render(wrap(<ChannelPostCard item={{ ...BASE_ITEM, gate_status: null }} displayTimezone="Asia/Seoul" />));
    });
    const card = container.querySelector('[data-testid="channel-post-calendar-card"]');
    expect(card?.getAttribute('data-status-chip')).toBe('draft');
  });

  it('⭐AC2 — gate_status 키 자체가 없으면(구 계약) 칩이 "unknown"(단정하지 않는다)', async () => {
    const { gate_status: _drop, ...withoutGateKey } = { ...BASE_ITEM, gate_status: null };
    await act(async () => {
      root.render(wrap(<ChannelPostCard item={withoutGateKey} displayTimezone="Asia/Seoul" />));
    });
    const card = container.querySelector('[data-testid="channel-post-calendar-card"]');
    expect(card?.getAttribute('data-status-chip')).toBe('unknown');
  });

  it('⭐scheduled_at이 있으면 displayTimezone 기준으로 포맷된 시각을 보인다', async () => {
    const item: ChannelPostCalendarItem = { ...BASE_ITEM, scheduled_at: '2026-09-05T12:00:00Z' };
    await act(async () => {
      root.render(wrap(<ChannelPostCard item={item} displayTimezone="Asia/Seoul" />));
    });
    // KST(UTC+9) = 09-05 21:00
    expect(container.querySelector('[data-testid="channel-post-calendar-card-time"]')?.textContent).toMatch(/^09-05 21:00/);
  });

  it('scheduled_at이 없으면(날짜 미정 레인 표본) 시각 노드를 안 그린다', async () => {
    await act(async () => {
      root.render(wrap(<ChannelPostCard item={BASE_ITEM} displayTimezone="Asia/Seoul" />));
    });
    expect(container.querySelector('[data-testid="channel-post-calendar-card-time"]')).toBeNull();
  });

  it('text_preview가 있으면 보이고 없으면 그 줄 자체를 안 그린다(없는 것을 지어내지 않는다)', async () => {
    await act(async () => {
      root.render(wrap(<ChannelPostCard item={{ ...BASE_ITEM, text_preview: '초안 미리보기' }} displayTimezone="Asia/Seoul" />));
    });
    expect(container.querySelector('[data-testid="channel-post-calendar-card-preview"]')?.textContent).toBe('초안 미리보기');
  });

  it('링크는 상세 편집 페이지를 가리킨다', async () => {
    await act(async () => {
      root.render(wrap(<ChannelPostCard item={BASE_ITEM} displayTimezone="Asia/Seoul" />));
    });
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/content/channel-posts/d1');
  });
});
