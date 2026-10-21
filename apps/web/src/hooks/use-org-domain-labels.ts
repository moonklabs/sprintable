'use client';

import { useEffect } from 'react';
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

// story #4748 — 같은 조직의 라벨은 이 모듈 한 곳에서 받는다. 대화방은 이벤트 블록 카드 · 입력창이 저마다 이 훅을 불러, 방을 열면 같은 요청이 30번 남짓
// 나갔다(prod android-webview 기록 · 훅 자체에 캐시도 진행 중 요청 공유도 없었다). 이제: ① 진행 중인 요청은 모두 한 요청을 같이 기다린다
// ② 받은 값은 TTL 동안 모든 소비처가 그대로 쓴다 ③ 실패는 짧게(FAILED_TTL) 기억해 실패하는 동안 소비처마다 다시 두드리는 폭풍을 막는다.
// 라벨을 바꾸는 쪽(PUT/DELETE — 지금 웹 화면엔 쓰는 자리가 없고 BE · MCP로 바뀐다)은 invalidateOrgDomainLabels(orgId)를 부르고, 안 불러도
// TTL 안에 새 값이 보인다(조직 설정 화면이 생기면 거기서 부른다). 이미 떠 있는 소비처도 같다: 무효화 · 슬롯 만료(성공 TTL · 실패 FAILED_TTL) 때 조직별 구독자에게
// «다시 읽어라»가 가고, 각자 같은 공유 요청을 통해 새로 읽는다(떠 있는 대화방이 옛 값 · 실패 값에 영영 붙어 있지 않게 — codex QA).
export const ORG_DOMAIN_LABELS_TTL_MS = 5 * 60_000;
export const ORG_DOMAIN_LABELS_FAILED_TTL_MS = 30_000;

type LabelSlot = { entries: DomainLabelEntry[]; expiresAt: number };
const labelSlots = new Map<string, LabelSlot>();
const labelRequests = new Map<string, Promise<DomainLabelEntry[]>>();
const labelEpochs = new Map<string, number>(); // 무효화 때 올린다 — 무효화 前에 출발한 응답이 옛 값을 다시 쓰지 못하게
const labelListeners = new Map<string, Set<() => void>>(); // 떠 있는 소비처(조직별) — 슬롯이 무효 · 만료되면 다시 읽게 깨운다
const labelTimers = new Map<string, ReturnType<typeof setTimeout>>(); // 조직별 슬롯 만료 알람(하나)

function notifyOrgDomainLabels(orgId: string): void {
  for (const wake of [...(labelListeners.get(orgId) ?? [])]) wake();
}

function subscribeOrgDomainLabels(orgId: string, wake: () => void): () => void {
  const set = labelListeners.get(orgId) ?? new Set<() => void>();
  set.add(wake);
  labelListeners.set(orgId, set);
  // a slot that was written while nobody was mounted has no alarm: the first consumer to mount sets it for what is left of the slot
  const slot = labelSlots.get(orgId);
  if (slot && !labelTimers.has(orgId)) scheduleLabelWake(orgId, Math.max(0, slot.expiresAt - Date.now()));
  return () => {
    set.delete(wake);
    if (set.size === 0 && labelListeners.get(orgId) === set) {
      labelListeners.delete(orgId);
      const timer = labelTimers.get(orgId); // nobody left to wake: no alarm either (the next mount sets it again)
      if (timer !== undefined) { clearTimeout(timer); labelTimers.delete(orgId); }
    }
  };
}

function scheduleLabelWake(orgId: string, ms: number): void {
  const old = labelTimers.get(orgId);
  if (old !== undefined) clearTimeout(old);
  labelTimers.set(orgId, setTimeout(() => {
    labelTimers.delete(orgId);
    const slot = labelSlots.get(orgId);
    if (slot && slot.expiresAt <= Date.now()) labelSlots.delete(orgId); // an expired slot is not kept
    if (labelListeners.get(orgId)?.size) notifyOrgDomainLabels(orgId);
  }, ms + 1));
}

/** 라벨을 바꾼 쪽이 부른다(orgId 없이 부르면 전부). 다음 읽기가 새로 받고, 이미 날아가 있는 요청의 응답은 버려진다. */
export function invalidateOrgDomainLabels(orgId?: string): void {
  const ids = orgId ? [orgId] : [...new Set([...labelSlots.keys(), ...labelRequests.keys(), ...labelListeners.keys()])];
  for (const id of ids) {
    labelSlots.delete(id);
    labelRequests.delete(id);
    labelEpochs.set(id, (labelEpochs.get(id) ?? 0) + 1);
    const timer = labelTimers.get(id);
    if (timer !== undefined) { clearTimeout(timer); labelTimers.delete(id); }
    notifyOrgDomainLabels(id); // 떠 있는 소비처는 새로 읽는다(같은 공유 요청 하나로)
  }
}

function freshSlot(orgId: string): LabelSlot | undefined {
  const slot = labelSlots.get(orgId);
  if (!slot) return undefined;
  if (slot.expiresAt <= Date.now()) { labelSlots.delete(orgId); return undefined; }
  return slot;
}

/** 첫 렌더에 깜빡임 없이 쓸 수 있는 값 — 받아 둔 게 있으면 그것, 없으면 undefined. */
function cachedEntries(orgId: string | undefined): DomainLabelEntry[] | undefined {
  return orgId ? freshSlot(orgId)?.entries : undefined;
}

function requestOrgDomainLabels(orgId: string): Promise<DomainLabelEntry[]> {
  const slot = freshSlot(orgId);
  if (slot) return Promise.resolve(slot.entries);
  const pending = labelRequests.get(orgId);
  if (pending) return pending;
  const epoch = labelEpochs.get(orgId) ?? 0;
  const request: Promise<DomainLabelEntry[]> = (async (): Promise<DomainLabelEntry[]> => {
    let entries: DomainLabelEntry[] = [];
    let ttl = ORG_DOMAIN_LABELS_FAILED_TTL_MS;
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/domain-labels`);
      // 카디르 재QA — 이 !res.ok 체크가 없어도 대개 결과가 같아서(에러 응답이 보통
      // 배열이 아니라 아래 Array.isArray 방어가 같은 []를 낸다) 이 체크 자체를 지워도
      // 기존 테스트가 안 틀렸다([못틀리는대조미자]). !res.ok는 응답 *모양*이 아니라
      // *상태*를 보는 별개 방어라 명시적으로 먼저 걸러야 한다(회귀테스트가 배열 모양
      // 에러 바디로 이 둘을 갈라 pin).
      if (res.ok) {
        const data = (await res.json()) as unknown;
        // story #3881(customer-zero) 실측 — 이 `as` 단언은 런타임 검증이 아니라 컴파일 타임
        // 힌트일 뿐이었다. 응답 body가 배열이 아닌 모양(예: 다른 엔드포인트 mock에 걸린
        // 테스트·BE 계약 드리프트·프록시 중간 오류 페이지)이면 비배열 값을 그대로 state에
        // 싣고, 다음 렌더의 `for (const e of entries)`가 즉시 TypeError로 터진다
        // (EventBlockCard가 이 훅을 새로 쓰기 시작하면서 실측 발견). 네트워크 실패와
        // 동일하게 빈 배열로 방어한다 — "무설정=기본값" 원칙 그대로, 응답 모양이 이상해도
        // 이 장식 계층이 화면 전체를 깨면 안 된다.
        if (Array.isArray(data)) { entries = data; ttl = ORG_DOMAIN_LABELS_TTL_MS; }
      }
    } catch {
      // 네트워크 예외 — 아래 FAILED_TTL로 짧게 기억(원래처럼 조용히 빈 배열 폴백)
    }
    // 무효화가 이 요청이 나간 뒤에 있었으면 이 응답은 옛 값이다 — 기억하지 않는다(받은 쪽에는 그대로 준다).
    if ((labelEpochs.get(orgId) ?? 0) === epoch) { labelSlots.set(orgId, { entries, expiresAt: Date.now() + ttl }); if (labelListeners.get(orgId)?.size) scheduleLabelWake(orgId, ttl); }
    return entries;
  })().finally(() => {
    if (labelRequests.get(orgId) === request) labelRequests.delete(orgId);
  });
  labelRequests.set(orgId, request);
  return request;
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
  const { data: entries, loading, refresh } = useAsyncResource<string, DomainLabelEntry[]>(
    orgId || undefined, cachedEntries(orgId) ?? [],
    (id) => requestOrgDomainLabels(id),
  );
  // 무효화 · 슬롯 만료 때 깨운다 — 떠 있는 소비처가 옛 값(또는 실패로 비운 값)에 붙어 있지 않게(refresh는 안정 참조 · 같은 요청을 같이 기다린다)
  useEffect(() => (orgId ? subscribeOrgDomainLabels(orgId, refresh) : undefined), [orgId, refresh]);

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
