// @vitest-environment jsdom
//
// story #2154 — 이 훅이 실제로 해결하는 문제를 재현·증명한다: 클라 사전검증이
// setError(null) 리셋보다 먼저 return해버리는 자리에서, 리셋 순서를 바로잡는 것만으론
// 부족하다는 것(같은 틱에 batching되면 최종값이 이전과 같아 리렌더가 스킵될 수 있음)과
// nonce를 key로 쓰면 순서와 무관하게 항상 새 DOM 노드가 만들어진다는 것을 대조 증명한다.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useRenderNonce } from './use-render-nonce';

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

// story #2154가 발견한 정확한 깨진 형태의 최소 재현 — 사전검증 실패가 리셋보다 먼저 return.
function BrokenValidationFirst({ triggerRef }: { triggerRef: { current: (() => void) | null } }) {
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    triggerRef.current = () => {
      // 사전검증 실패 분기 — setError(null) 도달 전에 return.
      setError('필수 항목을 채워주세요.');
    };
  });
  return error ? <p role="alert">{error}</p> : null;
}

function FixedWithNonce({ triggerRef }: { triggerRef: { current: (() => void) | null } }) {
  const [error, setError] = useState<string | null>(null);
  const [nonce, bump] = useRenderNonce();
  useEffect(() => {
    triggerRef.current = () => {
      bump();
      setError('필수 항목을 채워주세요.');
    };
  });
  return error ? <p key={nonce} role="alert">{error}</p> : null;
}

describe('useRenderNonce (story #2154)', () => {
  it('대조군 — nonce 없이는 동일 문구 연속 세팅 시 같은 DOM 노드가 재사용될 수 있다(회귀 재현)', async () => {
    const triggerRef: { current: (() => void) | null } = { current: null };
    await act(async () => { root.render(<BrokenValidationFirst triggerRef={triggerRef} />); });
    await act(async () => { triggerRef.current?.(); });
    const first = container.querySelector('[role="alert"]');
    expect(first).not.toBeNull();

    await act(async () => { triggerRef.current?.(); });
    const second = container.querySelector('[role="alert"]');
    // 값이 완전히 같은 문자열로 다시 set되면 React가 같은 노드를 재사용한다 — 이게 바로
    // 스크린리더가 두 번째 실패를 못 듣게 되는 원인이다.
    expect(second).toBe(first);
  });

  it('nonce를 key로 쓰면 동일 문구를 연속으로 세팅해도 항상 새 DOM 노드가 된다', async () => {
    const triggerRef: { current: (() => void) | null } = { current: null };
    await act(async () => { root.render(<FixedWithNonce triggerRef={triggerRef} />); });
    await act(async () => { triggerRef.current?.(); });
    const first = container.querySelector('[role="alert"]');
    expect(first).not.toBeNull();

    await act(async () => { triggerRef.current?.(); });
    const second = container.querySelector('[role="alert"]');
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
  });
});
