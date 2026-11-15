'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Checkbox } from '@/components/ds/checkbox';
import { Chip } from '@/components/ds/chip';
import { DataText, joinDot } from '@/components/ds/data-text';
import { Icon } from '@/components/ds/icon';
import { useEmbeddedServer } from '@/components/embedded-server-context';
import { EmptyState } from '@/components/ds/empty-state';
import { PageFrame } from '@/components/ds/page-frame';
import { PageHead } from '@/components/ds/page-head';
import { RowList, RowListItem, type RowAction } from '@/components/ds/row-list';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button as DialogButton } from '@/components/ui/button';
import { fetchWithAuth } from '@/lib/db/client';
import { fetchMe } from '@/lib/me-client';
import { formatViewerRelativeTime } from '@/lib/storage/format';
import { isSystemPublisher } from '@/lib/runtime-capabilities';
import { isDesktopRuntime } from '@/lib/agent-run-profile';
import { AgentRunProfileBulkDialog } from '@/components/agents/agent-run-profile-bulk-dialog';
import { CountBadge } from '@/components/ui/count-badge';
import { useFlatHref } from '@/hooks/use-flat-href';
import { agentRoleLabel } from '@/lib/org-role-label';
import { memberRowLabels } from '@/lib/member-display';
import { RowName } from '@/components/shared/row-name';
import { StatusLabel } from '@/components/ds/status-label';
import { Skeleton, SkeletonGroup } from '@/components/ds/skeleton';
import { useAgentStates } from '@/hooks/use-agent-states';
import { sessionStateLabel, shownState } from '@/components/chat/agent-session-strip';
import { limitHeld, limitLooksAgain } from '@/lib/agent-session-limit';
import { stateMark, type AgentStateRow } from '@/lib/agent-state-list';
import { useViewerTimeZone } from '@/components/viewer-time-zone';

/**
 * story #4129 — 워크포스 1줄(«런타임 vX · (플러그인 vY) · 세션 시작 N시간 전», PO 확定
 * 2026-09-21 23:25Z 문안 개정). client_version/session_started_at 둘 다 없으면 줄 전체를
 * 숨긴다(placeholder로 "판단 불가"를 보여주지 않는다, AC3) — 있는 세그먼트만 · 로 잇는다.
 */
export function formatAgentRuntimeLine(
  agent: Pick<OrgAgent, 'client_version' | 'plugin_version' | 'session_started_at'>,
  locale: string,
  displayTimezone: string | null,
  // story #4129 CI RED(check-i18n-keys.js) — 이 파라미터가 `t`였을 때, 이 파일의
  // `const t = useTranslations('settings')`(scripts/check-i18n-keys.js는 스코프를
  // 모르는 파일 단위 정적 매칭이라 함수 파라미터의 섀도잉을 못 본다)로 오귀속돼
  // agentRuntimeSegment류를 실제 호출부 네임스페이스(agents, 아래 `ta` 인자)가 아니라
  // settings 네임스페이스에서 찾다 missing 처리했다. 파라미터명을 `t`와 겹치지 않게
  // 바꿔 그 정적 매칭 오귀속 자체를 원천 차단(페드루 PO 리뷰).
  translate: (key: string, values?: Record<string, string>) => string,
): string | null {
  const segments: string[] = [];
  if (agent.client_version) {
    segments.push(translate('agentRuntimeSegment', { version: agent.client_version }));
  }
  if (agent.plugin_version) {
    segments.push(translate('agentRuntimePluginSegment', { version: agent.plugin_version }));
  }
  if (agent.session_started_at) {
    const relative = formatViewerRelativeTime(agent.session_started_at, locale, displayTimezone);
    if (relative) segments.push(translate('agentRuntimeSessionSegment', { relative }));
  }
  if (segments.length === 0) return null;
  return segments.join(' · ');
}

interface OrgAgent {
  id: string;
  name: string;
  role: string;
  is_active: boolean;
  // story #2751(설계②) — BE `_inject_active_stories()`가 배치 주입(fan-out 없음, PO
  // 확定 — get_verified_map()). false=stdio verify 미완주(이탈 후보) — "연결 안 됨" CTA
  // 대상. undefined/null이면 판별 불가(예: 이 필드를 아직 안 실어보내는 옛 응답 형태
  // 방어) — 그 경우 CTA를 안 띄운다(거짓 "연결 안 됨" 낙인 방지, 침묵 실패보다 과소표시가
  // 안전한 방향).
  verified?: boolean | null;
  // story #4129 — MCP clientInfo·(있으면)plugin 버전·세션 시작. 전부 BE computed_field라
  // 값이 없으면 그냥 undefined(마이그레이션 0, 새 응답 계약 필드 아님 — 무회귀).
  client_name?: string | null;
  client_version?: string | null;
  plugin_version?: string | null;
  session_started_at?: string | null;
  // BE `_inject_active_stories()`가 조직 내 plugin_version MAX 대비 배치 주입. null=판단
  // 불가(플러그인 버전이 없거나 org에 비교대상 없음) — false와 구분(휴리스틱 배지 금지).
  needs_restart?: boolean | null;
  // story #3994 — 「시스템 발행」(runtime_type==='system-publisher')은 verified가 항상
  // false지만 연결 대상이 아니다(BE TeamMemberResponse가 이미 실어 보내던 필드, 이
  // 로컬 타입에만 없었다 — 새 BE 0). 판별 없이 verified만 보면 거짓 「연결 안 됨」.
  runtime_type?: string | null;
  // story 4675 (F2) — the computer the agent is bound to now (BE `_inject_active_stories()` · null = no live desktop key)
  device_name?: string | null;
  // story 4686 (AC3): a desktop agent whose run profile names no model — the runtime's own default runs (true) · a model is named (false) · not a
  // desktop agent / an older server (null · absent). The row says «모델 · 런타임 기본값» only for true.
  run_model_unset?: boolean | null;
}

interface ProjectOption {
  id: string;
  name: string;
}

interface AccessRecord {
  member_id?: string | null;
}

interface AgentManagementTabProps {
  /** story d82c1092(생성경로 단일화) — "에이전트 추가"는 채용 탭으로 라우팅한다(별도 모달 제거). */
  onAddAgent?: () => void;
}

/**
 * story #2406 AC1 — 되돌릴 수 없는 방향(비활성화)에만 확認을 붙이고, 되돌릴 수 있는 방향
 * (활성화)엔 안 붙인다(PO 설계 판단 ②: 양쪽에 붙이면 무게가 같아져 되돌릴 수 없는 쪽의 경고가
 * 묽어진다). 실사고(2026-08-01) — 확認 없이 즉시 실행되어 PO 자신의 계정이 잘못 눌려 비활성화됐다.
 */
export function requiresDeactivateConfirm(agent: Pick<OrgAgent, 'is_active'>): boolean {
  return agent.is_active;
}

/**
 * story d63d3f73 §5② — org 에이전트 목록(관리 탭). 접근 프로젝트 수 요약은 에이전트별
 * fan-out(A×P) 대신 프로젝트별 access 를 P 콜로 한 번만 조회해 member_id 기준으로 집계한다
 * (AgentProjectAccessSection 의 단일-에이전트 fan-out과 동일 원천, org 목록에 맞게 방향만 반전 —
 * Phase 2 매트릭스가 우려하는 N×M 콜과 다름: 프로젝트 수 P에만 비례, 에이전트 수와는 무관).
 */
export function AgentManagementTab({ onAddAgent }: AgentManagementTabProps) {
  const flatHref = useFlatHref(); // story #4231 — flat 링크 `?p=`
  const router = useRouter();
  const embedded = useEmbeddedServer(); // story 4832: one computer — a computer name that tells two apart says nothing there
  const t = useTranslations('settings');
  const ta = useTranslations('agents');
  const tc = useTranslations('common');
  const to = useTranslations('organization');
  const locale = useLocale();
  const displayTimezone = useViewerTimeZone(); // story #4443 PR2b — the viewer's zone (null until known)
  const [agents, setAgents] = useState<OrgAgent[]>([]);
  // story #4311 — 같은 이름 구성원이 한 목록에서 갈리게 행 라벨은 memberRowLabels(member-display 한 곳의 꼬리 규칙)로.
  // story #4311(유나 비차단) — 행에 조직 역할 배지가 보이므로 그 글자를 roleLabel로 넘긴다(역할이 보이고 서로 다르면 꼬리 없음).
  const rowLabels = useMemo(() => memberRowLabels(agents, tc, (a) => agentRoleLabel(a.role, to) ?? ''), [agents, tc, to]);

  // story 4889 (W1): the list reads the SAME live state as the DM strip and the Today list (one read: /api/agents/desktop-sessions) — a row of an agent on a computer wears its state
  const { rows: stateRows } = useAgentStates();
  const stateByAgent = useMemo(() => new Map(stateRows.map((r) => [r.agent_id, r])), [stateRows]);
  const [grantCounts, setGrantCounts] = useState<Record<string, number>>({});
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  // story #1989: mount effect가 try/catch 없이 fetch를 직결해 네트워크 실패(오프라인 등) 시
  // fetch가 throw → setLoading(false)가 영영 안 불려 스켈레톤이 무한 행("loading은 finally에서
  // 해소" 하우스룰 위반). loadError로 실패를 별도 상태화해 재시도 affordance를 노출한다.
  const [loadError, setLoadError] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deactivateTarget, setDeactivateTarget] = useState<OrgAgent | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  // story #4540 — agents chosen for «실행 설정 바꾸기» (desktop runtimes only · the server judges each)
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);

  // settings/page.tsx 컨벤션과 동일: plain(비-useCallback) 헬퍼 — mount effect가 이를 호출하는
  // 체인 안에서 setState가 일어나도 react-hooks/set-state-in-effect가 useCallback 체인만큼
  // 깊이 추적하지 않는다(AgentPerformancePanel·AgentProjectAccessSection은 위임 없이 자체
  // setState라 통과, 여기선 refreshAgents/refreshGrantCounts로 위임하므로 plain fn 유지).
  // story 4912 D1 — a failed FIRST read used to return silently, so the list said «조직에 등록된 에이전트가 없어요» (an error read as «none»). The mount load passes `strict`, so a non-OK answer
  // throws into the load's catch (→ the error state with [다시 시도], which was already there for a rejected request). The re-reads after a toggle / bulk save stay quiet: the list already on screen is kept.
  const refreshAgents = async (strict = false) => {
    const res = await fetchWithAuth('/api/team-members?type=agent&include_inactive=true');
    if (!res.ok) {
      if (strict) throw new Error('agent list read failed');
      return;
    }
    const json = await res.json() as { data?: OrgAgent[] };
    setAgents(json.data ?? []);
  };

  const refreshGrantCounts = async (projectList: ProjectOption[]) => {
    if (projectList.length === 0) { setGrantCounts({}); return; }
    const results = await Promise.all(
      projectList.map((p) =>
        fetchWithAuth(`/api/projects/${p.id}/access`)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null) as Promise<{ data?: AccessRecord[] } | null>,
      ),
    );
    const counts: Record<string, number> = {};
    for (const json of results) {
      for (const rec of json?.data ?? []) {
        if (!rec.member_id) continue;
        counts[rec.member_id] = (counts[rec.member_id] ?? 0) + 1;
      }
    }
    setGrantCounts(counts);
  };

  useEffect(() => {
    void (async () => {
      setLoading(true);
      setLoadError(false);
      try {
        // story #3519(§16-7 2부, PO 確定 2026-09-05) — 둘 다 부수(ok?채움:방치, 예를 들어
        // meRes는 isAdmin 판정만 바꾼다)인데 격리가 없어, meRes가 네트워크단 reject하면
        // 이 try/catch 바깥 catch가 setLoadError(true)로 «승격»시켜 에이전트 목록(이
        // 탭의 실제 주 콘텐츠, refreshAgents가 따로 그린다)까지 통째로 못 뜨게 했다.
        const [meRes, projectsRes] = await Promise.all([
          fetchMe().catch(() => null),
          fetchWithAuth('/api/projects').catch(() => null),
        ]);
        if (meRes?.ok) {
          const meJson = await meRes.json() as { data?: { role?: string } };
          const role = meJson.data?.role ?? 'member';
          setIsAdmin(role === 'admin' || role === 'owner');
        }
        let projectList: ProjectOption[] = [];
        if (projectsRes?.ok) {
          const json = await projectsRes.json() as { data?: ProjectOption[] };
          projectList = (json.data ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));
        }
        await Promise.all([refreshAgents(true), refreshGrantCounts(projectList)]);
      } catch {
        setLoadError(true);
      } finally {
        setLoading(false);
      }
    })();
  }, [retryKey]);

  const handleToggleActive = async (agent: OrgAgent) => {
    setTogglingId(agent.id);
    setMessage(null);
    const res = await fetch(`/api/team-members/${agent.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: !agent.is_active }),
    });
    if (res.ok) {
      setMessage({ type: 'success', text: agent.is_active ? t('agentDeactivated') : t('agentActivated') });
      await refreshAgents();
    } else {
      // story #2485 — backend update_team_member()는 generic HTTP상태 코드만 낸다
      // (진짜 비즈니스 code 없음, 그라운딩 확認) — raw 서버 message 노출 대신 고정 문구.
      setMessage({ type: 'error', text: t('agentActionFailed') });
    }
    setTogglingId(null);
  };

  // story #2406 AC1 — 되돌릴 수 없는 방향(비활성화)만 확認 다이얼로그로 가로챈다.
  // 활성화는 되돌릴 수 있는 조작이라 즉시 실행(설계 판단 ②, PO 확認).
  const requestToggle = (agent: OrgAgent) => {
    if (requiresDeactivateConfirm(agent)) {
      setDeactivateTarget(agent);
      return;
    }
    void handleToggleActive(agent);
  };

  const confirmDeactivate = async () => {
    if (!deactivateTarget) return;
    const target = deactivateTarget;
    setDeactivateTarget(null);
    await handleToggleActive(target);
  };

  // story 4912 (UI-R4 · PR A1) — one row = ListRow(56): a name that is the link to the detail, a SECOND LINE of text (role · projects · computer · model · runtime — chips used to say all of it),
  // only the states that must be SAID as chips on the right (inactive · not connected · restart needed + the live state), and the row's actions in ONE array that draws both the «⋯» menu and the
  // right-click menu. Enter and double click open the detail (`onOpen`, the pointer version of Enter).
  const rowActions = (agent: OrgAgent, index: number): RowAction[] => {
    const list: RowAction[] = [];
    if (!isSystemPublisher(agent.runtime_type) && agent.verified === false) {
      list.push({ key: 'connection', label: ta('viewConnectionSettings'), icon: 'link', onSelect: () => router.push(flatHref(`/organization/workforce/${agent.id}`)) });
    }
    if (isAdmin) {
      // story #3592(§17-20 ⑧·§22-18 동형) — the toggle's name carries the row's ordinal; story #3608 — «…» is spelled as a word. The menu item says what it does now.
      const visibleLabel = togglingId === agent.id ? t('agentToggling') : agent.is_active ? t('deactivateAgent') : t('activateAgent');
      list.push({ key: 'toggle', label: visibleLabel, icon: agent.is_active ? 'block' : 'check_circle', variant: agent.is_active ? 'danger' : 'default', disabled: togglingId === agent.id, onSelect: () => requestToggle(agent), separatorBefore: list.length > 0 });
    }
    void index;
    return list;
  };

  const subtitleOf = (agent: OrgAgent): ReactNode[] => {
    const parts: ReactNode[] = [];
    const roleText = agentRoleLabel(agent.role, to); // story 4912 D8: the ONE role label function (org roles + default job keys; an unknown value shows raw) — the detail's chip uses the same one
    if (roleText) parts.push(roleText);
    parts.push(ta('manageProjectsGranted', { count: grantCounts[agent.id] ?? 0 }));
    if (agent.device_name && !embedded) parts.push(<DataText key="device">{agent.device_name}</DataText>); // story 4675 (F2): the computer — two agents with one name are told apart here (hidden where there is one computer, story 4832)
    if (agent.run_model_unset === true) parts.push(ta('modelUnsetBadge')); // story 4686 (AC3): no model named → the runtime's default runs
    if (isSystemPublisher(agent.runtime_type)) parts.push(ta('systemPublisherNeutralDescription'));
    const runtimeLine = formatAgentRuntimeLine(agent, locale, displayTimezone, ta);
    if (runtimeLine) parts.push(runtimeLine);
    return joinDot(parts);
  };

  const addAgentButton = isAdmin ? (
    <Button variant="primary" onClick={onAddAgent} iconStart={<Icon name="add" size={14} />}>{ta('manageAddAgent')}</Button>
  ) : null;

  return (
    <PageFrame width="reading">
      <PageHead description={t('orgAgentsDescription')} actions={addAgentButton} />

      {message ? <Banner tone={message.type === 'success' ? 'info' : 'failed'}>{message.text}</Banner> : null}

      {isAdmin && chosen.size > 0 ? (
        <div data-testid="agent-selection-bar" className="flex items-center justify-between gap-3 rounded-ds-control border border-ds-action/40 bg-ds-action-soft px-3 py-2 text-ds-small text-ds-action-text">
          <span role="status">{ta('runProfileChosenCount', { count: chosen.size })}</span>
          <Button onClick={() => setBulkOpen(true)}>
            {ta('runProfileBulkOpen')} <CountBadge count={chosen.size} />
          </Button>
        </div>
      ) : null}

      {loading ? (
        <SkeletonGroup label={tc('loading')} className="space-y-2" data-testid="agent-list-loading">
          {[1, 2, 3].map((i) => <Skeleton key={i} className="h-14" />)}
        </SkeletonGroup>
      ) : loadError ? (
        <EmptyState
          title={tc('error')}
          description={tc('errorDescription')}
          action={<Button onClick={() => setRetryKey((k) => k + 1)}>{tc('retry')}</Button>}
        />
      ) : agents.length === 0 ? (
        <EmptyState title={t('noOrgAgents')} description={t('noOrgAgentsCta')} />
      ) : (
        <RowList aria-label={t('orgAgentsTitle')} header={{ title: t('orgAgentsTitle'), count: agents.length }} data-testid="agent-row-list">
          {agents.map((agent, index) => {
            const detailHref = flatHref(`/organization/workforce/${agent.id}`);
            const label = rowLabels.get(agent.id);
            const actions = rowActions(agent, index);
            const common = {
              'data-testid': `agent-row-${agent.id}`,
              leading: isAdmin ? (
                isDesktopRuntime(agent.runtime_type) ? (
                  <Checkbox
                    checked={chosen.has(agent.id)}
                    onCheckedChange={(checked) => setChosen((prev) => {
                      const next = new Set(prev);
                      if (checked) next.add(agent.id); else next.delete(agent.id);
                      return next;
                    })}
                    label={<span className="sr-only">{ta('runProfileChooseAria', { name: label ?? agent.name })}</span>}
                  />
                ) : <span className="size-4 shrink-0" aria-hidden />
              ) : undefined,
              title: (
                <Link href={detailHref} className="block min-w-0 hover:underline">
                  <RowName label={label} id={agent.id} />
                </Link>
              ),
              subtitle: subtitleOf(agent),
              // bounded + wrapping: the state chips sit in the row's right slot, which does not shrink — with all four at 402px they would push the row wider than the screen (the 402px overflow guard)
              statusMark: (
                <span className="flex max-w-56 flex-wrap items-center justify-end gap-1.5">
                  <AgentStateMark row={stateByAgent.get(agent.id) ?? null} />
                  {!agent.is_active ? <Chip>{t('agentInactiveBadge')}</Chip> : null}
                  {!isSystemPublisher(agent.runtime_type) && agent.verified === false ? <Chip tone="needs-hand">{ta('agentNotConnected')}</Chip> : null}
                  {agent.needs_restart ? <Chip tone="needs-hand">{ta('agentNeedsRestartBadge')}</Chip> : null}
                </span>
              ),
              onOpen: () => router.push(detailHref),
            };
            return actions.length > 0
              ? <RowListItem key={agent.id} {...common} actions={actions} actionsLabel={ta('agentRowActionsAria', { name: label ?? agent.name })} />
              : <RowListItem key={agent.id} {...common} />;
          })}
        </RowList>
      )}

      <AgentRunProfileBulkDialog
        agents={agents.filter((a) => chosen.has(a.id))}
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        onSaved={() => { void refreshAgents(); setChosen(new Set()); }}
      />

      <Dialog open={!!deactivateTarget} onOpenChange={(o) => { if (!o) setDeactivateTarget(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            {/* story #2406 AC1 — 대상 이름은 «제목»에(본문에 두면 안 읽힌다). 실사고: 확認 없이
                즉시 실행되어 목록 최상단 행(다른 사람)이 잘못 눌려 비활성화됐다. */}
            <DialogTitle>
              {deactivateTarget ? t('deactivateAgentDialogTitle', { name: deactivateTarget.name }) : ''}
            </DialogTitle>
            <DialogDescription>{t('deactivateAgentDialogBody')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogButton variant="ghost" onClick={() => setDeactivateTarget(null)} disabled={togglingId === deactivateTarget?.id}>
              {tc('cancel')}
            </DialogButton>
            <DialogButton
              variant="destructive"
              onClick={() => void confirmDeactivate()}
              disabled={togglingId === deactivateTarget?.id}
            >
              {togglingId === deactivateTarget?.id ? '...' : t('deactivateAgentDialogConfirm')}
            </DialogButton>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageFrame>
  );
}

/** story 4889 (W1): the live state of an agent that runs on a computer — a ds StatusLabel in the strip's own words; nothing for an agent with no session (the row as it was). */
function AgentStateMark({ row }: { row: AgentStateRow | null }) {
  const tState = useTranslations('chats.agentSession');
  if (!row || row.state === null) return null;
  const word = shownState(row);
  // story 4889 (PO 11-11): a FINISHED session («끝») reads the same as no session in this list — it is the place to find who is running or needs a hand, and ~60 hollow dots only made noise. (The Today list keeps its «끝» line — that screen's own call.)
  if (word === 'stopped') return null;
  const limitRests = limitHeld(word, row.limit) || limitLooksAgain(word, row.limit) || (word === 'waiting_input' && !!row.limit?.self_resume);
  const mark = stateMark(word, { ask: !!row.first_screen?.ask, limitRests });
  return <StatusLabel status={mark} label={sessionStateLabel(row, tState)} data-testid="agent-state-mark" data-agent-id={row.agent_id} className="shrink-0 text-ds-small" />;
}
