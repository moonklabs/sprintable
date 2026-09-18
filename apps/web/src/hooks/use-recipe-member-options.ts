'use client';

import { useCallback, useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/db/client';

// story #4046(E-RECIPE-1 ①) — 레시피 적용 role_mapping 바인딩 대상 조회. 기존
// apply-recipe-dialog.tsx는 `?type=agent`로 고정해 에이전트만 받는다(개발 워크플로 레시피는
// 역할 전부가 에이전트라 지금까지 그걸로 충분했다) — 마케팅 레시피(#4039 seed)는 role="디렉터"
// 슬롯이 사람이라 그 제약을 걷어야 한다. `type` 쿼리파라미터를 아예 생략하면 backend
// list_team_members(team_members.py)가 project_id 스코프에서 타입 필터 없이 그 프로젝트의
// team_members 뷰 행 전부(agent+human)를 반환한다(project_id 지정 분기는 filters에 type이
// 없으면 안 거름 — repo.list 구현 그대로, org-level의 "type 생략=양쪽 다"와 대칭) — 신규
// 백엔드 변경 0, 기존 엔드포인트의 이미 있는 기능을 그대로 쓰는 것뿐이다.
//
// 프레젠테이션(드롭다운 UI 등)은 후속 카드 — 이 훅은 옵션 목록·로딩/에러 상태까지만.

const TEAM_MEMBERS_API_PATH = '/api/team-members';

export interface RecipeMemberOption {
  id: string;
  name: string;
  type: string; // 'agent' | 'human' — 서버 리터럴 그대로 통과(신규 enum 발명 안 함)
}

export interface UseRecipeMemberOptionsResult {
  options: RecipeMemberOption[];
  loading: boolean;
  // apply-recipe-dialog.tsx의 agentsLoadFailed와 동형 축 — options가 빈 배열인 게 "진짜
  // 0명"인지 "못 불러옴"인지 갈라야 옆 문구가 정직해진다(story #3521 관례 재사용).
  loadFailed: boolean;
  refresh: () => void;
}

export function useRecipeMemberOptions(projectId: string | null): UseRecipeMemberOptionsResult {
  const [options, setOptions] = useState<RecipeMemberOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [nonce, setNonce] = useState(0);

  const refresh = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!projectId) {
      setOptions([]);
      setLoadFailed(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadFailed(false);
    void (async () => {
      try {
        const res = await fetchWithAuth(`${TEAM_MEMBERS_API_PATH}?project_id=${projectId}`);
        if (!res.ok) throw new Error(`status ${res.status}`);
        const json = (await res.json()) as RecipeMemberOption[] | { data?: RecipeMemberOption[] };
        const all = Array.isArray(json) ? json : (json.data ?? []);
        if (cancelled) return;
        setOptions(all);
      } catch {
        if (cancelled) return;
        setOptions([]);
        setLoadFailed(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [projectId, nonce]);

  return { options, loading, loadFailed, refresh };
}
