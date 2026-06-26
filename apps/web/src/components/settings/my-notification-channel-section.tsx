'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Trash2, Send, Check, X, Loader2, AlertTriangle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { OperatorInput } from '@/components/ui/operator-control';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

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

function formatTs(ts?: string): string {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export function MyNotificationChannelSection({ projectId, projectName }: MyNotificationChannelSectionProps) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
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
    const res = await fetch('/api/webhooks/config');
    if (!res.ok) return;
    const json = await res.json() as { data: WebhookConfig[] };
    setWebhookConfigs(json.data ?? []);
  }, []);

  useEffect(() => {
    async function load() {
      try {
        const [meRes, projRes] = await Promise.all([
          fetch('/api/me'),
          fetch('/api/projects').catch(() => null),
        ]);
        if (projRes?.ok) {
          const pj = await projRes.json() as { data?: Array<{ id: string; name: string }> };
          const map: Record<string, string> = {};
          (pj.data ?? []).forEach((p) => { map[p.id] = p.name; });
          setNameMap(map);
        }
        if (!meRes.ok) return;
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
      const res = await fetch('/api/webhooks/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_id: memberId, url: c.url, project_id: c.project_id, is_active: next }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => null) as { error?: { message?: string } } | null;
        addToast({ type: 'error', title: json?.error?.message ?? tc('error') });
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
        const json = await res.json().catch(() => null) as { error?: { message?: string } } | null;
        addToast({ type: 'error', title: json?.error?.message ?? tc('error') });
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
      const res = await fetch('/api/webhooks/config', {
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
        const json = await res.json().catch(() => null) as { error?: { message?: string } } | null;
        addToast({ type: 'error', title: json?.error?.message ?? tc('error') });
        return;
      }
      addToast({ type: 'success', title: 'Webhook URL saved' });
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
    <SectionCard>
      <SectionCardHeader>
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-foreground">{t('destinationsTitle')}</h2>
          <p className="text-sm text-muted-foreground">{t('destinationsSubtitle')}</p>
        </div>
      </SectionCardHeader>
      <SectionCardBody className="space-y-4">
        {/* AC3 — 자가진단 패널 */}
        <section className="space-y-2 rounded-md border border-border bg-muted/40 p-3">
          <p className="text-sm font-medium text-foreground">{t('diagWhere')}</p>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Badge variant="success" className="shrink-0 text-xs">{t('inAppAlwaysChip')}</Badge>
            <span>{t('inAppAlways')}</span>
          </div>
          <p className="text-sm text-muted-foreground">
            {activeConfigs.length === 0
              ? t('externalNone')
              : `${t('externalActiveCount', { count: activeConfigs.length })} — ${activeScopeSummary}`}
          </p>
          {globalActive && (
            <div className="space-y-2 rounded-md border border-warning/35 bg-warning/12 p-2.5 text-xs text-foreground">
              <p className="flex items-start gap-1.5">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" aria-hidden />
                <span>{t('misconfigGlobalActive')}</span>
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={handleTurnOffGlobal}
                disabled={busyId === globalActive.id}
                className="whitespace-nowrap"
              >
                {t('turnOffGlobal')} →
              </Button>
            </div>
          )}
        </section>

        {/* AC2 — 목적지 집계(scope 그룹핑) */}
        {webhookConfigs.length === 0 ? (
          <p className="rounded-md border border-dashed border-border px-3 py-6 text-sm text-muted-foreground">
            {t('emptyExternalDest')}
          </p>
        ) : (
          <div className="space-y-3">
            {groups.map((group) => (
              <section key={group.key} className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <p className="text-xs font-medium text-foreground">{group.label}</p>
                  {group.isCurrent && (
                    <Badge variant="outline" className="text-[0.65rem]">{t('scopeCurrentMarker')}</Badge>
                  )}
                  <span className="text-xs text-muted-foreground tabular-nums">{group.configs.length}</span>
                </div>
                <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
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
                          className="flex items-center justify-between gap-3 bg-destructive/5 px-3 py-2.5"
                        >
                          <span className="min-w-0 truncate text-sm text-destructive" title={c.url}>
                            {t('webhookDeleteConfirm')}
                          </span>
                          <div className="flex shrink-0 items-center gap-2">
                            <Button ref={cancelRef} variant="ghost" size="sm" onClick={() => setDeleteConfirmId(null)} disabled={busy}>
                              {tc('cancel')}
                            </Button>
                            <Button variant="destructive" size="sm" onClick={() => void handleDeleteRow(c)} disabled={busy}>
                              {busy ? '...' : tc('delete')}
                            </Button>
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div key={c.id} className="px-3 py-2.5">
                        <div className="flex items-center gap-3">
                          <div className="flex min-w-0 flex-1 items-center gap-2">
                            <Badge variant={group.isGlobal ? 'secondary' : 'outline'} className="shrink-0 text-xs">
                              {group.label}
                            </Badge>
                            <span className="truncate font-mono text-xs text-muted-foreground" title={c.url}>
                              {c.url}
                            </span>
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="px-2 text-muted-foreground hover:text-foreground"
                              onClick={() => void handleTestSend(c)}
                              disabled={test.status === 'sending'}
                              aria-label={`${t('testSend')} — ${ariaScope}`}
                            >
                              {test.status === 'sending'
                                ? <Loader2 className="h-4 w-4 animate-spin" />
                                : <Send className="h-4 w-4" />}
                            </Button>
                            <Switch
                              checked={c.is_active}
                              onCheckedChange={(next) => void handleToggleRow(c, next)}
                              disabled={busy}
                              aria-label={`${t('webhookEnabledToggle')} — ${ariaScope}`}
                            />
                            <Button
                              variant="ghost"
                              size="sm"
                              className="px-2 text-muted-foreground hover:text-destructive"
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
                              'mt-1.5 flex items-center gap-1 text-xs',
                              test.status === 'ok' && 'text-success',
                              test.status === 'fail' && 'text-destructive',
                              (test.status === 'sending' || test.status === 'unavailable') && 'text-muted-foreground',
                            )}
                          >
                            {test.status === 'ok' && <><Check className="h-3 w-3" />{t('testReached')}{test.ts ? ` · ${formatTs(test.ts)}` : ''}</>}
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
        <section className="space-y-2 border-t border-border pt-4">
          <p className="text-sm font-medium">{t('webhookAddCurrentProject')}</p>
          <div className="flex gap-2">
            <OperatorInput
              type="url"
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder={t('webhookUrlPlaceholder')}
              className="flex-1 font-mono text-xs"
              aria-label={t('webhookAddCurrentProject')}
            />
            <Button
              variant="hero"
              size="sm"
              onClick={() => void handleSaveCurrentProject()}
              disabled={savingNew || !webhookUrl.trim()}
            >
              {savingNew ? '...' : tc('save')}
            </Button>
          </div>
        </section>
      </SectionCardBody>
    </SectionCard>
  );
}
