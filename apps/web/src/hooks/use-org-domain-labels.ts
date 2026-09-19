'use client';

import { fetchWithAuth } from '@/lib/db/client';
import { useAsyncResource } from './use-async-resource';

/**
 * story #3287([도메인탈고정·축1 Phase1] org 표시 라벨 레이어) FE 소비 — BFF
 * `GET /api/organizations/{org_id}/domain-labels`(canonical slug 불변, org별 표시
 * 라벨만) 조회+캐시. canonical_slug는 이 훅이 절대 안 바꾼다 — 호출부(kanban-board 등)가
 * 기존 하드코딩 라벨(t(col.i18nKey) 등)을 그대로 fallback으로 쓰고, 이 훅이 반환하는
 * override가 있을 때만 그 위에 얹는다("미설정=시스템 기본값" 원칙, BE 설계 doc
 * entity:doc:1fa7e2a9-c8c2-4a8e-a9da-35bce52a5012 §Phase 1 그대로).
 *
 * story #3705(P0 핫픽스) — 이 훅이 BFF route 없이 BE `/api/v2/...`를 직접 호출하고
 * 있었다(다른 모든 엔드포인트는 `/api/...` BFF proxy 경유). fetchWithAuth의
 * 401→refresh→재시도 경로가 직접 호출에도 그대로 걸려, refresh 성공 후에도 domain-labels
 * 재시도가 또 401(같은 이유로 BFF 인증 forwarding을 안 탐)이 되어 SessionExpiredDialog가
 * 로그인 직후 뜨는 원인이었다 — BFF route 신설(app/api/organizations/[id]/domain-labels/
 * route.ts) + 이 URL을 그 경로로 전환해 다른 엔드포인트와 동형화한다.
 */

type DomainLabelEntry = {
  domain: 'entity_type' | 'status';
  canonical_slug: string;
  label_ko: string | null;
  label_en: string | null;
};

export interface OrgDomainLabels {
  /** (domain, canonical_slug) → label. 현재 locale의 label_ko/label_en 중 값이 있는
   *쪽만 채워진다 — 없으면 호출부가 자기 기본 라벨(i18n)로 폴백. */
  statusLabel(canonicalSlug: string): string | undefined;
  entityTypeLabel(canonicalSlug: string): string | undefined;
  loading: boolean;
}

// 유나 design:changes(PR#3687, 2026-09-01) — 빈 문자열("")은 null이 아니라 값이 있는
// 것으로 취급돼 그대로 반환됐다(?? 는 null/undefined만 거름). 소비처(kanban-board 등)의
// `statusLabel(...) ?? t(...)` 폴백도 ""는 값으로 보고 폴백 안 타 헤더/배지가 빈칸으로
// 렌더됐을 것 — trim 후 빈 값이면 undefined로 정규화해 canonical 폴백이 항상 뜨게 한다.
function normalizeLabel(value: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function pickLocaleLabel(entry: DomainLabelEntry, locale: string): string | undefined {
  const preferred = normalizeLabel(locale.startsWith('ko') ? entry.label_ko : entry.label_en);
  return preferred ?? normalizeLabel(entry.label_ko) ?? normalizeLabel(entry.label_en);
}

/** orgId가 없으면(아직 로딩 중 등) 빈 오버라이드 — 전부 폴백(회귀 0). locale은 next-intl의
 * useLocale()을 호출부가 넘긴다(이 훅 자체는 next-intl 의존을 안 늘리려고 순수 string으로 받음).
 *
 * story #4066 마이그(useAsyncResource 위) — 스킵/성공/실패 세 경로 전부 헬퍼가 같은
 * 종료점에서 loading=false로 닫는다(#4431 카디르 QA가 잡았던 orgId→undefined 영구고착
 * 클래스가 이제 이 훅 코드에 다시 등장할 여지 자체가 없다). `!res.ok`와 네트워크 예외를
 * 원래처럼 동일하게(둘 다 조용히 빈 배열 폴백) 취급 — `loadFailed`는 이 훅의 공개 계약
 * (`OrgDomainLabels`)에 없으니 그대로 노출 안 함(장식 계층, "무설정=기본값" 원칙 그대로).
 *
 * ⚠️카디르 재QA(2026-09-19) — 원본 skip 조건 `if (!orgId)`는 falsy 전부(빈 문자열 포함)를
 * 스킵으로 봤는데, `useAsyncResource`의 skip 판정은 `null`/`undefined`만 인식한다.
 * `orgId=''`를 그대로 넘기면 `/api/organizations//domain-labels`로 실제 fetch가 나가
 * "기존동작 무변" 계약이 깨진다(원본·신규 나란히 실행비교로 실증) — `orgId || undefined`로
 * 정규화해 falsy 전부가 스킵되게 원본 semantics를 보존한다. */
export function useOrgDomainLabels(orgId: string | undefined, locale: string): OrgDomainLabels {
  const { data: entries, loading } = useAsyncResource<string, DomainLabelEntry[]>(
    orgId || undefined, [],
    async (id) => {
      const res = await fetchWithAuth(`/api/organizations/${id}/domain-labels`);
      // 카디르 재QA — 이 !res.ok 체크가 없어도 대개 결과가 같아서(에러 응답이 보통
      // 배열이 아니라 아래 Array.isArray 방어가 같은 []를 낸다) 이 체크 자체를 지워도
      // 기존 테스트가 안 틀렸다([못틀리는대조미자]). !res.ok는 응답 *모양*이 아니라
      // *상태*를 보는 별개 방어라 명시적으로 먼저 걸러야 한다(회귀테스트가 배열 모양
      // 에러 바디로 이 둘을 갈라 pin).
      if (!res.ok) return [];
      const data = (await res.json()) as unknown;
      // story #3881(customer-zero) 실측 — 이 `as` 단언은 런타임 검증이 아니라 컴파일 타임
      // 힌트일 뿐이었다. 응답 body가 배열이 아닌 모양(예: 다른 엔드포인트 mock에 걸린
      // 테스트·BE 계약 드리프트·프록시 중간 오류 페이지)이면 비배열 값을 그대로 state에
      // 싣고, 다음 렌더의 `for (const e of entries)`가 즉시 TypeError로 터진다
      // (EventBlockCard가 이 훅을 새로 쓰기 시작하면서 실측 발견). 네트워크 실패와
      // 동일하게 빈 배열로 방어한다 — "무설정=기본값" 원칙 그대로, 응답 모양이 이상해도
      // 이 장식 계층이 화면 전체를 깨면 안 된다.
      return Array.isArray(data) ? data : [];
    },
  );

  const byKey = new Map<string, DomainLabelEntry>();
  for (const e of entries) byKey.set(`${e.domain}:${e.canonical_slug}`, e);

  return {
    statusLabel: (slug) => {
      const entry = byKey.get(`status:${slug}`);
      return entry ? pickLocaleLabel(entry, locale) : undefined;
    },
    entityTypeLabel: (slug) => {
      const entry = byKey.get(`entity_type:${slug}`);
      return entry ? pickLocaleLabel(entry, locale) : undefined;
    },
    loading,
  };
}
