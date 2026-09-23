// story #3274(지원v1·후속, 선생님 확定 2026-09-01) — activation checklist 조회를
// activation-checklist-banner.tsx 밖으로 뽑아 공유 hook화(AC① "배너와 단일 fetch·
// COMPLETE_KEY 공유"). 두 소비처(배너 + support-widget-launcher.tsx의 온보딩 단계 게이팅)가
// 같은 트리 안에서 부모-자식 관계가 아니라(dashboard-shell.tsx에서 형제 위치) 각자
// useActivationStatus()를 부르는데, 모듈 스코프 in-flight promise로 캐싱해 실 네트워크
// 호출은 세션당 1회만 나간다(둘 다 마운트돼도 fetchWithAuth가 두 번 안 나감).
'use client';

import { useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/db/client';

const COMPLETE_KEY = 'sprintable_activation_checklist_complete';

export interface ActivationState {
  steps: {
    signed_up: boolean;
    email_verified: boolean;
    org_created: boolean;
    agent_connected: boolean;
    first_roundtrip: boolean;
  };
  completed: number;
  total: number;
  all_complete: boolean;
  // story #3201 — 왕복 성사된 대화(또는 org 최초 agent DM) id, 없으면 null.
  first_instruction_conversation_id: string | null;
  // story #3610(3607 잔여) CHANGES-2(유나 확認·PO 채택 2026-09-07) — 최초판 scope_org_id
  // (판정에 쓰인 org 값)를 폐기하고 불리언으로 대체했다. FE가 그 값을 orgId(실제로는
  // me.org_id=계정 기본 org)와 비교했는데, X-Org-Id(탭 effective org)와 다른 프레임이라
  // switch-org 전환 창에서 가드가 안 걸리는 구멍이 있었다 — BE가 "요청 org==판정 org"
  // 비교를 직접 끝내 낸다. undefined(구 응답 shape, 롤아웃 창)면 기존처럼 렌더 유지.
  scope_is_requested_org?: boolean;
}

function readLocalFlag(key: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function clearLocalFlag(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // 무시 — 다음 조회가 다시 판정
  }
}

function writeLocalFlag(key: string): void {
  try {
    window.localStorage.setItem(key, '1');
  } catch {
    // 영속 실패해도 이번 렌더는 정상 동작(단지 다음 세션에 한 번 더 조회할 뿐)
  }
}

// 모듈 스코프 in-flight 캐시 — 여러 컴포넌트가 같은 렌더 사이클에 훅을 호출해도 실
// fetchWithAuth 호출은 1회로 수렴한다(React 컴포넌트 트리와 무관한 공유, 페이지 세션
// 동안 유지 — activation은 단조 증가라 재조회할 이유가 없다).
// story #4219 F1(PO 리뷰) — **org별**. 체크리스트는 요청 org(X-Org-Id) 판정이라, org를 바꾼 뒤 옛 org 결과를 재사용하면
// 다른 org의 완주 여부를 보여 주고 힌트 쿠키에도 섞여 기록됐다.
const sharedFetchPromises = new Map<string, Promise<ActivationState | null>>();

// firebase-session.ts::_resetKeyCacheForTests()와 동일 컨벤션 — 모듈 스코프 캐시는 테스트
// 파일 간(그리고 한 파일의 it() 블록 간) 격리가 필요하다, 안 그러면 앞 테스트의 stub된
// fetch 응답이 캐시로 남아 뒤 테스트에 새지 않도록 test setup에서 명시 호출한다.
export function _resetActivationStatusCacheForTests(): void {
  sharedFetchPromises.clear();
}

async function fetchActivationState(orgKey: string): Promise<ActivationState | null> {
  let sharedFetchPromise = sharedFetchPromises.get(orgKey);
  if (!sharedFetchPromise) {
    sharedFetchPromise = (async () => {
      try {
        const res = await fetchWithAuth('/api/activation/checklist');
        if (!res.ok) return null;
        const json = (await res.json()) as { data?: ActivationState };
        return json.data ?? null;
      } catch {
        return null;
      }
    })();
    sharedFetchPromises.set(orgKey, sharedFetchPromise);
  }
  return sharedFetchPromise;
}

export interface UseActivationStatusResult {
  /** 조회 완료 전이거나 조회 실패면 null. 다른 org의 결과는 절대 싣지 않는다(org가 바뀌면 null로 돌아감). */
  state: ActivationState | null;
  /** state가 판정된 org(요청 org). state가 null이면 null. */
  stateOrgId: string | null;
  /** 완주 여부 — localStorage에 이미 기록된 경우(과거 세션에 완주 관측)도 true(fetch 자체를
   * 건너뛰므로 state는 null로 남지만 "온보딩 단계 아님"은 확定적으로 참이다). */
  allComplete: boolean;
}

// story #4032(CLS 처방 CHANGES-1, PO 지적) — `initialAllComplete`는 서버가 이미
// 확認해 둔 값((authenticated)/layout.tsx가 org 컨텍스트 확정 뒤 /api/v2/activation/
// checklist를 1회 조회해 흘려보낸다)이다. true면 이 브라우저에 localStorage 플래그가
// 없어도(새 기기·시크릿 창·저장소 삭제) 처음부터 완주로 취급해 fetch 자체를 스킵한다 —
// 그 경로가 없으면 "완주했지만 이 기기는 모른다"는 사용자에게 로딩 스켈레톤이 떴다
// 접히는 새 흔들림이 생긴다(첫 CHANGES에서 로컬 스토리지만 보던 자리의 결함).
export function useActivationStatus(
  initialAllComplete?: boolean,
  // story #4219 F1 — 완주 시드가 표시용 힌트에서 왔으면 스켈레톤 없이(완주로 보여 둔 채) 한 번 다시 조회해,
  // 완주가 되돌아간 드문 경우 배너가 늦게라도 뜨게 한다(힌트는 조언일 뿐).
  // orgId: 요청 org(대시보드 컨텍스트의 effective org = 인터셉터가 싣는 X-Org-Id). 캐시·로컬 완주 플래그·결과가 모두 이 org 범위.
  options?: { verifyInBackground?: boolean; orgId?: string },
): UseActivationStatusResult {
  const orgId = options?.orgId;
  // 로컬 완주 플래그도 org 범위(story #4219 · 예전엔 전역이라 한 org를 완주하면 다른 org 배너까지 숨었다). org 모르면 안 읽는다.
  const localKey = orgId ? `${COMPLETE_KEY}:${orgId}` : null;
  const seedComplete = initialAllComplete === true || (localKey ? readLocalFlag(localKey) : false);
  const skip = seedComplete && options?.verifyInBackground !== true;
  const [result, setResult] = useState<{ orgId: string | null; data: ActivationState } | null>(null);

  useEffect(() => {
    if (skip) return;
    let cancelled = false;
    const requestOrg = orgId ?? null;
    void (async () => {
      const data = await fetchActivationState(requestOrg ?? '');
      if (cancelled || !data) return;
      setResult({ orgId: requestOrg, data });
      if (localKey) {
        if (data.all_complete) writeLocalFlag(localKey);
        else clearLocalFlag(localKey);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [skip, orgId, localKey]);

  // org가 바뀌면 옛 org 결과는 버린다(렌더 파생 — 다음 조회가 새 org 결과로 채움).
  const state = result && result.orgId === (orgId ?? null) ? result.data : null;
  return { state, stateOrgId: state ? result!.orgId : null, allComplete: state ? state.all_complete === true : seedComplete };
}
