'use client';

import { useTranslations } from 'next-intl';
import { fetchEntityCardSummary } from '@/components/chat/embed-card';
import { fetchWithAuth } from '@/lib/db/client';
import { CardFrame } from './card-frame';
import { EntityCardFace } from './entity-card';
import type { EntityCardKind } from './card-kinds';
import { useCardRead } from './use-card-read';

/**
 * story 5034 (C4 step 4b) — the REFUSED card: an agent asked to show an object it may not see (or that does not exist — the server does not tell the two apart and neither does this card). The card is drawn
 * for EACH viewer by THEIR rights, with their own session:
 *  · a viewer who cannot read the object (404 / 403) sees the ordinary «찾을 수 없어요» card and NOTHING else — not that an agent was refused, not who can see it;
 *  · a viewer who can read the object sees it (the same card as any other) plus one line saying the agent could not see this project, and who CAN — the project's active agents by name, from the route the server
 *    already limits to people with access to that project (names only; never an id, a key or a record). Reading the agent's own name or that list failing never hides the card: those two lines are simply left out.
 */
const NAMES_MAX = 8;
const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nameOf = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

async function dataOf(url: string): Promise<unknown> {
  try {
    const res = await fetchWithAuth(url);
    if (!res.ok) return null;
    return ((await res.json()) as { data?: unknown }).data ?? null;
  } catch { return null; }
}

interface Refused { title: string | null; status: string | null; agentName: string | null; seers: string[] }

async function loadRefused(kind: EntityCardKind | 'kanban', ref: string, agentId: string): Promise<Refused> {
  const sum = await fetchEntityCardSummary(kind === 'kanban' ? 'sprint' : kind, ref); // throws 404 / 403 / fault exactly like any other card: the viewer's own rights decide
  const [agent, list] = await Promise.all([
    dataOf(`/api/team-members/${encodeURIComponent(agentId)}`),
    sum.projectId ? dataOf(`/api/team-members?project_id=${encodeURIComponent(sum.projectId)}&type=agent`) : Promise.resolve(null),
  ]);
  const seers = Array.isArray(list)
    ? list.filter((m): m is Record<string, unknown> => obj(m) && m.type === 'agent' && m.is_active === true).map((m) => nameOf(m.name)).filter((n): n is string => n !== null)
    : [];
  return { title: sum.title, status: sum.status, agentName: obj(agent) ? nameOf(agent.name) : null, seers: [...new Set(seers)] };
}

export function RefusedCard({ kind, refId, agentId }: { kind: EntityCardKind | 'kanban'; refId: string; agentId: string }) {
  const t = useTranslations('chats');
  const { read, retry } = useCardRead(`refused:${kind}:${refId}:${agentId}`, () => loadRefused(kind, refId, agentId));
  if (read.state !== 'ready') return <CardFrame state={read.state} onRetry={retry} data-testid="chat-card-refused" />;
  const r = read.value;
  const shown = r.seers.slice(0, NAMES_MAX);
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid="chat-card-refused">
      <EntityCardFace kind={kind === 'kanban' ? 'sprint' : kind} title={r.title ?? refId} statusLabel={null} />
      <div className="flex min-w-0 flex-col gap-0.5 px-1 text-ds-small text-ds-ink-2">
        {r.agentName ? <p className="m-0 break-words">{t('refusedWho', { name: r.agentName })}</p> : null}
        <p className="m-0 break-words">{t('refusedNote')}</p>
        {shown.length > 0 ? <p className="m-0 break-words" data-testid="chat-card-refused-seers">{t('refusedSeers', { names: shown.join(' · ') })}{r.seers.length > shown.length ? ' …' : ''}</p> : <p className="m-0 break-words">{t('refusedNoSeers')}</p>}
      </div>
    </div>
  );
}
