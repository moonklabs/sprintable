'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { fetchWithAuth } from '@/lib/db/client';

/**
 * story #3472(BE 3471/#3825, 페드루 PO 確定 2026-09-05) — 조직 콘텐츠 규칙 화면.
 * BE `GET/PUT /api/v2/organizations/{org_id}/content-rules` → `{org_id, rules,
 * version}`. 이 라우트 경로(`/organization/content-rules`)는 계약값 그대로 —
 * `violations[].settings_path`가 정확히 이 문자열로 온다(다른 경로면 초안 화면의
 * 링크가 깨진다).
 *
 * PUT은 휴먼 owner만(BE `_require_owner` 엄격 — admin·에이전트 불가). 연결 화면의
 * owner-or-admin 상수(`isOwner = role==='admin'||'owner'`)와 다르다 — 재사용
 * 금지(PO 明示). 그 외 역할은 값을 보되 편집 컨트롤이 없다(secret 아니라 읽기는
 * 전원 허용).
 */
interface BrandKit {
  logo_url?: string;
  colors?: string[];
  fonts?: string[];
}

interface ContentRules {
  banned_terms: string[];
  require_utm: boolean;
  tone: string | null;
  taxonomy: string[];
  channel_priority: string[];
  brand_kit: BrandKit;
}

interface ContentRulesResponse {
  org_id: string;
  rules: ContentRules;
  version: number;
}

const EMPTY_RULES: ContentRules = {
  banned_terms: [], require_utm: false, tone: null, taxonomy: [], channel_priority: [], brand_kit: {},
};

// story #3472(BE #3825 "보정 중") — 422 CONTENT_RULES_INVALID의 필드별 shape는 아직
// 최종이 아니다. 이 화면은 최선으로 `field`가 실려 오면 그 필드 옆에, 없으면 폼
// 상단 배너로 낸다(둘 다 원문을 안 지운다 — <details> 접기, §3-0 원칙과 동형).
type ContentRulesErrorBody = { error?: { code?: string; message?: string; field?: string } };

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
  // PO 明示(2026-09-05) — 연결 화면의 owner-or-admin 상수 재사용 금지, 정확히 owner만.
  const isOwner = currentRole === 'owner';
  const t = useTranslations('contentRules');

  const [rules, setRules] = useState<ContentRules>(EMPTY_RULES);
  const [version, setVersion] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saveSuccess, setSaveSuccess] = useState(false);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/content-rules`);
      if (!res.ok) { setLoadError(true); return; }
      const json = (await res.json().catch(() => null)) as { data?: ContentRulesResponse } | null;
      if (json?.data) {
        setRules({ ...EMPTY_RULES, ...json.data.rules, brand_kit: json.data.rules.brand_kit ?? {} });
        setVersion(json.data.version);
      }
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => { void load(); }, [load]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveError(null);
    setFieldErrors({});
    setSaveSuccess(false);
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/content-rules`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules }),
      });
      if (res.ok) {
        const json = (await res.json().catch(() => null)) as { data?: ContentRulesResponse } | null;
        if (json?.data) {
          setRules({ ...EMPTY_RULES, ...json.data.rules, brand_kit: json.data.rules.brand_kit ?? {} });
          setVersion(json.data.version);
          setSaveSuccess(true);
        }
      } else {
        const body = (await res.json().catch(() => null)) as ContentRulesErrorBody | null;
        const code = body?.error?.code;
        const field = body?.error?.field;
        if (code === 'CONTENT_RULES_INVALID' && field) {
          setFieldErrors({ [field]: t('errorInvalidField') });
        } else if (code === 'CONTENT_RULES_OWNER_ONLY') {
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
  }, [orgId, rules, t]);

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold text-foreground">{t('pageTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('pageDescription')}</p>
      </div>

      {loadError ? (
        <Alert variant="destructive" role="alert" aria-live="assertive" aria-atomic="true">
          <AlertDescription>{t('loadFailed')}</AlertDescription>
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
      {!isOwner ? (
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
                  readOnly={!isOwner}
                  placeholder={t('bannedTermsPlaceholder')}
                  testIdPrefix="content-rules-banned-terms"
                />
                {fieldErrors.banned_terms ? <p className="text-xs text-destructive">{fieldErrors.banned_terms}</p> : null}
              </div>

              <div className="space-y-1.5">
                {/* 카디르군 REQUEST_CHANGES(2026-09-05, PR#3827) — disabled={!isOwner}는
                    "살아 있는" 컨트롤(탭 순서·스크린리더가 여전히 체크박스로 읽는다)이라
                    AC "편집 컨트롤이 없다"를 안 지킨다. 나머지 4필드(TagListEditor)와
                    같은 원칙으로 읽기 전용 텍스트로 바꾼다. */}
                {isOwner ? (
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
                {isOwner ? (
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
                  readOnly={!isOwner}
                  placeholder={t('taxonomyPlaceholder')}
                  testIdPrefix="content-rules-taxonomy"
                />
                {fieldErrors.taxonomy ? <p className="text-xs text-destructive">{fieldErrors.taxonomy}</p> : null}
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">{t('channelPriorityLabel')}</label>
                {isOwner ? (
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
                  readOnly={!isOwner}
                  testIdPrefix="content-rules-channel-priority"
                />
                {fieldErrors.channel_priority ? <p className="text-xs text-destructive">{fieldErrors.channel_priority}</p> : null}
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground" htmlFor="content-rules-brand-logo">{t('brandKitLogoLabel')}</label>
                {isOwner ? (
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
                  readOnly={!isOwner}
                  placeholder={t('brandKitColorsPlaceholder')}
                  testIdPrefix="content-rules-brand-colors"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">{t('brandKitFontsLabel')}</label>
                <TagListEditor
                  items={rules.brand_kit.fonts ?? []}
                  onChange={(next) => setRules((r) => ({ ...r, brand_kit: { ...r.brand_kit, fonts: next } }))}
                  readOnly={!isOwner}
                  placeholder={t('brandKitFontsPlaceholder')}
                  testIdPrefix="content-rules-brand-fonts"
                />
                {fieldErrors.brand_kit ? <p className="text-xs text-destructive">{fieldErrors.brand_kit}</p> : null}
              </div>

              {isOwner ? (
                <Button size="sm" onClick={() => void handleSave()} disabled={saving} data-testid="content-rules-save-button">
                  {saving ? t('savingCta') : t('saveAction')}
                </Button>
              ) : null}
            </SectionCardBody>
          </SectionCard>
        </>
      )}
    </div>
  );
}
