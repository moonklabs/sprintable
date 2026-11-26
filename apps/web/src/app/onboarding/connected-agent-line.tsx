'use client';

// story 5036 (next PR · PO 11-26): an agent that connected through the key way BEFORE this page was opened — a reload, coming back — is not drawn as «not
// connected». The organization's activation cannot say it (its «agent connected» is false for a hosted key way until the first round trip: onboarding_activation.py,
// story 3197), so this asks what the key way's own panel asks — each of the project's agents, newest first, its verification status over the hosted transport — and
// when one says «verified» draws one line over the three ways: that an agent is already connected, and the way to the first chat (step ③).
// It says nothing while it does not know: an unreadable answer draws no line (and never a line that says «none») — the three ways stand as they are.

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ds/button';
import { Card } from '@/components/ds/card';
import { fetchWithAuth } from '@/lib/db/client';
import { parseVerificationRail } from './verify-rail';

/** how many of the project's newest agents are asked (a project with more is a project that is not on its first connection) */
const ASKED_AGENTS = 8;

interface AgentRow { id: string; name: string | null }

function rowsOf(body: unknown): AgentRow[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const rows: AgentRow[] = [];
  for (const r of data) {
    const row = r as { id?: unknown; name?: unknown } | null;
    if (row && typeof row.id === 'string' && row.id) rows.push({ id: row.id, name: typeof row.name === 'string' && row.name.trim() ? row.name.trim() : null });
  }
  return rows;
}

/** the newest verified agent of the project, or null (nothing verified · or the answer could not be read) */
async function findVerifiedAgent(projectId: string, isOff: () => boolean): Promise<AgentRow | null> {
  const listed = await fetchWithAuth(`/api/team-members?project_id=${encodeURIComponent(projectId)}&type=agent`);
  if (!listed.ok) return null;
  const agents = rowsOf(await listed.json().catch(() => null)).slice(-ASKED_AGENTS).reverse();
  for (const agent of agents) {
    if (isOff()) return null;
    try {
      const res = await fetchWithAuth(`/api/agents/${agent.id}/verification-status?transport=http`);
      if (!res.ok) continue;
      const rail = parseVerificationRail(await res.json());
      if (rail?.find((s) => s?.state === 'verified')?.status === 'done') return agent; // (`s?.`: the rail is an array of whatever the server sent — a null in it is not «verified»)
    } catch {
      // this agent's answer cannot be read: it is not «verified», and the next agent is still asked (one odd answer must not end the whole search)
    }
  }
  return null;
}

export function ConnectedAgentLine({ projectId, onGo }: { projectId: string; onGo: (agentId: string) => void }) {
  const t = useTranslations('onboarding.line');
  // what was found is kept WITH the project it was found for: a line is shown only for the project it is drawn under (another project → none, with no state set inside the effect)
  const [foundFor, setFound] = useState<{ projectId: string; agent: AgentRow } | null>(null);

  useEffect(() => {
    let off = false;
    void findVerifiedAgent(projectId, () => off).then((a) => { if (!off && a) setFound({ projectId, agent: a }); }).catch(() => undefined);
    return () => { off = true; };
  }, [projectId]);

  const found = foundFor && foundFor.projectId === projectId ? foundFor.agent : null;
  if (!found) return null;
  return (
    <Card className="space-y-3 p-4" data-testid="connect-branches-connected">
      <div className="space-y-1">
        <p role="status" className="break-keep text-ds-card-title font-semibold text-ds-ink">{t('connectedBefore')}</p>
        {found.name ? <p className="text-ds-small text-ds-ink-3 [overflow-wrap:anywhere]" data-testid="connect-branches-connected-name">{found.name}</p> : null}
      </div>
      <Button variant="primary" size="lg" className="w-full" onClick={() => onGo(found.id)} data-testid="connect-branches-connected-go">
        {t('connectedGo')}
      </Button>
    </Card>
  );
}
