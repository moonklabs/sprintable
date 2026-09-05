'use client';

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import {
  GenerationBudgetIndicator, formatMinorCurrency, majorToMinor, minorToMajor,
  type GenerationBudgetState, type GenerationBudgetCurrency,
} from '@/components/content/generation-budget-indicator';
import { fetchWithAuth } from '@/lib/db/client';

/**
 * story #3472(BE 3471/#3825, 페드루 PO 確定 2026-09-05) — 조직 콘텐츠 규칙 화면.
 * BE `GET/PUT /api/v2/organizations/{org_id}/content-rules` → `{org_id, rules,
 * version}`. 이 라우트 경로(`/organization/content-rules`)는 계약값 그대로 —
 * `violations[].settings_path`가 정확히 이 문자열로 온다(다른 경로면 초안 화면의
 * 링크가 깨진다).
 *
 * story #3490(PO 決定 2026-09-05, 3471 계약 정정) — PUT은 휴먼 owner **또는 admin**
 * (BE `_require_owner_or_admin`). 원래 "owner만"이 채널 연결 생성(owner-or-admin)과
 * 비대칭이었다 — dev org 유일 owner가 대표뿐이라 admin 운영자가 규칙을 못 넣던 갭.
 * 연결 화면의 `canEditRules = role==='admin'||'owner'` 상수를 이제 그대로 재사용한다(옛
 * "재사용 금지" 明示는 이 스토리로 정정됨). member·에이전트는 여전히 읽기만(secret
 * 아니라 값은 전원 허용, 편집 컨트롤만 없음).
 */
interface BrandKit {
  logo_url?: string;
  colors?: string[];
  fonts?: string[];
}

// story #3500(BE #3498, PO 確定 2026-09-05 — BE 미착지, 계약만 고정) — 생성 비용
// 한도(크레딧 게이트). limit_minor=0은 "정지", null은 "정책 미설정"(둘은 다른
// 값 — GenerationBudgetIndicator가 그 구분을 렌더한다). currency/period는
// 정책이 있을 때만 의미가 있다(둘 다 limit_minor가 null이면 화면에서 안 씀).
interface GenerationBudget {
  limit_minor: number;
  currency: 'KRW' | 'USD';
  period: 'month';
}

interface ContentRules {
  banned_terms: string[];
  require_utm: boolean;
  tone: string | null;
  taxonomy: string[];
  channel_priority: string[];
  brand_kit: BrandKit;
  generation_budget: GenerationBudget | null;
}

interface ContentRulesResponse {
  org_id: string;
  rules: ContentRules;
  version: number;
}

const EMPTY_RULES: ContentRules = {
  banned_terms: [], require_utm: false, tone: null, taxonomy: [], channel_priority: [], brand_kit: {},
  generation_budget: null,
};

// story #3472(BE #3825 "보정 중") — 422 CONTENT_RULES_INVALID의 필드별 shape는 아직
// 최종이 아니다. 이 화면은 최선으로 `field`가 실려 오면 그 필드 옆에, 없으면 폼
// 상단 배너로 낸다(둘 다 원문을 안 지운다 — <details> 접기, §3-0 원칙과 동형).
type ContentRulesErrorBody = {
  error?: {
    code?: string; message?: string; field?: string;
    // story #3501(doc a0da40c9 §20-2) — 409 CONTENT_RULES_VERSION_CONFLICT 전용.
    current_version?: number;
    updated_by?: { member_id: string; name: string | null } | null;
  };
};

// story #3501(doc a0da40c9 §20) — 필드 «이름»을 사람 라벨로. 이 화면이 편집하지
// 않는 미지 키(예: 다른 화면이 만든 utm_rules)는 원시 키 그대로 폴백한다.
const FIELD_LABEL_KEYS: Record<string, string> = {
  banned_terms: 'bannedTermsLabel',
  require_utm: 'requireUtmLabel',
  tone: 'toneLabel',
  taxonomy: 'taxonomyLabel',
  channel_priority: 'channelPriorityLabel',
  brand_kit: 'brandKitLabel',
  generation_budget: 'generationBudgetSectionTitle',
};

// story #3501(doc a0da40c9 §20-4) — "화면이 이미 가진 것으로 계산한다": 로드값·
// 로컬값·새 서버값 세 벌을 두 번 견주면 새 API 없이 두 목록이 나온다.
function diffFieldNames(a: object, b: object): string[] {
  const ar = a as Record<string, unknown>;
  const br = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ar), ...Object.keys(br)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (JSON.stringify(ar[key]) !== JSON.stringify(br[key])) changed.push(key);
  }
  return changed;
}

// §20-4 — "두 목록이 겹치는 필드가 «진짜 충돌»이다 — 겹치는 이름은 앞에 둔다."
function withOverlapFirst(fields: string[], overlap: ReadonlySet<string>): string[] {
  return [...fields].sort((a, b) => Number(overlap.has(b)) - Number(overlap.has(a)));
}

interface VersionConflictState {
  updatedByName: string | null;
  priorChangedFields: string[];
  myChangedFields: string[];
  freshServerRules: ContentRules;
  freshServerVersion: number;
}

function TagListEditor({
  items, onChange, readOnly, placeholder, testIdPrefix,
}: {
  items: string[];
  onChange: (next: string[]) => void;
  readOnly: boolean;
  placeholder: string;
  testIdPrefix: string;
}) {
  const [draft, setDraft] = useState('');

  const addTag = () => {
    const value = draft.trim();
    if (!value || items.includes(value)) { setDraft(''); return; }
    onChange([...items, value]);
    setDraft('');
  };

  if (readOnly) {
    return items.length === 0 ? (
      <p className="text-xs text-muted-foreground" data-testid={`${testIdPrefix}-empty`}>—</p>
    ) : (
      <div className="flex flex-wrap gap-1.5" data-testid={`${testIdPrefix}-readonly`}>
        {items.map((item) => (
          <span key={item} className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-xs text-foreground">
            {item}
          </span>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-1.5" data-testid={`${testIdPrefix}-editor`}>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <span key={item} className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-foreground">
            {item}
            <button
              type="button"
              onClick={() => onChange(items.filter((x) => x !== item))}
              aria-label={`Remove ${item}`}
              className="text-muted-foreground hover:text-foreground"
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
        placeholder={placeholder}
        className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
        data-testid={`${testIdPrefix}-input`}
      />
    </div>
  );
}

function OrderedListEditor({
  items, onChange, readOnly, testIdPrefix,
}: {
  items: string[];
  onChange: (next: string[]) => void;
  readOnly: boolean;
  testIdPrefix: string;
}) {
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  };

  if (items.length === 0) {
    return <p className="text-xs text-muted-foreground" data-testid={`${testIdPrefix}-empty`}>—</p>;
  }

  return (
    <ol className="space-y-1" data-testid={`${testIdPrefix}-list`}>
      {items.map((item, i) => (
        <li key={item} className="flex items-center justify-between gap-2 rounded-md border border-border px-2 py-1 text-sm">
          <span>{i + 1}. {item}</span>
          {readOnly ? null : (
            <span className="flex gap-1">
              <Button size="sm" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${item} up`}>↑</Button>
              <Button size="sm" variant="ghost" disabled={i === items.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${item} down`}>↓</Button>
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

export default function ContentRulesPage() {
  const { orgId, orgMemberships } = useDashboardContext();
  const currentRole = orgMemberships.find((o) => o.orgId === orgId)?.role ?? 'member';
  // story #3490(PO 決定 2026-09-05) — owner만이던 자격을 owner·admin으로(3471 계약
  // 정정, 채널 연결 화면과 동형 권한 폭).
  const canEditRules = currentRole === 'owner' || currentRole === 'admin';
  const t = useTranslations('contentRules');
  // PO REQUIRED②(2026-09-05, PR#3848 Design 재검) — 금액 형식 키(generationBudgetAmountKrw/
  // Usd)를 content·contentRules 두 네임스페이스에 중복 정의하면 한쪽만 고쳐지는 조용한
  // 갈림이 난다. 공용 네임스페이스(content, generation-budget-indicator.tsx·
  // generation-budget-exceeded-banner.tsx와 동일) 하나만 두고 이 화면은 그 네임스페이스로
  // 별도 t를 받아 formatMinorCurrency에만 쓴다.
  const tContent = useTranslations('content');
  const locale = useLocale();

  const [rules, setRules] = useState<ContentRules>(EMPTY_RULES);
  const [version, setVersion] = useState<number | null>(null);
  // story #3501(doc a0da40c9 §20-4) — 로드 시점 스냅샷(내 로컬 편집과 별개). 충돌
  // 진단 두 목록을 계산하는 기준선 — «로드값」이지 「지금 화면값」이 아니다.
  const [loadedRules, setLoadedRules] = useState<ContentRules>(EMPTY_RULES);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saveSuccess, setSaveSuccess] = useState(false);
  // story #3501(doc a0da40c9 §20) — 409 충돌 상태. null이 아니면 저장 버튼은
  // 비활성(§20-5, «상태» 축 — 다시 불러오면 풀린다).
  const [conflict, setConflict] = useState<VersionConflictState | null>(null);
  // §20-3 "되돌린 뒤에도 그 이름 목록을 한 줄 남긴다" — 다시 불러오기 직후에만 보인다.
  const [justRolledBackFields, setJustRolledBackFields] = useState<string[] | null>(null);
  // story #3500 — 잔량은 규칙 저장과 별개 왕복(계산값, `rules.generation_budget`은
  // 정책 설정값). 실패해도 규칙 화면 자체를 막지 않는다(§3-2 "모른다≠0").
  const [budget, setBudget] = useState<GenerationBudgetState>({ status: 'loading' });

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/content-rules`);
      if (!res.ok) { setLoadError(true); return; }
      const json = (await res.json().catch(() => null)) as { data?: ContentRulesResponse } | null;
      if (json?.data) {
        const merged = {
          ...EMPTY_RULES,
          ...json.data.rules,
          brand_kit: json.data.rules.brand_kit ?? {},
          generation_budget: json.data.rules.generation_budget ?? null,
        };
        setRules(merged);
        setLoadedRules(merged);
        setVersion(json.data.version);
      }
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    fetchWithAuth(`/api/organizations/${orgId}/generation-budget`)
      .then(async (r) => {
        if (cancelled) return;
        if (!r.ok) { setBudget({ status: 'failed' }); return; }
        const json = (await r.json().catch(() => null)) as
          | { data?: { limit_minor: number | null; spent_minor: number; remaining_minor: number | null; currency: 'KRW' | 'USD' | null; period: 'month' } }
          | null;
        if (!json?.data) { setBudget({ status: 'failed' }); return; }
        setBudget({
          status: 'ok',
          limitMinor: json.data.limit_minor,
          spentMinor: json.data.spent_minor,
          remainingMinor: json.data.remaining_minor,
          currency: json.data.currency,
          period: json.data.period,
        });
      })
      .catch(() => { if (!cancelled) setBudget({ status: 'failed' }); });
    return () => { cancelled = true; };
  }, [orgId]);

  const handleSave = useCallback(async () => {
    if (version === null) return;
    setSaving(true);
    setSaveError(null);
    setFieldErrors({});
    setSaveSuccess(false);
    setJustRolledBackFields(null);
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/content-rules`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules, expected_version: version }),
      });
      if (res.ok) {
        const json = (await res.json().catch(() => null)) as { data?: ContentRulesResponse } | null;
        if (json?.data) {
          const merged = {
            ...EMPTY_RULES,
            ...json.data.rules,
            brand_kit: json.data.rules.brand_kit ?? {},
            generation_budget: json.data.rules.generation_budget ?? null,
          };
          setRules(merged);
          setLoadedRules(merged);
          setVersion(json.data.version);
          setSaveSuccess(true);
          setConflict(null);
        }
      } else if (res.status === 409) {
        // story #3501(doc a0da40c9 §20-2·§20-4) — 409 detail은 current_version+
        // updated_by만 준다(rules 실물은 없음) — 두 목록을 계산하려면 별도 GET이
        // 필요하다(§20-4 "화면이 이미 가진 것"은 로드값·로컬값 둘, 새 서버값은
        // 이 GET으로 얻는다).
        const body = (await res.json().catch(() => null)) as ContentRulesErrorBody | null;
        const freshRes = await fetchWithAuth(`/api/organizations/${orgId}/content-rules`);
        const freshJson = freshRes.ok
          ? ((await freshRes.json().catch(() => null)) as { data?: ContentRulesResponse } | null)
          : null;
        if (freshJson?.data) {
          const freshServerRules = {
            ...EMPTY_RULES,
            ...freshJson.data.rules,
            brand_kit: freshJson.data.rules.brand_kit ?? {},
            generation_budget: freshJson.data.rules.generation_budget ?? null,
          };
          const priorChangedFields = diffFieldNames(loadedRules, freshServerRules);
          const myChangedFields = diffFieldNames(loadedRules, rules);
          const overlap = new Set(priorChangedFields.filter((f) => myChangedFields.includes(f)));
          setConflict({
            updatedByName: body?.error?.updated_by?.name ?? null,
            priorChangedFields: withOverlapFirst(priorChangedFields, overlap),
            myChangedFields: withOverlapFirst(myChangedFields, overlap),
            freshServerRules,
            freshServerVersion: freshJson.data.version,
          });
        } else {
          // 재조회 자체가 실패하면 목록 없이도 최소한 "바뀌었다"는 사실은 전한다
          // (§20-2 — 화면이 아는 것만 말한다, 지어내지 않는다).
          setConflict({
            updatedByName: body?.error?.updated_by?.name ?? null,
            priorChangedFields: [], myChangedFields: [],
            freshServerRules: loadedRules, freshServerVersion: body?.error?.current_version ?? version,
          });
        }
      } else {
        const body = (await res.json().catch(() => null)) as ContentRulesErrorBody | null;
        const code = body?.error?.code;
        const field = body?.error?.field;
        if (code === 'CONTENT_RULES_INVALID' && field) {
          setFieldErrors({ [field]: t('errorInvalidField') });
        } else if (code === 'CONTENT_RULES_ADMIN_ONLY') {
          setSaveError(t('errorOwnerOnly'));
        } else if (code === 'CONTENT_RULES_INVALID') {
          setSaveError(t('errorInvalid'));
        } else {
          setSaveError(t('saveFailed'));
        }
      }
    } catch {
      setSaveError(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }, [orgId, rules, loadedRules, version, t]);

  // story #3501(doc a0da40c9 §20-3) — "자동 병합은 하지 않는다·말없이 버리지도
  // 않는다" — 서버 값으로 갈아끼우고, 되돌린 필드 이름을 한 줄 남긴다.
  const handleReloadAfterConflict = useCallback(() => {
    if (!conflict) return;
    setRules(conflict.freshServerRules);
    setLoadedRules(conflict.freshServerRules);
    setVersion(conflict.freshServerVersion);
    setJustRolledBackFields(conflict.myChangedFields);
    setConflict(null);
  }, [conflict]);

  const fieldLabel = useCallback(
    (key: string) => (FIELD_LABEL_KEYS[key] ? t(FIELD_LABEL_KEYS[key]) : key),
    [t],
  );

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold text-foreground">{t('pageTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('pageDescription')}</p>
      </div>

      {/* doc a0da40c9 §20-1(유나 2026-09-05 정정) — 자리를 "무엇에 대한 말인가"로
          가른다: 화면이 못 서는 실패(로드 실패)만 맨 위, "내가 누른 것의 답"
          (저장 성공·실패·충돌)은 저장 버튼 곁으로 내린다(§19-8 422 배너와 같은
          규율). */}
      {loadError ? (
        <Alert variant="destructive" role="alert" aria-live="assertive" aria-atomic="true">
          <AlertDescription>{t('loadFailed')}</AlertDescription>
        </Alert>
      ) : null}
      {!canEditRules ? (
        <p className="text-xs text-muted-foreground" data-testid="content-rules-readonly-reason">{t('readOnlyReason')}</p>
      ) : null}

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <div key={i} className="h-16 animate-pulse rounded-md bg-muted" />)}
        </div>
      ) : (
        <>
          <SectionCard>
            <SectionCardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-foreground">{t('sectionTitle')}</h2>
                {version !== null ? <span className="text-xs text-muted-foreground" data-testid="content-rules-version">{t('versionLabel', { version })}</span> : null}
              </div>
            </SectionCardHeader>
            <SectionCardBody className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">{t('bannedTermsLabel')}</label>
                <TagListEditor
                  items={rules.banned_terms}
                  onChange={(next) => setRules((r) => ({ ...r, banned_terms: next }))}
                  readOnly={!canEditRules}
                  placeholder={t('bannedTermsPlaceholder')}
                  testIdPrefix="content-rules-banned-terms"
                />
                {fieldErrors.banned_terms ? <p className="text-xs text-destructive">{fieldErrors.banned_terms}</p> : null}
              </div>

              <div className="space-y-1.5">
                {/* 카디르군 REQUEST_CHANGES(2026-09-05, PR#3827) — disabled={!canEditRules}는
                    "살아 있는" 컨트롤(탭 순서·스크린리더가 여전히 체크박스로 읽는다)이라
                    AC "편집 컨트롤이 없다"를 안 지킨다. 나머지 4필드(TagListEditor)와
                    같은 원칙으로 읽기 전용 텍스트로 바꾼다. */}
                {canEditRules ? (
                  <label className="flex items-center gap-2 text-sm text-foreground">
                    <input
                      type="checkbox"
                      checked={rules.require_utm}
                      onChange={(e) => setRules((r) => ({ ...r, require_utm: e.target.checked }))}
                      data-testid="content-rules-require-utm"
                    />
                    {t('requireUtmLabel')}
                  </label>
                ) : (
                  <p className="text-sm text-foreground">
                    <span className="text-xs font-medium text-muted-foreground">{t('requireUtmLabel')}</span>{' '}
                    <span data-testid="content-rules-require-utm-readonly">
                      {rules.require_utm ? t('requireUtmOnLabel') : t('requireUtmOffLabel')}
                    </span>
                  </p>
                )}
                <p className="text-xs text-muted-foreground">{t('requireUtmHint')}</p>
                {fieldErrors.require_utm ? <p className="text-xs text-destructive">{fieldErrors.require_utm}</p> : null}
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="content-rules-tone">{t('toneLabel')}</label>
                {canEditRules ? (
                  <input
                    id="content-rules-tone"
                    type="text"
                    value={rules.tone ?? ''}
                    onChange={(e) => setRules((r) => ({ ...r, tone: e.target.value || null }))}
                    placeholder={t('tonePlaceholder')}
                    className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                  />
                ) : (
                  <p className="text-sm text-foreground" data-testid="content-rules-tone-readonly">{rules.tone || '—'}</p>
                )}
                {fieldErrors.tone ? <p className="text-xs text-destructive">{fieldErrors.tone}</p> : null}
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">{t('taxonomyLabel')}</label>
                <TagListEditor
                  items={rules.taxonomy}
                  onChange={(next) => setRules((r) => ({ ...r, taxonomy: next }))}
                  readOnly={!canEditRules}
                  placeholder={t('taxonomyPlaceholder')}
                  testIdPrefix="content-rules-taxonomy"
                />
                {fieldErrors.taxonomy ? <p className="text-xs text-destructive">{fieldErrors.taxonomy}</p> : null}
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">{t('channelPriorityLabel')}</label>
                {canEditRules ? (
                  <TagListEditor
                    items={rules.channel_priority}
                    onChange={(next) => setRules((r) => ({ ...r, channel_priority: next }))}
                    readOnly={false}
                    placeholder={t('channelPriorityPlaceholder')}
                    testIdPrefix="content-rules-channel-priority-add"
                  />
                ) : null}
                <OrderedListEditor
                  items={rules.channel_priority}
                  onChange={(next) => setRules((r) => ({ ...r, channel_priority: next }))}
                  readOnly={!canEditRules}
                  testIdPrefix="content-rules-channel-priority"
                />
                {fieldErrors.channel_priority ? <p className="text-xs text-destructive">{fieldErrors.channel_priority}</p> : null}
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="content-rules-brand-logo">{t('brandKitLogoLabel')}</label>
                {canEditRules ? (
                  <input
                    id="content-rules-brand-logo"
                    type="text"
                    value={rules.brand_kit.logo_url ?? ''}
                    onChange={(e) => setRules((r) => ({ ...r, brand_kit: { ...r.brand_kit, logo_url: e.target.value || undefined } }))}
                    placeholder={t('brandKitLogoPlaceholder')}
                    className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                  />
                ) : (
                  <p className="text-sm text-foreground" data-testid="content-rules-brand-logo-readonly">{rules.brand_kit.logo_url || '—'}</p>
                )}
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">{t('brandKitColorsLabel')}</label>
                <TagListEditor
                  items={rules.brand_kit.colors ?? []}
                  onChange={(next) => setRules((r) => ({ ...r, brand_kit: { ...r.brand_kit, colors: next } }))}
                  readOnly={!canEditRules}
                  placeholder={t('brandKitColorsPlaceholder')}
                  testIdPrefix="content-rules-brand-colors"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">{t('brandKitFontsLabel')}</label>
                <TagListEditor
                  items={rules.brand_kit.fonts ?? []}
                  onChange={(next) => setRules((r) => ({ ...r, brand_kit: { ...r.brand_kit, fonts: next } }))}
                  readOnly={!canEditRules}
                  placeholder={t('brandKitFontsPlaceholder')}
                  testIdPrefix="content-rules-brand-fonts"
                />
                {fieldErrors.brand_kit ? <p className="text-xs text-destructive">{fieldErrors.brand_kit}</p> : null}
              </div>
            </SectionCardBody>
          </SectionCard>

          {/* story #3500(BE #3498, PO 確定·doc a0da40c9 §19 디자인 유나 確定 2026-09-05
              — BE 미착지, 계약만 고정) — 생성 비용 한도는 별도 카드(§19-2: 저장되는
              정책값과 관찰되는 계산값 — 잔량 — 은 카드 몸통을 안 섞는다). 헤더 좌측=
              제목, 우측=잔량 3값(GenerationBudgetIndicator full). limit_minor 입력을
              비우면 generation_budget 전체가 null(정책 미설정)로 저장된다 — 0을
              넣으면 "정지"(다른 값, §19-3). 입력/표시는 전부 큰단위(major)이고
              분단위(minor) 변환은 generation-budget-indicator.tsx 한 곳에서만 한다
              (§19-1 — KRW·USD 소수 자릿수가 달라 하드코딩 /100은 조용한 결함이 된다). */}
          <SectionCard>
            <SectionCardHeader>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-foreground">{t('generationBudgetSectionTitle')}</h2>
                <GenerationBudgetIndicator state={budget} variant="full" />
              </div>
            </SectionCardHeader>
            <SectionCardBody className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="content-rules-generation-budget-limit">
                  {tContent('generationBudgetLimitLabel')}
                </label>
                {canEditRules ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <input
                      id="content-rules-generation-budget-limit"
                      type="number"
                      min={0}
                      step={1}
                      value={
                        rules.generation_budget
                          ? minorToMajor(rules.generation_budget.limit_minor, rules.generation_budget.currency)
                          : ''
                      }
                      onChange={(e) => {
                        const raw = e.target.value;
                        if (raw === '') {
                          setRules((r) => ({ ...r, generation_budget: null }));
                          return;
                        }
                        const majorValue = Number(raw);
                        if (!Number.isFinite(majorValue) || majorValue < 0) return;
                        setRules((r) => {
                          const currency = r.generation_budget?.currency ?? 'KRW';
                          return {
                            ...r,
                            generation_budget: { limit_minor: majorToMinor(majorValue, currency), currency, period: 'month' },
                          };
                        });
                      }}
                      placeholder={t('generationBudgetLimitPlaceholder')}
                      className="w-32 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                      data-testid="content-rules-generation-budget-limit"
                    />
                    {rules.generation_budget ? (
                      <select
                        value={rules.generation_budget.currency}
                        onChange={(e) => setRules((r) => {
                          if (!r.generation_budget) return r;
                          const nextCurrency = e.target.value as GenerationBudgetCurrency;
                          // 통화를 바꾸면 큰단위 값은 유지하고(사람이 입력한 숫자 자체는
                          // 안 바뀐다) 분단위만 새 exponent로 재계산한다.
                          const majorValue = minorToMajor(r.generation_budget.limit_minor, r.generation_budget.currency);
                          return {
                            ...r,
                            generation_budget: { limit_minor: majorToMinor(majorValue, nextCurrency), currency: nextCurrency, period: 'month' },
                          };
                        })}
                        className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                        data-testid="content-rules-generation-budget-currency"
                      >
                        <option value="KRW">KRW</option>
                        <option value="USD">USD</option>
                      </select>
                    ) : null}
                  </div>
                ) : rules.generation_budget === null ? (
                  <p className="text-sm text-foreground" data-testid="content-rules-generation-budget-readonly">{t('generationBudgetNotSet')}</p>
                ) : rules.generation_budget.limit_minor === 0 ? (
                  <p className="text-sm text-foreground" data-testid="content-rules-generation-budget-readonly">{t('generationBudgetSuspendedReadonly')}</p>
                ) : (
                  <p className="text-sm text-foreground" data-testid="content-rules-generation-budget-readonly">
                    {formatMinorCurrency(rules.generation_budget.limit_minor, rules.generation_budget.currency, locale, tContent)}
                  </p>
                )}
                {fieldErrors.generation_budget ? <p className="text-xs text-destructive">{fieldErrors.generation_budget}</p> : null}
              </div>

              {/* §19-6 정정 — 기간은 "월" 하나뿐이라 select 아닌 고정 텍스트(이 코드베이스
                  관례 — 선택지 하나짜리 select를 안 쓴다). */}
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">{t('generationBudgetPeriodLabel')}</label>
                <p className="text-sm text-foreground" data-testid="content-rules-generation-budget-period">{tContent('generationBudgetPeriodMonth')}</p>
              </div>

              <p className="text-xs text-muted-foreground">{t('generationBudgetHint')}</p>
            </SectionCardBody>
          </SectionCard>

          {/* PO 재정정(2026-09-05, PR#3848 유나 재검) — 저장 버튼은 «카드 밖»이어야
              한다(어느 SectionCard에도 속하지 않는 페이지 수준). 첫 재배치가 규칙
              카드 안(L456-460 옛 자리)에 남아 있던 게 틀렸다 — 부분 PATCH가 없어
              이 한 버튼이 두 카드(규칙+생성비용한도) 전체를 함께 저장한다는 사실을
              자리 자체가 말해야 한다.
              doc a0da40c9 §20-1 — "내가 누른 것의 답"(성공·실패·충돌)은 이 버튼 곁에. */}
          {canEditRules ? (
            <div className="space-y-2">
              {conflict ? (
                // §20-2·§20-5 — 충돌 배너는 destructive(§19-8과 같은 톤), 저장 버튼은
                // «상태» 비활성(다시 불러오면 풀린다 — 3653a18c §2 표대로 안 그림이
                // 아니라 비활성+사유는 버튼 밖).
                <Alert variant="destructive" role="alert" aria-live="assertive" aria-atomic="true" data-testid="content-rules-version-conflict">
                  <AlertDescription>
                    <span className="block">
                      {conflict.updatedByName
                        ? t('versionConflictFactWithName', { name: conflict.updatedByName })
                        : t('versionConflictFact')}
                    </span>
                    {conflict.priorChangedFields.length > 0 ? (
                      <span className="mt-1 block text-xs">
                        {t('versionConflictPriorChanged', { list: conflict.priorChangedFields.map(fieldLabel).join(', ') })}
                      </span>
                    ) : null}
                    {conflict.myChangedFields.length > 0 ? (
                      <span className="mt-1 block text-xs">
                        {t('versionConflictMyChanges', { list: conflict.myChangedFields.map(fieldLabel).join(', ') })}
                      </span>
                    ) : null}
                  </AlertDescription>
                </Alert>
              ) : null}
              {saveError ? (
                <Alert variant="destructive" role="alert" aria-live="assertive" aria-atomic="true">
                  <AlertDescription>{saveError}</AlertDescription>
                </Alert>
              ) : null}
              {saveSuccess && version !== null ? (
                <Alert variant="success" role="status" aria-live="polite" aria-atomic="true">
                  <AlertDescription>{t('saveSuccess', { version })}</AlertDescription>
                </Alert>
              ) : null}
              {justRolledBackFields && justRolledBackFields.length > 0 ? (
                <p className="text-xs text-muted-foreground" data-testid="content-rules-rolled-back-note">
                  {t('versionConflictRolledBack', { list: justRolledBackFields.map(fieldLabel).join(', ') })}
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="sm" onClick={() => void handleSave()} disabled={saving || conflict !== null}
                  data-testid="content-rules-save-button"
                >
                  {saving ? t('savingCta') : t('saveAction')}
                </Button>
                {conflict ? (
                  <Button size="sm" variant="outline" onClick={handleReloadAfterConflict} data-testid="content-rules-reload-button">
                    {t('versionConflictReloadAction')}
                  </Button>
                ) : null}
                {conflict ? (
                  <span className="text-xs text-muted-foreground" data-testid="content-rules-save-disabled-reason">
                    {t('versionConflictSaveDisabledReason')}
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
