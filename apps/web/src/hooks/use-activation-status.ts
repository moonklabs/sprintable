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
let sharedFetchPromise: Promise<ActivationState | null> | null = null;

// firebase-session.ts::_resetKeyCacheForTests()와 동일 컨벤션 — 모듈 스코프 캐시는 테스트
// 파일 간(그리고 한 파일의 it() 블록 간) 격리가 필요하다, 안 그러면 앞 테스트의 stub된
// fetch 응답이 캐시로 남아 뒤 테스트에 새지 않도록 test setup에서 명시 호출한다.
export function _resetActivationStatusCacheForTests(): void {
  sharedFetchPromise = null;
}

async function fetchActivationState(): Promise<ActivationState | null> {
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
  }
  return sharedFetchPromise;
}

export interface UseActivationStatusResult {
  /** 조회 완료 전이거나 조회 실패면 null. */
  state: ActivationState | null;
  /** 완주 여부 — localStorage에 이미 기록된 경우(과거 세션에 완주 관측)도 true(fetch 자체를
   * 건너뛰므로 state는 null로 남지만 "온보딩 단계 아님"은 확定적으로 참이다). */
  allComplete: boolean;
}

export function useActivationStatus(): UseActivationStatusResult {
  const [skip] = useState<boolean>(() => readLocalFlag(COMPLETE_KEY));
  const [state, setState] = useState<ActivationState | null>(null);

  useEffect(() => {
    if (skip) return;
    let cancelled = false;
    void (async () => {
      const data = await fetchActivationState();
      if (cancelled || !data) return;
      setState(data);
      if (data.all_complete) writeLocalFlag(COMPLETE_KEY);
    })();
    return () => {
      cancelled = true;
    };
  }, [skip]);

  return { state, allComplete: skip || state?.all_complete === true };
}
