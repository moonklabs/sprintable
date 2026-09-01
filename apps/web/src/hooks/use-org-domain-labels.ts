'use client';

import { useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/db/client';

/**
 * story #3287([도메인탈고정·축1 Phase1] org 표시 라벨 레이어) FE 소비 — BE
 * `GET /api/v2/organizations/{org_id}/domain-labels`(canonical slug 불변, org별 표시
 * 라벨만) 조회+캐시. canonical_slug는 이 훅이 절대 안 바꾼다 — 호출부(kanban-board 등)가
 * 기존 하드코딩 라벨(t(col.i18nKey) 등)을 그대로 fallback으로 쓰고, 이 훅이 반환하는
 * override가 있을 때만 그 위에 얹는다("미설정=시스템 기본값" 원칙, BE 설계 doc
 * entity:doc:1fa7e2a9-c8c2-4a8e-a9da-35bce52a5012 §Phase 1 그대로).
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

function pickLocaleLabel(entry: DomainLabelEntry, locale: string): string | undefined {
  const preferred = locale.startsWith('ko') ? entry.label_ko : entry.label_en;
  return preferred ?? entry.label_ko ?? entry.label_en ?? undefined;
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
        const res = await fetchWithAuth(`/api/v2/organizations/${orgId}/domain-labels`);
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
