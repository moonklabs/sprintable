'use client';

import { useCallback, useState } from 'react';

/**
 * story #2154 — phase1(#2399)이 세운 불변식("재시도 前에 setError(null)을 동기로 먼저
 * 호출해야 같은 에러가 연속으로 떠도 DOM이 mount/unmount돼 스크린리더가 다시 읽는다")이
 * 4곳에서 깨져 있었다: 클라 사전검증 실패가 그 리셋보다 먼저 return해버리는 형태.
 *
 * ⚠️리셋 순서를 바로잡는 것만으론 근본 해결이 안 된다 — 사전검증처럼 동기 실행 중에
 * setError(null) 다음 줄에서 바로 setError(sameMsg)를 불러도, React가 두 호출을 배칭해
 * 한 번만 커밋하면 최종값은 이전과 동일해 리렌더/DOM 갱신이 스킵될 수 있다.
 *
 * 이 훅은 그 순서 규율에 기대지 않는다 — 메시지를 "보여주는" 매 호출마다 key로 쓸 nonce를
 * 증가시켜, 값이 이전과 완전히 같아도 React가 항상 새 DOM 노드를 만들게 강제한다. 다음
 * 사람이 리셋을 빼먹거나 순서를 바꿔도 이 자리는 구조적으로 깨지지 않는다.
 *
 * 사용법: 에러/성공 문구를 실제로 세팅하는 바로 그 호출 옆에서 bump()를 같이 부르고,
 * 조건부로 렌더되는 요소에 `key={nonce}`를 준다 — 기존 useState/setState 로직은 그대로 둔다.
 */
export function useRenderNonce(): readonly [number, () => void] {
  const [nonce, setNonce] = useState(0);
  const bump = useCallback(() => setNonce((n) => n + 1), []);
  return [nonce, bump] as const;
}
