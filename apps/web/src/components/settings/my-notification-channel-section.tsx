'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Trash2, Send, Check, X, Loader2, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ds/button';
import { Input } from '@/components/ds/input';
import { useToast } from '@/components/ui/toast'; // the toast HOOK (the context the app's toasts go through) — it has no ds twin; not a visual part
import { SettingsSection } from './settings-section';
import { SwitchButton, Tag } from './settings-parts';
import { cn } from '@/lib/utils';
import { formatViewerRelativeTime } from '@/lib/storage/format';
import { fetchWithAuth } from '@/lib/db/client';
import { fetchMe } from '@/lib/me-client';
import { useViewerTimeZone } from '@/components/viewer-time-zone';

interface WebhookConfig {
  id: string;
  member_id: string | null;
  url: string;
  project_id: string | null;
  is_active: boolean;
}

interface MyNotificationChannelSectionProps {
  projectId: string;
  projectName: string;
}

const GLOBAL_KEY = '__global__';

type TestStatus = 'idle' | 'sending' | 'ok' | 'fail' | 'unavailable';
interface TestState {
  status: TestStatus;
  reason?: string;
  ts?: string;
}

function isWebhookUrlAllowed(url: string): boolean {
  if (!url) return true;
  if (/^https:\/\//i.test(url)) return true;
  return /^http:\/\/(localhost|127\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)/i.test(url);
}

// story #3493 — 웹훅 테스트 핑의 "언제 확認됐나"는 방금 벌어진 기록이라 §11-2
// 절대형이 아니라 3436 묶음 8 정본(formatRelativeTime)이 맞다. 모듈 스코프 순수
// 함수라 locale/tz를 인자로 받는다(훅은 컴포넌트 안에서만 호출 가능).
function formatTs(ts: string | undefined, locale: string, displayTimezone: string | null): string {
  if (!ts) return '';
  try {
    return formatViewerRelativeTime(ts, locale, displayTimezone);
  } catch {
    return '';
  }
}

export function MyNotificationChannelSection({ projectId, projectName }: MyNotificationChannelSectionProps) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const locale = useLocale();
  const displayTimezone = useViewerTimeZone(); // story #4443 PR2b — the viewer's zone (null until known)
  const { addToast } = useToast();

  const [memberId, setMemberId] = useState<string | null>(null);
  const [webhookConfigs, setWebhookConfigs] = useState<WebhookConfig[]>([]);
  const [nameMap, setNameMap] = useState<Record<string, string>>({});
  const [webhookUrl, setWebhookUrl] = useState('');
  const [savingNew, setSavingNew] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [testStates, setTestStates] = useState<Record<string, TestState>>({});
  const [loading, setLoading] = useState(true);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // inline confirm 진입 시 안전 기본값(취소)으로 포커스 이동 — 파괴적 액션 a11y
  useEffect(() => {
    if (deleteConfirmId) cancelRef.current?.focus();
  }, [deleteConfirmId]);

  // AC2 집계 — BE GET이 이미 caller user-scope(IDOR fix #1726=내 것만 반환). 클라 member_id 필터는
  // 중복+유해(BE가 member_id를 user_id로 저장/반환하는데 /api/me.id는 org-member-id라 0 매치→전 config 숨김 회귀).
  // → 필터 제거하고 BE 스코프 그대로 신뢰. (member_id 시맨틱은 디디 BE #1726 확인 항목)
  const fetchWebhookConfigs = useCallback(async () => {
    const res = await fetchWithAuth('/api/webhooks/config');
    if (!res.ok) return;
    const json = await res.json() as { data: WebhookConfig[] };
    setWebhookConfigs(json.data ?? []);
  }, []);

  useEffect(() => {
    async function load() {
      try {
        // story #3519(§16-7 2부, PO 確定 2026-09-05) — projRes만 격리돼 있었다(meRes는
        // 안 됨) — meRes가 네트워크단 reject하면 이 Promise.all 전체가 던져 이미 정상
        // 응답한 projRes의 결과(nameMap)까지 조용히 못 씌워졌다. meRes도 격리한다(한쪽만
        // 격리하면 나머지 격리가 무의미해진다).
        const [meRes, projRes] = await Promise.all([
          fetchMe().catch(() => null),
          fetchWithAuth('/api/projects').catch(() => null),
        ]);
        if (projRes?.ok) {
          const pj = await projRes.json() as { data?: Array<{ id: string; name: string }> };
          const map: Record<string, string> = {};
          (pj.data ?? []).forEach((p) => { map[p.id] = p.name; });
          setNameMap(map);
        }
        if (!meRes?.ok) return;
        const json = await meRes.json() as { data?: { id?: string } };
        const mid = json.data?.id ?? null;
        if (!mid) return;
        setMemberId(mid);
        await fetchWebhookConfigs();
      } finally {
        setLoading(false);
      }
    }
    void load();
  }, [fetchWebhookConfigs]);

  // [B] 슬롯 prefill — 현재 프로젝트 config의 URL (없으면 빈값=신규)
  const currentProjectConfig = webhookConfigs.find((c) => c.project_id === projectId);
  useEffect(() => {
    setWebhookUrl(currentProjectConfig?.url ?? '');
  }, [currentProjectConfig?.url]);

  const scopeName = useCallback(
    (pid: string | null) => {
      if (pid === null) return t('webhookScopeGlobal');
      // nameMap 미로드/실패 시 현재 프로젝트는 prop으로 graceful 폴백
      return nameMap[pid] ?? (pid === projectId ? projectName : pid);
    },
    [nameMap, projectId, projectName, t],
  );

  // 행별 활성 토글 — 글로벌 행은 project_id:null 그대로 전달
  const handleToggleRow = async (c: WebhookConfig, next: boolean) => {
    if (!memberId) return;
    setBusyId(c.id);
    try {
      const res = await fetchWithAuth('/api/webhooks/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_id: memberId, url: c.url, project_id: c.project_id, is_active: next }),
      });
      if (!res.ok) {
        // story #2485 — backend upsert_webhook_config()는 generic HTTP상태 코드만
        // 낸다(진짜 비즈니스 code 없음, 그라운딩 확認) — raw 서버 message 노출 제거.
        addToast({ type: 'error', title: tc('error') });
      }
      await fetchWebhookConfigs();
    } finally {
      setBusyId(null);
    }
  };

  const handleDeleteRow = async (c: WebhookConfig) => {
    if (!memberId) return;
    setBusyId(c.id);
    try {
      const res = await fetch(`/api/webhooks/config?id=${encodeURIComponent(c.id)}`, { method: 'DELETE' });
      if (!res.ok) {
        // story #2485 — backend delete_webhook_config()는 generic HTTP상태 코드만
        // 낸다(진짜 비즈니스 code 없음, 그라운딩 확認) — raw 서버 message 노출 제거.
        addToast({ type: 'error', title: tc('error') });
        setDeleteConfirmId(null);
        return;
      }
      setDeleteConfirmId(null);
      await fetchWebhookConfigs();
    } finally {
      setBusyId(null);
    }
  };

  // AC2 test-send — 도달확인. BE=0a6487c6-BE(디디). 미머지/404 시 'unavailable'(중립·가짜 destructive 회피).
  const handleTestSend = async (c: WebhookConfig) => {
    setTestStates((s) => ({ ...s, [c.id]: { status: 'sending' } }));
    try {
      const res = await fetch(`/api/webhooks/config/${encodeURIComponent(c.id)}/test-send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (!res.ok) {
        setTestStates((s) => ({ ...s, [c.id]: { status: 'unavailable' } }));
        return;
      }
      const json = await res.json() as { data?: { reached?: boolean; reason?: string; ts?: string }; reached?: boolean; reason?: string; ts?: string };
      const d = json?.data ?? json;
      if (d?.reached) {
        setTestStates((s) => ({ ...s, [c.id]: { status: 'ok', ts: d.ts } }));
      } else {
        setTestStates((s) => ({ ...s, [c.id]: { status: 'fail', reason: d?.reason } }));
      }
    } catch {
      setTestStates((s) => ({ ...s, [c.id]: { status: 'unavailable' } }));
    }
  };

  // [B] 현재 프로젝트 webhook 추가/편집 — is_active 보존, 신규는 기본 on
  const handleSaveCurrentProject = async () => {
    if (!memberId) return;
    const trimmed = webhookUrl.trim();
    if (!trimmed) return;
    if (!isWebhookUrlAllowed(trimmed)) {
      addToast({ type: 'error', title: t('webhookUrlInvalid') });
      return;
    }
    setSavingNew(true);
    try {
      const res = await fetchWithAuth('/api/webhooks/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          member_id: memberId,
          url: trimmed,
          project_id: projectId,
          is_active: currentProjectConfig?.is_active ?? true,
        }),
      });
      if (!res.ok) {
        // story #2485 — backend upsert_webhook_config()는 generic HTTP상태 코드만
        // 낸다(진짜 비즈니스 code 없음, 그라운딩 확認) — raw 서버 message 노출 제거.
        addToast({ type: 'error', title: tc('error') });
        return;
      }
      addToast({ type: 'success', title: t('webhookUrlSavedToast') });
      await fetchWebhookConfigs();
    } finally {
      setSavingNew(false);
    }
  };

  // scope 그룹핑 — 글로벌 먼저 → 현재 프로젝트 → 나머지 이름순
  const groups = useMemo(() => {
    const byScope = new Map<string, WebhookConfig[]>();
    for (const c of webhookConfigs) {
      const key = c.project_id ?? GLOBAL_KEY;
      const arr = byScope.get(key);
      if (arr) arr.push(c); else byScope.set(key, [c]);
    }
    const keys = [...byScope.keys()].sort((a, b) => {
      if (a === GLOBAL_KEY) return -1;
      if (b === GLOBAL_KEY) return 1;
      if (a === projectId) return -1;
      if (b === projectId) return 1;
      return scopeName(a).localeCompare(scopeName(b));
    });
    return keys.map((key) => ({
      key,
      isGlobal: key === GLOBAL_KEY,
      isCurrent: key === projectId,
      label: key === GLOBAL_KEY ? t('webhookScopeGlobal') : scopeName(key),
      configs: byScope.get(key) ?? [],
    }));
  }, [webhookConfigs, projectId, scopeName, t]);

  const activeConfigs = webhookConfigs.filter((c) => c.is_active);
  const globalActive = webhookConfigs.find((c) => c.project_id === null && c.is_active);
  const activeScopeSummary = useMemo(
    () => [...new Set(activeConfigs.map((c) => scopeName(c.project_id)))].join(', '),
    [activeConfigs, scopeName],
  );

  const handleTurnOffGlobal = () => {
    if (globalActive) void handleToggleRow(globalActive, false);
  };

  if (loading || !projectId) return null;

  return (
    <SettingsSection title={t('destinationsTitle')} description={t('destinationsSubtitle')}>
      {/* AC3 — 자가진단 패널 */}
      <section className="space-y-2 rounded-ds-control border border-ds-line bg-ds-surface-sunk p-3">
        <p className="text-ds-body font-semibold text-ds-ink">{t('diagWhere')}</p>
        <div className="flex items-center gap-2 text-ds-body text-ds-ink-3">
          <Tag tone="done">{t('inAppAlwaysChip')}</Tag>
          <span>{t('inAppAlways')}</span>
        </div>
        <p className="text-ds-body text-ds-ink-3">
          {activeConfigs.length === 0
            ? t('externalNone')
            : `${t('externalActiveCount', { count: activeConfigs.length })} — ${activeScopeSummary}`}
        </p>
        {globalActive && (
          <div className="space-y-2 rounded-ds-control border border-ds-needs-hand-bar/40 bg-ds-needs-hand-soft p-2.5 text-ds-small text-ds-ink">
            <p className="flex items-start gap-1.5">
              {/* story #2590(TIER1 아이콘) — 경고 아이콘은 글자색(ink)으로(색만으로 뜻을 싣지 않는다: 글이 같이 간다). */}
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ds-ink" aria-hidden />
              <span>{t('misconfigGlobalActive')}</span>
            </p>
            <Button variant="secondary" onClick={handleTurnOffGlobal} disabled={busyId === globalActive.id}>
              {t('turnOffGlobal')} →
            </Button>
          </div>
        )}
      </section>

      {/* AC2 — 목적지 집계(scope 그룹핑) */}
      {webhookConfigs.length === 0 ? (
        <p className="rounded-ds-control border border-dashed border-ds-line px-3 py-6 text-ds-body text-ds-ink-3">
          {t('emptyExternalDest')}
        </p>
      ) : (
        <div className="space-y-3">
          {groups.map((group) => (
            <section key={group.key} className="space-y-1.5">
              <div className="flex items-center gap-2">
                <p className="min-w-0 truncate text-ds-small font-semibold text-ds-ink">{group.label}</p>
                {group.isCurrent && <Tag>{t('scopeCurrentMarker')}</Tag>}
                <span className="text-ds-small tabular-nums text-ds-ink-3">{group.configs.length}</span>
              </div>
              <div className="divide-y divide-ds-line overflow-hidden rounded-ds-control border border-ds-line">
                {group.configs.map((c) => {
                  const busy = busyId === c.id;
                  const test = testStates[c.id] ?? { status: 'idle' as TestStatus };
                  const ariaScope = group.isGlobal ? t('webhookScopeGlobal') : group.label;

                  if (deleteConfirmId === c.id) {
                    return (
                      <div
                        key={c.id}
                        role="group"
                        aria-live="assertive"
                        aria-label={`${t('webhookDeleteConfirm')} (${ariaScope})`}
                        className="flex flex-wrap items-center justify-between gap-3 bg-ds-failed-soft px-3 py-2.5"
                      >
                        <span className="min-w-0 flex-1 text-ds-body text-ds-ink" title={c.url}>
                          {t('webhookDeleteConfirm')}
                        </span>
                        <div className="flex shrink-0 items-center gap-2">
                          <Button ref={cancelRef} variant="quiet" onClick={() => setDeleteConfirmId(null)} disabled={busy}>
                            {tc('cancel')}
                          </Button>
                          <Button variant="danger" onClick={() => void handleDeleteRow(c)} disabled={busy}>
                            {busy ? '...' : tc('delete')}
                          </Button>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div key={c.id} className="px-3 py-2.5">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                          <Tag tone={group.isGlobal ? 'action' : 'neutral'}>{group.label}</Tag>
                          <span className="min-w-[8rem] flex-1 truncate font-mono text-ds-small text-ds-ink-3" title={c.url}>
                            {c.url}
                          </span>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <Button
                            variant="quiet"
                            className="px-2"
                            onClick={() => void handleTestSend(c)}
                            disabled={test.status === 'sending'}
                            aria-label={`${t('testSend')} — ${ariaScope}`}
                          >
                            {test.status === 'sending'
                              ? <Loader2 className="h-4 w-4 animate-spin" />
                              : <Send className="h-4 w-4" />}
                          </Button>
                          <SwitchButton
                            checked={c.is_active}
                            onCheckedChange={(next) => void handleToggleRow(c, next)}
                            disabled={busy}
                            aria-label={`${t('webhookEnabledToggle')} — ${ariaScope}`}
                          />
                          <Button
                            variant="quiet"
                            className="px-2"
                            onClick={() => setDeleteConfirmId(c.id)}
                            disabled={busy}
                            aria-label={`${tc('delete')} — ${ariaScope}`}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                      {test.status !== 'idle' && (
                        <p
                          className={cn(
                            'mt-1.5 flex items-center gap-1 text-ds-small',
                            test.status === 'ok' && 'text-ds-done',
                            test.status === 'fail' && 'text-ds-failed',
                            (test.status === 'sending' || test.status === 'unavailable') && 'text-ds-ink-3',
                          )}
                          role={test.status === 'fail' ? 'alert' : 'status'}
                          aria-live={test.status === 'fail' ? 'assertive' : 'polite'}
                          aria-atomic="true"
                        >
                          {test.status === 'ok' && <><Check className="h-3 w-3" />{t('testReached')}{test.ts ? ` · ${formatTs(test.ts, locale, displayTimezone)}` : ''}</>}
                          {test.status === 'fail' && <><X className="h-3 w-3" />{t('testFailed')}{test.reason ? ` · ${test.reason}` : ''}</>}
                          {test.status === 'sending' && <>{t('testSending')}</>}
                          {test.status === 'unavailable' && <>{t('testUnavailable')}</>}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      {/* [B] 현재 프로젝트 webhook 추가/편집 슬롯 */}
      <section className="space-y-2 border-t border-ds-line pt-4">
        <p className="text-ds-body font-semibold text-ds-ink">{t('webhookAddCurrentProject')}</p>
        <div className="flex flex-wrap gap-2">
          <Input
            type="url"
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
            placeholder={t('webhookUrlPlaceholder')}
            className="min-w-0 flex-1 font-mono touch:h-11"
            aria-label={t('webhookAddCurrentProject')}
          />
          <Button variant="primary" onClick={() => void handleSaveCurrentProject()} disabled={savingNew || !webhookUrl.trim()}>
            {savingNew ? '...' : tc('save')}
          </Button>
        </div>
      </section>
    </SettingsSection>
  );
}
