'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldCheck } from 'lucide-react';
import { ProofCapsule } from '@/components/proof-capsule/proof-capsule';
import type { GateItem, DependencyEdge } from '@/components/kanban/types';
import {
  deriveGateAttentionItems, deriveBlockedAttentionItems, buildAttentionQueue,
  type AttentionStoryLite, type AttentionMember, type AttentionQueueItem,
} from './derive-attention-queue';

// P0-06("오늘" 구역) 착지 전까지 임시 스코프 — kanban 활성 상태만(done 제외, 개입 후보 풀).
const ACTIVE_STATUSES = ['backlog', 'ready-for-dev', 'in-progress', 'in-review'];
const CAP = 7;

interface StoryListItem {
  id: string;
  title: string;
  assignee_id: string | null;
}

interface TeamMemberItem {
  id: string;
  name: string | null;
  type: 'human' | 'agent';
}

async function fetchActiveStories(projectId: string): Promise<StoryListItem[]> {
  const results = await Promise.all(ACTIVE_STATUSES.map((status) => {
    const params = new URLSearchParams({ project_id: projectId, status, limit: '100' });
    return fetch(`/api/stories?${params}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((json: { data?: StoryListItem[] } | null) => json?.data ?? [])
      .catch(() => [] as StoryListItem[]);
  }));
  return results.flat();
}

async function fetchAttentionQueue(projectId: string): Promise<AttentionQueueItem[]> {
  const [gatesJson, graphJson, membersJson, stories] = await Promise.all([
    fetch('/api/gates?status=pending').then((r) => (r.ok ? r.json() : [])).catch(() => [] as GateItem[]),
    fetch('/api/dependencies/graph?item_type=story')
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null as { edges?: DependencyEdge[] } | null),
    fetch('/api/team-members')
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .catch(() => ({ data: [] as TeamMemberItem[] })),
    fetchActiveStories(projectId),
  ]);

  const gates = gatesJson as GateItem[];
  const blockedByMap: Record<string, string[]> = {};
  for (const edge of (graphJson as { edges?: DependencyEdge[] } | null)?.edges ?? []) {
    if (edge.dep_type === 'blocks') (blockedByMap[edge.to_id] ??= []).push(edge.from_id);
  }
  const members = ((membersJson as { data?: TeamMemberItem[] }).data ?? []);

  const storiesById = new Map<string, AttentionStoryLite>(
    stories.map((s) => [s.id, { id: s.id, title: s.title, assignee_id: s.assignee_id }]),
  );
  const membersById = new Map<string, AttentionMember>(
    members.map((m) => [m.id, { name: m.name, type: m.type }]),
  );

  return [
    ...deriveGateAttentionItems(gates, storiesById, membersById),
    ...deriveBlockedAttentionItems(blockedByMap, storiesById, membersById),
  ];
}

function RowSkeleton() {
  return <div className="h-[52px] animate-pulse border-b border-proof-line-soft bg-proof-sunk/60 last:border-b-0" />;
}

function AttentionRow({ item, onNavigate }: { item: AttentionQueueItem; onNavigate: (href: string) => void }) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a')) return;
        onNavigate(item.href);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onNavigate(item.href);
      }}
      className="cursor-pointer border-b border-proof-line-soft last:border-b-0 hover:bg-proof-sunk"
    >
      <ProofCapsule
        density="row"
        proofState={item.proofState}
        stateLabel={item.kindLabel}
        claim={item.claim}
        human={item.actor && !item.actor.isAgent ? { name: item.actor.name, role: '' } : undefined}
        agent={item.actor?.isAgent ? { name: item.actor.name, initial: item.actor.name.slice(0, 1) } : undefined}
        gate={{ action: item.actionLabel, href: item.href, tone: item.actionTone }}
        className="rounded-none border-0"
      />
    </div>
  );
}

/**
 * Attention Queue(E-UI-DAEGBYEON P0-05, story 5f25c615). "지금 개입할 3~7개"만 — 원시 이벤트
 * 나열 아니라 판단이 필요한 것만. Proof Capsule row density 재사용(신규 컴포넌트 아님).
 *
 * v1 스코프: 5유형 중 4개만(검증실패/결정필요/막힘/병합대기) — 범위이탈(Red)은 BE에 "승인범위
 * 밖" 판정 신호가 아직 없어 no-fiction 원칙상 제외(P0-04 착지 후 추가 예정, PO 승인·2026-07-11).
 */
export function AttentionQueueView({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<AttentionQueueItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const result = await fetchAttentionQueue(projectId);
      if (cancelled) return;
      setItems(result);
      setLoading(false);
    }
    void load();
    return () => { cancelled = true; };
  }, [projectId]);

  const { shown, overflow } = buildAttentionQueue(items, CAP);

  return (
    <div className="overflow-hidden rounded-2xl border border-proof-line bg-proof-panel" style={{ clipPath: 'polygon(0 0, calc(100% - 24px) 0, 100% 24px, 100% 100%, 0 100%)' }}>
      <div className="flex items-baseline justify-between gap-3 border-b border-proof-line-soft px-5 py-3.5">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-[0.12em] text-proof-faint">오늘 · Attention Queue</div>
          <h2 className="text-[19px] font-extrabold leading-tight tracking-[-0.014em] text-proof-ink">지금 개입할 것</h2>
        </div>
        {!loading ? (
          <div className="shrink-0 text-[13px] font-medium text-proof-ink-3">
            <b className="text-proof-ink">{shown.length}</b>건 · 로그 안 열고 판단
          </div>
        ) : null}
      </div>

      {loading ? (
        <div>{Array.from({ length: 3 }).map((_, i) => <RowSkeleton key={i} />)}</div>
      ) : shown.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-5 py-10 text-center">
          <div className="inline-flex items-center gap-1.5 text-[11px] font-bold tracking-[0.02em] text-proof-green">
            <ShieldCheck className="size-3.5" aria-hidden="true" />ALL CLEAR
          </div>
          <p className="text-[15px] font-semibold text-proof-ink-2">지금 개입할 것 없음</p>
          <p className="text-[12.5px] text-proof-faint">모든 작업이 흐르고 있는. 예외가 생기면 여기 올라오는.</p>
        </div>
      ) : (
        <div>
          {shown.map((item) => (
            <AttentionRow key={item.id} item={item} onNavigate={(href) => router.push(href)} />
          ))}
          {overflow > 0 ? (
            <div className="flex items-center gap-1.5 border-t border-proof-line-soft bg-proof-sunk px-5 py-2.5 text-[12.5px] text-proof-ink-3">
              <span className="size-1 rounded-full bg-proof-faint" aria-hidden="true" />
              나머지는 흐르는 중 — {overflow}건은 여기 안 올림
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
