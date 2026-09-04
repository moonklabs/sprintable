'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { fetchWithAuth } from '@/lib/db/client';
import { channelLabel } from '@/lib/channel-label';
import { ChannelStatusChip } from '@/components/channel-connect/channel-status-chip';
import { deriveChannelConnectionStatus, worstChannelConnectionStatus } from '@/components/channel-connect/connection-status';
import { AppCredentialsCard } from '@/components/channel-connect/app-credentials-card';
import { PastedSecretConnectCard } from '@/components/channel-connect/pasted-secret-connect-card';
import { connectErrorLabelKey } from '@/components/channel-connect/connect-error';
import type { AppCredentialsStatusResponse, ChannelConnectionResponse, TestConnectionResponse } from '@/components/channel-connect/types';

/**
 * story #3376(Phase1·마케팅운영) — 소셜 채널 OAuth 연결 화면. org-connectors(/organization/
 * connectors, «에이전트가 쓰는 도구 계약»)와 주체·수명이 달라 별도 라우트로 분리됐다(PO
 * 확定 2026-09-03 — 한 페이지 탭으로 섞으면 "연결"이라는 같은 말을 두 뜻으로 읽는다).
 *
 * story f30da19a(페드루 PO 확定 2026-09-04) — 하드코딩 CHANNELS 배열을 걷어내고 BE
 * `GET .../channel-connections/available-channels`(CHANNEL_ADAPTERS 레지스트리 파생)
 * 목록으로 무엇을 그릴지 결정한다. sandbox는 그 목록이 dev에서만 포함해 주므로(prod엔
 * SANDBOX_CHANNEL_ENABLED 자체가 없음) 이 화면에 별도 env 분기가 없다 — 「없는 자리를
 * 그리지 않는다」(유나 확定 §13-4)가 데이터 자체로 성립한다.
 */
interface AvailableChannelItem {
  channel: string;
  display_name: string;
  credential_kind: string;
  kind: string;
}

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
          <p className="flex flex-wrap items-center gap-1.5 truncate text-sm font-medium text-foreground">
            {conn.account_label ?? conn.account_id}
            {/* story f30da19a AC4③(유나 확定) — 연결 카드는 「테스트용 연결」(글 목록/
                캘린더의 「테스트」와 다른 정본 — 여기는 "이 연결 자체가 테스트"라는 뜻). */}
            {conn.channel === 'sandbox' ? (
              <span
                className="inline-flex items-center rounded-full border border-border px-1.5 py-0.5 text-xs font-normal text-muted-foreground"
                data-testid="channel-connect-sandbox-connection-badge"
              >
                {t('channelSandboxConnectionBadge')}
              </span>
            ) : null}
          </p>
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
        // 유나 design verdict(f9cab0c23) — 소형 텍스트에 계열색 직접은 라이트 대비 미달
        // (성공 #1F9D57 on white = 3.49, 4.5 미달). ChannelStatusChip과 같은 원칙 —
        // 성패는 dot으로, 텍스트는 항상 text-foreground.
        <p className="flex items-center gap-1.5 text-xs text-foreground">
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${testResult.ok ? 'bg-success' : 'bg-destructive'}`}
            aria-hidden="true"
          />
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
  item, connections, credentials, isOwner, orgId, onRefresh, t,
}: {
  item: AvailableChannelItem;
  connections: ChannelConnectionResponse[];
  credentials: AppCredentialsStatusResponse | undefined;
  isOwner: boolean;
  orgId: string;
  onRefresh: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const { channel, credential_kind } = item;
  const rowStatuses = connections.map((c) =>
    deriveChannelConnectionStatus({
      serverStatus: c.status, tokenExpiresAt: c.token_expires_at, canAutoRefresh: c.can_auto_refresh,
    }).status,
  );
  const effectiveSource = credentials?.effective_source ?? 'none';
  // story f30da19a(AC2) — 앱 자격 미완 게이팅은 credential_kind='oauth'에만 뜻이 있다
  // (sandbox·future pasted_secret 채널은 애초에 app-credentials 개념이 없다).
  const canStartConnect = credential_kind !== 'oauth' || effectiveSource !== 'none';
  const channelStatus = connections.length === 0
    ? deriveChannelConnectionStatus({ effectiveSource: credential_kind === 'oauth' ? effectiveSource : 'org' }).status
    : worstChannelConnectionStatus(rowStatuses);

  // story f30da19a(AC2) — sandbox(credential_kind='none')는 OAuth authorize 리다이렉트가
  // 아니라 BFF POST 한 번으로 연결이 즉시 생긴다(멱등, BE 5b27b32f). 성공하면 페이지
  // 리로드 없이 onRefresh()로 새 행을 반영한다.
  const [creatingSandbox, setCreatingSandbox] = useState(false);
  const [sandboxError, setSandboxError] = useState<string | null>(null);
  const handleCreateSandbox = useCallback(async () => {
    setCreatingSandbox(true);
    setSandboxError(null);
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/channel-connections/sandbox`, { method: 'POST' });
      if (res.ok) {
        onRefresh();
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
      const code = body?.error?.code;
      setSandboxError(
        code === 'CHANNEL_CONNECTION_OWNER_OR_ADMIN_ONLY'
          ? t('channelOwnerOnlyReason')
          // AC2 — 404 CHANNEL_SANDBOX_DISABLED는 이 버튼이 애초에 안 그려져야 정상이다
          // (available-channels 목록에 sandbox가 없으면 이 컴포넌트 자체가 안 만들어짐).
          // 그래도 두 요청 사이에 서버 설정이 바뀌는 경합을 대비한 방어적 문구만.
          : code === 'CHANNEL_SANDBOX_DISABLED'
            ? t('channelSandboxDisabledReason')
            : t('channelSandboxCreateFailed'),
      );
    } catch {
      setSandboxError(t('channelSandboxCreateFailed'));
    } finally {
      setCreatingSandbox(false);
    }
  }, [orgId, onRefresh, t]);

  return (
    <SectionCard>
      <SectionCardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">{channelLabel(channel, t)}</h2>
          {/* story dd29e6dd(유나 5회차 관찰) — rollup 칩은 여러 연결의 «최악»을 요약하는
              것이 존재 이유라, 연결이 1개면 요약할 것이 없어 행 칩과 같은 문장을 두 번
              보여줬다(0개일 때는 애초에 행 칩 자체가 없어 중복이 안 남). 연결 ≥2일 때만. */}
          {connections.length >= 2 ? <ChannelStatusChip status={channelStatus} /> : null}
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
          {credential_kind === 'oauth' ? (
            isOwner ? (
              <a href={canStartConnect ? `/api/oauth-channel/authorize?org=${orgId}&channel=${channel}` : undefined}>
                <Button size="sm" disabled={!canStartConnect}>
                  {t('channelConnectAction', { channel: channelLabel(channel, t) })}
                </Button>
              </a>
            ) : (
              <Button size="sm" disabled>{t('channelConnectAction', { channel: channelLabel(channel, t) })}</Button>
            )
          ) : credential_kind === 'none' ? (
            isOwner ? (
              <Button
                size="sm" onClick={() => void handleCreateSandbox()} disabled={creatingSandbox}
                data-testid="channel-connect-sandbox-button"
              >
                {creatingSandbox ? t('channelConnectSandboxPendingCta') : t('channelConnectSandboxAction', { channel: channelLabel(channel, t) })}
              </Button>
            ) : null
          ) : credential_kind === 'pasted_secret' ? (
            // story #3450 FE 후속(3653a18c §2 "②발급해서 붙여넣기", PO 確定
            // 2026-09-04 23:13Z) — 자리 채움. isOwner는 이 파일의 owner-or-admin
            // 상수(oauth/sandbox와 동일 게이팅, §5 "연결·해제는 owner" 취지에 admin
            // 까지 넓힌 기존 결정 그대로 재사용).
            <PastedSecretConnectCard channel={channel} orgId={orgId} isOwner={isOwner} onConnected={onRefresh} t={t} />
          ) : null}
          {credential_kind === 'oauth' && !canStartConnect ? (
            <p className="text-xs text-muted-foreground">{t('channelConfigIncompleteReason')}</p>
          ) : null}
          {(credential_kind === 'oauth' || credential_kind === 'none') && !isOwner ? (
            <p className="text-xs text-muted-foreground">{t('channelOwnerOnlyReason')}</p>
          ) : null}
          {credential_kind === 'none' && sandboxError ? (
            <p className="text-xs text-muted-foreground" data-testid="channel-connect-sandbox-error">{sandboxError}</p>
          ) : null}
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

  const [availableChannels, setAvailableChannels] = useState<AvailableChannelItem[]>([]);
  const [connections, setConnections] = useState<ChannelConnectionResponse[]>([]);
  const [credentialsByChannel, setCredentialsByChannel] = useState<Record<string, AppCredentialsStatusResponse>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setLoadError(false);
    try {
      const [availableRes, connsRes] = await Promise.all([
        fetchWithAuth(`/api/organizations/${orgId}/channel-connections/available-channels`),
        fetchWithAuth(`/api/organizations/${orgId}/channel-connections`),
      ]);
      if (!availableRes.ok || !connsRes.ok) {
        setLoadError(true);
        return;
      }
      const availableJson = (await availableRes.json().catch(() => null)) as { data?: AvailableChannelItem[] } | null;
      // story #3450 후속(페드루 PO 確定 2026-09-05, f30da19a 2026-09-04 13:52Z 결정을
      // PO가 직접 뒤집음) — 연결 필요 여부는 BE `requires_connection`이 결정한다
      // (f30da19a AC1, hosted_site=False라 이 목록에 애초에 안 옴). FE는 kind로 한 번
      // 더 거르지 않는다 — kind='blog'+credential_kind='pasted_secret'(WordPress·
      // webhook)이 블루프린트 §2(a) 대상인데 그 필터가 조용히 삼키고 있었다.
      const items = availableJson?.data ?? [];
      setAvailableChannels(items);
      const connsJson = (await connsRes.json().catch(() => null)) as { data?: ChannelConnectionResponse[] } | null;
      setConnections(connsJson?.data ?? []);

      const oauthChannels = items.filter((it) => it.credential_kind === 'oauth');
      const credResList = await Promise.all(
        oauthChannels.map((it) => fetchWithAuth(`/api/organizations/${orgId}/channel-connections/${it.channel}/app-credentials`)),
      );
      const nextCreds: Record<string, AppCredentialsStatusResponse> = {};
      for (let i = 0; i < oauthChannels.length; i++) {
        const res = credResList[i];
        if (res?.ok) {
          const json = (await res.json().catch(() => null)) as { data?: AppCredentialsStatusResponse } | null;
          if (json?.data) nextCreds[oauthChannels[i]!.channel] = json.data;
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
          <AlertDescription>{t('channelConnectSuccess', { channel: channelLabel(connected, t) })}</AlertDescription>
        </Alert>
      ) : null}
      {connectError ? (
        <Alert variant="destructive" role="alert" aria-live="assertive" aria-atomic="true">
          <AlertDescription>{t(connectErrorLabelKey(connectError, isOwner))}</AlertDescription>
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
          {availableChannels.filter((it) => it.credential_kind === 'oauth').map((it) => (
            <AppCredentialsCard
              key={it.channel}
              channel={it.channel}
              orgId={orgId ?? ''}
              isOwner={isOwner}
              credentials={credentialsByChannel[it.channel]}
              onSaved={() => void load()}
            />
          ))}
          {availableChannels.map((it) => (
            <ChannelSection
              key={it.channel}
              item={it}
              connections={connections.filter((c) => c.channel === it.channel)}
              credentials={credentialsByChannel[it.channel]}
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
