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

async function render(action: FailureAction) {
  await act(async () => {
    root.render(wrap(<FailureActionBadge action={action} />));
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

  it('⭐auto_retry — 버튼 없음(§17-13 "자동 재시도가 예정되면 수동 버튼 없음"), next_retry_at 보간', async () => {
    await render({ kind: 'auto_retry', nextRetryAt: '2026-09-05T00:00:00Z' });
    expect(container.querySelector('[data-testid="channel-post-failure-retry-button"]')).toBeNull();
    expect(container.textContent).toBe(koMessages.content.channelPostsFailureAutoRetryAt.replace('{time}', '2026-09-05T00:00:00Z'));
  });

  it('⭐dead_letter — 버튼 있음(수동 재시도, 휴먼 전용은 소비부 게이팅 몫)', async () => {
    await render({ kind: 'dead_letter' });
    expect(container.querySelector('[data-testid="channel-post-failure-retry-button"]')?.textContent)
      .toBe(koMessages.content.channelPostsFailureRetryCta);
  });

  it('⭐voided — 버튼 없음, 사유 보간', async () => {
    await render({ kind: 'voided', reasonCode: 'draft_edited' });
    expect(container.querySelector('[data-testid="channel-post-failure-retry-button"]')).toBeNull();
    expect(container.textContent).toBe(koMessages.content.channelPostsFailureVoidedWithReason.replace('{reason}', 'draft_edited'));
  });

  it('voided인데 사유가 없으면 사유 없는 폴백 문구', async () => {
    await render({ kind: 'voided', reasonCode: null });
    expect(container.textContent).toBe(koMessages.content.channelPostsFailureVoided);
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
      root.render(wrap(<FailureActionBadge action={{ kind: 'dead_letter' }} onRetryClick={() => { clicked = true; }} />));
    });
    const btn = container.querySelector('[data-testid="channel-post-failure-retry-button"]') as HTMLButtonElement;
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(clicked).toBe(true);
  });
});
