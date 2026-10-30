'use client';

import { useEffect, useState } from 'react';
import { fetchWithAuth } from '@/lib/db/client';
import { useSseNotifications } from '@/hooks/use-sse-notifications';
import { parseAgentStates, type AgentStateRow } from '@/lib/agent-state-list';

const REREAD_MS = 30_000;

/**
 * story #4833 — every agent's state in one read: again every 30 s and when any `desktop.session_changed` comes (the DM strip's own rule, for all agents).
 * A read that fails keeps the last rows (a network blip must not blank the list); `loaded` is false until the first answer (no «0명» flash).
 */
export function useAgentStates(): { rows: AgentStateRow[]; loaded: boolean; readAt: number } {
  const [state, setState] = useState<{ rows: AgentStateRow[]; loaded: boolean; readAt: number }>({ rows: [], loaded: false, readAt: 0 });
  const [nudges, setNudges] = useState(0);

  useSseNotifications({
    extraEventNames: ['desktop.session_changed'],
    onExtraEvent: () => setNudges((n) => n + 1),
  });

  useEffect(() => {
    let off = false;
    const read = () => {
      void fetchWithAuth('/api/agents/desktop-sessions')
        .then(async (res) => (res.ok ? parseAgentStates(await res.json()) : null))
        .catch(() => null)
        .then((rows) => {
          if (off) return;
          // a failed read keeps the rows but moves the clock on: a limit's «풀리는 때가 지났어요» is judged on this page's time, not on the last good read's
          if (!rows) { setState((prev) => (prev.loaded ? { ...prev, readAt: Date.now() } : prev)); return; }
          setState({ rows, loaded: true, readAt: Date.now() });
        });
    };
    read();
    const id = setInterval(read, REREAD_MS);
    return () => { off = true; clearInterval(id); };
  }, [nudges]);

  return state;
}
