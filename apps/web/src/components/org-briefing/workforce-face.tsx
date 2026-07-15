'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Users, Bot } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import {
  buildWorkforceFace, parseActiveEpics, parseEpicStories, parseTeamMembers,
  type WorkforceFaceItem, type WorkforceFaceTranslator,
} from './derive-workforce-face';

// story 09fa254e — 조직 브리핑 "워크포스" 면. S1 셸의 스켈레톤 자리에 배치 이동 없이 증분 장착.
// 아바타 클러스터는 collaboration-map.tsx(E-GLANCE §5)와 동일 스타일(숫자 배지 0, presence만).
// story 64b9a879: 빈상태를 "사람과 AI가 함께 맡은 일이 여기 모입니다"로 전환·Users+Bot 아이콘
// 페어로 인간+AI 하이브리드 정체성을 gentle하게 신호(무거운 일러스트 아닌 절제된 아이콘 2개).
const REFRESH_MS = 60_000;

interface WorkforceData {
  items: WorkforceFaceItem[];
  memberNames: Record<string, string>;
}

async function loadWorkforceFace(projectId: string, t: WorkforceFaceTranslator): Promise<WorkforceData> {
  const overview = await fetch('/api/dashboard/overview').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const epics = parseActiveEpics(overview);
  const [storiesResults, membersJson] = await Promise.all([
    Promise.all(epics.map((e) =>
      fetch(`/api/stories?epic_id=${e.epicId}&project_id=${projectId}&limit=100`)
        .then((r) => (r.ok ? r.json() : null)).catch(() => null),
    )),
    fetch('/api/team-members').then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  const storiesByEpic: Record<string, ReturnType<typeof parseEpicStories>> = {};
  epics.forEach((e, i) => { storiesByEpic[e.epicId] = parseEpicStories(storiesResults[i]); });
  return { items: buildWorkforceFace(epics, storiesByEpic, t), memberNames: parseTeamMembers(membersJson) };
}

function TrustBadge({ trust, label }: { trust: WorkforceFaceItem['trust']; label: string | null }) {
  if (!trust || !label) return null;
  return <Badge variant={trust === 'verified' ? 'success' : 'chip'} className="shrink-0 whitespace-nowrap">{label}</Badge>;
}

function WorkforceRow({ item, memberNames, t }: { item: WorkforceFaceItem; memberNames: Record<string, string>; t: WorkforceFaceTranslator }) {
  return (
    <div className="space-y-1.5 border-t border-border py-3 first:border-t-0 first:pt-0">
      <div className="flex items-center gap-2.5">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">{item.title}</span>
        <TrustBadge trust={item.trust} label={item.trustLabel} />
      </div>
      {item.collaboratorIds.length > 0 ? (
        <div className="flex items-center gap-2.5">
          <div className="flex -space-x-1.5">
            {item.collaboratorIds.map((id) => {
              const name = memberNames[id] ?? '?';
              return (
                <span
                  key={id}
                  title={name}
                  className="flex size-6 items-center justify-center rounded-full border-2 border-card bg-primary/15 text-[10px] font-semibold text-primary"
                >
                  {name.slice(0, 1)}
                </span>
              );
            })}
          </div>
          <span className="text-[11px] text-muted-foreground">{t('workforceTogether')}</span>
        </div>
      ) : (
        <span className="text-[11px] italic text-muted-foreground/70">{t('workforceUnassigned')}</span>
      )}
    </div>
  );
}

function RowSkeleton() {
  return (
    <div className="space-y-1.5 border-t border-border py-3 first:border-t-0 first:pt-0">
      <div className="h-3 w-3/5 animate-pulse rounded bg-muted" />
      <div className="h-6 w-16 animate-pulse rounded-full bg-muted" />
    </div>
  );
}

export function WorkforceFace({ projectId }: { projectId: string }) {
  const t = useTranslations('orgBriefing');
  const [data, setData] = useState<WorkforceData | null>(null);

  useEffect(() => {
    const load = async () => {
      const result = await loadWorkforceFace(projectId, t);
      setData(result);
    };
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(id);
  }, [projectId, t]);

  return (
    <div className="rounded-2xl border border-border bg-card p-4 transition-shadow hover:shadow-sm">
      <div className="mb-3 flex items-baseline gap-2.5">
        <span className="size-1.5 shrink-0 rounded-full bg-success" aria-hidden="true" />
        <h2 className="text-sm font-semibold text-foreground">{t('workforceTitle')}</h2>
        <span className="text-[11px] text-muted-foreground">{t('workforceSubject')}</span>
      </div>
      {data === null ? (
        <>
          <RowSkeleton />
          <RowSkeleton />
        </>
      ) : data.items.length === 0 ? (
        <div className="space-y-2 py-6 text-center">
          <div className="flex items-center justify-center gap-1.5 text-muted-foreground/50" aria-hidden="true">
            <Users className="size-4" />
            <Bot className="size-4" />
          </div>
          <p className="text-xs text-muted-foreground">{t('workforceEmpty')}</p>
        </div>
      ) : (
        data.items.map((item) => <WorkforceRow key={item.id} item={item} memberNames={data.memberNames} t={t} />)
      )}
    </div>
  );
}
