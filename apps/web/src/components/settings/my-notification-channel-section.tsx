'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { OperatorInput } from '@/components/ui/operator-control';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/components/ui/toast';

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

function getWebhookState(configs: WebhookConfig[]): 'empty' | 'active' | 'paused' {
  if (!configs.length) return 'empty';
  return configs[0].is_active ? 'active' : 'paused';
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
  const [webhookActive, setWebhookActive] = useState(false);
  const [savingWebhook, setSavingWebhook] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setWebhookUrl(webhookConfigs[0]?.url ?? '');
    setWebhookActive(webhookConfigs[0]?.is_active ?? false);
  }, [webhookConfigs]);

  const fetchWebhookConfigs = useCallback(async (mid: string) => {
    const res = await fetch('/api/webhooks/config');
    if (!res.ok) return;
    const json = await res.json() as { data: WebhookConfig[] };
    const mine = (json.data ?? []).filter(
      (c) => c.member_id === mid && c.project_id === projectId,
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

  const handleSaveWebhook = async () => {
    if (!memberId) return;
    const trimmed = webhookUrl.trim();
    if (trimmed && !isWebhookUrlAllowed(trimmed)) {
      addToast({ type: 'error', title: t('webhookUrlInvalid') });
      return;
    }
    setSavingWebhook(true);
    try {
      if (!trimmed) {
        if (webhookConfigs[0]) {
          await fetch(`/api/webhooks/config?id=${encodeURIComponent(webhookConfigs[0].id)}`, { method: 'DELETE' });
          setWebhookConfigs([]);
        }
      } else {
        const res = await fetch('/api/webhooks/config', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ member_id: memberId, url: trimmed, project_id: projectId, is_active: webhookActive }),
        });
        if (!res.ok) {
          const json = await res.json().catch(() => null) as { error?: { message?: string } } | null;
          addToast({ type: 'error', title: json?.error?.message ?? tc('error') });
          return;
        }
      }
      addToast({ type: 'success', title: 'Webhook URL saved' });
      await fetchWebhookConfigs(memberId);
    } finally {
      setSavingWebhook(false);
    }
  };

  const handleToggle = async (next: boolean) => {
    if (!memberId || !webhookConfigs[0]) return;
    setWebhookActive(next);
    setSavingWebhook(true);
    try {
      await fetch('/api/webhooks/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          member_id: memberId,
          url: webhookConfigs[0].url,
          project_id: projectId,
          is_active: next,
        }),
      });
      await fetchWebhookConfigs(memberId);
    } finally {
      setSavingWebhook(false);
    }
  };

  if (loading || !projectId) return null;

  const webhookState = getWebhookState(webhookConfigs);

  return (
    <SectionCard>
      <SectionCardHeader>
        <div className="space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-base font-semibold text-foreground">{t('notificationChannel')}</h2>
            <Badge variant="outline" className="text-xs">{projectName}</Badge>
            {webhookState === 'empty' && <Badge variant="info">{t('webhookStatusEmpty')}</Badge>}
            {webhookState === 'active' && <Badge variant="success">{t('webhookStatusActive')}</Badge>}
            {webhookState === 'paused' && (
              <>
                <Badge variant="secondary">{t('webhookStatusInactive')}</Badge>
                <Badge variant="info">{t('webhookStatusFallback')}</Badge>
              </>
            )}
          </div>
          <p className="text-sm text-muted-foreground">
            {webhookState === 'empty' && t('webhookHelperEmptyHuman')}
            {webhookState === 'active' && t('webhookHelperActiveHuman')}
            {webhookState === 'paused' && t('webhookHelperPaused')}
          </p>
        </div>
      </SectionCardHeader>
      <SectionCardBody className="space-y-3">
        <div className="flex items-center justify-between gap-4">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">{t('webhookEnabledToggle')}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{t('webhookEnabledHelp')}</p>
          </div>
          <Switch
            checked={webhookActive}
            onCheckedChange={(next) => void handleToggle(next)}
            disabled={savingWebhook}
          />
        </div>
        <div className="flex gap-2">
          <OperatorInput
            type="url"
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
            placeholder="https://your-endpoint.example.com/webhook"
            className="flex-1 font-mono text-xs"
            disabled={!webhookActive}
          />
          <Button
            variant="hero"
            size="sm"
            onClick={() => void handleSaveWebhook()}
            disabled={savingWebhook || !webhookActive || !webhookUrl.trim()}
          >
            {savingWebhook ? '...' : tc('save')}
          </Button>
        </div>
      </SectionCardBody>
    </SectionCard>
  );
}
