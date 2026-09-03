'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { fetchWithAuth } from '@/lib/db/client';
import { ChannelStatusChip } from '@/components/channel-connect/channel-status-chip';
import { deriveChannelConnectionStatus, worstChannelConnectionStatus } from '@/components/channel-connect/connection-status';
import { AppCredentialsCard } from '@/components/channel-connect/app-credentials-card';
import { connectErrorLabelKey } from '@/components/channel-connect/connect-error';
import type { AppCredentialsStatusResponse, ChannelConnectionResponse, TestConnectionResponse } from '@/components/channel-connect/types';

/**
 * story #3376(Phase1·마케팅운영) — 소셜 채널 OAuth 연결 화면. org-connectors(/organization/
 * connectors, «에이전트가 쓰는 도구 계약»)와 주체·수명이 달라 별도 라우트로 분리됐다(PO
 * 확定 2026-09-03 — 한 페이지 탭으로 섞으면 "연결"이라는 같은 말을 두 뜻으로 읽는다).
 *
 * Phase 1은 Threads 하나만 구현한다(BE PR#3736 channel_adapters.py). 채널이 늘어나면
 * CHANNELS 배열에 추가하는 것 외 이 페이지 로직 변경은 없다(파생·권한 로직이 channel
 * 문자열에 의존하지 않는다).
 */
const CHANNELS = ['threads'] as const;

function ExpiringSoonNote({ isAutoRefreshInfo, t }: { isAutoRefreshInfo?: boolean; t: ReturnType<typeof useTranslations> }) {
  return (
    <p className="text-xs text-muted-foreground">
      {isAutoRefreshInfo ? t('channelExpiringInfoNote') : t('channelExpiringActionNote')}
    </p>
  );
}

function ReauthNote({ reason, t }: { reason?: 'expired' | 'revoked' | 'error'; t: ReturnType<typeof useTranslations> }) {
  const key = reason === 'revoked' ? 'channelReauthRevoked' : reason === 'error' ? 'channelReauthError' : 'channelReauthExpired';
  return <p className="text-xs text-muted-foreground">{t(key)}</p>;
}

function ConnectionRow({
  conn, isOwner, orgId, onDisconnected, t,
}: {
  conn: ChannelConnectionResponse;
  isOwner: boolean;
  orgId: string;
  onDisconnected: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const derived = deriveChannelConnectionStatus({
    serverStatus: conn.status, tokenExpiresAt: conn.token_expires_at,
    canAutoRefresh: conn.can_auto_refresh, lastError: conn.last_error,
  });
  const [testResult, setTestResult] = useState<TestConnectionResponse | null>(null);
  const [testing, setTesting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  const handleTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/channel-connections/${conn.id}/test`, { method: 'POST' });
      const json = (await res.json().catch(() => null)) as { data?: TestConnectionResponse } | null;
      setTestResult(json?.data ?? { ok: false, error: 'CHANNEL_TEST_FAILED' });
    } catch {
      setTestResult({ ok: false, error: 'CHANNEL_TEST_FAILED' });
    } finally {
      setTesting(false);
    }
  }, [orgId, conn.id]);

  const handleDisconnect = useCallback(async () => {
    setDisconnecting(true);
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/channel-connections/${conn.id}/disconnect`, { method: 'POST' });
      if (res.ok) onDisconnected();
    } finally {
      setDisconnecting(false);
    }
  }, [orgId, conn.id, onDisconnected]);

  return (
    <div className="space-y-2 border-b border-border px-3 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-foreground">{conn.account_label ?? conn.account_id}</p>
          <p className="text-xs text-muted-foreground">
            {t('channelConnectedBy', { time: new Date(conn.created_at).toLocaleString() })}
          </p>
        </div>
        <ChannelStatusChip status={derived.status} />
      </div>
      {derived.status === 'expiring_soon' ? <ExpiringSoonNote isAutoRefreshInfo={derived.isAutoRefreshInfo} t={t} /> : null}
      {derived.status === 'reauth_required' ? <ReauthNote reason={derived.reauthReason} t={t} /> : null}
      {conn.last_error ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">{t('channelLastErrorToggle')}</summary>
          <p className="mt-1 font-mono">{conn.last_error}</p>
        </details>
      ) : null}
      {testResult ? (
        <p className={`text-xs ${testResult.ok ? 'text-success' : 'text-destructive'}`}>
          {testResult.ok
            ? t('channelTestOk', { account: String(testResult.account?.['username'] ?? conn.account_id) })
            : t('channelTestFailed', { error: testResult.error ?? '' })}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" onClick={() => void handleTest()} disabled={testing}>
          {t('channelTestAction')}
        </Button>
        {derived.status === 'reauth_required' ? (
          isOwner ? (
            <a href={`/api/oauth-channel/authorize?org=${orgId}&channel=${conn.channel}`}>
              <Button size="sm" variant="outline">{t('channelReauthAction')}</Button>
            </a>
          ) : (
            <span className="text-xs text-muted-foreground">{t('channelOwnerOnlyReason')}</span>
          )
        ) : null}
        {isOwner ? (
          <Button size="sm" variant="destructive" onClick={() => void handleDisconnect()} disabled={disconnecting}>
            {t('channelDisconnectAction')}
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">{t('channelOwnerOnlyReason')}</span>
        )}
      </div>
    </div>
  );
}

function ChannelSection({
  channel, connections, credentials, isOwner, orgId, onRefresh, t,
}: {
  channel: string;
  connections: ChannelConnectionResponse[];
  credentials: AppCredentialsStatusResponse | undefined;
  isOwner: boolean;
  orgId: string;
  onRefresh: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const rowStatuses = connections.map((c) =>
    deriveChannelConnectionStatus({
      serverStatus: c.status, tokenExpiresAt: c.token_expires_at, canAutoRefresh: c.can_auto_refresh,
    }).status,
  );
  const effectiveSource = credentials?.effective_source ?? 'none';
  const channelStatus = connections.length === 0
    ? deriveChannelConnectionStatus({ effectiveSource }).status
    : worstChannelConnectionStatus(rowStatuses);
  const canStartConnect = effectiveSource !== 'none';

  return (
    <SectionCard>
      <SectionCardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold capitalize text-foreground">{channel}</h2>
          <ChannelStatusChip status={channelStatus} />
        </div>
      </SectionCardHeader>
      <SectionCardBody className="space-y-4">
        {connections.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('channelNoConnections')}</p>
        ) : (
          <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
            {connections.map((c) => (
              <ConnectionRow key={c.id} conn={c} isOwner={isOwner} orgId={orgId} onDisconnected={onRefresh} t={t} />
            ))}
          </div>
        )}
        <div className="flex flex-col items-start gap-1">
          {isOwner ? (
            <a href={canStartConnect ? `/api/oauth-channel/authorize?org=${orgId}&channel=${channel}` : undefined}>
              <Button size="sm" disabled={!canStartConnect}>
                {t('channelConnectAction', { channel })}
              </Button>
            </a>
          ) : (
            <Button size="sm" disabled>{t('channelConnectAction', { channel })}</Button>
          )}
          {!canStartConnect ? <p className="text-xs text-muted-foreground">{t('channelConfigIncompleteReason')}</p> : null}
          {!isOwner ? <p className="text-xs text-muted-foreground">{t('channelOwnerOnlyReason')}</p> : null}
        </div>
      </SectionCardBody>
    </SectionCard>
  );
}

export default function OrganizationChannelsPage() {
  const { orgId, orgMemberships } = useDashboardContext();
  const currentRole = orgMemberships.find((o) => o.orgId === orgId)?.role ?? 'member';
  const isOwner = currentRole === 'admin' || currentRole === 'owner';
  const t = useTranslations('channelConnect');
  const searchParams = useSearchParams();

  const [connections, setConnections] = useState<ChannelConnectionResponse[]>([]);
  const [credentialsByChannel, setCredentialsByChannel] = useState<Record<string, AppCredentialsStatusResponse>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setLoadError(false);
    try {
      const [connsRes, ...credResList] = await Promise.all([
        fetchWithAuth(`/api/organizations/${orgId}/channel-connections`),
        ...CHANNELS.map((ch) => fetchWithAuth(`/api/organizations/${orgId}/channel-connections/${ch}/app-credentials`)),
      ]);
      if (connsRes.ok) {
        const json = (await connsRes.json().catch(() => null)) as { data?: ChannelConnectionResponse[] } | null;
        setConnections(json?.data ?? []);
      } else {
        setLoadError(true);
      }
      const nextCreds: Record<string, AppCredentialsStatusResponse> = {};
      for (let i = 0; i < CHANNELS.length; i++) {
        const res = credResList[i];
        if (res?.ok) {
          const json = (await res.json().catch(() => null)) as { data?: AppCredentialsStatusResponse } | null;
          if (json?.data) nextCreds[CHANNELS[i]!] = json.data;
        }
      }
      setCredentialsByChannel(nextCreds);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => { void load(); }, [load]);

  const connected = searchParams.get('connected');
  const connectError = searchParams.get('connect_error');

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold text-foreground">{t('pageTitle')}</h1>
        <p className="text-sm text-muted-foreground">{t('pageDescription')}</p>
      </div>

      {connected ? (
        <Alert variant="success" role="status" aria-live="polite" aria-atomic="true">
          <AlertDescription>{t('channelConnectSuccess', { channel: connected })}</AlertDescription>
        </Alert>
      ) : null}
      {connectError ? (
        <Alert variant="destructive" role="alert" aria-live="assertive" aria-atomic="true">
          <AlertDescription>{t(connectErrorLabelKey(connectError))}</AlertDescription>
        </Alert>
      ) : null}
      {loadError ? (
        <Alert variant="destructive" role="alert" aria-live="assertive" aria-atomic="true">
          <AlertDescription>{t('channelLoadFailed')}</AlertDescription>
        </Alert>
      ) : null}

      {loading ? (
        <div className="space-y-3">
          {[1, 2].map((i) => <div key={i} className="h-24 animate-pulse rounded-md bg-muted" />)}
        </div>
      ) : (
        <>
          {CHANNELS.map((channel) => (
            <AppCredentialsCard
              key={channel}
              channel={channel}
              orgId={orgId ?? ''}
              isOwner={isOwner}
              credentials={credentialsByChannel[channel]}
              onSaved={() => void load()}
            />
          ))}
          {CHANNELS.map((channel) => (
            <ChannelSection
              key={channel}
              channel={channel}
              connections={connections.filter((c) => c.channel === channel)}
              credentials={credentialsByChannel[channel]}
              isOwner={isOwner}
              orgId={orgId ?? ''}
              onRefresh={() => void load()}
              t={t}
            />
          ))}
        </>
      )}
    </div>
  );
}
