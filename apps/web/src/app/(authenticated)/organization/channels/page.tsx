'use client';

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { fetchWithAuth } from '@/lib/db/client';
import { channelLabel } from '@/lib/channel-label';
import { formatRelativeTime } from '@/lib/storage/format';
import { resolveDisplayTimezone } from '@/components/content/schedule-format';
import { ChannelStatusChip } from '@/components/channel-connect/channel-status-chip';
import { deriveChannelConnectionStatus, worstChannelConnectionStatus } from '@/components/channel-connect/connection-status';
import { AppCredentialsCard } from '@/components/channel-connect/app-credentials-card';
import { PastedSecretConnectCard } from '@/components/channel-connect/pasted-secret-connect-card';
import { ReplaceCredentialCard } from '@/components/channel-connect/replace-credential-card';
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

// story #3540(Phase1·마케팅운영, 페드루 PO 確定 2026-09-06) — 「성과 수집」 섹션. 발행
// 채널 연결과 별개 축(beacon·UTM 둘 다 ChannelConnection 행이 아니다) — GA4는 Phase 2
// 선행이라 이 화면에도 그 줄을 아예 안 그린다(유나 §13-7 「없는 자리를 그리지
// 않는다」). BE는 이미 measurement-connections이 넷 다 판정해 준다 — 화면은 안 짓는다.
interface MeasurementConnectionItem {
  key: 'beacon' | 'utm';
  status: string;
  last_seen_at: string | null;
  count_7d: number | null;
  settings_path: string | null;
}

// story #3540 PO 確定4 — 「시작하기」/「키 보기」는 같은 액션(GET metering-key, 키
// 없으면 최초 발급·있으면 반환만 — 발급 부작용 0은 BE가 이미 pin)이고 같은 자리에
// 인라인 패널을 연다. 재발급(rotate)·설치 검증 UI는 4180f67f 잔여(이 스토리 스코프
// 밖) — 여기는 「받아서 심는다」까지만.
function BeaconKeyPanel({ publicKey, t }: { publicKey: string; t: ReturnType<typeof useTranslations> }) {
  const [copied, setCopied] = useState(false);
  // 페드루 PO REQUIRED①(2026-09-06, #3896 리뷰) — window.location.origin은 이
  // 대시보드(FE) 호스트다. 고객이 그대로 복사하면 없는 경로로 beacon을 쏜다 —
  // 정본은 sprintable-landing의 view-beacon.tsx가 실제로 쓰는 BE 베이스
  // (NEXT_PUBLIC_FASTAPI_URL, fastapi-proxy.ts:16과 같은 값)다. UTM 4키·
  // keepalive:true도 그 실물과 동형(페이지 언로드 중에도 요청이 끊기지 않게).
  const backendBase = process.env['NEXT_PUBLIC_FASTAPI_URL'] ?? '';
  const snippet = `fetch('${backendBase}/api/v2/public/pageview', {\n  method: 'POST',\n  keepalive: true,\n  headers: { 'Content-Type': 'application/json' },\n  body: JSON.stringify({\n    public_key: '${publicKey}',\n    path: location.pathname,\n    referrer: document.referrer || null,\n    utm_source: new URLSearchParams(location.search).get('utm_source'),\n    utm_medium: new URLSearchParams(location.search).get('utm_medium'),\n    utm_campaign: new URLSearchParams(location.search).get('utm_campaign'),\n    utm_content: new URLSearchParams(location.search).get('utm_content'),\n  }),\n});`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(publicKey);
    } catch {
      // clipboard 실패는 조용히 무시(복사 버튼 재클릭으로 재시도 가능).
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-2 rounded-md border border-border p-3" data-testid="measurement-beacon-key-panel">
      <div className="space-y-1">
        <p className="text-xs font-medium text-muted-foreground">{t('measurementBeaconKeyLabel')}</p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="rounded bg-muted px-2 py-1 text-xs" data-testid="measurement-beacon-key-value">{publicKey}</code>
          <Button size="sm" variant="outline" onClick={() => void handleCopy()}>
            {copied ? t('measurementBeaconKeyCopied') : t('measurementBeaconKeyCopyAction')}
          </Button>
        </div>
      </div>
      <div className="space-y-1">
        <p className="text-xs font-medium text-muted-foreground">{t('measurementBeaconSnippetLabel')}</p>
        <pre className="overflow-x-auto rounded bg-muted p-2 text-xs" data-testid="measurement-beacon-snippet">{snippet}</pre>
      </div>
    </div>
  );
}

function MeasurementConnectionsSection({
  items, orgId, onRefresh, t,
}: {
  items: MeasurementConnectionItem[];
  orgId: string;
  onRefresh: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const locale = useLocale();
  const displayTimezone = resolveDisplayTimezone().tz;
  const [beaconPanel, setBeaconPanel] = useState<{ publicKey: string } | null>(null);
  const [beaconPanelLoading, setBeaconPanelLoading] = useState(false);
  const [beaconPanelError, setBeaconPanelError] = useState(false);

  const beacon = items.find((it) => it.key === 'beacon');
  const utm = items.find((it) => it.key === 'utm');

  const handleShowBeaconKey = useCallback(async () => {
    setBeaconPanelLoading(true);
    setBeaconPanelError(false);
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/metering-key`);
      if (!res.ok) { setBeaconPanelError(true); return; }
      const json = (await res.json().catch(() => null)) as { data?: { public_key: string } } | null;
      if (!json?.data) { setBeaconPanelError(true); return; }
      setBeaconPanel({ publicKey: json.data.public_key });
      // PO 確定4 — 「같은 마운트에서 no_data_yet으로 갱신(재로드 요구 X)」. 최초
      // 발급 뒤엔 status가 not_started→no_data_yet으로 바뀌어야 정확하다(beacon이
      // 아직 안 찍혔어도 키는 이제 있다).
      onRefresh();
    } catch {
      setBeaconPanelError(true);
    } finally {
      setBeaconPanelLoading(false);
    }
  }, [orgId, onRefresh]);

  return (
    <div className="space-y-4 border-t border-border pt-6" data-testid="measurement-connections-section">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold text-foreground">{t('measurementSectionTitle')}</h2>
        <p className="text-xs text-muted-foreground">{t('measurementSectionSubtitle')}</p>
      </div>

      {beacon ? (
        <div className="space-y-2" data-testid="measurement-beacon-row">
          <p className="text-sm font-medium text-foreground">{t('measurementBeaconLabel')}</p>
          <p className="text-sm text-foreground" data-testid="measurement-beacon-status">
            {beacon.status === 'not_started'
              ? t('measurementBeaconNotStarted')
              : beacon.status === 'no_data_yet'
                ? t('measurementBeaconNoDataYet')
                : t('measurementBeaconHasData', {
                    time: beacon.last_seen_at ? formatRelativeTime(beacon.last_seen_at, locale, displayTimezone) : '',
                    // 페드루 PO REQUIRED③(2026-09-06, #3896 리뷰) — count_7d(0 포함,
                    // null≠0 원칙 — has_data 상태면 항상 실수라 BE가 이미 보장).
                    count: beacon.count_7d ?? 0,
                  })}
          </p>
          {!beaconPanel ? (
            <Button size="sm" variant="outline" onClick={() => void handleShowBeaconKey()} disabled={beaconPanelLoading}>
              {beacon.status === 'not_started' ? t('measurementBeaconStartAction') : t('measurementBeaconViewKeyAction')}
            </Button>
          ) : (
            <BeaconKeyPanel publicKey={beaconPanel.publicKey} t={t} />
          )}
          {beaconPanelError ? (
            <p className="text-xs text-destructive" data-testid="measurement-beacon-key-error">{t('measurementBeaconKeyFailed')}</p>
          ) : null}
        </div>
      ) : null}

      {utm ? (
        <div className="space-y-2" data-testid="measurement-utm-row">
          <p className="text-sm font-medium text-foreground">{t('measurementUtmLabel')}</p>
          <p className="text-sm text-foreground" data-testid="measurement-utm-status">
            {utm.status === 'auto'
              ? t('measurementUtmAuto')
              : utm.status === 'manual'
                ? t('measurementUtmManual')
                : t('measurementUtmOff')}
          </p>
          {utm.settings_path ? (
            <a href={utm.settings_path} className="text-xs underline text-foreground" data-testid="measurement-utm-settings-link">
              {t('measurementUtmSettingsLink')}
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
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
  conn, isOwnerStrict, isOwnerOrAdmin, orgId, onDisconnected, t,
}: {
  conn: ChannelConnectionResponse;
  isOwnerStrict: boolean;
  isOwnerOrAdmin: boolean;
  orgId: string;
  onDisconnected: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const derived = deriveChannelConnectionStatus({
    serverStatus: conn.status, tokenExpiresAt: conn.token_expires_at,
    canAutoRefresh: conn.can_auto_refresh, lastError: conn.last_error,
  });
  // story #3486(유나 10회차, 3436 묶음 8 정본 재사용) — 「연결 시각」은 약속이 아니라
  // 기록이라 상대시각이 맞다(묶음 8 판정 그대로). 새 포맷 함수를 신설하지 않는다.
  const locale = useLocale();
  const displayTimezone = resolveDisplayTimezone().tz;
  const [testResult, setTestResult] = useState<TestConnectionResponse | null>(null);
  const [testing, setTesting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

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

  // story #3504(PO 정본③) — 옛 `if (res.ok) onDisconnected()`뿐이라 실패하면
  // 스피너만 멎고 화면이 그대로였다. replace-credential-card.tsx의 error+Alert
  // 패턴을 그대로 이식 — 403(CHANNEL_CONNECTION_OWNER_ONLY)은 「이 작업은
  // owner만 할 수 있습니다」(§5 정본 문구 재사용, connectErrorLabelKey의 다른
  // 자리용 문구와 안 섞는다), 그 외는 일반 실패.
  const handleDisconnect = useCallback(async () => {
    setDisconnecting(true);
    setDisconnectError(null);
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/channel-connections/${conn.id}/disconnect`, { method: 'POST' });
      if (res.ok) {
        onDisconnected();
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
      const code = body?.error?.code;
      setDisconnectError(code === 'CHANNEL_CONNECTION_OWNER_ONLY' ? t('channelOwnerOnlyReason') : t('channelDisconnectFailed'));
    } finally {
      setDisconnecting(false);
    }
  }, [orgId, conn.id, onDisconnected, t]);

  return (
    <div className="space-y-2 border-b border-border px-3 py-3 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-1.5 truncate text-sm font-medium text-foreground">
            {conn.account_label ?? conn.account_id}
            {/* story f30da19a AC4③(유나 확定) — 연결 카드는 「테스트용 연결」(글 목록/
                캘린더의 「테스트」와 다른 정본 — 여기는 "이 연결 자체가 테스트"라는 뜻).
                story #3523(PO 실측(3523 그라운딩·page.tsx:239)·確定 2026-09-06) — channel===
                'sandbox' 하드코딩은 instagram_sandbox 등 다른 샌드박스 채널의 배지를
                놓친다. credential_kind==='none'이 "이 연결은 OAuth 없는 테스트용"이라는
                뜻 그 자체(BE ChannelAdapterConfig.credential_kind 정의와 동형 축) —
                채널 문자열을 나열하지 않아도 신규 샌드박스 채널이 늘 때 자동으로 맞다. */}
            {conn.credential_kind === 'none' ? (
              <span
                className="inline-flex items-center rounded-full border border-border px-1.5 py-0.5 text-xs font-normal text-muted-foreground"
                data-testid="channel-connect-sandbox-connection-badge"
              >
                {t('channelSandboxConnectionBadge')}
              </span>
            ) : null}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('channelConnectedBy', { time: formatRelativeTime(conn.created_at, locale, displayTimezone) })}
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
        {/* story #3504 — 재인증·해제는 owner 전용(_require_owner). §5-2 "그려진
            컨트롤은 「할 수 있다」는 단정" — admin에게 넓게 그리고 403으로 막지
            않는다: 안 그리고 사유 한 줄만. */}
        {derived.status === 'reauth_required' ? (
          isOwnerStrict ? (
            <a href={`/api/oauth-channel/authorize?org=${orgId}&channel=${conn.channel}`}>
              <Button size="sm" variant="outline">{t('channelReauthAction')}</Button>
            </a>
          ) : (
            <span className="text-xs text-muted-foreground">{t('channelOwnerOnlyReason')}</span>
          )
        ) : null}
        {isOwnerStrict ? (
          <Button size="sm" variant="destructive" onClick={() => void handleDisconnect()} disabled={disconnecting}>
            {t('channelDisconnectAction')}
          </Button>
        ) : (
          <span className="text-xs text-muted-foreground">{t('channelOwnerOnlyReason')}</span>
        )}
      </div>
      {disconnectError ? (
        <Alert variant="destructive" role="alert" aria-live="assertive" aria-atomic="true" data-testid="channel-disconnect-error">
          <AlertDescription>{disconnectError}</AlertDescription>
        </Alert>
      ) : null}
      {/* story #3492 — 붙여넣기(pasted_secret) 연결만 「자격 바꾸기」를 갖는다(해제→
          재연결 대신 id 불변 제자리 교체). oauth 연결은 위 재인증 버튼이 그 역할).
          자격 교체는 owner|admin(_require_owner_or_admin) — isOwnerOrAdmin. */}
      {conn.credential_kind === 'pasted_secret' ? (
        <ReplaceCredentialCard
          channel={conn.channel}
          connectionId={conn.id}
          secretHint={conn.secret_hint}
          isOwner={isOwnerOrAdmin}
          orgId={orgId}
          onReplaced={onDisconnected}
          t={t}
        />
      ) : null}
    </div>
  );
}

function ChannelSection({
  item, connections, credentials, isOwnerStrict, isOwnerOrAdmin, orgId, onRefresh, t,
}: {
  item: AvailableChannelItem;
  connections: ChannelConnectionResponse[];
  credentials: AppCredentialsStatusResponse | undefined;
  isOwnerStrict: boolean;
  isOwnerOrAdmin: boolean;
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
  //
  // story #3523(PO 실측(3523 그라운딩·page.tsx:239)·確定 2026-09-06) — 이 경로가 channel
  // 문자열과 무관하게 항상 리터럴 `sandbox`로 고정돼 있어, credential_kind==='none'인
  // 카드 전부(instagram_sandbox 포함)가 눌러도 실은 Threads류 sandbox 연결을
  // 만드는 조용한 오분기였다. `${item.channel}/sandbox`(BE #3523 범용 라우트)로
  // 교체 — 이 카드가 어떤 채널인지는 item.channel이 항상 정확히 안다.
  const [creatingSandbox, setCreatingSandbox] = useState(false);
  const [sandboxError, setSandboxError] = useState<string | null>(null);
  const handleCreateSandbox = useCallback(async () => {
    setCreatingSandbox(true);
    setSandboxError(null);
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/channel-connections/${channel}/sandbox`, { method: 'POST' });
      if (res.ok) {
        onRefresh();
        return;
      }
      const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
      const code = body?.error?.code;
      setSandboxError(
        code === 'CHANNEL_CONNECTION_OWNER_OR_ADMIN_ONLY'
          ? t('channelOwnerOrAdminOnlyReason')
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
  }, [orgId, channel, onRefresh, t]);

  return (
    <SectionCard>
      <SectionCardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2" data-testid="channel-section-header">
          <h2 className="text-sm font-semibold text-foreground">{channelLabel(channel, t)}</h2>
          {/* story dd29e6dd(유나 5회차 관찰·정본 3653a18c §3-3) — 「메아리」(헤더 rollup이
              행 칩과 같은 문장을 두 번 보여주는 것)는 **연결이 정확히 1개일 때만** 성립한다
              (두 칩이 실제로 있어야 메아리가 생긴다). 연결 0개일 때 헤더 칩은 rollup이
              아니라 **자격 상태**(deriveChannelConnectionStatus({effectiveSource}) →
              「설정 미완」·「미연결」)를 지는 **유일한 칩**이라 지우면 신호 자체가 사라진다
              (카디르군 REQUEST_CHANGES 2026-09-05 뒤, 최초 처방 `>= 2`가 이 자리에서
              회귀를 냈다 — PO 보정, 유나 지적). 그래서 조건은 `connections.length !== 1`
              (0=자격 칩 그대로·1=메아리라 숨김·≥2=rollup+행 각각). data-testid로 자리
              (헤더 vs 행)를 구조적으로 구분해 테스트가 값이 아니라 위치를 잰다. */}
          {connections.length !== 1 ? <ChannelStatusChip status={channelStatus} /> : null}
        </div>
      </SectionCardHeader>
      <SectionCardBody className="space-y-4">
        {connections.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('channelNoConnections')}</p>
        ) : (
          <div className="divide-y divide-border overflow-hidden rounded-md border border-border" data-testid="channel-section-rows">
            {connections.map((c) => (
              <ConnectionRow key={c.id} conn={c} isOwnerStrict={isOwnerStrict} isOwnerOrAdmin={isOwnerOrAdmin} orgId={orgId} onDisconnected={onRefresh} t={t} />
            ))}
          </div>
        )}
        <div className="flex flex-col items-start gap-1">
          {/* story #3504(PO 정본§5) — OAuth 연결은 owner 전용(authorize_channel_connection
              = _require_owner). 권한을 먼저 판정해 안 그린다(옛 `<Button disabled>`는
              §5-2가 금지한 "권한인데 비활성"이었다 — L275 문제였던 자리) — 그 다음에야
              (owner인 경우에만) 자격 미설정이라는 **상태** 축을 disabled로 표현한다. */}
          {credential_kind === 'oauth' ? (
            isOwnerStrict ? (
              <a href={canStartConnect ? `/api/oauth-channel/authorize?org=${orgId}&channel=${channel}` : undefined}>
                <Button size="sm" disabled={!canStartConnect}>
                  {t('channelConnectAction', { channel: channelLabel(channel, t) })}
                </Button>
              </a>
            ) : null
          ) : credential_kind === 'none' ? (
            // story #3537(유나 18회차 발견, PO 確定 2026-09-06) — 배지는 연결 「행」의
            // credential_kind(상태)로 그리는데, 이 버튼은 채널 「항목」의 credential_kind
            // (성질)로만 그려 연결이 이미 있어도 「…연결 만들기」가 활성으로 남았다 —
            // 이름이 "만들기"인데 새로 생기는 게 없으면 라벨이 거짓말이 된다(§17-21).
            // connections는 이미 이 channel로 필터된 배열(부모 컴포넌트, 위 connections.
            // length===0/!==1 판정과 같은 변수) — 활성/만료 등 상태 무관하게 행이 하나라도
            // 있으면 버튼 자체를 안 그린다("다시 만들기" 경로는 의도적으로 두지 않는다).
            // sandbox 생성은 owner|admin(create_sandbox_channel_connection = _require_owner_or_admin).
            isOwnerOrAdmin && connections.length === 0 ? (
              <Button
                size="sm" onClick={() => void handleCreateSandbox()} disabled={creatingSandbox}
                data-testid="channel-connect-sandbox-button"
              >
                {creatingSandbox ? t('channelConnectSandboxPendingCta') : t('channelConnectSandboxAction', { channel: channelLabel(channel, t) })}
              </Button>
            ) : null
          ) : credential_kind === 'pasted_secret' ? (
            // story #3450 FE 후속(3653a18c §2 "②발급해서 붙여넣기", PO 確定
            // 2026-09-04 23:13Z) — 자리 채움. 붙여넣기 연결은 owner|admin
            // (create_pasted_secret_channel_connection = _require_owner_or_admin).
            <PastedSecretConnectCard channel={channel} orgId={orgId} isOwner={isOwnerOrAdmin} onConnected={onRefresh} t={t} />
          ) : null}
          {credential_kind === 'oauth' && isOwnerStrict && !canStartConnect ? (
            <p className="text-xs text-muted-foreground">{t('channelConfigIncompleteReason')}</p>
          ) : null}
          {/* story #3504 — L297은 «한 자리가 두 폭»이었다(유나 지적). oauth는 owner
              전용 문구, none(sandbox)은 owner|admin 문구 — credential_kind로 갈라야
              한쪽에서 거짓이 안 남는다. */}
          {credential_kind === 'oauth' && !isOwnerStrict ? (
            <p className="text-xs text-muted-foreground">{t('channelOwnerOnlyReason')}</p>
          ) : null}
          {/* story #3537 — 액션 자체가 없는 자리(연결 이미 있음)에 권한 사유 문구를
              남기면 "안 보이는 버튼을 왜 못 누르나"는 존재하지 않는 질문에 답하는
              꼴이라 노이즈다 — 버튼과 조건을 맞춘다. */}
          {credential_kind === 'none' && !isOwnerOrAdmin && connections.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('channelOwnerOrAdminOnlyReason')}</p>
          ) : null}
          {/* story #3521계 유나 #3877 관찰(PO 確定 2026-09-06) — 이 자리는 권한
              사유(§5-2, 위 두 블록처럼 muted)가 아니라 "액션 실패 결과" 슬롯이다
              — 하우스 관례(40:1대비 destructive) 그대로. */}
          {credential_kind === 'none' && sandboxError ? (
            <p className="text-xs text-destructive" data-testid="channel-connect-sandbox-error">{sandboxError}</p>
          ) : null}
        </div>
      </SectionCardBody>
    </SectionCard>
  );
}

export default function OrganizationChannelsPage() {
  const { orgId, orgMemberships } = useDashboardContext();
  const currentRole = orgMemberships.find((o) => o.orgId === orgId)?.role ?? 'member';
  // story #3504(PO 確定 2026-09-05, 유나 doc 3653a18c §5-1/§5-2) — 옛 `isOwner`는
  // 이름과 달리 owner|admin이었다. 서버 폭이 둘(owner 전용 vs owner|admin)이라
  // 화면도 두 불리언을 따로 가진다 — content-rules/page.tsx의 `canEditRules`와
  // 같은 소스(orgMemberships)에서 파생.
  const isOwnerStrict = currentRole === 'owner';
  const isOwnerOrAdmin = currentRole === 'owner' || currentRole === 'admin';
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

  // story #3540 — 「성과 수집」 섹션은 발행 채널 목록·연결 왕복과 별개 축(실패해도
  // 서로를 막지 않는다 — generation_budget/content-rules.py::page.tsx와 동형 관례).
  const [measurementItems, setMeasurementItems] = useState<MeasurementConnectionItem[]>([]);
  const [measurementLoadError, setMeasurementLoadError] = useState(false);
  const loadMeasurement = useCallback(async () => {
    if (!orgId) return;
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/measurement-connections`);
      if (!res.ok) { setMeasurementLoadError(true); return; }
      const json = (await res.json().catch(() => null)) as { data?: MeasurementConnectionItem[] } | null;
      setMeasurementItems(json?.data ?? []);
      setMeasurementLoadError(false);
    } catch {
      setMeasurementLoadError(true);
    }
  }, [orgId]);
  useEffect(() => { void loadMeasurement(); }, [loadMeasurement]);

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
          {/* story #3504 — CHANNEL_APP_CREDENTIALS_MISSING의 "누구에게 요청하나" 분기는
              app-credentials 등록 자격(owner 전용, 앱 자격 저장과 같은 폭)을 묻는다 —
              owner|admin 폭인 isOwnerOrAdmin이 아니라 isOwnerStrict가 맞다. */}
          <AlertDescription>{t(connectErrorLabelKey(connectError, isOwnerStrict))}</AlertDescription>
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
          {/* 앱 자격 저장은 owner 전용(set_channel_app_credentials = _require_owner). */}
          {availableChannels.filter((it) => it.credential_kind === 'oauth').map((it) => (
            <AppCredentialsCard
              key={it.channel}
              channel={it.channel}
              orgId={orgId ?? ''}
              isOwner={isOwnerStrict}
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
              isOwnerStrict={isOwnerStrict}
              isOwnerOrAdmin={isOwnerOrAdmin}
              orgId={orgId ?? ''}
              onRefresh={() => void load()}
              t={t}
            />
          ))}
          {measurementLoadError ? (
            <Alert variant="destructive" role="alert" aria-live="assertive" aria-atomic="true">
              <AlertDescription>{t('measurementLoadFailed')}</AlertDescription>
            </Alert>
          ) : measurementItems.length > 0 ? (
            <MeasurementConnectionsSection items={measurementItems} orgId={orgId ?? ''} onRefresh={() => void loadMeasurement()} t={t} />
          ) : null}
        </>
      )}
    </div>
  );
}
