'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { ListRow } from '@/components/ui/list-row';
import { useToast } from '@/components/ui/toast';
import {
  formatMinorCurrency, majorToMinor, minorToMajor,
  type GenerationBudgetState, type GenerationBudgetCurrency,
} from '@/components/content/generation-budget-indicator';
import { formatScheduledAt, resolveDisplayTimezone } from '@/components/content/schedule-format';
import { fetchWithAuth } from '@/lib/db/client';

/**
 * story #3747(UI 재설계 ⑥, 유나 시안 e07f98c6 v3 — 구획 넷) — 「긴 폼 하나+저장 하나」를
 * 「규칙 목록 + 규칙마다 고치기」로. 행 = ListRow(#4090 신설) 재사용, 한 번에 한 행만
 * 펼침(페이지가 `expandedField` 하나만 소유, #3743과 동형 규율). sticky 저장 바 0 —
 * 행마다 「고치기/정하기」 눌러 인라인 폼 열고, 그 행만 즉시 PUT+반영.
 *
 * story #3490(PO 決定 2026-09-05, 3471 계약 정정) — PUT은 휴먼 owner **또는 admin**.
 *
 * story #3747(ⓐ, 페드루 PO 정정 2026-09-09) — 부분 갱신(PATCH) 신설은 철회됐다:
 * `org_content_rules`는 org당 1행·version 하나뿐이라 저장소가 «그 규칙만» 충돌인지
 * 구분 못 한다. 대신 기존 PUT(통짜)+#3501 §20-4 겹침 판정(`diffFieldNames`/
 * `withOverlapFirst`)을 재사용 — 행 하나를 저장할 때도 항상 `rules` 전체를 실어
 * 보내되, 409면 «내가 고친 필드가 서버측 변경과 겹치는지»로 갈라 겹치면 그 필드만
 * 충돌 배너, 안 겹치면 최신 버전으로 자동 재저장(사람 개입 없이 조용히 rebase).
 */
interface BrandKit {
  logo_url?: string;
  colors?: string[];
  fonts?: string[];
}

interface GenerationBudget {
  limit_minor: number;
  currency: 'KRW' | 'USD';
  period: 'month';
}

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

interface UpdatedBy {
  member_id: string;
  name: string | null;
}

interface ContentRulesResponse {
  org_id: string;
  rules: ContentRules;
  version: number;
  updated_at: string | null;
  updated_by: UpdatedBy | null;
}

const EMPTY_RULES: ContentRules = {
  banned_terms: [], require_utm: false, tone: null, taxonomy: [], channel_priority: [], brand_kit: {},
  generation_budget: null, utm_rules: null,
};

type FieldKey = keyof ContentRules;

// story #3501(doc a0da40c9 §20-4, 재사용) — "두 목록이 겹치는 필드가 «진짜 충돌»이다."
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

function mergeRulesResponse(rules: ContentRules): ContentRules {
  return {
    ...EMPTY_RULES,
    ...rules,
    brand_kit: rules.brand_kit ?? {},
    generation_budget: rules.generation_budget ?? null,
    utm_rules: rules.utm_rules ?? null,
  };
}

// story #3532(PO 確定③) — DOM 자체 판정을 쓴다(정규식으로 CSS 색 문법을 재구현 안 함).
function isValidCssColor(value: string): boolean {
  if (typeof document === 'undefined') return false;
  const probe = document.createElement('div');
  probe.style.color = '';
  probe.style.color = value;
  return probe.style.color !== '';
}

/** 행 값 슬롯에 쓰는 짧은 칩 — `<p>`(ListRow subtitle 래퍼) 안에 유효하도록 span만 쓴다. */
function InlineChip({ children, swatch }: { children: React.ReactNode; swatch?: string }) {
  const showSwatch = swatch !== undefined && isValidCssColor(swatch);
  return (
    <span className="mr-1 inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-border px-2 py-0.5 align-middle text-xs text-foreground">
      {showSwatch ? (
        <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full border border-border" style={{ backgroundColor: swatch }} aria-hidden="true" />
      ) : null}
      {children}
    </span>
  );
}

function StatusDot({ on }: { on: boolean }) {
  return (
    <span
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full align-middle ${on ? 'bg-success' : 'bg-muted-foreground'}`}
      aria-hidden="true"
    />
  );
}

function TagChip({ item, onRemove, swatch, t }: { item: string; onRemove?: () => void; swatch?: string; t: ReturnType<typeof useTranslations> }) {
  const showSwatch = swatch !== undefined && isValidCssColor(swatch);
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-foreground">
      {showSwatch ? (
        <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-border" style={{ backgroundColor: swatch }} aria-hidden="true" />
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
  items, onChange, placeholder, testIdPrefix, variant = 'default', t,
}: {
  items: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  testIdPrefix: string;
  variant?: 'default' | 'color';
  t: ReturnType<typeof useTranslations>;
}) {
  const [draft, setDraft] = useState('');
  const addTag = () => {
    const value = draft.trim();
    if (!value || items.includes(value)) { setDraft(''); return; }
    onChange([...items, value]);
    setDraft('');
  };
  return (
    <div className="space-y-1.5" data-testid={`${testIdPrefix}-editor`}>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <TagChip key={item} item={item} swatch={variant === 'color' ? item : undefined} onRemove={() => onChange(items.filter((x) => x !== item))} t={t} />
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

function OrderedListEditor({ items, onChange, testIdPrefix, t }: {
  items: string[]; onChange: (next: string[]) => void; testIdPrefix: string; t: ReturnType<typeof useTranslations>;
}) {
  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  };
  return (
    <ol className="space-y-1" data-testid={`${testIdPrefix}-list`}>
      {items.map((item, i) => (
        <li key={item} className="flex items-center justify-between gap-2 rounded-md border border-border px-2 py-1 text-sm">
          <span>{i + 1}. {item}</span>
          <span className="flex gap-1">
            <Button size="sm" variant="ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label={t('moveItemUpAction', { item })}>↑</Button>
            <Button size="sm" variant="ghost" disabled={i === items.length - 1} onClick={() => move(i, 1)} aria-label={t('moveItemDownAction', { item })}>↓</Button>
            <Button size="sm" variant="ghost" onClick={() => onChange(items.filter((x) => x !== item))} aria-label={t('removeItemAction', { item })}>×</Button>
          </span>
        </li>
      ))}
    </ol>
  );
}

function BrandLogoPreview({ url, t }: { url?: string; t: ReturnType<typeof useTranslations> }) {
  const [failed, setFailed] = useState(false);
  if (!url) return null;
  if (failed) {
    return <p className="text-xs text-muted-foreground" data-testid="content-rules-brand-logo-preview-failed">{t('brandKitLogoLoadFailed')}</p>;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- story #3532: 임의 외부 URL.
    <img
      src={url}
      alt={t('brandKitLogoPreviewAlt')}
      className="h-12 w-12 rounded border border-border object-contain"
      data-testid="content-rules-brand-logo-preview"
      onError={() => setFailed(true)}
    />
  );
}

// story #3747(ⓓ, 페드루 PO 確定) — 값이 없다=「안 정함」(그로시 "—"). 배열/문자열/객체
// 공용 판정 하나(호출부마다 `.length===0` 재작성 방지).
function hasFieldValue(field: FieldKey, rules: ContentRules): boolean {
  switch (field) {
    case 'banned_terms': case 'taxonomy': case 'channel_priority':
      return rules[field].length > 0;
    case 'tone':
      return !!rules.tone;
    case 'brand_kit':
      return !!(rules.brand_kit.logo_url || (rules.brand_kit.colors?.length ?? 0) > 0 || (rules.brand_kit.fonts?.length ?? 0) > 0);
    case 'utm_rules': case 'generation_budget':
      return rules[field] !== null;
    case 'require_utm':
      return true;
    default:
      return false;
  }
}

export default function ContentRulesPage() {
  const { orgId, orgMemberships, currentTeamMemberId } = useDashboardContext();
  const currentRole = orgMemberships.find((o) => o.orgId === orgId)?.role ?? 'member';
  const canEditRules = currentRole === 'owner' || currentRole === 'admin';
  const t = useTranslations('contentRules');
  const tContent = useTranslations('content');
  const locale = useLocale();
  const { addToast } = useToast();

  const [rules, setRules] = useState<ContentRules>(EMPTY_RULES);
  const [loadedRules, setLoadedRules] = useState<ContentRules>(EMPTY_RULES);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [updatedBy, setUpdatedBy] = useState<UpdatedBy | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [expandedField, setExpandedField] = useState<FieldKey | null>(null);
  const [savingField, setSavingField] = useState<FieldKey | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [conflictField, setConflictField] = useState<
    { field: FieldKey; updatedByName: string | null; updatedByMemberId: string | null; viaUndo: boolean } | null
  >(null);
  const [budget, setBudget] = useState<GenerationBudgetState>({ status: 'loading' });
  // story #3501(§20-3, 재사용) — 되돌리기(undo)용 직전 값 스냅샷(필드별 1개).
  const draftBeforeSave = useRef<Partial<ContentRules>>({});
  // 페드루 PO 라이브 결함(2026-09-09, 3747 배포 뒤 직접 왕복 발견) — 되돌리기 버튼의
  // onClick 클로저는 그 저장을 시작시킨 saveField 호출 안에서 만들어지므로, version을
  // state로 두면 그 호출 동안 클로저에 갇힌 **저장 前** 값을 그대로 들고 있다(React
  // state는 그 실행 안에서 스냅샷 — 리렌더로 안 바뀜). 되돌리기가 그 값으로 PUT하면
  // 방금 자신이 만든 저장 자체와 버전이 어긋나 항상 409. version은 렌더에 안 쓰이므로
  // (충돌 여부·성공/실패만 렌더에 영향) 아예 state가 아니라 ref로 — 모든 성공 응답에서
  // 즉시 갱신돼 항상 "그 시점 최신"이 보인다.
  const versionRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoadState('loading');
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/content-rules`);
      if (!res.ok) { setLoadState('error'); return; }
      const json = (await res.json().catch(() => null)) as { data?: ContentRulesResponse } | null;
      if (json?.data) {
        const merged = mergeRulesResponse(json.data.rules);
        setRules(merged);
        setLoadedRules(merged);
        versionRef.current = json.data.version;
        setUpdatedAt(json.data.updated_at);
        setUpdatedBy(json.data.updated_by);
        setLoadState('ready');
      } else {
        setLoadState('error');
      }
    } catch {
      setLoadState('error');
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

  // story #3747(ⓐ, 페드루 PO 정정) — 행 하나 저장. 항상 `rules` 전체를 PUT하되
  // (저장소가 필드 단위 CAS를 못 함) 409면 겹침으로 가른다: 내가 고친 필드가 서버측
  // 변경과 겹치면 그 필드만 충돌 배너(재시도 안 함) · 안 겹치면 최신 버전으로 조용히
  // 한 번 재저장(사람 개입 없이 자동 rebase).
  const saveField = useCallback(async (
    field: FieldKey, nextRules: ContentRules, previousValue: ContentRules[FieldKey], viaUndo = false,
  ) => {
    if (versionRef.current === null) return;
    setSavingField(field);
    setRowErrors((prev) => { const { [field]: _drop, ...rest } = prev; return rest; });
    // 되돌리기(undo)용 직전 값 스냅샷. field는 런타임에 실제 값과 짝이 맞지만
    // TS는 이 correlated-union 대입을 못 좁혀(field: FieldKey가 넓혀진 키라
    // Partial<ContentRules>[field]가 전체 값 유니온이 됨) — 값 자체는 그대로 쓰는.
    (draftBeforeSave.current as Record<FieldKey, ContentRules[FieldKey]>)[field] = previousValue;

    type AttemptOutcome = { status: 'ok'; rebased: boolean } | { status: 'conflict-mine' } | { status: 'error' };

    const attempt = async (body: ContentRules, expectedVersion: number, rebased: boolean): Promise<AttemptOutcome> => {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/content-rules`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules: body, expected_version: expectedVersion }),
      });
      if (res.ok) {
        const json = (await res.json().catch(() => null)) as { data?: ContentRulesResponse } | null;
        if (!json?.data) return { status: 'error' };
        const merged = mergeRulesResponse(json.data.rules);
        setRules(merged);
        setLoadedRules(merged);
        versionRef.current = json.data.version;
        setUpdatedAt(json.data.updated_at);
        setUpdatedBy(json.data.updated_by);
        setConflictField(null);
        return { status: 'ok', rebased };
      }
      if (res.status === 409) {
        const errBody = (await res.json().catch(() => null)) as
          { error?: { updated_by?: { member_id: string | null; name: string | null } | null } } | null;
        const freshRes = await fetchWithAuth(`/api/organizations/${orgId}/content-rules`);
        const freshJson = freshRes.ok
          ? ((await freshRes.json().catch(() => null)) as { data?: ContentRulesResponse } | null)
          : null;
        if (!freshJson?.data) return { status: 'error' };
        const freshRules = mergeRulesResponse(freshJson.data.rules);
        // §20-4 — 서버가 내가 로드한 이후 실제로 바꾼 필드 목록.
        const serverChanged = diffFieldNames(loadedRules, freshRules);
        if (serverChanged.includes(field)) {
          setConflictField({
            field,
            updatedByName: errBody?.error?.updated_by?.name ?? null,
            updatedByMemberId: errBody?.error?.updated_by?.member_id ?? null,
            viaUndo,
          });
          setRules((r) => ({ ...r, [field]: freshRules[field] }));
          setLoadedRules(freshRules);
          versionRef.current = freshJson.data.version;
          setUpdatedAt(freshJson.data.updated_at);
          setUpdatedBy(freshJson.data.updated_by);
          return { status: 'conflict-mine' };
        }
        // 안 겹침 — 최신 rules 위에 내 필드 값만 얹어 조용히 «한 번만» 재저장. 재시도
        // 자체가 또 409를 맞으면(동시 쓰기 폭주 등 드문 경우) 여기서 멈춘다 — 겹침
        // 판정의 기준선(loadedRules)이 이 함수 호출 동안 안 바뀌어(클로저 고정) 두
        // 번째 재시도부터는 그 판정 자체가 신뢰 못 할 값이 되기 때문이다(무한 재귀
        // 방지와 별개로 정확성 문제).
        if (rebased) {
          setRowErrors((prev) => ({ ...prev, [field]: t('saveFailed') }));
          return { status: 'error' };
        }
        const rebasedBody = { ...freshRules, [field]: nextRules[field] };
        return attempt(rebasedBody, freshJson.data.version, true);
      }
      const body2 = (await res.json().catch(() => null)) as { error?: { code?: string; field?: string } } | null;
      const code = body2?.error?.code;
      setRowErrors((prev) => ({
        ...prev,
        [field]: code === 'CONTENT_RULES_ADMIN_ONLY'
          ? t('errorOwnerOnly')
          : code === 'CONTENT_RULES_INVALID' ? t('errorInvalidField') : t('saveFailed'),
      }));
      return { status: 'error' };
    };

    let outcome: AttemptOutcome;
    try {
      outcome = await attempt(nextRules, versionRef.current, false);
    } catch {
      setRowErrors((prev) => ({ ...prev, [field]: t('saveFailed') }));
      outcome = { status: 'error' };
    }
    setSavingField(null);
    if (outcome.status === 'ok') {
      setExpandedField(null);
      addToast({
        type: 'success', title: outcome.rebased ? t('contentRulesAutoRebasedToast') : t('contentRulesRowSaveSuccessToast'),
        action: { label: t('contentRulesUndoAction'), onClick: () => {
          const prev = draftBeforeSave.current[field];
          if (prev === undefined) return;
          void saveField(field, { ...rules, [field]: prev } as ContentRules, nextRules[field], true);
        } },
      });
    }
  }, [orgId, loadedRules, rules, t, addToast]);

  const fieldTitle = useCallback((field: FieldKey) => {
    const KEYS: Record<FieldKey, string> = {
      banned_terms: 'bannedTermsLabel', require_utm: 'requireUtmRowTitle', tone: 'toneLabel',
      taxonomy: 'taxonomyLabel', channel_priority: 'channelPriorityLabel', brand_kit: 'brandKitLabel',
      generation_budget: 'generationBudgetRowTitle', utm_rules: 'utmRulesRowTitle',
    };
    return t(KEYS[field]);
  }, [t]);

  if (!orgId) return null;

  // story #3747(첫 절 §갈래 셋, 페드루 PO 確定 2026-09-09) — updated_at은 row가 있으면
  // 항상 값이 있다(모델 nullable=False) · null이면 「row 자체가 없다」는 뜻이라 아직
  // 한 번도 안 정함을 사람말로 설명한다(빈 줄 0). updated_by는 그 안에서만 갈린다.
  //
  // story #3747 CHANGES(페드루 PO 지적, 2026-09-09, CI 가드 story #3493) — 날짜는
  // `toLocaleDateString` 직접 호출 대신 doc §11-2 정본 `formatScheduledAt()`(「MM-DD
  // HH:mm {TZ}」+`resolveDisplayTimezone()`)로. 시안의 "9월 7일" 형은 이 정본 함수가
  // 이미 확定해 둔 형과 달라 코드 쪽이 정본(유나 통지는 PO 몫).
  const displayTimezone = resolveDisplayTimezone().tz;
  const lastChangedText = loadState !== 'ready' ? null : updatedAt === null
    ? t('pageNeverSetSuffix')
    : updatedBy?.name
      ? t('pageLastChangedWithName', { date: formatScheduledAt(updatedAt, displayTimezone).display, name: updatedBy.name })
      : t('pageLastChangedDateOnly', { date: formatScheduledAt(updatedAt, displayTimezone).display });

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
      {/* story #3747 CHANGES③(페드루 PO 지적, 2026-09-09) — 「마지막 변경」을 설명
          문장에 이어 붙이면 한 문단으로 흘러 줄바꿈된다(시안은 설명 아래 별도 muted
          줄). PageHeader에 부제 슬롯이 없어 컴포넌트 밖에서 별도 줄로 그린다. */}
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} size="section" />
      {lastChangedText ? (
        <p className="-mt-4 text-xs text-muted-foreground" data-testid="content-rules-last-changed">{lastChangedText}</p>
      ) : null}

      {loadState === 'error' ? (
        <Alert variant="destructive" role="alert" aria-live="assertive" aria-atomic="true">
          <AlertDescription>{t('loadFailed')}</AlertDescription>
        </Alert>
      ) : null}
      {!canEditRules ? (
        <p className="text-xs text-muted-foreground" data-testid="content-rules-readonly-reason">{t('readOnlyReason')}</p>
      ) : null}

      {loadState === 'loading' ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => <div key={i} className="h-16 animate-pulse rounded-md bg-muted" />)}
        </div>
      ) : loadState === 'ready' ? (
        <>
          {/* story #3785(유나 定) — 페이지 배경 위 테두리만 있는 상자는 배경과 한 색이라
              경계가 안 보인다(1층 규칙: Card, surface='solid'). */}
          <Card className="overflow-hidden">
            {/* ① 초안 검사 */}
            <SectionBar title={t('contentRulesInspectionSectionTitle')} description={t('contentRulesInspectionSectionDescription')} />
            <div className="divide-y divide-border">
              <RuleRowShell
                field="banned_terms" rules={rules} canEdit={canEditRules} expandedField={expandedField}
                setExpandedField={setExpandedField} title={fieldTitle('banned_terms')}
                subtitle={rules.banned_terms.length > 0
                  ? <>{rules.banned_terms.map((term) => <InlineChip key={term}>{term}</InlineChip>)}</>
                  : t('contentRulesNotSetLabel')}
                saving={savingField === 'banned_terms'} error={rowErrors.banned_terms} t={t}
              >
                <RowEditForm
                  initial={rules.banned_terms}
                  onCancel={() => setExpandedField(null)}
                  onSave={(next) => void saveField('banned_terms', { ...rules, banned_terms: next }, rules.banned_terms)}
                  saving={savingField === 'banned_terms'} t={t}
                >
                  {(draft, setDraft) => (
                    <TagListEditor items={draft} onChange={setDraft} placeholder={t('bannedTermsPlaceholder')} testIdPrefix="content-rules-banned-terms" t={t} />
                  )}
                </RowEditForm>
              </RuleRowShell>

              <RuleRowShell
                field="require_utm" rules={rules} canEdit={canEditRules} expandedField={expandedField}
                setExpandedField={setExpandedField} title={fieldTitle('require_utm')}
                status={
                  <span className="flex items-center gap-1.5 text-xs" data-testid="content-rules-require-utm-status">
                    <StatusDot on={rules.require_utm} />
                    {rules.require_utm
                      ? (rules.utm_rules?.enabled ? t('requireUtmOnAutoFulfilledStatus') : t('requireUtmOnLabel'))
                      : t('requireUtmOffLabel')}
                  </span>
                }
                subtitle={t('requireUtmHint')}
                saving={savingField === 'require_utm'} error={rowErrors.require_utm} t={t}
              >
                <RowEditForm
                  initial={rules.require_utm}
                  onCancel={() => setExpandedField(null)}
                  onSave={(next) => void saveField('require_utm', { ...rules, require_utm: next }, rules.require_utm)}
                  saving={savingField === 'require_utm'} t={t}
                >
                  {(draft, setDraft) => (
                    <label className="flex items-center gap-2 text-sm text-foreground">
                      <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} data-testid="content-rules-require-utm" />
                      {t('requireUtmLabel')}
                    </label>
                  )}
                </RowEditForm>
              </RuleRowShell>
            </div>

            {/* ② UTM 자동 부착 */}
            <SectionBar title={t('utmRulesSectionTitle')} description={t('utmRulesSectionDescription')} />
            <div className="divide-y divide-border">
              <RuleRowShell
                field="utm_rules" rules={rules} canEdit={canEditRules} expandedField={expandedField}
                setExpandedField={setExpandedField} title={fieldTitle('utm_rules')}
                status={
                  <span className="flex items-center gap-1.5 text-xs" data-testid="content-rules-utm-rules-status">
                    {rules.utm_rules === null ? (
                      <span className="text-muted-foreground">{t('contentRulesNotSetLabel')}</span>
                    ) : (
                      <>
                        <StatusDot on={rules.utm_rules.enabled} />
                        {rules.utm_rules.enabled ? (
                          <>
                            {t('utmRulesEnabledOnLabel')}
                            <span className="text-muted-foreground">
                              {' '}· {t('utmRulesStatusSource')} <strong className="text-foreground">{rules.utm_rules.default_source || t('utmRulesNotSetValue')}</strong>
                              {' '}· {t('utmRulesStatusMedium')} <strong className="text-foreground">{rules.utm_rules.default_medium || t('utmRulesNotSetValue')}</strong>
                              {' '}· {t('utmRulesStatusContent')} {rules.utm_rules.content_from === 'draft_id' ? t('utmRulesContentFromDraftId') : t('utmRulesContentFromNone')}
                            </span>
                          </>
                        ) : t('utmRulesEnabledOffLabel')}
                      </>
                    )}
                  </span>
                }
                subtitle={t('utmRulesEnabledHint')}
                saving={savingField === 'utm_rules'} error={rowErrors.utm_rules} t={t}
              >
                <UtmRulesEditForm
                  value={rules.utm_rules}
                  onCancel={() => setExpandedField(null)}
                  onSave={(next) => void saveField('utm_rules', { ...rules, utm_rules: next }, rules.utm_rules)}
                  saving={savingField === 'utm_rules'} t={t}
                />
              </RuleRowShell>
            </div>

            {/* ③ 생성 비용 한도 */}
            <SectionBar title={t('generationBudgetSectionTitle')} description={t('generationBudgetSectionDescription')} />
            <div className="divide-y divide-border">
              <RuleRowShell
                field="generation_budget" rules={rules} canEdit={canEditRules} expandedField={expandedField}
                setExpandedField={setExpandedField} title={fieldTitle('generation_budget')}
                subtitle={
                  rules.generation_budget === null ? (
                    t('contentRulesNotSetLabel')
                  ) : rules.generation_budget.limit_minor === 0 ? (
                    t('generationBudgetSuspendedReadonly')
                  ) : (
                    <>
                      <strong className="text-foreground">{formatMinorCurrency(rules.generation_budget.limit_minor, rules.generation_budget.currency, locale, tContent)}</strong>
                      {budget.status === 'ok' && budget.spentMinor !== null && budget.currency !== null
                        ? <> · {t('generationBudgetSpentSoFarSuffix', { spent: formatMinorCurrency(budget.spentMinor, budget.currency, locale, tContent) })}</>
                        : null}
                    </>
                  )
                }
                saving={savingField === 'generation_budget'} error={rowErrors.generation_budget} t={t}
              >
                <GenerationBudgetEditForm
                  value={rules.generation_budget}
                  onCancel={() => setExpandedField(null)}
                  onSave={(next) => void saveField('generation_budget', { ...rules, generation_budget: next }, rules.generation_budget)}
                  saving={savingField === 'generation_budget'} t={t}
                />
              </RuleRowShell>
            </div>

            {/* ④ 참고 항목 */}
            <SectionBar title={t('contentRulesReferenceSectionTitle')} description={t('contentRulesAdvisoryNotice')} />
            <div className="divide-y divide-border">
              <RuleRowShell
                field="tone" rules={rules} canEdit={canEditRules} expandedField={expandedField}
                setExpandedField={setExpandedField} title={fieldTitle('tone')}
                subtitle={rules.tone || t('contentRulesNotSetLabel')}
                saving={savingField === 'tone'} error={rowErrors.tone} t={t}
              >
                <RowEditForm
                  initial={rules.tone}
                  onCancel={() => setExpandedField(null)}
                  onSave={(next) => void saveField('tone', { ...rules, tone: next || null }, rules.tone)}
                  saving={savingField === 'tone'} t={t}
                >
                  {(draft, setDraft) => (
                    <input
                      id="content-rules-tone"
                      type="text" value={draft ?? ''} onChange={(e) => setDraft(e.target.value || null)}
                      placeholder={t('tonePlaceholder')} className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                      data-testid="content-rules-tone"
                    />
                  )}
                </RowEditForm>
              </RuleRowShell>

              <RuleRowShell
                field="taxonomy" rules={rules} canEdit={canEditRules} expandedField={expandedField}
                setExpandedField={setExpandedField} title={fieldTitle('taxonomy')}
                subtitle={rules.taxonomy.length > 0
                  ? <>{rules.taxonomy.map((tag) => <InlineChip key={tag}>{tag}</InlineChip>)}</>
                  : t('contentRulesNotSetLabel')}
                saving={savingField === 'taxonomy'} error={rowErrors.taxonomy} t={t}
              >
                <RowEditForm
                  initial={rules.taxonomy}
                  onCancel={() => setExpandedField(null)}
                  onSave={(next) => void saveField('taxonomy', { ...rules, taxonomy: next }, rules.taxonomy)}
                  saving={savingField === 'taxonomy'} t={t}
                >
                  {(draft, setDraft) => (
                    <TagListEditor items={draft} onChange={setDraft} placeholder={t('taxonomyPlaceholder')} testIdPrefix="content-rules-taxonomy" t={t} />
                  )}
                </RowEditForm>
              </RuleRowShell>

              <RuleRowShell
                field="channel_priority" rules={rules} canEdit={canEditRules} expandedField={expandedField}
                setExpandedField={setExpandedField} title={fieldTitle('channel_priority')}
                subtitle={rules.channel_priority.length > 0
                  ? <>{rules.channel_priority.map((ch, i) => <InlineChip key={ch}>{i + 1} {ch}</InlineChip>)}</>
                  : t('contentRulesNotSetLabel')}
                saving={savingField === 'channel_priority'} error={rowErrors.channel_priority} t={t}
              >
                <RowEditForm
                  initial={rules.channel_priority}
                  onCancel={() => setExpandedField(null)}
                  onSave={(next) => void saveField('channel_priority', { ...rules, channel_priority: next }, rules.channel_priority)}
                  saving={savingField === 'channel_priority'} t={t}
                >
                  {(draft, setDraft) => (
                    <div className="space-y-2">
                      <TagListEditor items={draft} onChange={setDraft} placeholder={t('channelPriorityPlaceholder')} testIdPrefix="content-rules-channel-priority-add" t={t} />
                      <OrderedListEditor items={draft} onChange={setDraft} testIdPrefix="content-rules-channel-priority" t={t} />
                    </div>
                  )}
                </RowEditForm>
              </RuleRowShell>

              <RuleRowShell
                field="brand_kit" rules={rules} canEdit={canEditRules} expandedField={expandedField}
                setExpandedField={setExpandedField} title={fieldTitle('brand_kit')}
                subtitle={
                  <>
                    {t('brandKitLogoShortLabel')} {rules.brand_kit.logo_url || t('contentRulesNotSetLabel')}
                    {' '}· {t('brandKitColorsShortLabel')}{' '}
                    {(rules.brand_kit.colors?.length ?? 0) > 0
                      ? rules.brand_kit.colors!.map((c) => <InlineChip key={c} swatch={c}>{c}</InlineChip>)
                      : t('contentRulesNotSetLabel')}
                  </>
                }
                saving={savingField === 'brand_kit'} error={rowErrors.brand_kit} t={t}
              >
                <BrandKitEditForm
                  value={rules.brand_kit}
                  onCancel={() => setExpandedField(null)}
                  onSave={(next) => void saveField('brand_kit', { ...rules, brand_kit: next }, rules.brand_kit)}
                  saving={savingField === 'brand_kit'} t={t}
                />
              </RuleRowShell>
            </div>
          </Card>

          <p className="text-xs text-muted-foreground">{t('contentRulesFooterNote')}</p>

          {conflictField ? (
            <Alert variant="destructive" role="alert" aria-live="assertive" aria-atomic="true" data-testid="content-rules-version-conflict">
              <AlertDescription>
                {conflictField.viaUndo ? `${t('contentRulesUndoFailedPrefix')} ` : ''}
                {conflictField.updatedByMemberId !== null && conflictField.updatedByMemberId === currentTeamMemberId
                  ? t('versionConflictFieldSelfOtherTab', { field: fieldTitle(conflictField.field) })
                  : conflictField.updatedByName
                    ? t('versionConflictFieldWithName', { field: fieldTitle(conflictField.field), name: conflictField.updatedByName })
                    : t('versionConflictFieldFact', { field: fieldTitle(conflictField.field) })}
              </AlertDescription>
            </Alert>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function SectionBar({ title, description }: { title: string; description: string }) {
  return (
    <div className="bg-muted px-3 py-2 text-xs" data-testid={`content-rules-section-${title}`}>
      <span className="font-semibold text-foreground">{title}</span>{'  '}
      <span className="text-muted-foreground">{description}</span>
    </div>
  );
}

function RuleRowShell({
  field, rules, canEdit, expandedField, setExpandedField, title, subtitle, status, saving, error, children, t,
}: {
  field: FieldKey;
  rules: ContentRules;
  canEdit: boolean;
  expandedField: FieldKey | null;
  setExpandedField: (f: FieldKey | null) => void;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  status?: React.ReactNode;
  saving: boolean;
  error?: string;
  children: React.ReactNode;
  t: ReturnType<typeof useTranslations>;
}) {
  const isExpanded = expandedField === field;
  const hasValue = hasFieldValue(field, rules);
  return (
    <ListRow
      data-testid={`content-rules-row-${field}`}
      title={title}
      subtitle={status ? undefined : subtitle}
      status={status}
      action={canEdit ? (
        <Button
          size="sm" variant="outline" disabled={saving}
          onClick={() => setExpandedField(isExpanded ? null : field)}
          data-testid={`content-rules-row-action-${field}`}
        >
          {hasValue ? t('contentRulesEditAction') : t('contentRulesSetAction')}
        </Button>
      ) : null}
    >
      {status && subtitle ? <p className="text-xs text-muted-foreground">{subtitle}</p> : null}
      {isExpanded ? (
        <div className="mt-2 rounded-md border border-border bg-background p-3">
          {children}
          {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
        </div>
      ) : null}
    </ListRow>
  );
}

// 필드 하나짜리 인라인 폼 공용 셸 — draft 상태를 `initial`(현재 저장된 값)로 시작해
// 로컬로 갖고 저장/취소 버튼을 공용화.
function RowEditForm<V>({
  initial, onSave, onCancel, saving, t, children,
}: {
  initial: V;
  onSave: (value: V) => void;
  onCancel: () => void;
  saving: boolean;
  t: ReturnType<typeof useTranslations>;
  children: (draft: V, setDraft: (v: V) => void) => React.ReactNode;
}) {
  const [draft, setDraft] = useState<V>(initial);
  const tc = useTranslations('common');
  return (
    <div className="space-y-3">
      {children(draft, setDraft)}
      <div className="flex gap-2">
        <Button size="sm" onClick={() => onSave(draft)} disabled={saving} data-testid="content-rules-row-save">
          {saving ? t('savingCta') : t('saveAction')}
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel} disabled={saving}>{tCancel(t, tc)}</Button>
      </div>
    </div>
  );
}

// story #3776(1층B) — 예전 '취소' 원시 폴백을 common ns의 기존 cancel 키로 교체(호출부
// 4곳이 각자 useTranslations('common')을 새로 열어 tc로 넘긴다).
function tCancel(t: ReturnType<typeof useTranslations>, tc: ReturnType<typeof useTranslations>): string {
  return t.has('cancelAction') ? t('cancelAction') : tc('cancel');
}

function UtmRulesEditForm({ value, onSave, onCancel, saving, t }: {
  value: UtmRules | null;
  onSave: (v: UtmRules | null) => void;
  onCancel: () => void;
  saving: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const [draft, setDraft] = useState<UtmRules>(value ?? {
    enabled: false, default_source: null, default_medium: null, campaign_from: 'campaign_slug', content_from: 'draft_id',
  });
  const tc = useTranslations('common');
  return (
    <div className="space-y-3">
      <label className="flex items-center gap-2 text-sm text-foreground">
        <input
          type="checkbox" checked={draft.enabled}
          onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))}
          data-testid="content-rules-utm-rules-enabled"
        />
        {t('utmRulesEnabledLabel')}
      </label>
      {draft.enabled ? (
        <div className="space-y-3 rounded-md border border-border p-3">
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="content-rules-utm-default-source">{t('utmRulesDefaultSourceLabel')}</label>
            <input
              id="content-rules-utm-default-source" type="text" value={draft.default_source ?? ''}
              onChange={(e) => setDraft((d) => ({ ...d, default_source: e.target.value || null }))}
              placeholder={t('utmRulesDefaultSourcePlaceholder')} className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              data-testid="content-rules-utm-default-source"
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="content-rules-utm-default-medium">{t('utmRulesDefaultMediumLabel')}</label>
            <input
              id="content-rules-utm-default-medium" type="text" value={draft.default_medium ?? ''}
              onChange={(e) => setDraft((d) => ({ ...d, default_medium: e.target.value || null }))}
              placeholder={t('utmRulesDefaultMediumPlaceholder')} className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
              data-testid="content-rules-utm-default-medium"
            />
          </div>
          <p className="text-xs text-muted-foreground" data-testid="content-rules-utm-campaign-from-fixed-note">{t('utmRulesCampaignFromFixedNote')}</p>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="content-rules-utm-content-from">{t('utmRulesContentFromLabel')}</label>
            <select
              id="content-rules-utm-content-from" value={draft.content_from}
              onChange={(e) => setDraft((d) => ({ ...d, content_from: e.target.value as UtmRules['content_from'] }))}
              className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm" data-testid="content-rules-utm-content-from"
            >
              <option value="draft_id">{t('utmRulesContentFromDraftId')}</option>
              <option value="none">{t('utmRulesContentFromNone')}</option>
            </select>
          </div>
        </div>
      ) : null}
      <div className="flex gap-2">
        <Button size="sm" onClick={() => onSave(draft)} disabled={saving} data-testid="content-rules-row-save">
          {saving ? t('savingCta') : t('saveAction')}
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel} disabled={saving}>{tCancel(t, tc)}</Button>
      </div>
    </div>
  );
}

function GenerationBudgetEditForm({ value, onSave, onCancel, saving, t }: {
  value: GenerationBudget | null;
  onSave: (v: GenerationBudget | null) => void;
  onCancel: () => void;
  saving: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const [draft, setDraft] = useState<GenerationBudget | null>(value);
  const tc = useTranslations('common');
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="number" min={0} step={1}
          value={draft ? minorToMajor(draft.limit_minor, draft.currency) : ''}
          onChange={(e) => {
            const raw = e.target.value;
            if (raw === '') { setDraft(null); return; }
            const majorValue = Number(raw);
            if (!Number.isFinite(majorValue) || majorValue < 0) return;
            const currency = draft?.currency ?? 'KRW';
            setDraft({ limit_minor: majorToMinor(majorValue, currency), currency, period: 'month' });
          }}
          placeholder={t('generationBudgetLimitPlaceholder')} className="w-32 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
          data-testid="content-rules-generation-budget-limit"
        />
        {draft ? (
          <select
            value={draft.currency}
            onChange={(e) => {
              const nextCurrency = e.target.value as GenerationBudgetCurrency;
              const majorValue = minorToMajor(draft.limit_minor, draft.currency);
              setDraft({ limit_minor: majorToMinor(majorValue, nextCurrency), currency: nextCurrency, period: 'month' });
            }}
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm" data-testid="content-rules-generation-budget-currency"
          >
            <option value="KRW">KRW</option>
            <option value="USD">USD</option>
          </select>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">{t('generationBudgetRowHint')}</p>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => onSave(draft)} disabled={saving} data-testid="content-rules-row-save">
          {saving ? t('savingCta') : t('saveAction')}
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel} disabled={saving}>{tCancel(t, tc)}</Button>
      </div>
    </div>
  );
}

function BrandKitEditForm({ value, onSave, onCancel, saving, t }: {
  value: BrandKit;
  onSave: (v: BrandKit) => void;
  onCancel: () => void;
  saving: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const [draft, setDraft] = useState<BrandKit>(value);
  const tc = useTranslations('common');
  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground" htmlFor="content-rules-brand-logo">{t('brandKitLogoLabel')}</label>
        <input
          id="content-rules-brand-logo" type="text" value={draft.logo_url ?? ''}
          onChange={(e) => setDraft((d) => ({ ...d, logo_url: e.target.value || undefined }))}
          placeholder={t('brandKitLogoPlaceholder')} className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
        />
        <BrandLogoPreview key={draft.logo_url ?? ''} url={draft.logo_url} t={t} />
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">{t('brandKitColorsLabel')}</label>
        <TagListEditor items={draft.colors ?? []} onChange={(next) => setDraft((d) => ({ ...d, colors: next }))} placeholder={t('brandKitColorsPlaceholder')} testIdPrefix="content-rules-brand-colors" variant="color" t={t} />
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-muted-foreground">{t('brandKitFontsLabel')}</label>
        <TagListEditor items={draft.fonts ?? []} onChange={(next) => setDraft((d) => ({ ...d, fonts: next }))} placeholder={t('brandKitFontsPlaceholder')} testIdPrefix="content-rules-brand-fonts" t={t} />
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => onSave(draft)} disabled={saving} data-testid="content-rules-row-save">
          {saving ? t('savingCta') : t('saveAction')}
        </Button>
        <Button size="sm" variant="outline" onClick={onCancel} disabled={saving}>{tCancel(t, tc)}</Button>
      </div>
    </div>
  );
}
