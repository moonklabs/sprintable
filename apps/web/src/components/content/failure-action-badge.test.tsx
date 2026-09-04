// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { FailureActionBadge } from './failure-action-badge';
import type { FailureAction } from './failure-action';

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
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="UTC">{node}</NextIntlClientProvider>;
}

async function render(action: FailureAction, displayTimezone = 'UTC') {
  await act(async () => {
    root.render(wrap(<FailureActionBadge action={action} displayTimezone={displayTimezone} />));
  });
}

describe('FailureActionBadge — story #3422 ②-c 2/N(doc §17-13 버튼 유무표)', () => {
  it('⭐blocked — 버튼 없음(§17-13)', async () => {
    await render({ kind: 'blocked' });
    expect(container.querySelector('[data-testid="channel-post-failure-retry-button"]')).toBeNull();
    expect(container.textContent).toBe(koMessages.content.channelPostsFailureBlocked);
  });

  it('⭐needs_check — 버튼 있음(2단계)', async () => {
    await render({ kind: 'needs_check' });
    expect(container.querySelector('[data-testid="channel-post-failure-retry-button"]')?.textContent)
      .toBe(koMessages.content.channelPostsFailureCheckedRetryCta);
  });

  // B3(페드루 PO, 2026-09-04 13:14Z) — 재시도 클릭 배선은 story f061c1a3 후속(BE
  // command_id 노출 뒤). 그 前까지 onRetryClick 미배선 상태로는 disabled+title로만
  // 렌더한다(눌리는데 아무 일 없는 버튼 금지).
  it('⭐B3 — needs_check 재시도 버튼은 onRetryClick 미배선이면 disabled+title', async () => {
    await render({ kind: 'needs_check' });
    const btn = container.querySelector('[data-testid="channel-post-failure-retry-button"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe(koMessages.content.channelPostsFailureRetryComingSoon);
  });

  // N3(페드루 PO, 2026-09-04 13:26Z) — ChannelPostCard(`<Link>`)가 쓰는 모드. 버튼 자체를
  // 안 그린다(disabled로도 인터랙티브 요소 중첩은 남는다 — a>button 자체를 없앤다).
  it('⭐N3 — compact=true면 needs_check 재시도 버튼을 아예 안 그린다(라벨만)', async () => {
    await act(async () => {
      root.render(wrap(<FailureActionBadge action={{ kind: 'needs_check' }} displayTimezone="UTC" compact />));
    });
    expect(container.querySelector('[data-testid="channel-post-failure-retry-button"]')).toBeNull();
    expect(container.textContent).toBe(koMessages.content.channelPostsFailureNeedsCheck);
  });

  it('⭐auto_retry — 버튼 없음(§17-13 "자동 재시도가 예정되면 수동 버튼 없음"), next_retry_at 보간', async () => {
    await render({ kind: 'auto_retry', nextRetryAt: '2026-09-05T00:00:00Z' });
    expect(container.querySelector('[data-testid="channel-post-failure-retry-button"]')).toBeNull();
    expect(container.textContent).toBe(koMessages.content.channelPostsFailureAutoRetryAt.replace('{time}', '09-05 00:00 UTC'));
  });

  // B2(페드루 PO 지적, 2026-09-04) — scheduled_at(ChannelPostCard)과 같은 카드 안에서
  // next_retry_at만 ISO 원문으로 뜨던 결함. formatScheduledAt을 거쳐 같은 형식(MM-DD
  // HH:mm TZ)이어야 하고, ISO 원문(끊긴 T·Z 포함 문자열)이 DOM에 남으면 안 된다.
  it('⭐B2 — next_retry_at은 ISO 원문이 아니라 displayTimezone 기준 formatScheduledAt 형식으로 뜬다', async () => {
    await render({ kind: 'auto_retry', nextRetryAt: '2026-09-05T21:30:00Z' }, 'Asia/Seoul');
    expect(container.textContent).not.toContain('2026-09-05T21:30:00Z');
    expect(container.textContent).toContain('09-06 06:30');
  });

  it('⭐dead_letter — 버튼 있음(수동 재시도, 휴먼 전용은 소비부 게이팅 몫)', async () => {
    await render({ kind: 'dead_letter' });
    expect(container.querySelector('[data-testid="channel-post-failure-retry-button"]')?.textContent)
      .toBe(koMessages.content.channelPostsFailureRetryCta);
  });

  it('⭐B3 — dead_letter 재시도 버튼은 onRetryClick 미배선이면 disabled+title', async () => {
    await render({ kind: 'dead_letter' });
    const btn = container.querySelector('[data-testid="channel-post-failure-retry-button"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe(koMessages.content.channelPostsFailureRetryComingSoon);
  });

  it('⭐N3 — compact=true면 dead_letter 재시도 버튼을 아예 안 그린다(라벨만)', async () => {
    await act(async () => {
      root.render(wrap(<FailureActionBadge action={{ kind: 'dead_letter' }} displayTimezone="UTC" compact />));
    });
    expect(container.querySelector('[data-testid="channel-post-failure-retry-button"]')).toBeNull();
    expect(container.textContent).toBe(koMessages.content.channelPostsFailureDeadLetter);
  });

  // N2(페드루 PO 지적, 2026-09-04) — CONTENT_CHANGED는 실측 BE reason_code(channel_posts.py
  // 재승인 트리거) 중 하나 — 맵에 있으니 라벨로 보인다(원시 코드 노출 금지).
  it('⭐voided — 버튼 없음, 맵에 있는 사유는 라벨로 보인다(원시 코드 아님)', async () => {
    await render({ kind: 'voided', reasonCode: 'CONTENT_CHANGED' });
    expect(container.querySelector('[data-testid="channel-post-failure-retry-button"]')).toBeNull();
    expect(container.textContent).toBe(koMessages.content.channelPostsFailureVoidedWithReason.replace('{reason}', '본문이 바뀜'));
    expect(container.textContent).not.toContain('CONTENT_CHANGED');
  });

  it('voided인데 사유가 없으면 사유 없는 폴백 문구', async () => {
    await render({ kind: 'voided', reasonCode: null });
    expect(container.textContent).toBe(koMessages.content.channelPostsFailureVoided);
  });

  // N2 — 맵에 없는(미지) reason_code는 원시값을 그대로 노출하지 않고 사유 없는 폴백으로
  // 떨어진다(entity-status-labels.ts::translateEntityStatus와 동형 규율).
  it('⭐N2 — 맵에 없는 reason_code는 원시값 노출 대신 사유 없는 「무효가 됨」으로 떨어진다', async () => {
    await render({ kind: 'voided', reasonCode: 'SOME_FUTURE_REASON_CODE' });
    expect(container.textContent).toBe(koMessages.content.channelPostsFailureVoided);
    expect(container.textContent).not.toContain('SOME_FUTURE_REASON_CODE');
  });

  it('⭐processing(§17-15) — 버튼 없음, transient와 다른 문구', async () => {
    await render({ kind: 'processing' });
    expect(container.querySelector('[data-testid="channel-post-failure-retry-button"]')).toBeNull();
    expect(container.textContent).toBe(koMessages.content.channelPostsFailureProcessing);
    expect(container.textContent).not.toBe(koMessages.content.channelPostsFailureAutoRetryUnknown);
  });

  it('onRetryClick이 dead_letter 재시도 버튼 클릭 시 호출된다', async () => {
    let clicked = false;
    await act(async () => {
      root.render(wrap(<FailureActionBadge action={{ kind: 'dead_letter' }} onRetryClick={() => { clicked = true; }} displayTimezone="UTC" />));
    });
    const btn = container.querySelector('[data-testid="channel-post-failure-retry-button"]') as HTMLButtonElement;
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(clicked).toBe(true);
  });
});
