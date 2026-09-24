// @vitest-environment jsdom
//
// story #4262(유나 «디자인 확정» 표) — 발송 게이트 «발송 상태» 한 줄 + 사람 재시도. 상태별 표시 · 버튼 유무 · 재시도 1회 · 사람 전용.
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import type { GateItem } from '@/components/kanban/types';

const { fetchWithAuthMock } = vi.hoisted(() => ({ fetchWithAuthMock: vi.fn() }));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: fetchWithAuthMock }));
vi.mock('@/app/dashboard/dashboard-shell', () => ({ useConnectRulesHref: () => '/organization/channels' }));

import { NewsletterSendStatus } from './newsletter-send-status';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const K = koMessages.content as Record<string, string>;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetchWithAuthMock.mockReset();
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

type Command = NonNullable<GateItem['newsletter_send_command']>;

function gate(command: Partial<Command> | null, gateType = 'newsletter_send'): GateItem {
  return {
    id: 'gate-1', org_id: 'org-1', work_item_id: 'story-1', work_item_type: 'story', gate_type: gateType, status: 'approved',
    resolver_id: null, resolved_at: null, resolution_note: null, neutral_facts: null,
    created_at: '2026-09-24T00:00:00Z', updated_at: '2026-09-24T00:00:00Z',
    newsletter_send_command: command === null ? null : {
      id: 'cmd-1', status: 'dead_letter', failure_kind: null, reason_code: null, next_attempt_at: null, reason_reset_at: null,
      ...command,
    },
  } as GateItem;
}

async function mount(g: GateItem, { isHuman = true, onRetried }: { isHuman?: boolean; onRetried?: () => void } = {}) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <NewsletterSendStatus gate={g} orgId="org-1" isHuman={isHuman} displayTimezone="Asia/Seoul" onRetried={onRetried} />
      </NextIntlClientProvider>,
    );
  });
}

const q = (id: string) => document.querySelector(`[data-testid="${id}"]`);

async function click(el: Element | null) {
  await act(async () => { (el as HTMLElement).click(); });
  await act(async () => { await Promise.resolve(); });
}

describe('NewsletterSendStatus — 상태별 표시(유나 표)', () => {
  it.each([
    ['명령 없음', null],
    ['대기(실패 없음)', { status: 'pending' }],
    ['처리 중', { status: 'in_progress' }],
    ['완료', { status: 'completed' }],
    ['조직 일시정지 blocked', { status: 'blocked', failure_kind: 'paused' }],
  ] as const)('%s → 줄 없음', async (_label, command) => {
    await mount(gate(command as Partial<Command> | null));
    expect(q('newsletter-send-status')).toBeNull();
  });

  it('뉴스레터 게이트가 아니면 줄 없음', async () => {
    await mount(gate({ status: 'dead_letter' }, 'external_publish'));
    expect(q('newsletter-send-status')).toBeNull();
  });

  it('일시 실패 · 자동 재시도 예정 → 재시도 시각 줄 · 버튼 없음', async () => {
    await mount(gate({ status: 'pending', failure_kind: 'transient', next_attempt_at: '2026-09-24T05:00:00Z' }));
    expect(q('channel-post-failure-badge')?.textContent).toContain('14:00');
    expect(q('channel-post-failure-retry-button')).toBeNull();
  });

  it('dead_letter · 보냈는지 모름 → 확인 문장 · «확인했어요 · 다시 시도» · 체크 전엔 확인 버튼 비활성', async () => {
    await mount(gate({ status: 'dead_letter', failure_kind: 'needs_check' }));
    expect(q('channel-post-failure-badge')?.textContent).toContain(K.channelPostsFailureNeedsCheck);
    expect(q('channel-post-failure-retry-button')?.textContent).toBe(K.channelPostsFailureCheckedRetryCta);
    await click(q('channel-post-failure-retry-button'));
    expect(q('channel-post-retry-confirm-checklist')).not.toBeNull();
  });

  it('dead_letter · 확실히 안 나감(not_sent) → «자동 재시도를 멈췄어요.» · «다시 시도»', async () => {
    await mount(gate({ status: 'dead_letter', failure_kind: 'not_sent', reason_code: 'NEWSLETTER_SEND_CHANNEL_UNSUPPORTED' }));
    expect(q('channel-post-failure-badge')?.textContent).toContain(K.channelPostsFailureDeadLetter);
    expect(q('channel-post-failure-retry-button')?.textContent).toBe(K.channelPostsFailureRetryCta);
  });

  it('연결 문제로 멈춤(blocked_unapproved + 연결 비활성) → «연결 문제로 멈춤» + 연결 화면 링크 + «다시 시도»', async () => {
    await mount(gate({ status: 'blocked_unapproved', reason_code: 'NEWSLETTER_SEND_CONNECTION_UNAVAILABLE' }));
    expect(q('channel-post-failure-badge')?.textContent).toBe(K.channelPostsFailureBlocked);
    expect(q('newsletter-send-connection-reason')?.querySelector('a')?.getAttribute('href')).toBe('/organization/channels');
    expect(q('channel-post-failure-retry-button')?.textContent).toBe(K.channelPostsFailureRetryCta);
  });

  it('그 밖의 blocked_unapproved(캠페인 없음 등) → «자동 재시도를 멈췄어요.» · 버튼 없음', async () => {
    await mount(gate({ status: 'blocked_unapproved', reason_code: 'NEWSLETTER_SEND_CAMPAIGN_MISSING' }));
    expect(q('channel-post-failure-badge')?.textContent).toContain(K.channelPostsFailureDeadLetter);
    expect(q('channel-post-failure-retry-button')).toBeNull();
  });
});

describe('NewsletterSendStatus — 재시도', () => {
  it('에이전트 화면엔 상태 줄만(버튼 0) — 재시도 API가 사람 전용', async () => {
    await mount(gate({ status: 'dead_letter', failure_kind: 'not_sent' }), { isHuman: false });
    expect(q('channel-post-failure-badge')?.textContent).toContain(K.channelPostsFailureDeadLetter);
    expect(q('channel-post-failure-retry-button')).toBeNull();
  });

  it('확인 창을 거쳐 공용 재시도 BFF를 정확히 1회 · 결과 줄 · 게이트 다시 읽기', async () => {
    fetchWithAuthMock.mockResolvedValue(new Response(JSON.stringify({ id: 'cmd-1', status: 'pending' }), { status: 200 }));
    const onRetried = vi.fn();
    await mount(gate({ status: 'dead_letter', failure_kind: 'not_sent' }), { onRetried });
    await click(q('channel-post-failure-retry-button'));
    expect(fetchWithAuthMock).not.toHaveBeenCalled(); // 확인 전엔 부르지 않는다(구독자 전원에게 두 번 갈 수 있어서)
    // 확인 창의 확인 버튼(배지 버튼과 낱말이 같아 창 안에서 고른다).
    const confirm = Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) => b.textContent === K.channelPostsRetryConfirmAction);
    await click(confirm ?? null);
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(1);
    expect(fetchWithAuthMock).toHaveBeenCalledWith('/api/organizations/org-1/publication-commands/cmd-1/retry', { method: 'POST' });
    expect(q('channel-post-retry-result')?.textContent).toBe(K.channelPostsRetrySuccess);
    expect(onRetried).toHaveBeenCalledTimes(1);
  });

  // story #4266 — 채널 포스트 · 사이트 글과 같은 공용 규칙: 결과가 무엇이든 창을 닫고 결과 줄 · 404는 게이트를 다시 읽고 유나 문장.
  async function confirmRetry(onRetried = vi.fn()) {
    await mount(gate({ status: 'dead_letter', failure_kind: 'not_sent' }), { onRetried });
    await click(q('channel-post-failure-retry-button'));
    const confirm = Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) => b.textContent === K.channelPostsRetryConfirmAction);
    await click(confirm ?? null);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    return onRetried;
  }

  it('⭐#4266 AC1 — 재시도 500 → 확인 창이 닫히고 결과 줄 · 서버 원문 0 · 게이트 다시 읽기 안 함', async () => {
    fetchWithAuthMock.mockResolvedValue(new Response(JSON.stringify({ detail: '내부 서버 원문 문장' }), { status: 500 }));
    const onRetried = await confirmRetry();
    expect(document.querySelector('[role="dialog"]')?.hasAttribute('data-open') ?? false).toBe(false);
    expect(q('channel-post-retry-result')?.querySelector('p')?.textContent).toBe(K.channelPostsRetryFailed);
    // 서버 응답은 접힌 «서버 응답 보기»에만 남는다(#3454 관례) — 보이는 문장엔 0.
    expect(q('channel-post-retry-result')?.querySelector('p')?.textContent).not.toContain('내부 서버 원문');
    expect(onRetried).not.toHaveBeenCalled();
  });

  it('⭐#4266 AC2 — 재시도 404 → 창 닫힘 · 게이트를 다시 읽고 유나 문장 · 서버 원문 0', async () => {
    fetchWithAuthMock.mockResolvedValue(new Response(JSON.stringify({ detail: 'command를 찾을 수 없거나 재시도 대상이 아닙니다' }), { status: 404 }));
    const onRetried = await confirmRetry();
    expect(document.querySelector('[role="dialog"]')?.hasAttribute('data-open') ?? false).toBe(false);
    expect(q('channel-post-retry-result')?.textContent).toBe(K.publicationRetryNotRetryableReloaded);
    expect(document.body.textContent).not.toContain('command를 찾을 수 없거나');
    expect(onRetried).toHaveBeenCalledTimes(1);
  });

  it('#4266 AC3 — 403(사람 전용 코드) → 로케일 문장 · 네트워크 실패 → «다시 시도하지 못했어요.»', async () => {
    fetchWithAuthMock.mockResolvedValue(new Response(JSON.stringify({ detail: { code: 'CHANNEL_POST_PUBLISH_HUMAN_ONLY', message: '서버 원문 403' } }), { status: 403 }));
    await confirmRetry();
    expect(q('channel-post-retry-result')?.querySelector('p')?.textContent).toBe(K.errorChannelPublishHumanOnly);
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    fetchWithAuthMock.mockRejectedValue(new TypeError('network'));
    await confirmRetry();
    expect(q('channel-post-retry-result')?.querySelector('p')?.textContent).toBe(K.channelPostsRetryFailed);
  });
});
