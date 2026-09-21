'use client';

import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/db/client';

// story #4075(AC1/AC6) — 스토리 화면 «레시피 시작» 진입점의 활성화 판단용 데이터 층.
// GET /api/events/definitions/start-candidates(BE 신설, 이 story 스코프)를 그대로 호출 —
// FE는 필터/정렬을 하지 않는다(적용 레시피 2개 이상이면 그대로 나열해 고르게 하는 게 설계,
// 페드루 확定).

export interface RecipeStartCandidate {
  definition_id: string;
  key: string;
  name: string;
  first_stage: string;
  role_bound: boolean;
  started: boolean;
  conversation_id: string | null;
  message_id: string | null;
  // story #4082([E-RECIPE-1] 진행 위치 표시) — started=true일 때만 채워진다.
  current_stage: string | null;
  current_role: string | null;
  next_stage: string | null;
  next_role: string | null;
  last_published_at: string | null;
  // story #4082(유나 design CHANGES 2026-09-21) — recipe-stage-label.ts 미등재 slug일 때
  // 「단계 n/9」 자리표시용(내부어 raw slug 노출 대신).
  current_stage_position: number | null;
  total_stages: number | null;
}

export interface UseRecipeStartCandidatesResult {
  candidates: RecipeStartCandidate[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const START_CANDIDATES_API_PATH = '/api/events/definitions/start-candidates';

export function useRecipeStartCandidates(
  projectId: string | undefined,
  workItemType: string,
  workItemId: string,
): UseRecipeStartCandidatesResult {
  const [candidates, setCandidates] = useState<RecipeStartCandidate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!projectId || !workItemId) {
      setCandidates([]);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const params = new URLSearchParams({
          project_id: projectId, work_item_type: workItemType, work_item_id: workItemId,
        });
        const res = await fetchWithAuth(`${START_CANDIDATES_API_PATH}?${params.toString()}`);
        if (!res.ok) throw new Error(`status ${res.status}`);
        // story #4046/#4048 관례와 동일 방어적 unwrap(fastapi-proxy 경유 계약이 {data:...}로
        // 감싸질 가능성 방어).
        const json = (await res.json()) as {
          candidates?: RecipeStartCandidate[];
          data?: { candidates?: RecipeStartCandidate[] };
        };
        if (cancelled) return;
        setCandidates(json.candidates ?? json.data?.candidates ?? []);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : 'failed to load recipe start candidates');
        setCandidates([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [projectId, workItemType, workItemId, nonce]);

  return { candidates, loading, error, refresh };
}
