// @vitest-environment jsdom
//
// story #2153 — access-matrix-tab.tsx가 message.type('success'|'error')을 선언해놓고
// 렌더가 이를 무시해 항상 role="alert"/assertive/destructive(빨강)로만 그렸다. 지금은
// setter가 'error'만 넣어 무해했지만, 'success'가 들어오는 날 성공 메시지가 빨간 글씨로
// 뜨고 스크린리더 낭독을 assertive로 끊는 회귀가 된다(#2096 관례 위반, #2149와 동일 클래스
// 결함의 개별 화면판).
//
// 렌더 분기(AccessMatrixMessage)를 분리해 success/error 각각을 직접 고정한다 — 실제
// setter 코드는 현재 'error'만 만들어 success 경로를 종단(fetch mock) 테스트로 재현할
// 방법이 없어, 렌더 분기 자체를 단위로 검증한다.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import { AccessMatrixMessage, AccessMatrixTab } from './access-matrix-tab';
import koMessages from '../../../messages/ko.json';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

describe('AccessMatrixMessage 접근성 (story #2153)', () => {
  it('type=success → role=status, aria-live=polite, text-success 클래스(빨강 아님)', async () => {
    await act(async () => {
      root.render(<AccessMatrixMessage message={{ type: 'success', text: '완료' }} />);
    });
    const el = container.querySelector('[role="status"]');
    expect(el).not.toBeNull();
    expect(el?.getAttribute('aria-live')).toBe('polite');
    expect(el?.getAttribute('aria-atomic')).toBe('true');
    expect(el?.className).toContain('text-success');
    expect(el?.className).not.toContain('text-destructive');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('type=error → role=alert, aria-live=assertive, text-destructive 클래스(현행 유지)', async () => {
    await act(async () => {
      root.render(<AccessMatrixMessage message={{ type: 'error', text: '실패' }} />);
    });
    const el = container.querySelector('[role="alert"]');
    expect(el).not.toBeNull();
    expect(el?.getAttribute('aria-live')).toBe('assertive');
    expect(el?.getAttribute('aria-atomic')).toBe('true');
    expect(el?.className).toContain('text-destructive');
    expect(el?.className).not.toContain('text-success');
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('message가 null이면 아무것도 렌더하지 않는다', async () => {
    await act(async () => {
      root.render(<AccessMatrixMessage message={null} />);
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});

// story #3997 CHANGES(카디르 「고르는 자리」 전수, 페드루 확定 2026-09-17) — 예약 멤버
// 「시스템 발행」의 프로젝트 접근을 회수하면 자동 발행이 막힐 수 있어, 매트릭스 행 자체를
// 제외한다(토글이 아니라 행 제외 — 서버 측 원자적 거부는 story #3999).
describe('AccessMatrixTab — 시스템 발행 행 제외(story #3997 CHANGES)', () => {
  it('⭐매트릭스에 「시스템 발행」 행이 안 뜨고 실 에이전트 행은 그대로 뜬다', async () => {
    const fetchMock = (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch;
    const originalFetch = fetchMock;
    (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = (async (url: string) => {
      if (typeof url === 'string' && url.startsWith('/api/team-members?type=agent')) {
        return {
          ok: true,
          json: async () => ({
            data: [
              { id: 'sp1', name: '시스템 발행', runtime_type: 'system-publisher' },
              { id: 'a1', name: '점검봇', runtime_type: 'claude-code' },
            ],
          }),
        } as Response;
      }
      if (typeof url === 'string' && url === '/api/projects') {
        return { ok: true, json: async () => ({ data: [{ id: 'p1', name: '프로젝트 A' }] }) } as Response;
      }
      if (typeof url === 'string' && url === '/api/agents/access-matrix') {
        return { ok: true, json: async () => ({ data: [] }) } as Response;
      }
      return { ok: false, json: async () => null } as Response;
    }) as typeof fetch;

    try {
      await act(async () => {
        root.render(
          <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
            <AccessMatrixTab />
          </NextIntlClientProvider>,
        );
      });
      await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });

      expect(container.textContent).not.toContain('시스템 발행');
      expect(container.textContent).toContain('점검봇');
    } finally {
      (globalThis as typeof globalThis & { fetch: typeof fetch }).fetch = originalFetch;
    }
  });
});
