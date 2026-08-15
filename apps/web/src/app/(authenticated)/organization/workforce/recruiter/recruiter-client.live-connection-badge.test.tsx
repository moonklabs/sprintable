// @vitest-environment jsdom
//
// story #2657(디디 그라운딩, 2026-08-14·doc 625bab77 ⓐ) — RUNTIME_CONNECT_CONFIRM(런타임-클래스
// 정적 스냅샷)은 "지금 이 에이전트"의 실제 리스너 부착 여부와 무관했다(#2656 codex 훅-미신뢰가
// 그 자리 — 배지는 살아있는데 리스너는 죽어있어도 안 바뀜). LiveConnectionBadge는 기존 presence
// 인프라(GET /api/team-members/{id})를 폴링해 별개 축의 실시간 신호를 보여준다. 소스 텍스트
// 가드만으로는 폴링·상태전환이 실제로 도는지 못 잡으므로 실 렌더+타이머로 고정한다.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { LiveConnectionBadge } from './recruiter-client';
import koMessages from '../../../../../../messages/ko.json';

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

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe('LiveConnectionBadge (story #2657) — 정적 배지와 별개인 라이브 presence 축', () => {
  it('최초 폴링 전/응답 대기 중에는 "아직 연결 안 됨" — 정적 표처럼 무근거 초록을 켜지 않는다', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {}))); // 영구 pending
    await act(async () => {
      root.render(wrap(<LiveConnectionBadge agentId="agent-1" />));
    });
    expect(container.textContent).toContain('아직 연결 안 됨');
    expect(container.textContent).not.toContain('지금 연결됨');
  });

  it('presence_status=online 응답이 오면 "지금 연결됨"(success)으로 전환된다', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      expect(url).toBe('/api/team-members/agent-2');
      return { ok: true, json: async () => ({ data: { presence_status: 'online' } }) };
    }));
    await act(async () => {
      root.render(wrap(<LiveConnectionBadge agentId="agent-2" />));
    });
    // 최초 poll()의 fetch가 resolve될 때까지 마이크로태스크를 흘려보낸다.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('지금 연결됨');
    const badge = container.querySelector('span, div');
    expect(badge?.className ?? container.innerHTML).not.toMatch(/text-warning|text-destructive/);
  });

  // story #2656 클래스 — 훅이 안 붙어 리스너가 죽어있으면(정적 배지는 안 바뀌지만) 이 라이브
  // 배지는 offline을 그대로 반영해야 한다(거짓 초록 금지).
  it('presence_status=offline(#2656류 훅-미신뢰)이면 "아직 연결 안 됨"을 유지한다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ data: { presence_status: 'offline' } }) })));
    await act(async () => {
      root.render(wrap(<LiveConnectionBadge agentId="agent-3" />));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('아직 연결 안 됨');
    expect(container.textContent).not.toContain('지금 연결됨');
  });

  it('fetch 실패(네트워크 에러)에도 크래시 없이 "아직 연결 안 됨"으로 안전 폴백한다', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    await act(async () => {
      root.render(wrap(<LiveConnectionBadge agentId="agent-4" />));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(container.textContent).toContain('아직 연결 안 됨');
  });

  it('online 확인 후에는 폴링을 멈춘다(스펙 doc §ⓐ.3 — FE 재량으로 중단)', async () => {
    let callCount = 0;
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => {
      callCount += 1;
      return { ok: true, json: async () => ({ data: { presence_status: 'online' } }) };
    }));
    await act(async () => {
      root.render(wrap(<LiveConnectionBadge agentId="agent-5" />));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(callCount).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(callCount).toBe(1); // online 후 재폴링 없음
    vi.useRealTimers();
  });
});
