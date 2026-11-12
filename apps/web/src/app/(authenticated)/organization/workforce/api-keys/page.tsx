'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AgentApiKeyManager } from '@/components/agents/agent-api-key-manager';
import { Button } from '@/components/ui/button';
import { fetchWithAuth } from '@/lib/db/client';
import { isSystemPublisher } from '@/lib/runtime-capabilities';
import { memberOrAgentLabel, memberRowLabels } from '@/lib/member-display';

interface Agent {
  id: string;
  name: string | null;
  type: string;
  is_active: boolean;
  // story #3994 — 「시스템 발행」은 키를 발급받을 연결 대상이 아니다(제외, AC4와
  // 같은 결 — "고를 자리에 실익 없는 행을 안 둔다").
  runtime_type?: string | null;
}

export default function ApiKeysPage() {
  const tc = useTranslations('common');
  const t = useTranslations('settings'); // story #4359
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  // story 4912 D2 — a failed read returned silently and the page said «활성 에이전트가 없어요» (an error read as «none»): now it says the read failed, with [다시 시도].
  const [loadFailed, setLoadFailed] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
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

  return (
    <div className="container mx-auto px-4 py-8 space-y-8"> {/* story 4889: 큰 제목이 셸 칼럼 왼쪽 끝(x≈313)에 붙던 것 — 줄 띠와 같은 px-4 */}
      <div>
        <h1 className="text-display font-bold">{t('agentApiKeysPageTitle')}</h1>
        <p className="text-muted-foreground mt-2">
          {t('agentApiKeyListDescription')}
        </p>
      </div>

      {loading ? (
        <div className="space-y-4">
          {[1, 2].map((i) => (
            <div key={i} className="h-32 animate-pulse rounded-lg border border-border bg-muted/30" />
          ))}
        </div>
      ) : loadFailed ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-6 py-12 text-center" data-testid="api-keys-load-failed">
          <p className="text-sm text-muted-foreground">{t('agentApiKeysLoadFailed')}</p>
          <Button size="sm" variant="outline" onClick={() => setRetryKey((k) => k + 1)}>{tc('retry')}</Button>
        </div>
      ) : agents.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-6 py-12 text-center">
          <p className="text-sm text-muted-foreground">{t('agentApiKeysNoAgents')}</p>
        </div>
      ) : (
        <div className="space-y-6">
          {agents.map((agent) => (
            <div key={agent.id} className="space-y-4">
              <AgentApiKeyManager agentId={agent.id} agentName={agent.name ?? ''} agentLabel={agentLabels.get(agent.id)} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
