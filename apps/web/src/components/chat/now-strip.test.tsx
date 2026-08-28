// @vitest-environment jsdom
//
// story #3177(S3a) — chat 구심점 상단 고정 「지금」 스트립(attention 7종 흡수). AC1(타입별
// 라벨 재사용)·AC2(SID 3150 no-fiction 회귀 금지)·AC3(severity 정렬·collapsed/expanded)·
// AC4(원탭 도달) 회귀가드.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { NowStrip } from './now-strip';
import type { AttentionItem } from '@/components/dashboard/command-center/types';

const { fetchWithAuthMock, useAutoRefreshMock, subscribeMock, useSseMultiplexerContextMock } = vi.hoisted(() => ({
  fetchWithAuthMock: vi.fn(),
  useAutoRefreshMock: vi.fn(),
  subscribeMock: vi.fn(),
  useSseMultiplexerContextMock: vi.fn(),
}));
vi.mock('@/lib/db/client', () => ({ fetchWithAuth: fetchWithAuthMock }));
// story #3177 — 전역 RefreshContext(폴링 주기) 배선 자체는 useAutoRefreshMock 호출 인자로만
// 검증한다(register 자체를 재구현하지 않는다, chat-list-view.test.tsx와 동일 관례).
vi.mock('@/hooks/use-auto-refresh', () => ({ useAutoRefresh: (key: string, fn: () => void) => useAutoRefreshMock(key, fn) }));
// story #3180 — mux는 useSseMultiplexerContextMock으로 대체(use-team-presence.test.tsx와
// 동형 관례가 없어 최소 구현 — subscribe만 검증, 나머지 핸들 필드는 미사용이라 생략).
vi.mock('@/components/realtime-provider', () => ({ useSseMultiplexerContext: () => useSseMultiplexerContextMock() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

function mockAttention(items: AttentionItem[]) {
  fetchWithAuthMock.mockResolvedValue({
    ok: true,
    json: async () => ({ data: { action_queue: { scope: 'org', items: [] }, attention: { scope: 'org', items, pending: [] }, is_clear: items.length === 0 } }),
  });
}

const AGENT_STUCK: AttentionItem = {
  type: 'agent_stuck', severity: 'warn', auto_detected: true,
  entity_type: 'story', entity_id: 's-1', gate_type: 'merge', stuck_since: null,
};
const AGENT_AUTH_FAILURE: AttentionItem = {
  type: 'agent_auth_failure', severity: 'danger', auto_detected: true,
  member_id: 'm-1', reason: 'revoked', failure_count: 1, first_failed_at: null, last_failed_at: null,
};
// SID 3150 회귀 케이스 그대로: entity_id/entity_type이 없는 6종 중 하나.
const HYPOTHESIS_FALSIFIED: AttentionItem = {
  type: 'hypothesis_falsified', severity: 'info', auto_detected: true,
  hypothesis_id: 'h-1', statement: '가입 전환율 개선 가설', outcome_result: null,
  falsified_days: 3, superseded_by_hypothesis_id: null, project_id: 'p-1',
};

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  fetchWithAuthMock.mockReset();
  useAutoRefreshMock.mockReset();
  subscribeMock.mockReset();
  useSseMultiplexerContextMock.mockReset();
  // 기본값 — 플래그 OFF/Provider 밖과 동형(대부분의 기존 테스트는 mux 무관이라 null 폴백).
  useSseMultiplexerContextMock.mockReturnValue(null);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

describe('NowStrip — attention 0건이면 스트립 자체가 안 보인다', () => {
  it('빈 attention.items면 아무것도 렌더하지 않는다', async () => {
    mockAttention([]);
    await act(async () => { root.render(wrap(<NowStrip />)); });
    await flush();
    expect(container.textContent).toBe('');
  });

  it('fetch가 실패해도(네트워크 오류) 조용히 빈 상태로 남는다(크래시 없음)', async () => {
    fetchWithAuthMock.mockRejectedValue(new Error('network'));
    await act(async () => { root.render(wrap(<NowStrip />)); });
    await flush();
    expect(container.textContent).toBe('');
  });
});

describe('NowStrip — AC3 collapsed 기본·severity 카운트', () => {
  it('collapsed 기본 상태로 「지금 · N건」과 severity 카운트만 보이고 카드는 안 보인다', async () => {
    mockAttention([AGENT_STUCK, AGENT_AUTH_FAILURE, HYPOTHESIS_FALSIFIED]);
    await act(async () => { root.render(wrap(<NowStrip />)); });
    await flush();
    expect(container.textContent).toContain('지금');
    expect(container.textContent).toContain('3');
    // 카드 상세(가설 반증 라벨)는 아직 접힌 상태라 안 보여야 한다.
    expect(container.textContent).not.toContain('가입 전환율 개선 가설');
  });

  it('헤더를 누르면 펼쳐져 카드가 보인다(AC1 타입별 라벨)', async () => {
    mockAttention([AGENT_STUCK, AGENT_AUTH_FAILURE, HYPOTHESIS_FALSIFIED]);
    await act(async () => { root.render(wrap(<NowStrip />)); });
    await flush();
    const header = container.querySelector('button[aria-expanded]');
    expect(header).toBeTruthy();
    await act(async () => { header!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container.textContent).toContain('가입 전환율 개선 가설');
  });

  it('다시 누르면 접힌다(토글)', async () => {
    mockAttention([HYPOTHESIS_FALSIFIED]);
    await act(async () => { root.render(wrap(<NowStrip />)); });
    await flush();
    const header = container.querySelector('button[aria-expanded]')!;
    await act(async () => { header.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container.textContent).toContain('가입 전환율 개선 가설');
    await act(async () => { header.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(container.textContent).not.toContain('가입 전환율 개선 가설');
  });
});

describe('NowStrip — AC2 SID 3150 회귀 금지(no-fiction, entity_id 없는 타입도 공백 렌더 0)', () => {
  it('entity_id/entity_type이 없는 6종(hypothesis_falsified)도 자기 필드(statement)로 라벨된다 — 공백 아님', async () => {
    mockAttention([HYPOTHESIS_FALSIFIED]);
    await act(async () => { root.render(wrap(<NowStrip />)); });
    await flush();
    const header = container.querySelector('button[aria-expanded]')!;
    await act(async () => { header.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const titleEl = Array.from(container.querySelectorAll('a')).find((a) => a.textContent?.includes('가입 전환율 개선 가설'));
    expect(titleEl).toBeTruthy();
    expect(titleEl!.textContent?.trim()).not.toBe('');
  });
});

describe('NowStrip — AC4 원탭 도달(카드는 실 href를 가진 링크)', () => {
  it('agent_stuck(entity_type=story) 카드는 /board?story=로 향한다', async () => {
    mockAttention([AGENT_STUCK]);
    await act(async () => { root.render(wrap(<NowStrip />)); });
    await flush();
    const header = container.querySelector('button[aria-expanded]')!;
    await act(async () => { header.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const link = container.querySelector('a[href="/board?story=s-1"]');
    expect(link).toBeTruthy();
  });
});

describe('NowStrip — 폴링 배선(AC4 조정: 실시간 아닌 기존 RefreshContext 주기)', () => {
  it('useAutoRefresh가 고유 key와 refetch 함수로 등록된다', async () => {
    mockAttention([]);
    await act(async () => { root.render(wrap(<NowStrip />)); });
    await flush();
    expect(useAutoRefreshMock).toHaveBeenCalledWith('chat-now-strip', expect.any(Function));
  });
});

describe('NowStrip — story #3180 attention.changed 신호(AC2 즉시 재조회·AC3 하위호환)', () => {
  it('mux가 없으면(플래그 OFF·Provider 밖) subscribe를 호출하지 않는다 — 폴링만 남는다', async () => {
    useSseMultiplexerContextMock.mockReturnValue(null);
    mockAttention([]);
    await act(async () => { root.render(wrap(<NowStrip />)); });
    await flush();
    expect(subscribeMock).not.toHaveBeenCalled();
  });

  it('mux가 있으면 attention.changed를 구독한다', async () => {
    const unsubscribe = vi.fn();
    subscribeMock.mockReturnValue(unsubscribe);
    useSseMultiplexerContextMock.mockReturnValue({ subscribe: subscribeMock, subscribeMessage: vi.fn(), subscribeReconnect: vi.fn(), connected: true });
    mockAttention([]);
    await act(async () => { root.render(wrap(<NowStrip />)); });
    await flush();
    expect(subscribeMock).toHaveBeenCalledWith('attention.changed', expect.any(Function));
  });

  it('attention.changed 신호 수신 시 폴링 주기 대기 없이 즉시 재조회한다', async () => {
    let handler: (() => void) | undefined;
    subscribeMock.mockImplementation((_name: string, fn: () => void) => { handler = fn; return vi.fn(); });
    useSseMultiplexerContextMock.mockReturnValue({ subscribe: subscribeMock, subscribeMessage: vi.fn(), subscribeReconnect: vi.fn(), connected: true });
    mockAttention([]);
    await act(async () => { root.render(wrap(<NowStrip />)); });
    await flush();
    const callsAfterMount = fetchWithAuthMock.mock.calls.length;
    expect(handler).toBeTruthy();
    await act(async () => { handler!(); });
    await flush();
    expect(fetchWithAuthMock.mock.calls.length).toBe(callsAfterMount + 1);
  });
});
