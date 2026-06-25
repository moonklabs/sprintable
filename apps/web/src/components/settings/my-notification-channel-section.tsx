'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Trash2 } from 'lucide-react';
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

function isWebhookUrlAllowed(url: string): boolean {
  if (!url) return true;
  if (/^https:\/\//i.test(url)) return true;
  return /^http:\/\/(localhost|127\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)/i.test(url);
}

export function MyNotificationChannelSection({ projectId, projectName }: MyNotificationChannelSectionProps) {
  const t = useTranslations('settings');
  const tc = useTranslations('common');
  const { addToast } = useToast();

  const [memberId, setMemberId] = useState<string | null>(null);
  const [webhookConfigs, setWebhookConfigs] = useState<WebhookConfig[]>([]);
  const [webhookUrl, setWebhookUrl] = useState('');
  const [savingNew, setSavingNew] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // [A] 리스트 = 글로벌(null) + 현재 프로젝트 config 만 노출 (스코프 결정: 다른 프로젝트는 해당 탭에서 관리)
  const fetchWebhookConfigs = useCallback(async (mid: string) => {
    const res = await fetch('/api/webhooks/config');
    if (!res.ok) return;
    const json = await res.json() as { data: WebhookConfig[] };
    const mine = (json.data ?? []).filter(
      (c) => c.member_id === mid && (c.project_id === projectId || c.project_id === null),
    );
    setWebhookConfigs(mine);
  }, [projectId]);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch('/api/me');
        if (!res.ok) return;
        const json = await res.json() as { data?: { id?: string } };
        const mid = json.data?.id ?? null;
        if (!mid) return;
        setMemberId(mid);
        await fetchWebhookConfigs(mid);
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

  const scopeLabel = (c: WebhookConfig) =>
    c.project_id === null ? t('webhookScopeGlobal') : projectName;

  // 행별 활성 토글 — 글로벌 행은 project_id:null 그대로 전달 (BE upsert 키 = member_id + project_id, PO 검증 완료)
  const handleToggleRow = async (c: WebhookConfig, next: boolean) => {
    if (!memberId) return;
    setBusyId(c.id);
    try {
      const res = await fetch('/api/webhooks/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          member_id: memberId,
          url: c.url,
          project_id: c.project_id,
          is_active: next,
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => null) as { error?: { message?: string } } | null;
        addToast({ type: 'error', title: json?.error?.message ?? tc('error') });
      }
      await fetchWebhookConfigs(memberId);
    } finally {
      setBusyId(null);
    }
  };

  // 행별 삭제 (inline confirm 통과 후)
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
      await fetchWebhookConfigs(memberId);
    } finally {
      setBusyId(null);
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
      await fetchWebhookConfigs(memberId);
    } finally {
      setSavingNew(false);
    }
  };

  if (loading || !projectId) return null;

  return (
    <SectionCard>
      <SectionCardHeader>
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-foreground">{t('notificationChannel')}</h2>
          <p className="text-sm text-muted-foreground">{t('webhookEnabledHelp')}</p>
        </div>
      </SectionCardHeader>
      <SectionCardBody className="space-y-4">
        {/* [A] 보유 webhook 리스트 */}
        <section className="space-y-2">
          <p className="text-sm font-medium">{t('webhookListTitle')}</p>
          {webhookConfigs.length === 0 ? (
            <p className="rounded-md border border-dashed border-border px-3 py-6 text-sm text-muted-foreground">
              {t('webhookListEmpty')}
            </p>
          ) : (
            <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
              {webhookConfigs.map((c) => {
                const isGlobal = c.project_id === null;
                const label = scopeLabel(c);
                const busy = busyId === c.id;

                if (deleteConfirmId === c.id) {
                  return (
                    <div
                      key={c.id}
                      className="flex items-center justify-between gap-3 bg-destructive/5 px-3 py-2.5"
                    >
                      <span className="min-w-0 truncate text-sm text-destructive" title={c.url}>
                        {t('webhookDeleteConfirm')}
                      </span>
                      <div className="flex shrink-0 items-center gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setDeleteConfirmId(null)}
                          disabled={busy}
                        >
                          {tc('cancel')}
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => void handleDeleteRow(c)}
                          disabled={busy}
                        >
                          {busy ? '...' : tc('delete')}
                        </Button>
                      </div>
                    </div>
                  );
                }

                return (
                  <div key={c.id} className="flex items-center gap-3 px-3 py-2.5">
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <Badge variant={isGlobal ? 'secondary' : 'outline'} className="shrink-0 text-xs">
                        {label}
                      </Badge>
                      <span className="truncate font-mono text-xs text-muted-foreground" title={c.url}>
                        {c.url}
                      </span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <Switch
                        checked={c.is_active}
                        onCheckedChange={(next) => void handleToggleRow(c, next)}
                        disabled={busy}
                        aria-label={`${t('webhookEnabledToggle')} — ${label}`}
                      />
                      <Button
                        variant="ghost"
                        size="sm"
                        className={cn('px-2 text-muted-foreground hover:text-destructive')}
                        onClick={() => setDeleteConfirmId(c.id)}
                        disabled={busy}
                        aria-label={`${tc('delete')} — ${label}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

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
