'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Bot, Clock } from 'lucide-react';
import { SectionCard, SectionCardBody, SectionCardHeader } from '@/components/ui/section-card';
import { Badge } from '@/components/ui/badge';

export interface AgentPresenceMember {
  id: string;
  name: string;
  type: string;
  presence_status: 'online' | 'idle' | 'offline' | null;
  active_story: { id: string; title: string; status: string } | null;
  last_seen_at: string | null;
}

interface AgentPresencePanelProps {
  initialMembers: AgentPresenceMember[];
  projectId: string;
}

const POLL_INTERVAL = 30_000;

function presenceDotClass(status: AgentPresenceMember['presence_status']): string {
  switch (status) {
    case 'online': return 'bg-emerald-500';
    case 'idle': return 'bg-amber-400';
    default: return 'bg-muted-foreground/40';
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}

export function AgentPresencePanel({ initialMembers, projectId }: AgentPresencePanelProps) {
  const t = useTranslations('agentPresence');
  const [members, setMembers] = useState<AgentPresenceMember[]>(initialMembers);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchMembers = useCallback(async () => {
    try {
      const res = await fetch(`/api/team-members?project_id=${encodeURIComponent(projectId)}&type=agent`);
      if (!res.ok) return;
      const json = await res.json() as { data: AgentPresenceMember[] | null };
      if (Array.isArray(json.data)) {
        setMembers(json.data.filter((m) => m.type === 'agent'));
      }
    } catch {
      // Silently skip poll failures
    }
  }, [projectId]);

  useEffect(() => {
    const start = () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = setInterval(fetchMembers, POLL_INTERVAL);
    };
    const stop = () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };

    const handleVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        fetchMembers();
        start();
      }
    };

    start();
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [fetchMembers]);

  const agentMembers = members.filter((m) => m.type === 'agent');

  return (
    <SectionCard>
      <SectionCardHeader>
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-semibold text-foreground">{t('title')}</div>
          <Badge variant="chip" className="inline-flex items-center gap-1 text-xs">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" aria-hidden="true" />
            {t('liveLabel')}
          </Badge>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('description')}</p>
      </SectionCardHeader>
      <SectionCardBody className="space-y-2">
        {agentMembers.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <Bot className="size-8 text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">{t('empty')}</p>
          </div>
        ) : (
          agentMembers.map((member) => (
            <div
              key={member.id}
              className="flex items-start gap-3 rounded-md border border-border bg-muted/30 px-3 py-2.5"
            >
              <span
                className={`mt-1 h-2 w-2 shrink-0 rounded-full ${presenceDotClass(member.presence_status)}`}
                aria-label={t(`status_${member.presence_status ?? 'offline'}`)}
              />
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="text-sm font-medium text-foreground leading-snug">{member.name}</div>
                {member.active_story ? (
                  <div className="text-xs text-muted-foreground truncate">
                    {truncate(member.active_story.title, 40)}
                  </div>
                ) : (
                  <div className="text-xs text-muted-foreground">{t(`status_${member.presence_status ?? 'offline'}`)}</div>
                )}
              </div>
              {member.active_story && (
                <Badge variant="chip" className="shrink-0 text-[10px]">
                  {member.active_story.status}
                </Badge>
              )}
              {!member.active_story && member.last_seen_at && member.presence_status !== 'online' && (
                <Clock className="mt-0.5 size-3 shrink-0 text-muted-foreground/50" aria-hidden="true" />
              )}
            </div>
          ))
        )}
      </SectionCardBody>
    </SectionCard>
  );
}
