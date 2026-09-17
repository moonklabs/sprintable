'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Badge, badgeVariants } from '@/components/ui/badge';
import type { VariantProps } from 'class-variance-authority';
import { fetchWithAuth } from '@/lib/db/client';
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
 * story #3982 §(d) 연결된 채널 — `channel-connect/connection-status.ts`의 파생 함수를
 * 그대로 재사용(새 판정식 발명 0, organization/channels/page.tsx와 같은 원천). §③ 색
 * 규율(「사람 손 필요」에만 색) — 'connected'/'not_connected'만 중립, 나머지 넷은 amber
 * (§⑤ 정본이 다시 연결 필요=amber만 명시하나, provider_error/config_incomplete도 같은
 * "사람이 할 일이 남았다" 축이라 같은 톤으로 묶는다 — 정보 손실 없이 §③ 정신 확장).
 * ads kind(광고 계정)는 「글이 나갈 채널」이 아니라 별도 축(#3806)이라 목록에서 제외.
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
}

const HUMAN_ACTION_STATUSES = new Set<ChannelConnectionStatus>([
  'reauth_required', 'provider_error', 'expiring_soon', 'config_incomplete',
]);

function statusBadgeVariant(status: ChannelConnectionStatus): BadgeVariant {
  return HUMAN_ACTION_STATUSES.has(status) ? 'warning' : 'secondary';
}

export function ConnectRulesV3Channels({ orgId }: { orgId: string }) {
  const t = useTranslations('connectRulesV3');
  const tc = useTranslations('channelConnect');
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
        if (!availableRes.ok || !connsRes.ok) {
          if (!cancelled) setLoadState('error');
          return;
        }
        const availableJson = await availableRes.json() as { data?: AvailableChannelItem[] };
        const connsJson = await connsRes.json() as { data?: ChannelConnectionResponse[] };
        if (cancelled) return;
        // ads(광고 계정)는 이 「연결된 채널」 목록의 대상이 아니다(#3806 별도 축).
        setAvailable((availableJson.data ?? []).filter((c) => c.kind !== 'ads'));
        setConnections(connsJson.data ?? []);
        if (measurementRes.ok) {
          const measurementJson = await measurementRes.json() as { data?: MeasurementConnectionItem[] };
          if (!cancelled) setMeasurement(measurementJson.data ?? []);
        }
        if (!cancelled) setLoadState('ready');
      } catch {
        if (!cancelled) setLoadState('error');
      }
    })();
    return () => { cancelled = true; };
  }, [orgId, retryKey]);

  if (loadState === 'loading') return <ConnectRulesV3SectionSkeleton />;
  if (loadState === 'error') return <ConnectRulesV3SectionError onRetry={() => setRetryKey((k) => k + 1)} />;

  return (
    <div className="space-y-4">
      {available.length === 0 ? (
        <ConnectRulesV3SectionEmpty title={t('channelsEmptyTitle')} />
      ) : (
        <div className="space-y-2">
          {available.map((item) => {
            const rows = connections.filter((c) => c.channel === item.channel);
            const statuses = rows.map((c) => deriveChannelConnectionStatus({
              serverStatus: c.status,
              tokenExpiresAt: c.token_expires_at,
              canAutoRefresh: c.can_auto_refresh ?? undefined,
              lastErrorCode: c.last_error_code,
            }).status);
            const worst = worstChannelConnectionStatus(statuses);
            const needsReconnect = HUMAN_ACTION_STATUSES.has(worst);
            return (
              <div key={item.channel} className="rounded-md border border-border bg-muted/30 px-3 py-3 text-sm" data-testid="connect-rules-v3-channel-row">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-medium text-foreground">{item.display_name}</span>
                  <Badge variant={statusBadgeVariant(worst)}>{tc(channelConnectionStatusLabelKey(worst))}</Badge>
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
          })}
        </div>
      )}

      {measurement.length > 0 ? (
        <div className="border-t border-border pt-3">
          <div className="mb-2 flex items-baseline gap-2">
            <h3 className="text-xs font-semibold text-foreground">{tc('measurementSectionTitle')}</h3>
            <span className="text-[11px] text-muted-foreground">{tc('measurementSectionSubtitle')}</span>
          </div>
          <div className="space-y-1.5 text-xs text-muted-foreground">
            {measurement.map((m) => (
              <div key={m.key} className="flex items-center justify-between gap-3" data-testid={`connect-rules-v3-measurement-${m.key}`}>
                <span>{m.key === 'ga4' ? tc('measurementGa4Label') : m.key === 'utm' ? tc('measurementUtmLabel') : tc('measurementBeaconLabel')}</span>
                <span>{m.status === 'connected' ? tc('channelStatusConnected') : m.status}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      <Link href="/organization/channels" className="inline-block text-xs font-medium text-primary hover:underline">
        {t('goToChannelSettingsLink')}
      </Link>
    </div>
  );
}
