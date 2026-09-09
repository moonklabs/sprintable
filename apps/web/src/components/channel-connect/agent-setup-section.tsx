'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { ListRow, ListRowMark } from '@/components/ui/list-row';
import { fetchWithAuth } from '@/lib/db/client';
import { channelLabel, channelMarkColor, channelMarkInitials } from '@/lib/channel-label';

/**
 * story #3743(UI 재설계 ③, 시안 a98386e6 「담당 에이전트가 설정하는 것」) — 옛
 * `/organization/connectors`(4180f67f) 화면 흡수. 설정 키·환경변수 이름은 사용자
 * 화면에서 걷는다(유나 사전 B갈래와 같은 원칙) — 사람은 「준비됨/설정 필요」만 보고,
 * 필요하면 담당 에이전트에게 `/chats` 새 대화로 요청한다(§13-8⑦ "담당에게 요청" —
 * PO 確定 2026-09-09, chats/layout.tsx:109 새 대화 버튼 실재 확認 済).
 *
 * ⚠️ 옛 화면의 org_config 값 직접 입력 UI(관리자가 create.senderEmail 등을 타이핑)는
 * 이 화면에 없다 — 그 값은 원래도 "담당 에이전트가 설정하는 것"이었다(정의역 그대로,
 * 시안이 사람 입력 폼을 안 그린다). 사람의 자기서비스 편집 경로가 사라지는 것이
 * 맞는지는 페드루 PO 確定(2026-09-09, 이 스토리 범위)으로 이미 닫힌 결정 — 재론
 * 대상 아님.
 */
export interface ConnectorItem {
  connector_key: string;
  version: string;
  channel: string;
  fields: Array<{ name: string; source: 'content' | 'org_config'; required?: boolean | null }>;
  requires_env: string[];
  kinds: string[] | null;
  org_config: Record<string, unknown>;
}

export function missingRequiredConnectorFieldNames(connector: ConnectorItem): string[] {
  return connector.fields
    .filter((f) => f.source === 'org_config' && f.required)
    .filter((f) => {
      const v = connector.org_config[f.name];
      return v === undefined || v === null || v === '';
    })
    .map((f) => f.name);
}

// story #3743 — 커넥터 준비 상태는 채널 연결 상태(5종, connection-status.ts)와 다른
// 축이라 ChannelStatusChip을 그대로 못 쓴다(값을 억지로 끼워 맞추면 "연결됨"류 낱말이
// 여기 뜻과 안 맞는다) — 같은 dot+낱말 형만 재사용, 값은 이 자리 전용 둘.
function ConnectorReadinessChip({ ready, t }: { ready: boolean; t: ReturnType<typeof useTranslations> }) {
  return (
    <span
      data-status-chip={ready ? 'ready' : 'needs_setup'}
      className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${ready ? 'bg-success-tint' : 'bg-warning-tint'} text-foreground`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${ready ? 'bg-success' : 'bg-warning'}`} aria-hidden="true" />
      {ready ? t('agentSetupReadyStatus') : t('agentSetupNeedsSetupStatus')}
    </span>
  );
}

function ConnectorRow({ connector, t }: { connector: ConnectorItem; t: ReturnType<typeof useTranslations> }) {
  const missing = missingRequiredConnectorFieldNames(connector);
  const ready = missing.length === 0;
  return (
    <ListRow
      data-testid={`agent-setup-row-${connector.connector_key}`}
      mark={<ListRowMark label={channelMarkInitials(connector.channel)} color={channelMarkColor(connector.channel)} />}
      title={t('agentSetupConnectorTitle', { channel: channelLabel(connector.channel, t) })}
      subtitle={ready ? undefined : t('agentSetupNeedsSetupHint', { fields: missing.join(', ') })}
      status={<ConnectorReadinessChip ready={ready} t={t} />}
      action={ready ? undefined : (
        <Link href="/chats">
          <Button size="sm" variant="outline">{t('agentSetupAskAgentAction')}</Button>
        </Link>
      )}
    />
  );
}

export function AgentSetupSection({ orgId }: { orgId: string }) {
  const t = useTranslations('channelConnect');
  const [connectors, setConnectors] = useState<ConnectorItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    // 마운트-fetch 패턴(setState를 effect 안에서 동기 호출)을 정적분석이 「cascading
    // renders」로 잡는 기존 코드베이스 관례(now-strip.tsx·connect-step.tsx 등)를 따라 disable.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setLoadError(false);
    fetchWithAuth(`/api/organizations/${orgId}/connectors`)
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) { setLoadError(true); return; }
        const json = (await res.json().catch(() => null)) as { data?: ConnectorItem[] } | null;
        setConnectors(json?.data ?? []);
      })
      .catch(() => { if (!cancelled) setLoadError(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [orgId]);

  // story #3743(빈 상태 규율) — 로딩 중·오류·커넥터 자체가 0(플러그인 미설치)이면
  // 이 구획을 그리지 않는다(없는 자리를 그리지 않는다, §13-4와 동형) — 페이지 전체
  // 빈 상태(연결 0건)와 별개 축이라 여기서 별도 문구를 새로 만들지 않는다.
  if (loading || loadError || connectors.length === 0) return null;

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-foreground">{t('agentSetupTitle')}</h2>
        <p className="text-xs text-muted-foreground">{t('agentSetupDescription')}</p>
      </div>
      <div className="divide-y divide-border overflow-hidden rounded-md border border-border">
        {connectors.map((c) => <ConnectorRow key={c.connector_key} connector={c} t={t} />)}
      </div>
    </div>
  );
}
