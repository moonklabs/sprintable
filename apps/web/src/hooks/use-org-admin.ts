'use client';

import { useEffect, useState } from 'react';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { fetchMe } from '@/lib/me-client';

/**
 * story 4889 (UI-6) — «지금 조직에서 관리자(admin · owner)인가» 한 곳. «팀» 탭줄의 «접근권한» 탭과 에이전트 화면의 접근권한 패널이 같은 답을 쓴다.
 * story 4891 규칙 그대로: 역할은 **한 조직의 것**이다(조직을 바꾸면 이 화면은 다시 마운트되지 않고 다시 그려진다) — 답은 «물은 조직»과 함께 들고, **지금 조직의 답만** 센다
 * (옛 조직의 답이 새 조직에서 접근권한 탭을 열어 두거나, 이미 떠난 조직의 늦은 답이 지금 조직의 역할을 덮는 일이 없다). 답이 오기 전(loaded=false)은 관리자가 아닌 것으로 읽는다.
 */
export function useOrgAdmin(): { isAdmin: boolean; loaded: boolean } {
  const { orgId } = useDashboardContext();
  const [me, setMe] = useState<{ org: string | null; isAdmin: boolean } | null>(null);
  const mine = me && me.org === (orgId ?? null) ? me : null;

  useEffect(() => {
    let cancelled = false;
    const org = orgId ?? null;
    void (async () => {
      let next = { org, isAdmin: false };
      try {
        const res = await fetchMe();
        if (res.ok) {
          const json = await res.json() as { data?: { role?: string } };
          const role = json.data?.role ?? 'member';
          next = { org, isAdmin: role === 'admin' || role === 'owner' };
        }
      } catch {
        // 네트워크가 끊겨도 «관리자가 아님»으로 끝낸다 — 끝내지 않으면 loaded가 영영 false라 접근권한 주소가 빈 본문으로 남는다.
      }
      if (!cancelled) setMe(next);
    })();
    return () => { cancelled = true; };
  }, [orgId]);

  return { isAdmin: mine?.isAdmin ?? false, loaded: mine !== null };
}
