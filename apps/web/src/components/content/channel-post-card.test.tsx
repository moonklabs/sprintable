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

  // B3(페드루 PO, 2026-09-04 13:14Z) — FailureActionBadge가 정의만 있고 캘린더 셀·레인
  // 어디에도 mount 안 돼 있던 갭. 표본 5종이 카드에서 실제로 「보인다」를 pin한다(존재
  // 여부가 아니라 렌더 여부 — deriveFailureAction을 다시 짜지 않고 그대로 재사용).
  describe('⭐B3 — 실패 배지 5종이 카드에서 보인다', () => {
    it('blocked', async () => {
      await act(async () => {
        root.render(wrap(<ChannelPostCard item={{ ...BASE_ITEM, command_status: 'blocked' }} displayTimezone="Asia/Seoul" />));
      });
      expect(container.querySelector('[data-testid="channel-post-failure-badge"]')?.textContent)
        .toBe(koMessages.content.channelPostsFailureBlocked);
    });

    it('needs_check — 카드에선 compact(라벨만, 버튼 없음 — N3)', async () => {
      await act(async () => {
        root.render(wrap(
          <ChannelPostCard item={{ ...BASE_ITEM, command_status: 'pending', failure_kind: 'needs_check' }} displayTimezone="Asia/Seoul" />,
        ));
      });
      expect(container.querySelector('[data-testid="channel-post-failure-badge"]')?.textContent)
        .toBe(koMessages.content.channelPostsFailureNeedsCheck);
      expect(container.querySelector('[data-testid="channel-post-failure-retry-button"]')).toBeNull();
    });

    it('auto_retry', async () => {
      await act(async () => {
        root.render(wrap(
          <ChannelPostCard
            item={{ ...BASE_ITEM, command_status: 'pending', failure_kind: 'transient', next_retry_at: '2026-09-05T00:00:00Z' }}
            displayTimezone="Asia/Seoul"
          />,
        ));
      });
      expect(container.querySelector('[data-testid="channel-post-failure-badge"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="channel-post-failure-retry-button"]')).toBeNull();
    });

    it('dead_letter — 카드에선 compact(라벨만, 버튼 없음 — N3)', async () => {
      await act(async () => {
        root.render(wrap(<ChannelPostCard item={{ ...BASE_ITEM, command_status: 'dead_letter' }} displayTimezone="Asia/Seoul" />));
      });
      expect(container.querySelector('[data-testid="channel-post-failure-badge"]')?.textContent)
        .toBe(koMessages.content.channelPostsFailureDeadLetter);
      expect(container.querySelector('[data-testid="channel-post-failure-retry-button"]')).toBeNull();
    });

    // N3(페드루 PO, 2026-09-04 13:26Z) — 카드 전체가 <Link>다. 실패 배지가 어떤 갈래든
    // 카드 안에 <button>이 하나도 없어야 인터랙티브 중첩(a>button)이 안 생긴다.
    it('⭐N3 — needs_check·dead_letter여도 카드 안에 button이 0개(a>button 중첩 금지)', async () => {
      await act(async () => {
        root.render(wrap(<ChannelPostCard item={{ ...BASE_ITEM, command_status: 'dead_letter' }} displayTimezone="Asia/Seoul" />));
      });
      expect(container.querySelectorAll('button').length).toBe(0);
    });

    it('voided', async () => {
      await act(async () => {
        root.render(wrap(
          <ChannelPostCard item={{ ...BASE_ITEM, command_status: 'voided', command_reason_code: 'CONTENT_CHANGED' }} displayTimezone="Asia/Seoul" />,
        ));
      });
      expect(container.querySelector('[data-testid="channel-post-failure-badge"]')?.textContent)
        .toBe(koMessages.content.channelPostsFailureVoidedWithReason.replace('{reason}', '본문이 바뀜'));
    });
  });

  // story f30da19a AC5 — T8(캘린더 칸). sandbox 연결로 만든 초안은 진짜 초안과 나란히
  // 서므로 표기 유무를 pin한다.
  it('⭐AC5 — channel=sandbox면 「테스트」 배지가 칩 옆에 뜬다', async () => {
    await act(async () => {
      root.render(wrap(<ChannelPostCard item={{ ...BASE_ITEM, channel: 'sandbox' }} displayTimezone="Asia/Seoul" />));
    });
    expect(container.querySelector('[data-testid="channel-post-sandbox-test-badge"]')?.textContent)
      .toBe(koMessages.content.channelPostsSandboxTestBadge);
  });

  it('AC5 — channel=threads(실채널)면 「테스트」 배지가 없다', async () => {
    await act(async () => {
      root.render(wrap(<ChannelPostCard item={{ ...BASE_ITEM, channel: 'threads' }} displayTimezone="Asia/Seoul" />));
    });
    expect(container.querySelector('[data-testid="channel-post-sandbox-test-badge"]')).toBeNull();
  });

  // story #3457 후속(유나 §14-2 안전 표기, PO 확定 2026-09-04 20:54Z) — 카드 전체가 이미
  // <Link>라 원문 링크는 중첩 불가(a>a 무효 HTML) — 평문으로만. 배지는 상세 전용(유나
  // 정본) — 카드엔 안 그린다.
  it('source_content_item_id가 없으면(정상값) "같은 스토리의 글" 줄이 안 그려진다', async () => {
    await act(async () => {
      root.render(wrap(<ChannelPostCard item={BASE_ITEM} displayTimezone="Asia/Seoul" />));
    });
    expect(container.querySelector('[data-testid="channel-post-calendar-card-source"]')).toBeNull();
  });

  it('⭐source_title이 있으면 "같은 스토리의 글" 평문(링크 아님, 카드 자체가 이미 링크)이 보인다', async () => {
    await act(async () => {
      root.render(wrap(
        <ChannelPostCard
          item={{ ...BASE_ITEM, source_content_item_id: 'site-1', source_title: '9월 실험 회고' }}
          displayTimezone="Asia/Seoul"
        />,
      ));
    });
    const el = container.querySelector('[data-testid="channel-post-calendar-card-source"]');
    expect(el?.textContent).toContain(koMessages.content.channelPostsSourceLabel);
    expect(el?.textContent).toContain('9월 실험 회고');
    expect(el?.querySelector('a')).toBeNull();
  });
});
