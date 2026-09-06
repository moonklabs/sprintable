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

// story #3540(BE #3506, PO 確定 2026-09-06 — 「성과 수집」 UTM 구멍 처방) — UTM
// 자동 부착 정책값. 지금까지 이 화면 어디에도 편집 자리가 없어(build_tagged_link이
// 실제로 쓰는 값인데도) 「어디서 바꾸나」가 거짓이던 갭 — content_rules.py::UtmRules
// 모델 그대로(신규 필드 0). default_source/default_medium 빈 문자열=「안 정함」
// (어댑터 하드코딩 그대로 쓰겠다는 뜻, null로 저장 — generation_budget 빈 입력=null
// 관례와 동형).
interface UtmRules {
  enabled: boolean;
  default_source: string | null;
  default_medium: string | null;
  campaign_from: 'campaign_slug' | 'draft_id';
  content_from: 'draft_id' | 'none';
}

interface ContentRules {
  banned_terms: string[];
  require_utm: boolean;
  tone: string | null;
  taxonomy: string[];
  channel_priority: string[];
  brand_kit: BrandKit;
  generation_budget: GenerationBudget | null;
  utm_rules: UtmRules | null;
}

interface ContentRulesResponse {
  org_id: string;
  rules: ContentRules;
  version: number;
}

const EMPTY_RULES: ContentRules = {
  banned_terms: [], require_utm: false, tone: null, taxonomy: [], channel_priority: [], brand_kit: {},
  generation_budget: null, utm_rules: null,
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
  utm_rules: 'utmRulesSectionTitle',
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

// story #3532(PO 確定③ 재대조 2026-09-06) — 값이 CSS 색으로 안 읽히면 스와치
// 없이 문자열 그대로(형식 검증은 범위 밖·강제 변환·오류 표시 0, 그냥 스와치를
// 안 그린다). DOM에 실제로 대입해 브라우저 자체의 판정을 그대로 쓴다(직접
// 정규식을 짜서 CSS 색 문법을 재구현하지 않는다 — named color("rebeccapurple")·
// hsl()·rgb() 등 전부를 브라우저가 이미 안다).
function isValidCssColor(value: string): boolean {
  if (typeof document === 'undefined') return false;
  const probe = document.createElement('div');
  probe.style.color = '';
  probe.style.color = value;
  return probe.style.color !== '';
}

// story #3532(유나 §23, PO 確定 2026-09-06) — 색 칩에 실제 색 스와치를 보인다(색
// 코드를 적어 두기만 해서는 맞는 색인지 아무도 확인 못 한다 — 로고 미리보기와 같은
// 취지). banned_terms·taxonomy·channel_priority는 그대로(색 스와치가 뜻이 없는
// 자리라 variant='default'가 기본).
// story #3436 묶음11(유나 §17-20류 낱말, 페드루 PO 確定 2026-09-06) — 이 제거
// 버튼의 접근성 이름이 하드코딩 영문(`Remove ${item}`)이라 한국어 화면에서도
// 스크린리더가 영어로 읽었다(§17-20 낱말 축과 같은 클래스 — dep.remove
// 「의존 관계 제거」 선례와 동형 형태 「{item} 제거」/`Remove {item}`).
function TagChip({ item, variant, onRemove, t }: { item: string; variant: 'default' | 'color'; onRemove?: () => void; t: ReturnType<typeof useTranslations> }) {
  const showSwatch = variant === 'color' && isValidCssColor(item);
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-foreground">
      {showSwatch ? (
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full border border-border"
          style={{ backgroundColor: item }}
          aria-hidden="true"
          data-testid="content-rules-brand-color-swatch"
        />
      ) : null}
      {item}
      {onRemove ? (
        <button type="button" onClick={onRemove} aria-label={t('removeItemAction', { item })} className="text-muted-foreground hover:text-foreground">
          ×
        </button>
      ) : null}
    </span>
  );
}

function TagListEditor({
  items, onChange, readOnly, placeholder, testIdPrefix, variant = 'default', emptyText = '—', t,
}: {
  items: string[];
  onChange: (next: string[]) => void;
  readOnly: boolean;
  placeholder: string;
  testIdPrefix: string;
  // story #3532 — 색 스와치 렌더 축(기본은 지금처럼 텍스트뿐).
  variant?: 'default' | 'color';
  // story #3532(PO 確定⑤) — 「—」는 이 제품에서 «모른다·못 잰다»는 뜻으로 이미 쓰는
  // 글자라, 브랜드 킷처럼 "아직 정하지 않았다"는 다른 사실엔 다른 문구가 맞다.
  // 기본값은 기존 호출부(banned_terms 등) 회귀 0을 위해 '—' 그대로 유지.
  emptyText?: string;
  t: ReturnType<typeof useTranslations>;
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
      <p className="text-xs text-muted-foreground" data-testid={`${testIdPrefix}-empty`}>{emptyText}</p>
    ) : (
      <div className="flex flex-wrap gap-1.5" data-testid={`${testIdPrefix}-readonly`}>
        {items.map((item) => <TagChip key={item} item={item} variant={variant} t={t} />)}
      </div>
    );
  }

  return (
    <div className="space-y-1.5" data-testid={`${testIdPrefix}-editor`}>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <TagChip key={item} item={item} variant={variant} onRemove={() => onChange(items.filter((x) => x !== item))} t={t} />
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

// story #3532(PO 確定②, 유나 §23) — 로고 URL 미리보기 1장. url이 없으면 자리
// 자체를 안 그린다("안 정함" 문구는 위 readonly 텍스트가 이미 말한다 — 여기서
// 한 번 더 말하지 않는다). key={url}로 새 URL마다 컴포넌트를 새로 마운트해
// 에러 상태를 자동으로 초기화한다(이전 URL의 실패가 새 URL에 들러붙지 않는다).
function BrandLogoPreview({ url, t }: { url?: string; t: ReturnType<typeof useTranslations> }) {
  const [failed, setFailed] = useState(false);
  if (!url) return null;
  if (failed) {
    return <p className="text-xs text-muted-foreground" data-testid="content-rules-brand-logo-preview-failed">{t('brandKitLogoLoadFailed')}</p>;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- story #3532: 임의 외부 URL(고객이 붙여넣은 값, next/image 최적화 대상 밖).
    <img
      src={url}
      alt={t('brandKitLogoPreviewAlt')}
      className="h-12 w-12 rounded border border-border object-contain"
      data-testid="content-rules-brand-logo-preview"
      onError={() => setFailed(true)}
    />
  );
}

function OrderedListEditor({
  items, onChange, readOnly, testIdPrefix, t,
}: {
  items: string[];
  onChange: (next: string[]) => void;
  readOnly: boolean;
  testIdPrefix: string;
  t: ReturnType<typeof useTranslations>;
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
              <Button size="sm" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t('moveItemUpAction', { item })}>↑</Button>
              <Button size="sm" variant="ghost" disabled={i === items.length - 1} onClick={() => move(i, 1)} aria-label={t('moveItemDownAction', { item })}>↓</Button>
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
          utm_rules: json.data.rules.utm_rules ?? null,
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
            utm_rules: json.data.rules.utm_rules ?? null,
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
            utm_rules: freshJson.data.rules.utm_rules ?? null,
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
                  testIdPrefix="content-rules-banned-terms" t={t}
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

              {/* story #3540(BE #3506, PO 確定 2026-09-06) — utm_rules 편집 자리. 지금까지
                  이 화면 어디에도 없어(build_tagged_link이 실제로 쓰는 값인데도) 「어디서
                  바꾸나」가 거짓이던 갭. require_utm 곁에(같은 카드, 별도 SectionCard
                  아님). enabled=false(또는 utm_rules 자체가 null)면 나머지 4필드는 안
                  그린다(꺼져 있으면 값이 무의미 — generation_budget의 "정책 없으면 통화
                  select 숨김"과 동형 관례). default_source/default_medium 빈 입력=null
                  ("안 정함", 어댑터 하드코딩 그대로 — build_tagged_link 계약 그대로). */}
              <div className="space-y-1.5">
                <h3 className="text-xs font-medium text-muted-foreground">{t('utmRulesSectionTitle')}</h3>
                {canEditRules ? (
                  <label className="flex items-center gap-2 text-sm text-foreground">
                    <input
                      type="checkbox"
                      checked={rules.utm_rules?.enabled ?? false}
                      onChange={(e) => setRules((r) => ({
                        ...r,
                        utm_rules: e.target.checked
                          ? {
                              enabled: true,
                              default_source: r.utm_rules?.default_source ?? null,
                              default_medium: r.utm_rules?.default_medium ?? null,
                              campaign_from: r.utm_rules?.campaign_from ?? 'campaign_slug',
                              content_from: r.utm_rules?.content_from ?? 'draft_id',
                            }
                          : (r.utm_rules ? { ...r.utm_rules, enabled: false } : null),
                      }))}
                      data-testid="content-rules-utm-rules-enabled"
                    />
                    {t('utmRulesEnabledLabel')}
                  </label>
                ) : (
                  <p className="text-sm text-foreground">
                    <span className="text-xs font-medium text-muted-foreground">{t('utmRulesEnabledLabel')}</span>{' '}
                    <span data-testid="content-rules-utm-rules-enabled-readonly">
                      {rules.utm_rules?.enabled ? t('utmRulesEnabledOnLabel') : t('utmRulesEnabledOffLabel')}
                    </span>
                  </p>
                )}
                <p className="text-xs text-muted-foreground">{t('utmRulesEnabledHint')}</p>
                {rules.utm_rules?.enabled ? (
                  <div className="space-y-3 rounded-md border border-border p-3">
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground" htmlFor="content-rules-utm-default-source">
                        {t('utmRulesDefaultSourceLabel')}
                      </label>
                      {canEditRules ? (
                        <input
                          id="content-rules-utm-default-source"
                          type="text"
                          value={rules.utm_rules.default_source ?? ''}
                          onChange={(e) => setRules((r) => (r.utm_rules ? {
                            ...r, utm_rules: { ...r.utm_rules, default_source: e.target.value || null },
                          } : r))}
                          placeholder={t('utmRulesDefaultSourcePlaceholder')}
                          className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                          data-testid="content-rules-utm-default-source"
                        />
                      ) : (
                        <p className="text-sm text-foreground" data-testid="content-rules-utm-default-source-readonly">
                          {rules.utm_rules.default_source ?? t('utmRulesNotSetValue')}
                        </p>
                      )}
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground" htmlFor="content-rules-utm-default-medium">
                        {t('utmRulesDefaultMediumLabel')}
                      </label>
                      {canEditRules ? (
                        <input
                          id="content-rules-utm-default-medium"
                          type="text"
                          value={rules.utm_rules.default_medium ?? ''}
                          onChange={(e) => setRules((r) => (r.utm_rules ? {
                            ...r, utm_rules: { ...r.utm_rules, default_medium: e.target.value || null },
                          } : r))}
                          placeholder={t('utmRulesDefaultMediumPlaceholder')}
                          className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                          data-testid="content-rules-utm-default-medium"
                        />
                      ) : (
                        <p className="text-sm text-foreground" data-testid="content-rules-utm-default-medium-readonly">
                          {rules.utm_rules.default_medium ?? t('utmRulesNotSetValue')}
                        </p>
                      )}
                    </div>
                    <div className="space-y-1.5">
                      {/* 페드루 PO REQUIRED②(2026-09-06, #3892 리뷰) — campaign_from은
                          content_rules.py::UtmRules docstring(:71-74) 그대로 "순수
                          서술용"(실 campaign 해소는 여전히 resolve_utm_campaign()의
                          기존 규칙, 이 필드가 뭐든 동작 무변경) — select를 두면 눌러도
                          아무것도 안 바뀌는 죽은 컨트롤이 된다. 편집 제거·고정 안내
                          한 줄만(값은 로드값 그대로 보존해 저장 — 지어내지 않는다).
                          content_from은 실제로 동작하므로(build_tagged_link) 그대로
                          select 유지. */}
                      <p className="text-xs text-muted-foreground" data-testid="content-rules-utm-campaign-from-fixed-note">
                        {t('utmRulesCampaignFromFixedNote')}
                      </p>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-muted-foreground" htmlFor="content-rules-utm-content-from">
                        {t('utmRulesContentFromLabel')}
                      </label>
                      {canEditRules ? (
                        <select
                          id="content-rules-utm-content-from"
                          value={rules.utm_rules.content_from}
                          onChange={(e) => setRules((r) => (r.utm_rules ? {
                            ...r,
                            utm_rules: { ...r.utm_rules, content_from: e.target.value as UtmRules['content_from'] },
                          } : r))}
                          className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                          data-testid="content-rules-utm-content-from"
                        >
                          <option value="draft_id">{t('utmRulesContentFromDraftId')}</option>
                          <option value="none">{t('utmRulesContentFromNone')}</option>
                        </select>
                      ) : (
                        <p className="text-sm text-foreground" data-testid="content-rules-utm-content-from-readonly">
                          {rules.utm_rules.content_from === 'draft_id'
                            ? t('utmRulesContentFromDraftId')
                            : t('utmRulesContentFromNone')}
                        </p>
                      )}
                    </div>
                  </div>
                ) : null}
                {fieldErrors.utm_rules ? <p className="text-xs text-destructive">{fieldErrors.utm_rules}</p> : null}
              </div>

              {/* story #3532(유나 §23, PO 確定 2026-09-06) — 아래 네 필드(tone·taxonomy·
                  channel_priority·brand_kit)는 기계 검사 소비처가 0이다(banned_terms·
                  require_utm 둘만 실제로 검사된다) — 그런데 같은 입력칸 모양으로 나란히
                  서 있어 "적어 두면 강제된다"로 읽힌다. 묶음 위에 한 번만(항목마다
                  반복 X) 약속의 크기를 줄이는 문장 — 명령형("지키세요") 금지, 이 문구가
                  거짓이 되는 날(실제 lint 축이 생기는 날)이 삭제 조건. 페드루 PO
                  明示(2026-09-06, #3892 리뷰) — utm_rules 섹션이 이 문장 위(#3540
                  편집 폼은 그 자체가 검사 대상이 아니라 이 광고문 묶음과 무관). */}
              <p className="text-xs text-muted-foreground" data-testid="content-rules-advisory-notice">
                {t('contentRulesAdvisoryNotice')}
              </p>

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
                  testIdPrefix="content-rules-taxonomy" t={t}
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
                    testIdPrefix="content-rules-channel-priority-add" t={t}
                  />
                ) : null}
                <OrderedListEditor
                  items={rules.channel_priority}
                  onChange={(next) => setRules((r) => ({ ...r, channel_priority: next }))}
                  readOnly={!canEditRules}
                  testIdPrefix="content-rules-channel-priority"
                  t={t}
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
                  <p className="text-sm text-foreground" data-testid="content-rules-brand-logo-readonly">
                    {rules.brand_kit.logo_url || t('contentRulesNotSetLabel')}
                  </p>
                )}
                {/* story #3532(PO 確定②) — URL만 적어 두면 오타·죽은 링크가 그대로 "정본"
                    행세를 한다(아무도 못 본다) — 편집·읽기 두 모드 다 실물 1장을
                    보여준다. 로드 실패는 <img onError>로 잡아 "불러오지 못했습니다"로
                    바꾼다(깨진 이미지 아이콘을 그대로 두지 않는다). */}
                <BrandLogoPreview key={rules.brand_kit.logo_url ?? ''} url={rules.brand_kit.logo_url} t={t} />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">{t('brandKitColorsLabel')}</label>
                <TagListEditor
                  items={rules.brand_kit.colors ?? []}
                  onChange={(next) => setRules((r) => ({ ...r, brand_kit: { ...r.brand_kit, colors: next } }))}
                  readOnly={!canEditRules}
                  placeholder={t('brandKitColorsPlaceholder')}
                  testIdPrefix="content-rules-brand-colors"
                  variant="color"
                  emptyText={t('contentRulesNotSetLabel')} t={t}
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">{t('brandKitFontsLabel')}</label>
                {/* story #3532(PO 確定③, 유나 §23) — 폰트는 이름 그대로만 보인다. 웹폰트
                    로딩(구글 폰트 등) 시도 금지 — 고객 브랜드 폰트지 이 화면의 폰트가
                    아니다(로딩 시도 자체가 없다 — style/link 삽입 코드 0). */}
                <TagListEditor
                  items={rules.brand_kit.fonts ?? []}
                  onChange={(next) => setRules((r) => ({ ...r, brand_kit: { ...r.brand_kit, fonts: next } }))}
                  readOnly={!canEditRules}
                  placeholder={t('brandKitFontsPlaceholder')}
                  testIdPrefix="content-rules-brand-fonts"
                  emptyText={t('contentRulesNotSetLabel')} t={t}
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
