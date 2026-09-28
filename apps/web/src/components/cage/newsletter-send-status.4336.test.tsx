// @vitest-environment jsdom
//
// story #4336 AC4(PO 라이브 03:55Z) — 외부 발행 게이트 상세에 발행 상태가 0이었다(«승인됨»만). 이제 발송 게이트와 같은 자리 · 같은 판정으로
// 목록 · 상세처럼 «발행 중»(서버 processing_kind) · «게시됨»(완료) · 실패 배지 · 사람 «다시 시도». 발송 게이트는 예전 그대로(진행 · 완료 줄 없음).
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

type Publish = NonNullable<GateItem['publish_command']>;

function gate(command: Partial<Publish> | null, gateType = 'external_publish'): GateItem {
  return {
    id: 'gate-1', org_id: 'org-1', work_item_id: 'story-1', work_item_type: 'story', gate_type: gateType, status: 'approved',
    resolver_id: null, resolved_at: null, resolution_note: null, neutral_facts: null,
    created_at: '2026-09-28T00:00:00Z', updated_at: '2026-09-28T00:00:00Z',
    newsletter_send_command: null,
    publish_command: command === null ? null : {
      id: 'cmd-1', status: 'pending', failure_kind: null, reason_code: null, next_attempt_at: null, reason_reset_at: null,
      command_retryable: false, processing_kind: null, ...command,
    },
  } as GateItem;
}

async function mount(g: GateItem) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        <NewsletterSendStatus gate={g} orgId="org-1" displayTimezone="Asia/Seoul" />
      </NextIntlClientProvider>,
    );
  });
}

const q = (id: string) => document.querySelector(`[data-testid="${id}"]`);

describe('외부 발행 게이트 — 발행 상태(story #4336 AC4 · 목록 · 상세와 같은 판정)', () => {
  it('⭐발행 중(서버 processing_kind = publishing) → 목록 · 상세와 같은 «발행 중» 줄 · 버튼 없음', async () => {
    await mount(gate({ status: 'in_progress', processing_kind: 'publishing' }));
    expect(q('gate-publish-status')).not.toBeNull();
    expect(q('gate-publish-status')!.textContent).toContain(K.channelPostsPublishingNotice);
    expect(q('channel-post-failure-retry-button')).toBeNull();
  });

  it('⭐완료 → 목록의 «게시됨» 칩', async () => {
    await mount(gate({ status: 'completed' }));
    const chip = q('gate-publish-status')!.querySelector('[data-status-chip="published"]');
    expect(chip?.textContent).toBe(K.contentStatusPublished);
  });

  it('⭐실패(dead_letter) · 사람이 다시 시도할 수 있음 → 실패 배지 + «다시 시도»', async () => {
    await mount(gate({ status: 'dead_letter', failure_kind: 'not_sent', command_retryable: true }));
    expect(q('channel-post-failure-badge')?.textContent).toContain(K.channelPostsFailureDeadLetter);
    expect(q('channel-post-failure-retry-button')?.textContent).toBe(K.channelPostsFailureRetryCta);
  });

  it('실패 · 다시 시도 불가(서버 판정 false) → 배지만 · 버튼 없음', async () => {
    await mount(gate({ status: 'dead_letter', failure_kind: 'not_sent', command_retryable: false }));
    expect(q('channel-post-failure-badge')).not.toBeNull();
    expect(q('channel-post-failure-retry-button')).toBeNull();
  });

  it('예약 대기(processing_kind 없음 · 실패 없음) · 명령 없음 → 줄 없음(지어내지 않음)', async () => {
    await mount(gate({ status: 'pending', processing_kind: null }));
    expect(q('gate-publish-status')).toBeNull();
    await mount(gate(null));
    expect(q('gate-publish-status')).toBeNull();
  });

  it('외부 발행이 아닌 게이트는 publish_command가 있어도 무시(발송 게이트는 발송 명령만)', async () => {
    await mount(gate({ status: 'completed' }, 'newsletter_send'));
    expect(q('gate-publish-status')).toBeNull();
    expect(q('newsletter-send-status')).toBeNull();
  });
});
