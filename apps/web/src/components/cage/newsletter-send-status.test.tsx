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
import type { ReloadOutcome } from '@/components/content/publication-retry';

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

// story #4290 — 서버처럼 command_retryable을 싣는다(보는 사람 기준 `viewer_can_retry` · 사람이 볼 때: dead_letter · blocked(일시정지
// 제외) · 사람 재시도 사유의 blocked_unapproved → 참). 테스트가 직접 주면 그 값(에이전트 화면 = 서버가 false).
function withServerRetryable(c: Command): Command {
  if ('command_retryable' in c) return c;
  const retryable = c.status === 'dead_letter' || (c.status === 'blocked' && c.failure_kind !== 'paused')
    || (c.status === 'blocked_unapproved' && c.reason_code === 'NEWSLETTER_SEND_CONNECTION_UNAVAILABLE');
  return { ...c, command_retryable: retryable };
}

function gate(command: Partial<Command> | null, gateType = 'newsletter_send'): GateItem {
  return {
    id: 'gate-1', org_id: 'org-1', work_item_id: 'story-1', work_item_type: 'story', gate_type: gateType, status: 'approved',
    resolver_id: null, resolved_at: null, resolution_note: null, neutral_facts: null,
    created_at: '2026-09-24T00:00:00Z', updated_at: '2026-09-24T00:00:00Z',
    newsletter_send_command: command === null ? null : withServerRetryable({
      id: 'cmd-1', status: 'dead_letter', failure_kind: null, reason_code: null, next_attempt_at: null, reason_reset_at: null,
      ...command,
    }),
  } as GateItem;
}

async function mount(g: GateItem, { onRetried }: { onRetried?: () => Promise<ReloadOutcome> } = {}) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <NewsletterSendStatus gate={g} orgId="org-1" displayTimezone="Asia/Seoul" onRetried={onRetried} />
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

describe('NewsletterSendStatus — 연결 사유 blocked의 «연결 확인»(story #4304)', () => {
  it('연결 실패로 멈춘 발송(blocked · connection) — 배지 머리 줄에 «연결 확인» 링크', async () => {
    await mount(gate({ status: 'blocked', failure_kind: 'connection' }));
    expect(q('channel-post-failure-connection-link')?.getAttribute('href')).toBe('/organization/channels');
  });

  it('⭐재시도를 못 하는 사람(서버 false)에게도 링크는 선다 — 버튼만 없다(유나 반려 08:56Z)', async () => {
    await mount(gate({ status: 'blocked', failure_kind: 'connection', command_retryable: false }));
    expect(q('channel-post-failure-connection-link')?.getAttribute('href')).toBe('/organization/channels');
    expect(q('channel-post-failure-retry-button')).toBeNull();
  });

  it('없는 · 모르는 failure_kind의 blocked는 연결 링크를 받지 않는다(닫힌 판정) · 머리도 중립(story #4305)', async () => {
    await mount(gate({ status: 'blocked', failure_kind: null }));
    expect(q('channel-post-failure-connection-link')).toBeNull();
    expect(q('channel-post-failure-badge')?.textContent).toContain(koMessages.content.channelPostsFailureBlockedUnknown);
  });
});

describe('NewsletterSendStatus — 재시도', () => {
  it('에이전트 화면엔 상태 줄만(버튼 0) — 재시도 API가 사람 전용이라 서버가 command_retryable=false로 싣는다(까디르 QA ③)', async () => {
    await mount(gate({ status: 'dead_letter', failure_kind: 'not_sent', command_retryable: false }));
    expect(q('channel-post-failure-badge')?.textContent).toContain(K.channelPostsFailureDeadLetter);
    expect(q('channel-post-failure-retry-button')).toBeNull();
  });

  it('확인 창을 거쳐 공용 재시도 BFF를 정확히 1회 · 결과 줄 · 게이트 다시 읽기', async () => {
    fetchWithAuthMock.mockResolvedValue(new Response(JSON.stringify({ id: 'cmd-1', status: 'pending' }), { status: 200 }));
    const onRetried = vi.fn(async () => true);
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
  async function confirmRetry(onRetried: () => Promise<ReloadOutcome> = vi.fn(async (): Promise<ReloadOutcome> => true)) {
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

  // story #4290 AC2 — 버튼은 서버 판정(command_retryable)만 본다. 뮤테이션: canRetry가 상태로 따로 가르면 RED.
  it('⭐#4290 AC2 — 서버가 다시 시도 불가라고 한 발송 명령엔 다시 시도 버튼이 없다', async () => {
    await mount(gate({ status: 'dead_letter', failure_kind: 'needs_check', command_retryable: false }));
    expect(q('channel-post-failure-retry-button')).toBeNull();
  });

  // story #4290(유나 03:29Z) — 404 뒤 다시 읽은 발송 명령이 다시 시도 가능한 새 멈춤이면 «그 사이 다시 시도됐고…»(글 상세와 같은 키).
  it('⭐#4290 — 404 + 다시 읽은 발송 명령이 새 멈춤 → «그 사이 다시 시도됐고…»', async () => {
    fetchWithAuthMock.mockResolvedValue(new Response(JSON.stringify({ detail: 'x' }), { status: 404 }));
    await confirmRetry(vi.fn(async (): Promise<ReloadOutcome> => ({ retryable: true })));
    expect(q('channel-post-retry-result')?.textContent).toBe(K.publicationRetryStoppedAgainReloaded);
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

  // 까디르 codex 4634 P2 — 게이트 다시 읽기(onRetried)가 실패(false · 예외)하면 «다시 불러왔어요» 대신 «불러오지 못했어요».
  it('⭐#4634 — 404 + 게이트 다시 읽기 실패(false) → «다시 시도할 수 없는 상태» + «불러오지 못했어요» · «다시 불러왔어요» 0', async () => {
    fetchWithAuthMock.mockResolvedValue(new Response(JSON.stringify({ detail: 'x' }), { status: 404 }));
    await confirmRetry(vi.fn(async () => false));
    const texts = [...(q('channel-post-retry-result')?.querySelectorAll('p') ?? [])].map((e) => e.textContent);
    expect(texts).toEqual([K.publicationRetryNotRetryable, K.publicationRetryReloadFailed]);
    expect(document.body.textContent).not.toContain(K.publicationRetryNotRetryableReloaded);
  });

  it('#4634 — 성공 + 게이트 다시 읽기 예외 → 성공 문장 + «불러오지 못했어요»', async () => {
    fetchWithAuthMock.mockResolvedValue(new Response(JSON.stringify({ id: 'cmd-1', status: 'pending' }), { status: 200 }));
    await confirmRetry(vi.fn(async () => { throw new Error('network'); }));
    const texts = [...(q('channel-post-retry-result')?.querySelectorAll('p') ?? [])].map((e) => e.textContent);
    expect(texts).toEqual([K.channelPostsRetrySuccess, K.publicationRetryReloadFailed]);
  });
});
