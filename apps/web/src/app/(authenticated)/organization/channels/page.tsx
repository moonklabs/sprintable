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
import { FacebookPageSelectCard, type FacebookPageCandidate } from '@/components/channel-connect/facebook-page-select-card';
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
// 채널 연결과 별개 축(beacon·UTM 둘 다 ChannelConnection 행이 아니다).
//
// story #3583(Phase2·마케팅운영, 페드루 PO 確定 2026-09-06 · 유나 §13-9) — GA4 「고객
// 소유」 연결이 이 셋째 key로 들어온다. status는 기계값 넷: connected(property_id
// 있음)·disconnected·needs_reauth·property_pending(토큰 저장 済·속성 미선택 —
// 「connected인데 property_id가 null」로 뜻을 싣지 않는다, 이름에 의미를 준다는
// PO 판단). property_id/property_name은 connected일 때만 실 값, 나머지는 null.
interface MeasurementConnectionItem {
  key: 'beacon' | 'utm' | 'ga4';
  status: string;
  last_seen_at: string | null;
  count_7d: number | null;
  settings_path: string | null;
  property_id?: string | null;
  property_name?: string | null;
  // story #3583(PO CONDITIONAL, PR#3935, 2026-09-06) — needs_reauth 계약 보강. 행은
  // ConnectionRow가 이미 쓰는 ReauthNote 낱말 그대로 재사용(새 문구 0) — reason이
  // 없으면(구버전 BE 응답 등) note 자체를 안 그린다(모른다≠알려진 사유 하나).
  reason?: 'expired' | 'revoked' | 'error' | null;
}

// story #3583(BE 계약, PO 確定 2026-09-06 스토리 본문) — GA4 속성 선택(property_pending
// 전용). GET .../ga4/properties → [{property_id, display_name}] 목록(Admin API 그대로).
interface Ga4Property {
  property_id: string;
  display_name: string;
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
  const tCommon = useTranslations('common');
  const displayTimezone = resolveDisplayTimezone().tz;
  const [beaconPanel, setBeaconPanel] = useState<{ publicKey: string } | null>(null);
  const [beaconPanelLoading, setBeaconPanelLoading] = useState(false);
  const [beaconPanelError, setBeaconPanelError] = useState(false);

  const beacon = items.find((it) => it.key === 'beacon');
  const utm = items.find((it) => it.key === 'utm');
  const ga4 = items.find((it) => it.key === 'ga4');

  // story #3583 — 인증(authorize)·속성 선택(select)·해제(disconnect) 셋 다 이 컴포넌트가
  // 직접 부른다(beacon의 handleShowBeaconKey와 같은 자리 — 상위로 안 올린다).
  const [ga4AuthorizeLoading, setGa4AuthorizeLoading] = useState(false);
  // 유나 CHANGES ⑤(PR#3935, 2026-09-06, 3575 ⑤ 동형) — 응답 있음(status)과 응답
  // 없음(null, 네트워크 자체가 안 닿음)을 갈라 서로 다른 문장을 쓴다. undefined=오류 없음.
  const [ga4ActionError, setGa4ActionError] = useState<{ status: number | null } | undefined>(undefined);
  const [ga4Properties, setGa4Properties] = useState<Ga4Property[] | null>(null);
  const [ga4PropertiesError, setGa4PropertiesError] = useState(false);
  const [ga4SelectedPropertyId, setGa4SelectedPropertyId] = useState('');
  const [ga4SelectLoading, setGa4SelectLoading] = useState(false);
  const [ga4DisconnectLoading, setGa4DisconnectLoading] = useState(false);

  const handleGa4Authorize = useCallback(async () => {
    setGa4AuthorizeLoading(true);
    setGa4ActionError(undefined);
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/measurement-connections/ga4/authorize`, { method: 'POST' });
      if (!res.ok) { setGa4ActionError({ status: res.status }); return; }
      const json = (await res.json().catch(() => null)) as { data?: { authorize_url: string } } | null;
      if (!json?.data?.authorize_url) { setGa4ActionError({ status: res.status }); return; }
      // story #3583(그라운딩) — 소셜 채널의 GET 기반 BFF 리다이렉트(<a href>)와 달리
      // 이 계약은 POST라 앵커로 못 연다 — fetch 뒤 전체 페이지 리다이렉트.
      window.location.href = json.data.authorize_url;
    } catch {
      setGa4ActionError({ status: null });
      setGa4AuthorizeLoading(false);
    }
  }, [orgId]);

  // story #3583(PO 確定 2026-09-06) — property_pending에 들어서면 목록을 자동으로
  // 부른다(별도 「불러오기」 버튼 없음 — beacon의 "시작하기=키 보기"처럼 이 화면
  // 진입 자체가 요청이다). 유나 CHANGES ④(PR#3935) — 자동 로딩이라 실패 시 사람이
  // 직접 다시 시킬 방법이 없었다 — retryToken을 증가시켜 재요청을 트리거하는
  // 「다시 시도」 버튼을 둔다.
  const [ga4PropertiesRetryToken, setGa4PropertiesRetryToken] = useState(0);
  useEffect(() => {
    if (ga4?.status !== 'property_pending') { setGa4Properties(null); return; }
    let cancelled = false;
    setGa4PropertiesError(false);
    fetchWithAuth(`/api/organizations/${orgId}/measurement-connections/ga4/properties`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json: { data?: Ga4Property[] } | null) => {
        if (cancelled) return;
        if (!json?.data) { setGa4PropertiesError(true); return; }
        setGa4Properties(json.data);
      })
      .catch(() => { if (!cancelled) setGa4PropertiesError(true); });
    return () => { cancelled = true; };
  }, [ga4?.status, orgId, ga4PropertiesRetryToken]);

  const handleGa4Select = useCallback(async () => {
    if (!ga4SelectedPropertyId) return;
    setGa4SelectLoading(true);
    setGa4ActionError(undefined);
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/measurement-connections/ga4/select`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ property_id: ga4SelectedPropertyId }),
      });
      if (!res.ok) { setGa4ActionError({ status: res.status }); return; }
      onRefresh();
    } catch {
      setGa4ActionError({ status: null });
    } finally {
      setGa4SelectLoading(false);
    }
  }, [orgId, ga4SelectedPropertyId, onRefresh]);

  // story #3583(유나 §13-9⑤ 확定) — 확인 대화상자 없음. 그 대신 이 버튼 아래
  // 상시 문장(measurementGa4DisconnectEffect)이 누르기 前에 이미 서 있다.
  const handleGa4Disconnect = useCallback(async () => {
    setGa4DisconnectLoading(true);
    setGa4ActionError(undefined);
    try {
      const res = await fetchWithAuth(`/api/organizations/${orgId}/measurement-connections/ga4`, { method: 'DELETE' });
      if (!res.ok) { setGa4ActionError({ status: res.status }); return; }
      onRefresh();
    } catch {
      setGa4ActionError({ status: null });
    } finally {
      setGa4DisconnectLoading(false);
    }
  }, [orgId, onRefresh]);

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

      {/* story #3583(페드루 PO 確定 2026-09-06, 유나 §13-9·CHANGES PR#3935) — 문장
          리듬(칩 X), beacon·utm과 같은 자리 규율. 상태 낱말은 3종만 재사용
          (channelStatus{Connected,NotConnected,ReauthRequired}) — property_pending은
          새 낱말을 짓지 않고 NotConnected로 접는다(그 대신 이 줄 아래 속성 선택 UI
          자체가 "다음 걸음"을 보인다). */}
      {ga4 ? (
        <div className="space-y-2" data-testid="measurement-ga4-row">
          <p className="text-sm font-medium text-foreground">{t('measurementGa4Label')}</p>
          <p className="text-sm text-foreground" data-testid="measurement-ga4-status">
            {/* 유나 CHANGES 필수②(PR#3935) — property_name이 없으면 「연결됨 · 」
                구분자까지 함께 뺀다(§17-23 ⑤-1, 낱말만 빼면 구분자가 헛돈다). */}
            {ga4.status === 'connected'
              ? (ga4.property_name ? `${t('channelStatusConnected')} · ${ga4.property_name}` : t('channelStatusConnected'))
              : ga4.status === 'needs_reauth'
                ? t('channelStatusReauthRequired')
                : t('channelStatusNotConnected')}
          </p>
          {/* 계약 보강(PO, PR#3935) — needs_reauth에 reason이 실리면 ConnectionRow와
              같은 ReauthNote 낱말을 그대로 재사용한다. reason이 없으면(구버전 응답 등)
              note 자체를 안 그린다. */}
          {ga4.status === 'needs_reauth' && ga4.reason ? <ReauthNote reason={ga4.reason} t={t} /> : null}

          {ga4.status === 'disconnected' || ga4.status === 'needs_reauth' ? (
            <Button
              size="sm" variant="outline" onClick={() => void handleGa4Authorize()}
              disabled={ga4AuthorizeLoading} data-testid="measurement-ga4-authorize-button"
            >
              {ga4.status === 'needs_reauth' ? t('channelReauthAction') : t('channelConnectAction', { channel: 'GA4' })}
            </Button>
          ) : null}

          {ga4.status === 'property_pending' ? (
            <div className="space-y-2" data-testid="measurement-ga4-property-select">
              {ga4PropertiesError ? (
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-xs text-destructive" data-testid="measurement-ga4-properties-error">
                    {t('measurementGa4PropertiesLoadFailed')}
                  </p>
                  {/* 유나 CHANGES ④(PR#3935) — 자동 로딩이라 사람이 직접 다시 시킬
                      방법이 버튼 없인 없다. */}
                  <Button
                    size="sm" variant="outline" onClick={() => setGa4PropertiesRetryToken((n) => n + 1)}
                    data-testid="measurement-ga4-properties-retry-button"
                  >
                    {tCommon('retry')}
                  </Button>
                </div>
              ) : !ga4Properties ? (
                <p className="text-xs text-muted-foreground">{t('measurementGa4PropertiesLoading')}</p>
              ) : ga4Properties.length === 0 ? (
                // 유나 CHANGES 필수①(PR#3935) — 속성 0개는 드롭다운(빈 목록)이 아니라
                // "어디 가서 무엇을 하면 되는지"를 말하는 문장.
                <p className="text-xs text-muted-foreground" data-testid="measurement-ga4-no-properties">
                  {t('measurementGa4NoProperties')}
                </p>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    className="rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
                    value={ga4SelectedPropertyId}
                    onChange={(e) => setGa4SelectedPropertyId(e.target.value)}
                    data-testid="measurement-ga4-property-dropdown"
                  >
                    <option value="">{t('measurementGa4PropertySelectPlaceholder')}</option>
                    {ga4Properties.map((p) => (
                      <option key={p.property_id} value={p.property_id}>{p.display_name}</option>
                    ))}
                  </select>
                  <Button
                    size="sm" onClick={() => void handleGa4Select()}
                    disabled={!ga4SelectedPropertyId || ga4SelectLoading}
                    data-testid="measurement-ga4-property-confirm"
                  >
                    {tCommon('confirm')}
                  </Button>
                </div>
              )}
            </div>
          ) : null}

          {ga4.status === 'connected' ? (
            <div className="space-y-1">
              <Button
                size="sm" variant="outline" onClick={() => void handleGa4Disconnect()}
                disabled={ga4DisconnectLoading} data-testid="measurement-ga4-disconnect-button"
              >
                {t('channelDisconnectAction')}
              </Button>
              {/* 유나 §13-9⑤ 확定 — 확인 대화상자 없음, 누르기 前에 이미 서는 문장. */}
              <p className="text-xs text-muted-foreground" data-testid="measurement-ga4-disconnect-effect">
                {t('measurementGa4DisconnectEffect')}
              </p>
            </div>
          ) : null}

          {/* 유나 CHANGES ⑤(PR#3935, 3575 ⑤ 동형) — 응답 있음(status 코드)/응답
              없음(네트워크 자체가 안 닿음) 두 문장으로 가른다. */}
          {ga4ActionError ? (
            <p className="text-xs text-destructive" data-testid="measurement-ga4-action-error">
              {ga4ActionError.status !== null
                ? t('measurementGa4ActionFailedWithStatus', { status: ga4ActionError.status })
                : t('measurementGa4ActionFailedNoResponse')}
            </p>
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
  conn, index, isOwnerStrict, isOwnerOrAdmin, orgId, onDisconnected, t,
}: {
  conn: ChannelConnectionResponse;
  index: number;
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
      {/* story #3592(§17-20 ⑧·§22-18 동형) — 행마다 같은 접근 이름(「연결 시험」·
          「다시 연결」·「해제」)이라 보조기술 버튼 목록에서 어느 연결 행인지 못
          가른다. */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm" variant="outline" onClick={() => void handleTest()} disabled={testing}
          aria-label={t('channelRowActionAriaLabel', { n: index + 1, label: t('channelTestAction') })}
        >
          {t('channelTestAction')}
        </Button>
        {/* story #3504 — 재인증·해제는 owner 전용(_require_owner). §5-2 "그려진
            컨트롤은 「할 수 있다」는 단정" — admin에게 넓게 그리고 403으로 막지
            않는다: 안 그리고 사유 한 줄만. */}
        {derived.status === 'reauth_required' ? (
          isOwnerStrict ? (
            <a href={`/api/oauth-channel/authorize?org=${orgId}&channel=${conn.channel}`}>
              <Button
                size="sm" variant="outline"
                aria-label={t('channelRowActionAriaLabel', { n: index + 1, label: t('channelReauthAction') })}
              >
                {t('channelReauthAction')}
              </Button>
            </a>
          ) : (
            <span className="text-xs text-muted-foreground">{t('channelOwnerOnlyReason')}</span>
          )
        ) : null}
        {isOwnerStrict ? (
          <Button
            size="sm" variant="destructive" onClick={() => void handleDisconnect()} disabled={disconnecting}
            aria-label={t('channelRowActionAriaLabel', { n: index + 1, label: t('channelDisconnectAction') })}
          >
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
  item, connections, credentials, isOwnerStrict, isOwnerOrAdmin, orgId, onRefresh, t, pendingSelection,
}: {
  item: AvailableChannelItem;
  connections: ChannelConnectionResponse[];
  credentials: AppCredentialsStatusResponse | undefined;
  isOwnerStrict: boolean;
  isOwnerOrAdmin: boolean;
  orgId: string;
  onRefresh: () => void;
  t: ReturnType<typeof useTranslations>;
  // story #3549(§13-8②, 3547 계약) — 콜백이 2개 이상 페이지를 찾아 돌려보낸
  // 「선택 대기」. candidates=[]는 §13-8③ 0개 실패(원인 둘을 하나로 안 뭉친다).
  pendingSelection?: { pendingId: string; candidates: FacebookPageCandidate[] };
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
  // story #3549 REQUIRED 1(페드루 PO 지적, 2026-09-06) — 실 Meta App Review 前엔
  // facebook_sandbox가 §13-8 라이브 검증(AC5)의 유일한 길이다. 선택 대기 얼굴·앱
  // 안내는 채널 문자열이 아니라 «Facebook Page류 oauth인가»로 걸어야 한다 —
  // facebook_sandbox도 같은 OAuth+선택 대기 흐름을 탄다(디디 PR#3904:
  // `_FACEBOOK_OAUTH_MODULE_PATHS`에 둘 다 등록, select는 어느 쪽이든 리터럴
  // `/facebook/select` 하나로 통한다 — pending.channel로 식별, URL로 안 가른다).
  const isFacebookOauthChannel = channel === 'facebook' || channel === 'facebook_sandbox';
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
            {connections.map((c, index) => (
              <ConnectionRow key={c.id} conn={c} index={index} isOwnerStrict={isOwnerStrict} isOwnerOrAdmin={isOwnerOrAdmin} orgId={orgId} onDisconnected={onRefresh} t={t} />
            ))}
          </div>
        )}
        <div className="flex flex-col items-start gap-1">
          {/* story #3504(PO 정본§5) — OAuth 연결은 owner 전용(authorize_channel_connection
              = _require_owner). 권한을 먼저 판정해 안 그린다(옛 `<Button disabled>`는
              §5-2가 금지한 "권한인데 비활성"이었다 — L275 문제였던 자리) — 그 다음에야
              (owner인 경우에만) 자격 미설정이라는 **상태** 축을 disabled로 표현한다. */}
          {credential_kind === 'oauth' && isFacebookOauthChannel && isOwnerStrict && !pendingSelection ? (
            // story #3549(유나 §13-8①) — 「우리가 검사할 수 없는 조건」을 연결
            // 시작 버튼 위에 미리 말한다. 비활성 사유가 아니다(canStartConnect는
            // 별개 축) — 앱 자격 미등록 문구와 한 문장으로 합치지 않는다.
            <p className="text-xs text-muted-foreground" data-testid="channel-connect-facebook-app-guidance">
              {t('channelConnectFacebookAppGuidance')}
            </p>
          ) : null}
          {credential_kind === 'oauth' && isFacebookOauthChannel && pendingSelection && connections.length === 0 ? (
            <FacebookPageSelectCard
              channel={channel} orgId={orgId} pendingId={pendingSelection.pendingId}
              candidates={pendingSelection.candidates} isOwner={isOwnerStrict} onConnected={onRefresh} t={t}
            />
          ) : credential_kind === 'oauth' ? (
            isOwnerStrict ? (
              <a href={canStartConnect ? `/api/oauth-channel/authorize?org=${orgId}&channel=${channel}` : undefined}>
                <Button size="sm" disabled={!canStartConnect}>
                  {/* story #3436 묶음10(유나 §17-21⑧, PO 確定 2026-09-06) — 두 번째
                      연결이 유의미한 채널(wordpress·webhook 실재)이라 sandbox(#3537)와
                      달리 버튼은 유지하되, 연결이 이미 있을 때 "연결"이라는 낱말이
                      거짓("추가로 생기는 게 없다"는 착각)이 되지 않게 이름을 가른다. */}
                  {t(connections.length === 0 ? 'channelConnectAction' : 'channelConnectAnotherAction', { channel: channelLabel(channel, t) })}
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
            <PastedSecretConnectCard channel={channel} orgId={orgId} isOwner={isOwnerOrAdmin} connectionCount={connections.length} onConnected={onRefresh} t={t} />
          ) : null}
          {credential_kind === 'oauth' && isOwnerStrict && !canStartConnect ? (
            <p className="text-xs text-muted-foreground">{t('channelConfigIncompleteReason')}</p>
          ) : null}
          {/* story #3504 — L297은 «한 자리가 두 폭»이었다(유나 지적). oauth는 owner
              전용 문구, none(sandbox)은 owner|admin 문구 — credential_kind로 갈라야
              한쪽에서 거짓이 안 남는다.
              story #3436 묶음10(유나 §17-21⑨, PO 確定) — 이 버튼 자리 전용 사유로
              channelOwnerOnlyReason(재인증·해제 등 6곳 공용)과 분리한다 — 공용 키를
              바꾸면 그 6곳의 문구가 "이 작업"에서 뜻이 좁아진 문장으로 조용히
              번져나간다. */}
          {credential_kind === 'oauth' && !isOwnerStrict ? (
            <p className="text-xs text-muted-foreground">{t('channelConnectOwnerOnlyReason', { channel: channelLabel(channel, t) })}</p>
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

  // story #3549(§13-8②, 3547 계약) — 콜백 BFF(api/oauth-channel/callback/[channel])가
  // 2개 이상 페이지를 찾으면 `?select_pending={channel}&pending_id=...&candidates=...`
  // 로 돌려보낸다. candidates는 작은 배열(§13-8⑦ "미리보기 없음"과 같은 이유로
  // 원래도 가벼운 데이터)이라 새 왕복 없이 쿼리에 그대로 실려 온다. JSON.parse
  // 실패(손상된 쿼리 등)는 빈 배열로 fail-closed — §13-8③ 0개 얼굴과 같은 처리라
  // 별도 에러 상태를 새로 만들지 않는다.
  const selectPendingChannel = searchParams.get('select_pending');
  const selectPendingId = searchParams.get('pending_id');
  const selectPendingCandidates = (() => {
    if (!selectPendingChannel || !selectPendingId) return null;
    try {
      const parsed = JSON.parse(searchParams.get('candidates') ?? '[]') as unknown;
      return Array.isArray(parsed) ? (parsed as FacebookPageCandidate[]) : [];
    } catch {
      return [];
    }
  })();

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
              pendingSelection={
                selectPendingChannel === it.channel && selectPendingId && selectPendingCandidates
                  ? { pendingId: selectPendingId, candidates: selectPendingCandidates }
                  : undefined
              }
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
