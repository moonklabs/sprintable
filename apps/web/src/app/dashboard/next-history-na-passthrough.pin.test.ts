// story #4226(PO 조건 1) — 셸의 flat `?p=` 정규화는 Next **비공개 내부 동작**에 기댄다: app-router가 설치하는 history.replaceState
// 패치는 `data.__NA`가 실린 호출을 «Next 내부 호출»로 보고 라우터 액션(ACTION_RESTORE) 없이 그대로 통과시킨다. 셸은 그 덕에
// 라우터 큐에 들어가지 않아 대기 중인 이동(router.push/replace)을 덮지 않는다(까디르 QA 4585).
// 이 테스트는 **설치된 next 모듈의 실제 패치 코드**를 꺼내 실행해 그 계약을 단언한다 — Next를 올려 모양이나 동작이 바뀌면
// 여기가 먼저 RED(그때 dashboard-shell.tsx의 정규화 방식을 다시 판단할 것). 확인한 버전: next 16.2.2.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const NEXT_VERSION = (require('next/package.json') as { version: string }).version;
const APP_ROUTER_SRC = readFileSync(require.resolve('next/dist/client/components/app-router.js'), 'utf8');

/** `window.history.replaceState = function replaceState(...) {...}` 본문을 괄호 짝으로 잘라 낸다(모양이 바뀌면 throw → RED). */
function extractPatchedReplaceState(src: string): string {
  const head = 'window.history.replaceState = function replaceState(data, _unused, url) {';
  const start = src.indexOf(head);
  if (start < 0) throw new Error('next app-router의 history.replaceState 패치 모양이 바뀌었다');
  let depth = 0;
  for (let i = start + head.length - 1; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start + 'window.history.replaceState = '.length, i + 1);
  }
  throw new Error('패치 함수 본문의 끝을 못 찾음');
}

function loadPatch(currentState: unknown) {
  const originalReplaceState = vi.fn();
  const applyUrlFromHistoryPushReplace = vi.fn();
  // 패치가 부르는 Next 헬퍼 — 실제 구현과 같은 일(현재 항목의 Next 상태를 새 data에 복사)을 하는 최소 대역.
  const copyNextJsInternalHistoryState = (data: Record<string, unknown> | null) => {
    const d = data ?? {};
    const cur = currentState as Record<string, unknown> | null;
    if (cur?.__NA) d.__NA = cur.__NA;
    if (cur?.__PRIVATE_NEXTJS_INTERNALS_TREE) d.__PRIVATE_NEXTJS_INTERNALS_TREE = cur.__PRIVATE_NEXTJS_INTERNALS_TREE;
    return d;
  };
  // 설치된 next의 실제 코드를 그대로 실행하는 것이 이 핀의 목적(new Function).
  const replaceState = new Function(
    'originalReplaceState', 'applyUrlFromHistoryPushReplace', 'copyNextJsInternalHistoryState',
    `return (${extractPatchedReplaceState(APP_ROUTER_SRC)});`,
  )(originalReplaceState, applyUrlFromHistoryPushReplace, copyNextJsInternalHistoryState) as (d: unknown, u: string, url?: string) => void;
  return { replaceState, originalReplaceState, applyUrlFromHistoryPushReplace };
}

describe(`Next(${NEXT_VERSION}) history.replaceState 패치 — \`__NA\` 통과 계약(story #4226)`, () => {
  it('확인한 버전 핀 — next를 올리면 이 계약을 다시 확인하고 버전을 갱신할 것', () => {
    expect(NEXT_VERSION).toBe('16.2.2');
  });

  it('⭐`__NA` 실은 호출 → 라우터 액션 디스패치 0 · 받은 상태 그대로 원본 replaceState', () => {
    const state = { __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: { t: 1 } };
    const { replaceState, originalReplaceState, applyUrlFromHistoryPushReplace } = loadPatch(state);
    replaceState(state, '', '/inbox?p=proj-1');
    expect(applyUrlFromHistoryPushReplace).not.toHaveBeenCalled();
    expect(originalReplaceState).toHaveBeenCalledWith(state, '', '/inbox?p=proj-1');
  });

  it('양성대조 — `__NA` 없는 호출(null)은 디스패치한다(= 대기 이동과 경합하는 갈래 · 셸이 피하는 쪽)', () => {
    const { replaceState, applyUrlFromHistoryPushReplace } = loadPatch({ __NA: true });
    replaceState(null, '', '/inbox?p=proj-1');
    expect(applyUrlFromHistoryPushReplace).toHaveBeenCalledWith('/inbox?p=proj-1');
  });
});
