'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/toast';

interface AgentWebhookManagerProps {
  agentId: string;
  agentName: string;
  currentWebhookUrl: string | null;
}

export function AgentWebhookManager({ agentId, agentName, currentWebhookUrl }: AgentWebhookManagerProps) {
  const tc = useTranslations('common');
  const [webhookUrl, setWebhookUrl] = useState(currentWebhookUrl ?? '');
  const [saving, setSaving] = useState(false);
  const { addToast } = useToast();

  const handleSave = async () => {
    const trimmed = webhookUrl.trim();
    if (trimmed && !/^https:\/\//i.test(trimmed)) {
      addToast({ title: 'Webhook URL must start with https://', type: 'error' });
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/team-members/${agentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhook_url: trimmed || null }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({})) as { error?: { message?: string } };
        addToast({ title: json.error?.message ?? 'Failed to save webhook URL', type: 'error' });
        return;
      }
      addToast({ title: `Webhook URL updated for ${agentName}`, type: 'success' });
    } catch {
      addToast({ title: 'Network error — please retry', type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-muted/30 p-4 space-y-3">
      <div>
        <p className="text-sm font-medium text-foreground">Webhook URL</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          Events will be POSTed to this endpoint. Must be HTTPS.
        </p>
      </div>
      <div className="flex gap-2">
        <Input
          value={webhookUrl}
          onChange={(e) => setWebhookUrl(e.target.value)}
          placeholder="https://your-agent.example.com/webhook"
          className="flex-1 font-mono text-xs"
          type="url"
        />
        <Button size="sm" disabled={saving} onClick={() => void handleSave()}>
          {saving ? tc('loading') : tc('save')}
        </Button>
      </div>
      {currentWebhookUrl && (
        <p className="text-[11px] text-muted-foreground truncate">
          Current: <span className="font-mono">{currentWebhookUrl}</span>
        </p>
      )}
    </div>
  );
}
