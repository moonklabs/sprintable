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
import { AccessMatrixMessage } from './access-matrix-tab';

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
