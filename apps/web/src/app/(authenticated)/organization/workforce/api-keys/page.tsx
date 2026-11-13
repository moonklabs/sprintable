'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AgentApiKeyManager } from '@/components/agents/agent-api-key-manager';
import { Button } from '@/components/ds/button';
import { EmptyState } from '@/components/ds/empty-state';
import { PageFrame } from '@/components/ds/page-frame';
import { PageHead } from '@/components/ds/page-head';
import { Panel, PanelBody, PanelContent, PanelHeader } from '@/components/ds/panel';
import { DialogTitle } from '@/components/ds/dialog';
import { RowList, RowListItem } from '@/components/ds/row-list';
import { Skeleton, SkeletonGroup } from '@/components/ds/skeleton';
import { TopBarSlot } from '@/components/nav/top-bar-slot';
import { useViewerTimeZone } from '@/components/viewer-time-zone';
import { fetchWithAuth } from '@/lib/db/client';
import { isSystemPublisher } from '@/lib/runtime-capabilities';
import { memberOrAgentLabel, memberRowLabels } from '@/lib/member-display';
import { formatViewerRelativeTime } from '@/lib/storage/format';

interface Agent {
  id: string;
  name: string | null;
  type: string;
  is_active: boolean;
  // story #3994 — 「시스템 발행」은 키를 발급받을 연결 대상이 아니다(제외, AC4와
  // 같은 결 — "고를 자리에 실익 없는 행을 안 둔다").
  runtime_type?: string | null;
}

interface KeyRecord {
  id: string;
  last_used_at: string | null;
  revoked_at: string | null;
  expires_at: string | null;
}

// story 4912 (B1) — what a row says about the agent's keys: loading · the read FAILED (not «no key» — a failed read is not an empty list) · or how many are active / when last used / expiring within 7 days
type KeySummary =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'ok'; active: number; lastUsedAt: string | null; expiresInDays: number | null };

export function summarizeKeys(keys: KeyRecord[], now = Date.now()): Extract<KeySummary, { state: 'ok' }> {
  const active = keys.filter((k) => !k.revoked_at);
  let lastUsedAt: string | null = null;
  for (const k of active) if (k.last_used_at && (!lastUsedAt || k.last_used_at > lastUsedAt)) lastUsedAt = k.last_used_at;
  // the same rule the key line used to wear: «⚠ n일 뒤 만료» within 7 days (an already expired key is not «expiring»)
  let expiresInDays: number | null = null;
  for (const k of active) {
    if (!k.expires_at) continue;
    const days = Math.ceil((new Date(k.expires_at).getTime() - now) / (1000 * 60 * 60 * 24));
    if (days > 0 && days <= 7 && (expiresInDays === null || days < expiresInDays)) expiresInDays = days;
  }
  return { state: 'ok', active: active.length, lastUsedAt, expiresInDays };
}

/** One agent = one row. The row reads that agent's key list itself (the card used to, one read per agent — the same number of reads), and re-reads when the panel closes (`reloadToken`). */
function AgentKeyRow({ agent, label, reloadToken, onOpen }: { agent: Agent; label: string | undefined; reloadToken: number; onOpen: () => void }) {
  const t = useTranslations('settings');
  const locale = useLocale();
  const displayTimezone = useViewerTimeZone();
  const [summary, setSummary] = useState<KeySummary>({ state: 'loading' });
  const readSeq = useRef(0);

  useEffect(() => {
    const seq = ++readSeq.current;
    void (async () => {
      try {
        const res = await fetchWithAuth(`/api/agents/${agent.id}/api-key`);
        if (!res.ok) throw new Error('key list read failed');
        const json = await res.json() as { data?: KeyRecord[] };
        if (seq === readSeq.current) setSummary(summarizeKeys(json.data ?? []));
      } catch {
        if (seq === readSeq.current) setSummary({ state: 'failed' });
      }
    })();
  }, [agent.id, reloadToken]);

  const name = label ?? agent.name ?? '';
  const subtitle = (() => {
    if (summary.state === 'loading') return undefined;
    if (summary.state === 'failed') return t('agentApiKeyRowReadFailed');
    if (summary.active === 0) return t('agentApiKeyRowNone');
    const parts = [t('agentApiKeyRowActive', { count: summary.active })];
    if (summary.lastUsedAt) parts.push(t('agentApiKeyLastUsedAt', { time: formatViewerRelativeTime(summary.lastUsedAt, locale, displayTimezone) }));
    if (summary.expiresInDays !== null) parts.push(`⚠ ${t('agentApiKeyRowExpiring', { days: summary.expiresInDays })}`);
    return parts.join(' · ');
  })();

  return (
    <RowListItem
      data-testid={`api-key-row-${agent.id}`}
      title={name}
      subtitle={subtitle}
      trailing={<Button onClick={onOpen} aria-label={t('agentApiKeyManageTitle', { name })}>{t('agentApiKeyManageCta')}</Button>}
      actions={[{ key: 'manage', label: t('agentApiKeyManageCta'), icon: 'key', onSelect: onOpen }]}
      actionsLabel={t('agentApiKeyManageTitle', { name })}
      onOpen={onOpen}
    />
  );
}

export default function ApiKeysPage() {
  const tc = useTranslations('common');
  const t = useTranslations('settings'); // story #4359
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  // story 4912 D2 — a failed read returned silently and the page said «활성 에이전트가 없어요» (an error read as «none»): now it says the read failed, with [다시 시도].
  const [loadFailed, setLoadFailed] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  // story 4912 (B1): the «키 관리» panel holds ONE agent at a time; closing it re-reads the rows' key summaries
  const [openAgentId, setOpenAgentId] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  // [SID:4311 PR 3] 에이전트 칸 머리 — 같은 이름 둘이면 «· ID 앞 8자» · 이름 빔 = «이름 없는 에이전트»(목록 행 규칙 한 곳).
  const agentLabels = useMemo(() => memberRowLabels(agents, tc, () => '', (a) => memberOrAgentLabel(a, tc)), [agents, tc]);

  useEffect(() => {
    async function loadAgents() {
      setLoading(true);
      setLoadFailed(false);
      try {
        const res = await fetchWithAuth('/api/team-members?type=agent');
        if (!res.ok) { setLoadFailed(true); return; }
        const json = await res.json() as { data?: Agent[] };
        setAgents((json.data ?? []).filter((m) => m.type === 'agent' && m.is_active && !isSystemPublisher(m.runtime_type)));
      } catch {
        setLoadFailed(true);
      } finally {
        setLoading(false);
      }
    }
    void loadAgents();
  }, [retryKey]);

  const openAgent = agents.find((a) => a.id === openAgentId) ?? null;
  const openLabel = openAgent ? (agentLabels.get(openAgent.id) ?? openAgent.name ?? '') : '';

  return (
    <PageFrame width="reading">
      <TopBarSlot title={<h1 className="text-sm font-medium">{t('agentApiKeysPageTitle')}</h1>} />
      <PageHead description={t('agentApiKeyListDescription')} />

      {loading ? (
        <SkeletonGroup label={tc('loading')} className="space-y-2" data-testid="api-keys-loading">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-14" />)}
        </SkeletonGroup>
      ) : loadFailed ? (
        <div data-testid="api-keys-load-failed">
          <EmptyState title={t('agentApiKeysLoadFailed')} action={<Button onClick={() => setRetryKey((k) => k + 1)}>{tc('retry')}</Button>} />
        </div>
      ) : agents.length === 0 ? (
        <EmptyState title={t('agentApiKeysNoAgents')} />
      ) : (
        <RowList aria-label={t('agentApiKeysPageTitle')} header={{ title: t('agentApiKeysPageTitle'), count: agents.length }} data-testid="api-key-list">
          {agents.map((agent) => (
            <AgentKeyRow key={agent.id} agent={agent} label={agentLabels.get(agent.id)} reloadToken={reloadToken} onOpen={() => setOpenAgentId(agent.id)} />
          ))}
        </RowList>
      )}

      <Panel open={openAgent !== null} onOpenChange={(open) => { if (!open) { setOpenAgentId(null); setReloadToken((n) => n + 1); } }}>
        <PanelContent aria-label={t('agentApiKeyManageTitle', { name: openLabel })} data-testid="api-key-panel">
          <PanelHeader><DialogTitle>{t('agentApiKeyManageTitle', { name: openLabel })}</DialogTitle></PanelHeader>
          <PanelBody>
            {openAgent ? <AgentApiKeyManager agentId={openAgent.id} agentName={openAgent.name ?? ''} agentLabel={openLabel} compact /> : null}
          </PanelBody>
        </PanelContent>
      </Panel>
    </PageFrame>
  );
}
