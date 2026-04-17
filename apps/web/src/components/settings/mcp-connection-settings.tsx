'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { OperatorInput, OperatorTextarea } from '@/components/ui/operator-control';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';

interface McpConnectionSummary {
  serverKey: string;
  displayName: string;
  provider: 'github' | 'linear' | 'jira';
  authStrategy: 'oauth' | 'api_key' | 'api_token';
  connected: boolean;
  connectUrl: string | null;
  maskedSecret: string | null;
  label: string | null;
  status: 'active' | 'error' | 'pending_oauth' | 'disconnected';
  toolNames: string[];
  validatedAt: string | null;
  lastError: string | null;
}

const STATUS_VARIANTS: Record<McpConnectionSummary['status'], 'success' | 'destructive' | 'outline' | 'secondary'> = {
  active: 'success',
  error: 'destructive',
  pending_oauth: 'secondary',
  disconnected: 'outline',
};

export function McpConnectionSettings({ projectId }: { projectId: string }) {
  const t = useTranslations('settings.mcpConnections');
  const tc = useTranslations('common');
  const searchParams = useSearchParams();

  const [connections, setConnections] = useState<McpConnectionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});
  const [labelDrafts, setLabelDrafts] = useState<Record<string, string>>({});
  const [requestName, setRequestName] = useState('');
  const [requestUrl, setRequestUrl] = useState('');
  const [requestNotes, setRequestNotes] = useState('');
  const [requesting, setRequesting] = useState(false);

  const oauthMessage = useMemo(() => {
    const state = searchParams.get('mcp_connection');
    if (state === 'github_connected') {
      return { type: 'success' as const, text: t('githubOAuthSuccess') };
    }
    if (state === 'github_error') {
      return { type: 'error' as const, text: t('githubOAuthError') };
    }
    return null;
  }, [searchParams, t]);

  const loadConnections = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/projects/${projectId}/mcp-connections`, { cache: 'no-store' });
      const json = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(json?.error?.message ?? t('loadError'));
      }
      const nextConnections = (json?.data?.connections ?? []) as McpConnectionSummary[];
      setConnections(nextConnections);
      setSecretDrafts((current) => {
        const next = { ...current };
        nextConnections.forEach((connection) => {
          if (!(connection.serverKey in next)) next[connection.serverKey] = '';
        });
        return next;
      });
      setLabelDrafts((current) => {
        const next = { ...current };
        nextConnections.forEach((connection) => {
          if (!(connection.serverKey in next)) next[connection.serverKey] = connection.label ?? '';
        });
        return next;
      });
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : t('loadError') });
    } finally {
      setLoading(false);
    }
  }, [projectId, t]);

  useEffect(() => {
    void loadConnections();
  }, [loadConnections]);

  useEffect(() => {
    if (oauthMessage) {
      setMessage(oauthMessage);
    }
  }, [oauthMessage]);

  const handleManualConnect = async (serverKey: string) => {
    const secret = secretDrafts[serverKey]?.trim() ?? '';
    if (!secret) return;

    setSavingKey(serverKey);
    setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/mcp-connections/${serverKey}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret,
          label: labelDrafts[serverKey]?.trim() || undefined,
        }),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(json?.error?.message ?? t('connectError'));
      }
      setSecretDrafts((current) => ({ ...current, [serverKey]: '' }));
      setMessage({ type: 'success', text: t('connectSuccess', { server: json?.data?.displayName ?? serverKey }) });
      await loadConnections();
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : t('connectError') });
    } finally {
      setSavingKey(null);
    }
  };

  const handleDelete = async (serverKey: string) => {
    setDeletingKey(serverKey);
    setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/mcp-connections/${serverKey}`, { method: 'DELETE' });
      const json = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(json?.error?.message ?? t('disconnectError'));
      }
      setMessage({ type: 'success', text: t('disconnectSuccess') });
      await loadConnections();
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : t('disconnectError') });
    } finally {
      setDeletingKey(null);
    }
  };

  const handleRequestReview = async () => {
    if (!requestName.trim() || !requestUrl.trim()) return;

    setRequesting(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/projects/${projectId}/mcp-connections`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          server_name: requestName.trim(),
          server_url: requestUrl.trim(),
          notes: requestNotes.trim() || undefined,
        }),
      });
      const json = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(json?.error?.message ?? t('requestError'));
      }
      setRequestName('');
      setRequestUrl('');
      setRequestNotes('');
      setMessage({ type: 'success', text: t('requestSuccess') });
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : t('requestError') });
    } finally {
      setRequesting(false);
    }
  };

  return (
    <SectionCard>
      <SectionCardHeader>
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-[color:var(--operator-foreground)]">{t('title')}</h2>
          <p className="text-sm text-[color:var(--operator-muted)]">{t('description')}</p>
        </div>
      </SectionCardHeader>
      <SectionCardBody className="space-y-4">
        {message ? (
          <div className={`rounded-2xl border px-3 py-2 text-xs ${message.type === 'success' ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-200' : 'border-rose-400/20 bg-rose-500/10 text-rose-200'}`}>
            {message.text}
          </div>
        ) : null}

        {loading ? (
          <div className="h-32 animate-pulse rounded-2xl bg-[color:var(--operator-surface-soft)]" />
        ) : (
          <div className="space-y-4">
            {connections.map((connection) => {
              const isOAuth = connection.authStrategy === 'oauth';
              const canSave = !isOAuth && Boolean(secretDrafts[connection.serverKey]?.trim());
              return (
                <div key={connection.serverKey} className="rounded-3xl border border-white/10 bg-[color:var(--operator-surface-soft)]/45 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-2">
                      <div className="flex items-center gap-2">
                        <h3 className="text-sm font-semibold text-[color:var(--operator-foreground)]">{connection.displayName}</h3>
                        <Badge variant={STATUS_VARIANTS[connection.status]}>{t(`status.${connection.status}`)}</Badge>
                        <Badge variant="outline">{t(`auth.${connection.authStrategy}`)}</Badge>
                      </div>
                      <div className="space-y-1 text-xs text-[color:var(--operator-muted)]">
                        {connection.label ? <div>{t('labelValue', { label: connection.label })}</div> : null}
                        {connection.maskedSecret ? <div>{t('maskedSecretValue', { secret: connection.maskedSecret })}</div> : null}
                        <div>{t('toolCountValue', { count: connection.toolNames.length })}</div>
                        {connection.validatedAt ? <div>{t('validatedAtValue', { date: new Date(connection.validatedAt).toLocaleString() })}</div> : null}
                        {connection.lastError ? <div className="text-rose-200">{connection.lastError}</div> : null}
                      </div>
                    </div>

                    <div className="flex gap-2">
                      {connection.connected ? (
                        <Button variant="glass" size="sm" onClick={() => handleDelete(connection.serverKey)} disabled={deletingKey === connection.serverKey}>
                          {deletingKey === connection.serverKey ? '...' : tc('delete')}
                        </Button>
                      ) : null}
                      {isOAuth ? (
                        <Button
                          variant="hero"
                          size="sm"
                          disabled={!connection.connectUrl}
                          onClick={() => {
                            if (connection.connectUrl) {
                              window.location.assign(connection.connectUrl);
                            }
                          }}
                        >
                          {t('connectGitHub')}
                        </Button>
                      ) : null}
                    </div>
                  </div>

                  {!isOAuth ? (
                    <div className="mt-4 space-y-3">
                      <OperatorInput
                        value={labelDrafts[connection.serverKey] ?? ''}
                        onChange={(event) => setLabelDrafts((current) => ({ ...current, [connection.serverKey]: event.target.value }))}
                        placeholder={t('labelPlaceholder')}
                      />
                      <OperatorInput
                        type="password"
                        value={secretDrafts[connection.serverKey] ?? ''}
                        onChange={(event) => setSecretDrafts((current) => ({ ...current, [connection.serverKey]: event.target.value }))}
                        placeholder={connection.authStrategy === 'api_key' ? t('apiKeyPlaceholder') : t('apiTokenPlaceholder')}
                      />
                      <div className="flex justify-end">
                        <Button variant="hero" size="sm" onClick={() => handleManualConnect(connection.serverKey)} disabled={!canSave || savingKey === connection.serverKey}>
                          {savingKey === connection.serverKey ? '...' : t('connectManual')}
                        </Button>
                      </div>
                    </div>
                  ) : null}

                  {connection.toolNames.length > 0 ? (
                    <div className="mt-4 flex flex-wrap gap-2">
                      {connection.toolNames.slice(0, 12).map((toolName) => (
                        <Badge key={toolName} variant="outline">{toolName}</Badge>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}

        <div className="rounded-3xl border border-dashed border-white/10 p-4">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold text-[color:var(--operator-foreground)]">{t('customRequestTitle')}</h3>
            <p className="text-sm text-[color:var(--operator-muted)]">{t('customRequestDescription')}</p>
          </div>
          <div className="mt-4 space-y-3">
            <OperatorInput value={requestName} onChange={(event) => setRequestName(event.target.value)} placeholder={t('requestNamePlaceholder')} />
            <OperatorInput type="url" value={requestUrl} onChange={(event) => setRequestUrl(event.target.value)} placeholder={t('requestUrlPlaceholder')} />
            <OperatorTextarea value={requestNotes} onChange={(event) => setRequestNotes(event.target.value)} placeholder={t('requestNotesPlaceholder')} />
            <div className="flex justify-end">
              <Button variant="glass" size="sm" onClick={handleRequestReview} disabled={!requestName.trim() || !requestUrl.trim() || requesting}>
                {requesting ? '...' : t('requestReview')}
              </Button>
            </div>
          </div>
        </div>
      </SectionCardBody>
    </SectionCard>
  );
}
