'use client';

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { LIMIT_AXIS_ORDER, TIER_DEFINITIONS, TIER_ORDER, type LimitAxisKey, type TierId } from './pricing-data';

function formatAutomationCell(t: ReturnType<typeof useTranslations>, multiplier: number): string {
  if (multiplier <= 1) return t('automationMultiplierBase');
  return t('automationMultiplierOf', { n: multiplier });
}

function renderCell(t: ReturnType<typeof useTranslations>, axis: LimitAxisKey, tierId: TierId): React.ReactNode {
  const { limits } = TIER_DEFINITIONS[tierId];
  switch (axis) {
    case 'seats':
      return limits.seats;
    case 'agents':
      return limits.agents == null ? t('agentsUnlimited') : `${limits.agents}`;
    case 'automation':
      return formatAutomationCell(t, limits.automationMultiplier);
    case 'realtimeConnections':
      return limits.realtimeConnections;
    case 'storageGb':
      return `${limits.storageGb}GB`;
    case 'maxFileMb':
      return `${limits.maxFileMb}MB`;
    case 'requestsPerMin':
      return t('requestsPerMinValue', { count: limits.requestsPerMin });
    case 'automationRules':
      return limits.automationRules;
    case 'webhooks':
      return limits.webhooks;
    case 'eventReplayDays':
      return t('eventReplayDaysValue', { count: limits.eventReplayDays });
    case 'support':
      return tierId === 'free' || tierId === 'starter'
        ? t('supportDocsCommunity')
        : tierId === 'team'
          ? t('supportEmail')
          : t('supportPriorityQueue');
    default:
      return null;
  }
}

const AXIS_LABEL_KEY: Record<LimitAxisKey, string> = {
  seats: 'axisSeats',
  agents: 'axisAgents',
  automation: 'axisAutomation',
  realtimeConnections: 'axisRealtimeConnections',
  storageGb: 'axisStorage',
  maxFileMb: 'axisMaxFile',
  requestsPerMin: 'axisRequestRate',
  automationRules: 'axisAutomationRules',
  webhooks: 'axisWebhooks',
  eventReplayDays: 'axisEventReplay',
  support: 'axisSupport',
};

export function PricingLimitsTable({ currentTier }: { currentTier: TierId }) {
  const t = useTranslations('pricingPlans');

  return (
    <div>
      <h3 className="text-base font-semibold">{t('limitsTableHeading')}</h3>
      <p className="mb-3 text-xs text-muted-foreground">{t('limitsTableDesc')}</p>
      <div className="overflow-x-auto rounded-2xl border border-border">
        <table className="w-full min-w-[560px] border-collapse text-sm">
          <thead>
            <tr className="bg-muted">
              <th className="px-3 py-2.5 text-left text-xs font-medium text-muted-foreground">&nbsp;</th>
              {TIER_ORDER.map((tierId) => (
                <th
                  key={tierId}
                  className={cn(
                    'px-3 py-2.5 text-right text-xs font-medium text-muted-foreground',
                    tierId === currentTier && 'text-brand',
                  )}
                >
                  {t(`tierName_${tierId}`)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {LIMIT_AXIS_ORDER.map((axis) => (
              <tr key={axis} className="border-t border-border">
                <td className="px-3 py-2.5 text-left text-xs font-semibold">{t(AXIS_LABEL_KEY[axis])}</td>
                {TIER_ORDER.map((tierId) => (
                  <td
                    key={tierId}
                    className={cn(
                      'px-3 py-2.5 text-right text-xs',
                      tierId === currentTier && 'bg-brand-tint font-semibold',
                    )}
                  >
                    {renderCell(t, axis, tierId)}
                  </td>
                ))}
              </tr>
            ))}
            <tr className="border-t border-border">
              <td className="px-3 py-2.5 text-left text-xs font-semibold">{t('axisReachRow')}</td>
              {TIER_ORDER.map((tierId) => (
                <td
                  key={tierId}
                  className={cn(
                    'px-3 py-2.5 text-right text-xs font-semibold',
                    TIER_DEFINITIONS[tierId].limits.canPurchasePacks ? 'text-success' : 'text-warning',
                    tierId === currentTier && 'bg-brand-tint',
                  )}
                >
                  {TIER_DEFINITIONS[tierId].limits.canPurchasePacks ? t('reachGoShort') : t('reachStopShort')}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
