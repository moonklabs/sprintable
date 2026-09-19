'use client';

import { useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/db/client';
import type { HookPerformanceSummary } from '@/services/material-lineage';

// story #4063(E-RECIPE-1 ④ 렌더, PR #4434 위) — GET /api/v2/material-lineage/hook-performance
// ?hook_key= 를 hookKeys 배열만큼 병렬 조회. 훅 하나마다 별 호출이라(BE가 배치 엔드포인트를
// 안 열었다, doc c7991109에 그런 계약 없음 — 지어내지 않는다) Promise.all로 묶는다.
const HOOK_PERFORMANCE_API_PATH = '/api/v2/material-lineage/hook-performance';

export interface UseHookPerformancesResult {
  // hook_key → summary. 실패/미조회 hook_key는 이 맵에 아예 안 들어간다(0 위장 안 함).
  summaries: Record<string, HookPerformanceSummary>;
  loading: boolean;
  loadFailed: boolean;
}

async function fetchOne(hookKey: string): Promise<HookPerformanceSummary | null> {
  try {
    const params = new URLSearchParams({ hook_key: hookKey });
    const res = await fetchWithAuth(`${HOOK_PERFORMANCE_API_PATH}?${params.toString()}`);
    if (!res.ok) return null;
    return (await res.json()) as HookPerformanceSummary;
  } catch {
    return null;
  }
}

// story #4046/#4059 관례 — 배열 identity가 아니라 정렬된 join으로 deps를 비교한다(호출부가
// 매 렌더 새 배열 리터럴을 넘겨도 불필요한 재요청이 안 돌게).
// ⚠️story #4436 qa:changes round-2(카디르, 2026-09-19) — hook_key는 material_lineage
// 응답 필드라 채널 API처럼 문자 제약이 없다(공백 포함 가능, doc §3① 그대로 "임의 문자열").
// 공백 구분자였을 때: ['hook a']→split(' ')이 2개로 오분할되거나, ['a b','c']와
// ['a','b c']가 우연히 같은 join 결과를 내 서로 다른 키 집합인데 재요청을 스킵하는 실버그가
// 났다(카디르 실 훅 테스트로 재현). NUL 바이트 구분자로 "고쳤던" 이전 시도도 틀렸다 — 그건
// 우연히 안전한 게 아니라 "hook_key가 절대 못 갖는 문자라 의도적으로 고른 안전 구분자"였던
// 걸 이번 사고로 알았다. JSON.stringify는 배열 구분을 이스케이프로 보장해 이 클래스
// 자체를 막고, printable이라 git이 파일을 binary로 오분류하는 부작용도 같이 없앤다.
function hookKeysDepsKey(hookKeys: string[]): string {
  return JSON.stringify([...hookKeys].sort());
}

export function useHookPerformances(hookKeys: string[]): UseHookPerformancesResult {
  const [summaries, setSummaries] = useState<Record<string, HookPerformanceSummary>>({});
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const depsKey = hookKeysDepsKey(hookKeys);

  useEffect(() => {
    const keys = JSON.parse(depsKey) as string[];
    if (keys.length === 0) {
      // app-sidebar.tsx 관례 — 객체 리터럴 setState는 배열/원시값과 달리
      // set-state-in-effect가 걸린다(단일 setState라도).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSummaries({});
      setLoadFailed(false);
      // story #4436 qa:changes(카디르, 2026-09-19) — 이 guard가 setLoading(false)를 빼먹어
      // hookKeys가 값→빈 배열로 바뀌는 순간 loading이 영구고착(use-material-lineage.ts와
      // 동일 클래스).
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadFailed(false);
    void (async () => {
      const results = await Promise.all(keys.map((k) => fetchOne(k)));
      if (cancelled) return;
      const next: Record<string, HookPerformanceSummary> = {};
      let anyFailed = false;
      results.forEach((summary, i) => {
        if (summary) next[keys[i]] = summary;
        else anyFailed = true;
      });
      setSummaries(next);
      // 전부 실패한 경우만 loadFailed — 일부 실패는 summaries에서 그 키가 그냥
      // 빠진 것으로 이미 정직하게 드러난다(전체를 감추지 않는다).
      setLoadFailed(anyFailed && Object.keys(next).length === 0);
      setLoading(false);
    })();
    return () => { cancelled = true; };
  }, [depsKey]);

  return { summaries, loading, loadFailed };
}
