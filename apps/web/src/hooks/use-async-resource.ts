'use client';

import { useCallback, useEffect, useState } from 'react';

// story #4066(사전조사 doc 193b2797) — 이번 E-RECIPE-1 사이클에서 7회 반복된 "async fetch +
// guard 분기서 setLoading(false) 누락 → loading 영구고착" 버그 클래스를 원천 차단한다.
// 매번 재발한 이유는 하나 — "key가 없으면 스킵" 분기와 "fetch 성공/실패" 분기가 서로 다른
// 코드 경로에서 각자 setLoading(false)를 불러야 했고, 새 훅을 쓸 때마다 그중 하나(주로 스킵
// 분기)를 깜빡했기 때문(use-material-lineage.ts·use-hook-performances.ts·
// use-material-performances.ts·use-channel-post-calendar-data.ts 등). 이 훅은 그 두 분기를
// 같은 return 경로로 강제 합류시켜 "깜빡할 자리" 자체를 없앤다 — 호출부는 setLoading을
// 아예 손대지 않는다.

export interface AsyncResourceState<T> {
  data: T;
  loading: boolean;
  loadFailed: boolean;
}

export interface AsyncResourceSignal {
  /** effect cleanup(키 변경·언마운트) 이후에도 fetcher가 계속 실행 중일 수 있다 — 그 결과를
   * state에 반영하기 前에 이걸로 확인한다(cancelled=true면 setState 자체를 안 한다). */
  cancelled: () => boolean;
}

export interface UseAsyncResourceResult<T> extends AsyncResourceState<T> {
  /** 같은 key로 강제 재조회(예: "새로고침" 버튼) — nonce를 올려 effect를 재실행시킨다. */
  refresh: () => void;
}

export interface UseAsyncResourceOptions {
  /** story #4071 qa:changes(카디르, 2026-09-19, #4445 재작업 계기) — 기본값(false)은
   * 실패 시 `data`를 `initial`로 되돌린다(스킵과 동일 취급). 그런데 마이그 대상 훅 중
   * 일부(예: use-channel-post-calendar-data.ts)는 원본이 "재조회 실패 시 이전 성공
   * 데이터를 그대로 유지 + error만 세움"이었다 — 캘린더가 이미 그린 일정을 실패
   * 화면으로 안 지우는 게 원래 계약이었던 것. 헬퍼 기본값을 바꾸면 이미 마이그된
   * 훅(#4444/#4446 등, 원본도 실패 시 리셋이었음) 전부가 영향받으니
   * (계약변경소비처전수 위험) 옵션으로 분리 — true를 넘긴 훅만 이전 데이터를 보존한다. */
  keepPreviousDataOnError?: boolean;
}

/**
 * `key`가 null/undefined면 fetch 자체를 스킵하고 `initial`로 되돌린다(그 무엇도 "모른다"를
 * 지어내지 않는다 — no-fiction). `key`가 있으면 `fetcher(key, signal)`을 호출해 성공 시
 * `data`를, 실패 시 `loadFailed=true`를 낸다(`data`는 `options.keepPreviousDataOnError`가
 * true가 아닌 한 `initial`로 되돌아간다 — 기본값은 기존 동작 그대로). 스킵/성공/실패 세
 * 경로 전부 이 함수 안에서 반드시 `loading=false`로 끝난다 — 호출부가 그걸 빼먹을 여지
 * 자체가 없다.
 *
 * `deps`는 `key` 자체가 바뀌지 않아도 `fetcher` 클로저가 참조하는 다른 값(예: orgId)이
 * 바뀌면 재조회해야 하는 경우를 위한 추가 의존성 배열이다(use-channel-post-calendar-data.ts
 * 류처럼 key 하나 + 클로저 캡처 값 하나를 같이 쓰는 훅을 흡수하기 위함) — 없으면 `[]`.
 */
export function useAsyncResource<Key, T>(
  key: Key | null | undefined,
  initial: T,
  fetcher: (key: Key, signal: AsyncResourceSignal) => Promise<T>,
  deps: React.DependencyList = [],
  options: UseAsyncResourceOptions = {},
): UseAsyncResourceResult<T> {
  const { keepPreviousDataOnError = false } = options;
  const [data, setData] = useState<T>(initial);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    if (key === null || key === undefined) {
      setData(initial);
      setLoadFailed(false);
      setLoading(false);
      return () => { cancelled = true; };
    }
    setLoading(true);
    setLoadFailed(false);
    void (async () => {
      try {
        const result = await fetcher(key, { cancelled: () => cancelled });
        if (cancelled) return;
        setData(result);
      } catch {
        if (cancelled) return;
        if (!keepPreviousDataOnError) setData(initial);
        setLoadFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, nonce, ...deps]);

  return { data, loading, loadFailed, refresh };
}

export interface UseAsyncResourceBatchResult<T> {
  /** key → 성공 결과. 실패/미조회 key는 이 맵에 아예 안 들어간다(0 위장 안 함 —
   * use-hook-performances.ts 관례 그대로). */
  itemsByKey: Record<string, T>;
  loading: boolean;
  /** 전부 실패했을 때만 true — 일부 실패는 itemsByKey에서 그 key가 그냥 빠진 것으로
   * 이미 정직하게 드러난다(전체를 감추지 않는다). */
  loadFailed: boolean;
}

// story #4436 qa:changes round-2(카디르, 2026-09-19) 교훈 — key가 임의 문자열(공백 등 포함
// 가능)이면 구분자 join/split은 오분할·우연한 충돌 둘 다로 깨질 수 있다(hookKeysDepsKey
// 사고). JSON.stringify는 배열 경계를 이스케이프로 보장해 그 클래스 자체를 막고, printable
// 이라 git이 파일을 binary로 오분류하는 부작용도 없다 — 이 헬퍼가 흡수하는 모든 배치 훅이
// 이 교훈을 다시 겪지 않게 여기 한 곳에 고정한다.
function keysDepsKey(keys: string[]): string {
  return JSON.stringify([...keys].sort());
}

/**
 * `keys` 배열만큼 `fetchOne`을 병렬 호출(Promise.all 계열)한다 — BE가 배치 엔드포인트를
 * 안 여는 한 훅마다 개별 호출이 이 레포의 관례(useHookPerformances/useMaterialPerformances
 * 와 동형). `keys`가 빈 배열이면 스킵 경로도 `useAsyncResource`와 동일하게 같은 종료점에서
 * `loading=false`로 끝난다.
 *
 * ⚠️story #4440 qa:changes(카디르, 2026-09-19) — 이 카드가 막으려던 바로 그 "loading
 * 영구고착" 버그가 배치 경로 자신의 `Promise.all`에서 재현됐다: `fetchOne`이 하나라도
 * reject하면(내부에서 catch 안 하는 호출부도 있을 수 있다 — 그 전제를 이 헬퍼가 강제할 수
 * 없다) `Promise.all`이 즉시 reject하고, `void (async () => {...})()`엔 `.catch`가 없어
 * `setLoading(false)`에 영영 못 도달 + unhandled rejection이 났다. `Promise.allSettled`로
 * 교체 — reject한 항목도 `fetchOne`이 null을 반환한 것과 동일하게(그 key만 실패, 전체를
 * 안 죽임) 수렴시켜 이 async 블록이 항상 정상 종료하게 만든다.
 *
 * ⚠️round-2(카디르, 2026-09-19) — 위 fix는 `fetchOne`이 **비동기** reject하는 경우만
 * 막았다. `fetchOne`이 `async` 없이 선언돼 호출 즉시(await 前) **동기** throw하면
 * `resolvedKeys.map((k) => fetchOne(k))` 자체가 `.map()` 안에서 동기 throw해
 * `Promise.allSettled`에 배열이 넘어가기도 전에 이 async 블록 전체가 죽는다 — 같은 결과
 * (고착+unhandled)를 다른 경로로 낸다. 각 호출을 `Promise.resolve().then(() =>
 * fetchOne(k))`로 감싸 동기 throw도 그 `.then` 콜백 안에서 나게 만든다 — 동기/비동기
 * 예외 둘 다 Promise 세계로 들어와 allSettled가 개별 rejection으로 흡수한다. */
export function useAsyncResourceBatch<T>(
  keys: string[],
  fetchOne: (key: string) => Promise<T | null>,
): UseAsyncResourceBatchResult<T> {
  const [itemsByKey, setItemsByKey] = useState<Record<string, T>>({});
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const depsKey = keysDepsKey(keys);

  useEffect(() => {
    let cancelled = false;
    const resolvedKeys = JSON.parse(depsKey) as string[];
    if (resolvedKeys.length === 0) {
      setItemsByKey({});
      setLoadFailed(false);
      setLoading(false);
      return () => { cancelled = true; };
    }
    setLoading(true);
    setLoadFailed(false);
    void (async () => {
      const settled = await Promise.allSettled(
        resolvedKeys.map((k) => Promise.resolve().then(() => fetchOne(k))),
      );
      if (cancelled) return;
      // story #4440 P2(카디르) — key가 "__proto__" 등 특수 프로퍼티명이면 plain object에
      // 직접 대입(`next[key] = item`) 시 own property가 아니라 프로토타입 체인을 건드릴
      // 수 있다(그 key만 조용히 소실). 이 도메인(uuid/hook_key)에선 저위험이지만 범용
      // 헬퍼라 Object.create(null)로 프로토타입 자체를 없애 그 클래스를 구조로 막는다.
      const next: Record<string, T> = Object.create(null) as Record<string, T>;
      let anyFailed = false;
      settled.forEach((result, i) => {
        const item = result.status === 'fulfilled' ? result.value : null;
        if (item !== null) next[resolvedKeys[i]!] = item;
        else anyFailed = true;
      });
      setItemsByKey(next);
      setLoadFailed(anyFailed && Object.keys(next).length === 0);
      setLoading(false);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depsKey]);

  return { itemsByKey, loading, loadFailed };
}
