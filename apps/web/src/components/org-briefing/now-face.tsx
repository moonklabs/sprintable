'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { CheckCircle2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { fetchWithAuth } from '@/lib/db/client';
import { cn } from '@/lib/utils';
import { useDashboardContext } from '@/app/dashboard/dashboard-shell';
import {
  buildNowFace, parseCompletionNotifications, parseMyActions,
  type NowFaceItem, type NowFaceTranslator,
} from './derive-now-face';
import { deriveAttentionClusters, type AttentionClusters, type ViewerContext } from './derive-attention-clusters';
import { AttentionClusterBoard } from './attention-cluster-board';
import { parseTeamMembers } from './derive-workforce-face';

// story ded31cb3 — 조직 브리핑 "지금" 면. doc org-briefing-hypothesis-grammar-blueprint §1.3.
// 기본 5 + "+N 더" 인라인 펼침(⛔우선순위 컷 금지 — nod 확定②: 초과분 숨김은 정보 은닉이라 폐기).
const CAP = 5;
const REFRESH_MS = 60_000;

interface NowFaceLoad {
  items: NowFaceItem[];
  clusters: AttentionClusters;
  memberNames: Record<string, string>;
}

async function loadNowFace(t: NowFaceTranslator, viewer: ViewerContext): Promise<NowFaceLoad> {
  // story #2689 — 콜드 재진입 시 raw fetch는 401을 재시도 없이 삼켜(!r.ok=>null) "지금" 면이
  // 빈 채로 60초 REFRESH_MS까지 안 채워졌다. fetchWithAuth로 401→refresh→재시도 경로에 태운다.
  // story #2852 — agent_auth_failure 클러스터가 member_id만 갖고 있어(BE가 이름을 안 줌)
  // 이름 표시엔 /api/team-members가 필요하다(workforce-face.tsx parseTeamMembers와 동형 소비).
  const [ma, notifs, membersJson] = await Promise.all([
    fetchWithAuth('/api/dashboard/my-actions').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetchWithAuth('/api/notifications?type=task_completed&unread=true').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetchWithAuth('/api/team-members').then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  const raw = parseMyActions(ma);
  return {
    items: buildNowFace(raw, parseCompletionNotifications(notifs), t),
    // story #2541 — 같은 raw.attention을 story_stalled/hypothesis_falsified 전용으로 한 번 더
    // 읽어 클러스터로 묶는다(buildNowFace는 이 두 타입을 더는 flat 행으로 안 올린다).
    // story #2829/#2830 — loop_* 3종도 동형(buildNowFace는 이 타입들을 flat 행으로 안 올림,
    // 미배선이라 자연히 무시됨). count 4종은 raw에서 그대로 넘긴다.
    clusters: deriveAttentionClusters(raw.attention, t, {
      loopOverdueHypothesisCount: raw.loopOverdueHypothesisCount,
      loopOverdueGoalCount: raw.loopOverdueGoalCount,
      loopOutcomeMissingGoalCount: raw.loopOutcomeMissingGoalCount,
      measurePlanMissingGoalCount: raw.measurePlanMissingGoalCount,
      unmeasurableGoalCount: raw.unmeasurableGoalCount,
    }, viewer),
    memberNames: parseTeamMembers(membersJson),
  };
}

function KindBadge({ kind, label }: { kind: NowFaceItem['kind']; label: string }) {
  const variant = kind === 'done' ? 'success' : 'info';
  return (
    <Badge variant={variant} className="w-[92px] shrink-0 justify-center whitespace-nowrap">
      {label}
    </Badge>
  );
}

function NowRow({ item }: { item: NowFaceItem }) {
  return (
    <Link
      href={item.href}
      className="flex items-center gap-3 border-t border-border px-3 py-3 transition-colors first:border-t-0 hover:bg-muted/50"
    >
      <KindBadge kind={item.kind} label={item.kindLabel} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium text-foreground">{item.title}</span>
        <span className="block truncate text-xs text-muted-foreground">{item.context}</span>
      </span>
      <span
        className={cn(
          'shrink-0 rounded-md px-3 py-1.5 text-xs font-medium',
          item.actionTone === 'primary'
            ? 'bg-primary text-primary-foreground'
            : 'border border-border text-foreground',
        )}
      >
        {item.actionLabel}
      </span>
    </Link>
  );
}

function RowSkeleton() {
  return <div className="h-[60px] animate-pulse border-t border-border bg-muted/30 first:border-t-0" />;
}

const EMPTY_CLUSTERS: AttentionClusters = { falsified: [], stalled: [], loop: [], loopTotalCount: 0, measurePlanMissingGoalCount: 0, unmeasurableGoalCount: 0, authFailure: [] };

export function NowFace() {
  const t = useTranslations('orgBriefing');
  const [items, setItems] = useState<NowFaceItem[] | null>(null);
  const [clusters, setClusters] = useState<AttentionClusters>(EMPTY_CLUSTERS);
  const [memberNames, setMemberNames] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState(false);
  // story #2842 — loop-face.tsx와 동형(orgMemberships에서 orgSlug 파생). useMemo로 orgId/
  // projectId(원시값)가 실제로 바뀔 때만 새 참조를 만든다 — 매 렌더 새 객체면 아래 effect가
  // 무한 재구독된다.
  const { orgId, orgMemberships, projectId } = useDashboardContext();
  const orgSlug = orgMemberships.find((o) => o.orgId === orgId)?.orgSlug;
  const viewer = useMemo<ViewerContext>(() => ({ orgSlug, activeProjectId: projectId }), [orgSlug, projectId]);

  useEffect(() => {
    const load = async () => {
      const result = await loadNowFace(t, viewer);
      setItems(result.items);
      setClusters(result.clusters);
      setMemberNames(result.memberNames);
    };
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(id);
  }, [t, viewer]);

  const list = items ?? [];
  const shown = expanded ? list : list.slice(0, CAP);
  const overflow = Math.max(0, list.length - CAP);
  const hasClusters = clusters.falsified.length > 0 || clusters.stalled.length > 0 || clusters.loopTotalCount > 0 || clusters.authFailure.length > 0;
  // story #2541 AC1/AC2 — story_stalled/hypothesis_falsified가 클러스터 보드로 옮겨간 뒤
  // NowFace 플랫 리스트가 실제로 비어도(decide/done/agent_stuck/unanswered_blocker가 0건)
  // 클러스터에 내용이 있으면 "모두 확인했어요"는 거짓이다 — 두 표면을 합쳐서 판단한다.
  const nothingPending = items !== null && list.length === 0 && !hasClusters;

  return (
    <section aria-label={t('nowTitle')}>
      <div className="mb-2.5 flex items-baseline gap-2.5">
        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-primary">
          {t('nowHeroBadge')}
        </span>
        <h2 className="text-sm font-semibold text-foreground">{t('nowTitle')}</h2>
        {items && list.length > 0 ? (
          <span className="ml-auto text-[11px] text-muted-foreground">{t('nowNote', { count: items.length })}</span>
        ) : null}
      </div>
      {items !== null ? (
        <AttentionClusterBoard
          falsified={clusters.falsified}
          stalled={clusters.stalled}
          loop={clusters.loop}
          loopTotalCount={clusters.loopTotalCount}
          measurePlanMissingGoalCount={clusters.measurePlanMissingGoalCount}
          unmeasurableGoalCount={clusters.unmeasurableGoalCount}
          authFailure={clusters.authFailure}
          memberNames={memberNames}
        />
      ) : null}
      {items === null ? (
        <div className="rounded-2xl border border-border bg-card transition-shadow hover:shadow-sm">
          {Array.from({ length: 3 }).map((_, i) => <RowSkeleton key={i} />)}
        </div>
      ) : nothingPending ? (
        <div className="rounded-2xl border border-border bg-card transition-shadow hover:shadow-sm">
          <div className="flex flex-col items-center gap-1.5 px-5 py-10 text-center">
            <CheckCircle2 className="size-5 text-success/70" aria-hidden="true" />
            <p className="text-sm font-medium text-foreground">{t('nowEmptyTitle')}</p>
          </div>
        </div>
      ) : list.length > 0 ? (
        <div className="rounded-2xl border border-border bg-card transition-shadow hover:shadow-sm">
          {shown.map((item) => (
            <NowRow key={item.id} item={item} />
          ))}
          {!expanded && overflow > 0 ? (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="w-full border-t border-border px-3 py-2.5 text-left text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
            >
              {t('nowMore', { count: overflow })}
            </button>
          ) : null}
        </div>
      ) : null}
      {items && list.length > 0 ? (
        <p className="mt-2 px-1 text-[11.5px] text-muted-foreground">{t('nowFoot')}</p>
      ) : null}
    </section>
  );
}
