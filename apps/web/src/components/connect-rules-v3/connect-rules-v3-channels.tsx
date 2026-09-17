'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Badge, badgeVariants } from '@/components/ui/badge';
import type { VariantProps } from 'class-variance-authority';
import { fetchWithAuth } from '@/lib/db/client';
import { formatRelativeTime } from '@/lib/storage/format';
import { resolveDisplayTimezone } from '@/components/content/schedule-format';
import {
  deriveChannelConnectionStatus,
  channelConnectionStatusLabelKey,
  worstChannelConnectionStatus,
  type ChannelConnectionStatus,
} from '@/components/channel-connect/connection-status';
import {
  ConnectRulesV3SectionEmpty,
  ConnectRulesV3SectionError,
  ConnectRulesV3SectionSkeleton,
} from './connect-rules-v3-section-state';

/**
 * story #3982 §(d) 연결된 채널(+성과 수집) — `channel-connect/connection-status.ts`의
 * 파생 함수를 그대로 재사용(새 판정식 발명 0, organization/channels/page.tsx와 같은
 * 원천). §③ 색 규율(「사람 손 필요」에만 색) — 중립 상태(연결됨·미연결)는 muted span,
 * amber Badge는 사람이 할 일이 남은 상태에만.
 *
 * PO CHANGES-1(2026-09-17) — Meta 광고 계정을 목록에서 빼면 사라짐 0 위반(AC3⑥ "채널
 * 8종"엔 광고 계정도 포함, 현행 화면에도 있는 행). 손 필터 제거 — `available-channels`가
 * 돌려주는 전부(레지스트리 SSOT)를 그리되, kind==="ads"만 같은 섹션 안 작은 「광고 계정」
 * 묶음으로 시각적으로 분리한다(발행 채널과 다른 개념이라는 것만 표시, 존재 자체는 유지).
 *
 * PO CHANGES-2 — 성과 수집은 raw 영어 status를 그대로 찍지 않는다: 기존
 * MeasurementConnectionsSection(organization/channels/page.tsx)의 3값 문장 파생(beacon
 * not_started/no_data_yet/has_data · utm auto/manual/off · ga4 connected/needs_reauth/
 * disconnected) 그대로 재사용(같은 i18n 키, 새 판정 0). GA4 미연결·재인증 필요만 amber+
 * 「GA4 계정 연결」/「다시 연결」 링크(설정 화면으로, 인가 흐름 자체는 무접촉). 이 절도
 * fetch 실패 시 조용히 사라지지 않고 절 공용 오류+재시도로 떨어진다.
 */
type BadgeVariant = VariantProps<typeof badgeVariants>['variant'];

interface AvailableChannelItem {
  channel: string;
  display_name: string;
  credential_kind: string;
  kind: string;
}

interface ChannelConnectionResponse {
  id: string;
  channel: string;
  account_id: string;
  account_label?: string | null;
  credential_kind: string;
  status: 'active' | 'expired' | 'revoked' | 'error';
  token_expires_at: string | null;
  can_auto_refresh?: boolean | null;
  last_error_code?: string | null;
}

interface MeasurementConnectionItem {
  key: 'beacon' | 'utm' | 'ga4';
  status: string;
  last_seen_at: string | null;
  count_7d: number | null;
  settings_path: string | null;
  property_name?: string | null;
}

const HUMAN_ACTION_STATUSES = new Set<ChannelConnectionStatus>([
  'reauth_required', 'provider_error', 'expiring_soon', 'config_incomplete',
]);

function statusBadgeVariant(status: ChannelConnectionStatus): BadgeVariant {
  return HUMAN_ACTION_STATUSES.has(status) ? 'warning' : 'secondary';
}

function ChannelRow({
  item, connections, t, tc,
}: {
  item: AvailableChannelItem;
  connections: ChannelConnectionResponse[];
  t: ReturnType<typeof useTranslations<'connectRulesV3'>>;
  tc: ReturnType<typeof useTranslations<'channelConnect'>>;
}) {
  const rows = connections.filter((c) => c.channel === item.channel);
  const statuses = rows.map((c) => deriveChannelConnectionStatus({
    serverStatus: c.status,
    tokenExpiresAt: c.token_expires_at,
    canAutoRefresh: c.can_auto_refresh ?? undefined,
    lastErrorCode: c.last_error_code,
  }).status);
  const worst = worstChannelConnectionStatus(statuses);
  const needsReconnect = HUMAN_ACTION_STATUSES.has(worst);
  const label = tc(channelConnectionStatusLabelKey(worst));
  return (
    <div className="rounded-md border border-border bg-muted/30 px-3 py-3 text-sm" data-testid="connect-rules-v3-channel-row">
      <div className="flex items-center justify-between gap-3">
        <span className="font-medium text-foreground">{item.display_name}</span>
        {needsReconnect ? <Badge variant={statusBadgeVariant(worst)}>{label}</Badge> : <span className="text-xs text-muted-foreground">{label}</span>}
      </div>
      {needsReconnect ? (
        <div className="mt-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <p>{t('channelReconnectBanner')}</p>
          <Link href="/organization/channels" className="shrink-0 font-medium text-primary hover:underline">
            {tc('channelReauthAction')}
          </Link>
        </div>
      ) : null}
    </div>
  );
}

function MeasurementSection({
  items, tc, locale,
}: {
  items: MeasurementConnectionItem[];
  tc: ReturnType<typeof useTranslations<'channelConnect'>>;
  locale: string;
}) {
  const displayTimezone = resolveDisplayTimezone().tz;
  const beacon = items.find((it) => it.key === 'beacon');
  const utm = items.find((it) => it.key === 'utm');
  const ga4 = items.find((it) => it.key === 'ga4');

  const beaconStatusText = beacon && (
    beacon.status === 'not_started'
      ? tc('measurementBeaconNotStarted')
      : beacon.status === 'no_data_yet'
        ? tc('measurementBeaconNoDataYet')
        : tc('measurementBeaconHasData', {
            time: beacon.last_seen_at ? formatRelativeTime(beacon.last_seen_at, locale, displayTimezone) : '',
            count: beacon.count_7d ?? 0,
          })
  );
  const utmStatusText = utm && (
    utm.status === 'auto' ? tc('measurementUtmAuto') : utm.status === 'manual' ? tc('measurementUtmManual') : tc('measurementUtmOff')
  );
  const ga4NeedsAction = ga4?.status === 'disconnected' || ga4?.status === 'needs_reauth';
  const ga4StatusText = ga4 && (
    ga4.status === 'connected'
      ? (ga4.property_name ? `${tc('channelStatusConnected')} · ${ga4.property_name}` : tc('channelStatusConnected'))
      : ga4.status === 'needs_reauth'
        ? tc('channelStatusReauthRequired')
        : tc('channelStatusNotConnected')
  );

  return (
    <div className="border-t border-border pt-3">
      <div className="mb-2 flex items-baseline gap-2">
        <h3 className="text-xs font-semibold text-foreground">{tc('measurementSectionTitle')}</h3>
        <span className="text-[11px] text-muted-foreground">{tc('measurementSectionSubtitle')}</span>
      </div>
      <div className="space-y-1.5 text-xs">
        {beacon ? (
          <div className="flex items-center justify-between gap-3" data-testid="connect-rules-v3-measurement-beacon">
            <span className="text-foreground">{tc('measurementBeaconLabel')}</span>
            <span className="text-muted-foreground">{beaconStatusText}</span>
          </div>
        ) : null}
        {utm ? (
          <div className="flex items-center justify-between gap-3" data-testid="connect-rules-v3-measurement-utm">
            <span className="text-foreground">{tc('measurementUtmLabel')}</span>
            <span className="flex items-center gap-2 text-muted-foreground">
              {utmStatusText}
              {utm.settings_path ? (
                <Link href={utm.settings_path} className="font-medium text-primary hover:underline">
                  {tc('measurementUtmSettingsLink')}
                </Link>
              ) : null}
            </span>
          </div>
        ) : null}
        {ga4 ? (
          <div className="flex items-center justify-between gap-3" data-testid="connect-rules-v3-measurement-ga4">
            <span className="text-foreground">{tc('measurementGa4Label')}</span>
            <span className="flex items-center gap-2">
              {ga4NeedsAction ? <Badge variant="warning">{ga4StatusText}</Badge> : <span className="text-muted-foreground">{ga4StatusText}</span>}
              {ga4NeedsAction ? (
                <Link href="/organization/channels" className="font-medium text-primary hover:underline">
                  {ga4.status === 'needs_reauth' ? tc('channelReauthAction') : tc('channelConnectAction', { channel: 'GA4' })}
                </Link>
              ) : null}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ConnectRulesV3Channels({ orgId }: { orgId: string }) {
  const t = useTranslations('connectRulesV3');
  const tc = useTranslations('channelConnect');
  const locale = useLocale();
  const [available, setAvailable] = useState<AvailableChannelItem[]>([]);
  const [connections, setConnections] = useState<ChannelConnectionResponse[]>([]);
  const [measurement, setMeasurement] = useState<MeasurementConnectionItem[]>([]);
  const [loadState, setLoadState] = useState<'loading' | 'error' | 'ready'>('loading');
  const [retryKey, setRetryKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoadState('loading');
      try {
        const [availableRes, connsRes, measurementRes] = await Promise.all([
          fetchWithAuth(`/api/organizations/${orgId}/channel-connections/available-channels`),
          fetchWithAuth(`/api/organizations/${orgId}/channel-connections`),
          fetchWithAuth(`/api/organizations/${orgId}/measurement-connections`),
        ]);
        if (!availableRes.ok || !connsRes.ok || !measurementRes.ok) {
          if (!cancelled) setLoadState('error');
          return;
        }
        const availableJson = await availableRes.json() as { data?: AvailableChannelItem[] };
        const connsJson = await connsRes.json() as { data?: ChannelConnectionResponse[] };
        const measurementJson = await measurementRes.json() as { data?: MeasurementConnectionItem[] };
        if (cancelled) return;
        setAvailable(availableJson.data ?? []);
        setConnections(connsJson.data ?? []);
        setMeasurement(measurementJson.data ?? []);
        setLoadState('ready');
      } catch {
        if (!cancelled) setLoadState('error');
      }
    })();
    return () => { cancelled = true; };
  }, [orgId, retryKey]);

  if (loadState === 'loading') return <ConnectRulesV3SectionSkeleton />;
  if (loadState === 'error') return <ConnectRulesV3SectionError onRetry={() => setRetryKey((k) => k + 1)} />;

  const mainChannels = available.filter((c) => c.kind !== 'ads');
  const adChannels = available.filter((c) => c.kind === 'ads');

  return (
    <div className="space-y-4">
      {available.length === 0 ? (
        <ConnectRulesV3SectionEmpty title={t('channelsEmptyTitle')} />
      ) : (
        <div className="space-y-2">
          {mainChannels.map((item) => (
            <ChannelRow key={item.channel} item={item} connections={connections} t={t} tc={tc} />
          ))}
          {adChannels.length > 0 ? (
            <div className="pt-1">
              <p className="mb-1.5 text-[11px] font-medium text-muted-foreground">{t('adAccountsSectionTitle')}</p>
              <div className="space-y-2">
                {adChannels.map((item) => (
                  <ChannelRow key={item.channel} item={item} connections={connections} t={t} tc={tc} />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      )}

      <MeasurementSection items={measurement} tc={tc} locale={locale} />

      <Link href="/organization/channels" className="inline-block text-xs font-medium text-primary hover:underline">
        {t('goToChannelSettingsLink')}
      </Link>
    </div>
  );
}
