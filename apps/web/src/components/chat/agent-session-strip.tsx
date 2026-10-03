'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Circle, CircleDashed, CircleDot, Loader2, Square, type LucideIcon } from 'lucide-react';
import { fetchWithAuth } from '@/lib/db/client';
import { useSseNotifications } from '@/hooks/use-sse-notifications';
import { useFlatHref } from '@/hooks/use-flat-href';

/**
 * story #4534 (명세 모음 B-3 · «상태 칩 ↔ 서버 세션 상태») — the agent's session in its DM: the desktop bar's words and shapes
 * (no new word), and one line where the phone's [멈춤] [지금 지시] would be. The web only looks (a browser has no device key to
 * sign with). Read again on `desktop.session_changed` and every 30 s.
 */
type SessionState = 'starting' | 'working' | 'idle' | 'waiting_permission' | 'stopped' | 'unknown';
interface View {
  device_name: string | null;
  state: SessionState | null;
  remote_control: boolean;
  pending_permission_request_id: string | null;
}

const SHAPES: Record<SessionState, LucideIcon> = {
  starting: Circle, working: Loader2, idle: CircleDot, waiting_permission: AlertTriangle, stopped: Square, unknown: CircleDashed,
};
const REREAD_MS = 30_000;

async function readView(agentId: string): Promise<View | null> {
  try {
    const res = await fetchWithAuth(`/api/agents/${agentId}/desktop-session`);
    return res.ok ? ((await res.json()) as View) : null;
  } catch {
    return null;
  }
}

export function AgentSessionStrip({ agentId }: { agentId: string }) {
  const [view, setView] = useState<View | null>(null);
  const [nudges, setNudges] = useState(0);

  useSseNotifications({
    extraEventNames: ['desktop.session_changed'],
    onExtraEvent: (_name, data) => {
      const raw = typeof data === 'string' ? data : JSON.stringify(data);
      try {
        if ((JSON.parse(raw) as { agent_member_id?: string }).agent_member_id === agentId) setNudges((n) => n + 1);
      } catch {
        // not ours
      }
    },
  });

  useEffect(() => {
    let off = false;
    const read = () => void readView(agentId).then((v) => { if (!off) setView((prev) => v ?? prev); });
    read();
    const id = setInterval(read, REREAD_MS);
    return () => { off = true; clearInterval(id); };
  }, [agentId, nudges]);

  if (!view?.state) return null; // not on a computer · no session: the DM as it was
  return <Strip view={view as View & { state: SessionState }} />;
}

function Strip({ view }: { view: View & { state: SessionState } }) {
  const t = useTranslations('chats.agentSession');
  const flatHref = useFlatHref();
  const Shape = SHAPES[view.state];
  const unknown = view.state === 'unknown';
  const label = view.state === 'starting' ? t('state.starting')
    : view.state === 'working' ? t('state.working')
      : view.state === 'idle' ? t('state.idle')
        : view.state === 'waiting_permission' ? t('state.waiting_permission')
          : view.state === 'stopped' ? t('state.stopped') : t('state.unknown');
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-4 py-2 text-xs" data-testid="agent-session-strip">
      <span
        className={unknown ? 'inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-muted-foreground'
          : 'inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-foreground'}
        data-testid="agent-session-chip"
      >
        <Shape className={view.state === 'working' ? 'size-3 animate-spin' : 'size-3'} aria-hidden />
        {label}
      </span>
      {view.device_name ? <span className="text-muted-foreground">{view.device_name}</span> : null}
      <Line view={view} t={t} href={flatHref('/inbox?tab=gates')} />
    </div>
  );
}

function Line({ view, t, href }: { view: View & { state: SessionState }; t: ReturnType<typeof useTranslations>; href: string }) {
  if (view.state === 'unknown') return <p className="w-full text-muted-foreground" data-testid="agent-session-line">{t('line.unknown')}</p>;
  if (view.state === 'waiting_permission') {
    return <Link className="w-full text-muted-foreground underline" href={href} data-testid="agent-session-line">{t('line.inbox')}</Link>;
  }
  if (view.state !== 'working') return null; // idle · starting · stopped: no button place (명세 표)
  if (!view.remote_control) return <p className="w-full text-muted-foreground" data-testid="agent-session-line">{t('line.remoteOff')}</p>;
  return <p className="w-full text-muted-foreground" data-testid="agent-session-line">{t('line.onPhone')}</p>;
}
