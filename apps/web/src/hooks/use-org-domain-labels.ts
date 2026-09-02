'use client';

import { useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/db/client';

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
 * useLocale()을 호출부가 넘긴다(이 훅 자체는 next-intl 의존을 안 늘리려고 순수 string으로 받음). */
export function useOrgDomainLabels(orgId: string | undefined, locale: string): OrgDomainLabels {
  const [entries, setEntries] = useState<DomainLabelEntry[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!orgId) {
      setEntries([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const res = await fetchWithAuth(`/api/organizations/${orgId}/domain-labels`);
        if (!res.ok) {
          if (!cancelled) setEntries([]);
          return;
        }
        const data = (await res.json()) as DomainLabelEntry[];
        if (!cancelled) setEntries(data);
      } catch {
        // 네트워크 실패 등 — 조용히 폴백(라벨 오버라이드는 장식 계층, 실패가 보드 자체를
        // 막으면 안 된다·설계 doc의 "무설정=기본값" 원칙과 동일 정신).
        if (!cancelled) setEntries([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orgId]);

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
