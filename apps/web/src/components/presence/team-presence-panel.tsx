'use client';

import { useTranslations } from 'next-intl';
import { KeyRound, X } from 'lucide-react';
import type { PresenceStatus } from '@/components/chat/presence-dot';
import { Avatar } from '@/components/shared/avatar';
import { GlassPanel } from '@/components/ui/glass-panel';
import { cn } from '@/lib/utils';
import type { TeamPresenceItem } from './use-team-presence';
import type { AgentAuthFailureInfo } from './use-agent-auth-failures';

type GroupKey = 'working' | 'online' | 'offline';
// story #2023(ⓑ): working=시스템 활동 신호(L5) — brand(인간 서명)가 아니라 info.
const GROUP_DOT: Record<GroupKey, string> = {
  working: 'bg-info',
  online: 'bg-success',
  offline: 'bg-muted-foreground/40',
};

function groupItems(items: TeamPresenceItem[]): { key: GroupKey; items: TeamPresenceItem[] }[] {
  const byName = (a: TeamPresenceItem, b: TeamPresenceItem) => a.name.localeCompare(b.name);
  const working = items.filter((i) => i.working).sort(byName);
  // online 그룹 = working 아님 + (online | idle). idle은 dot=amber로 구분(별 그룹 안 만듦·노이즈↓).
  const online = items.filter((i) => !i.working && (i.presence_status === 'online' || i.presence_status === 'idle')).sort(byName);
  const offline = items.filter((i) => !i.working && (i.presence_status === 'offline' || !i.presence_status)).sort(byName);
  return ([
    { key: 'working', items: working },
    { key: 'online', items: online },
    { key: 'offline', items: offline },
  ] as { key: GroupKey; items: TeamPresenceItem[] }[]).filter((g) => g.items.length > 0);
}

// story #2852(2836 FE 조각) AC1 — 인증 실패는 「복구 가능한 주의 요망 상태」(키 재발급으로
// 복구)이지 kill/종결이 아니다. destructive(빨강) 금지 — warning-tint 뱃지+text-foreground
// (story #2420 규칙, tint 배경 위 계열색 금지). AC3 — reason enum을 raw로 안 보이고 title
// 툴팁에 유저 어휘로 매핑.
const AUTH_FAILURE_TOOLTIP_KEY: Record<AgentAuthFailureInfo['reason'], string> = {
  expired: 'authFailureTooltipExpired',
  revoked: 'authFailureTooltipRevoked',
  invalid: 'authFailureTooltipInvalid',
};

function AuthFailureBadge({ info }: { info: AgentAuthFailureInfo | undefined }) {
  const t = useTranslations('presence');
  if (!info) return null;
  return (
    <span
      title={t(AUTH_FAILURE_TOOLTIP_KEY[info.reason], { n: info.failureCount })}
      // 유나 design:changes(2026-08-20, PR#3275) — border 없는 bg-warning-tint 단독은 패널
      // 배경과 대비 1.06(라이트)/1.67(다크)로 AC2 layer①(≥3:1) 미달. 클러스터 행 Badge
      // variant="warning"이 이미 쓰는 관례(border-warning-border)를 그대로 맞춘다.
      className="inline-flex shrink-0 items-center gap-1 rounded-md border border-warning-border bg-warning-tint px-1.5 py-0.5 text-[10px] font-semibold text-foreground"
    >
      <KeyRound className="size-2.5 shrink-0" aria-hidden />
      {t('authFailureBadge')}
    </span>
  );
}

function PresenceRow({ item, authFailure }: { item: TeamPresenceItem; authFailure?: AgentAuthFailureInfo }) {
  const t = useTranslations('presence');
  const offline = !item.working && (item.presence_status === 'offline' || !item.presence_status);
  const dotStatus: PresenceStatus = item.presence_status ?? 'offline';
  const fallback = [item.agent_role, item.runtime_type].filter(Boolean).join(' · ');

  return (
    <li className={cn('flex items-center gap-2.5 rounded-lg px-2 py-1.5', offline && 'opacity-60')}>
      <Avatar
        name={item.name}
        avatarUrl={item.avatar_url}
        actorType="agent"
        size={32}
        presenceStatus={dotStatus}
        isWorking={item.working}
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className={cn('min-w-0 truncate text-sm font-medium', offline ? 'text-muted-foreground' : 'text-foreground')}>
            {item.name}
          </p>
          <AuthFailureBadge info={authFailure} />
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {item.working ? (
            <span className="inline-flex max-w-full items-center gap-1 text-info">
              <span className="shrink-0">{t('working')}</span>
              <span className="inline-flex shrink-0 gap-0.5" aria-hidden>
                <span className="size-1 rounded-full bg-info motion-safe:animate-bounce" />
                <span className="size-1 rounded-full bg-info motion-safe:animate-bounce [animation-delay:150ms]" />
                <span className="size-1 rounded-full bg-info motion-safe:animate-bounce [animation-delay:300ms]" />
              </span>
              {item.active_story ? (
                <span className="truncate text-muted-foreground">· {t('assignedStory', { title: item.active_story.title })}</span>
              ) : null}
            </span>
          ) : item.active_story ? (
            t('assignedStory', { title: item.active_story.title })
          ) : (
            fallback
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * 2505d27d 팀 presence 패널 본체 — 상태별 그룹(🔵working↑→🟢online→⚫offline↓).
 * 폴은 ScrollShell의 `useTeamPresence`에서 상향(단일 폴·FAB 배지와 공유)·items로 주입받는다.
 * contextual-panel-layout의 renderPanel로 inline(right-rail)/drawer 양쪽에서 렌더.
 */
export function TeamPresencePanel({
  items,
  onClose,
  authFailureByMember = {},
}: {
  items: TeamPresenceItem[];
  onClose?: () => void;
  authFailureByMember?: Record<string, AgentAuthFailureInfo>;
}) {
  const t = useTranslations('presence');
  const groups = groupItems(items);

  return (
    <GlassPanel className="flex h-full min-h-0 flex-col overflow-hidden rounded-xl">
      <header className="flex shrink-0 items-center justify-between border-b border-border/60 px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">{t('panelTitle')}</h2>
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label={t('panelTitle')}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        ) : null}
      </header>

      <div className="focus-inset min-h-0 flex-1 overflow-y-auto py-2">
        {groups.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">{t('empty')}</p>
        ) : (
          groups.map((g) => (
            <section key={g.key} className="px-2 py-1">
              <div className="flex items-center gap-2 px-2 py-1">
                <span className={cn('size-2 rounded-full', GROUP_DOT[g.key])} aria-hidden />
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {t(g.key === 'working' ? 'groupWorking' : g.key === 'online' ? 'groupOnline' : 'groupOffline')}
                </h3>
                <span className="ml-auto text-xs tabular-nums text-muted-foreground">{g.items.length}</span>
              </div>
              <ul>
                {g.items.map((item) => (
                  <PresenceRow key={item.member_id} item={item} authFailure={authFailureByMember[item.member_id]} />
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    </GlassPanel>
  );
}
