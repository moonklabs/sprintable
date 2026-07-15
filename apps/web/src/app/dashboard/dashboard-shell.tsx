'use client';

import { createContext, useContext, useCallback, useEffect, useMemo, useState, startTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  TAB_PROJECT_STORAGE_KEY,
  installProjectHeaderInterceptor,
  resolveEffectiveProjectId,
  setEffectiveProjectId,
} from '@/lib/project-context-client';
import { useTranslations } from 'next-intl';
import { RealtimeProvider } from '@/components/realtime-provider';
import { SessionExpiredDialog } from '@/components/auth/session-expired-dialog';
import { AppSidebar } from '@/components/nav/app-sidebar';
import { TopBar } from '@/components/nav/top-bar';
import { TopBarProvider, useTopBar } from '@/components/nav/top-bar-context';
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar';
import { ContextualPanelLayout, useContextualPanelState } from '@/components/ui/contextual-panel-layout';
import { TeamPresencePanel } from '@/components/presence/team-presence-panel';
import { useTeamPresence } from '@/components/presence/use-team-presence';
import { ReleaseNotesProvider } from '@/components/release-notes/release-notes-gate';
import { RefreshProvider } from '@/contexts/refresh-context';
import { TeamPresenceToggleProvider } from '@/components/presence/team-presence-toggle';
import type { OrgSwitcherItem } from '@/components/nav/unified-switcher';

export interface DashboardProjectOption {
  projectId: string;
  projectName: string;
}

interface DashboardContext {
  currentTeamMemberId?: string;
  orgId?: string;
  projectId?: string;
  projectName?: string;
  // story a539c649 S2: 현재 project 의 slug(사이드바/⌘K 가 /{ws}/{proj}/docs 직접 path 를
  // 만드는 데만 사용 — /me/memberships 는 slug 를 안 실어보내 여기 단건 조회로 보강했다).
  currentProjectSlug?: string;
  userName?: string;
  role?: string;
  projectMemberships: DashboardProjectOption[];
  orgMemberships: OrgSwitcherItem[];
}

const DashboardCtx = createContext<DashboardContext>({ projectMemberships: [], orgMemberships: [] });

export function useDashboardContext() {
  return useContext(DashboardCtx);
}

interface DashboardShellProps extends DashboardContext {
  children: React.ReactNode;
}

function ScrollShell({ showTopBar, children }: { showTopBar: boolean; children: React.ReactNode }) {
  const { setScrollContainer } = useTopBar();
  const setRef = useCallback((el: HTMLDivElement | null) => {
    setScrollContainer(el);
  }, [setScrollContainer]);
  const t = useTranslations('presence');
  // 2505d27d: 상시 팀 presence 패널 — 2xl=inline right-rail / <2xl=drawer. storageKey로 open 영속.
  const panel = useContextualPanelState({ storageKey: 'team-presence', defaultOpen: true });
  // R2(da9d1781): presence SSE event-driven(3s 폴 제거). member_id 로 event-stream 구독.
  const { currentTeamMemberId } = useDashboardContext();
  const items = useTeamPresence(true, currentTeamMemberId);
  const workingCount = items.filter((i) => i.working).length;

  return (
    <ReleaseNotesProvider userId={currentTeamMemberId}>
    <TeamPresenceToggleProvider value={{ toggle: panel.togglePanel, workingCount, open: panel.inlinePanelOpen || panel.drawerOpen }}>
    <SidebarInset className="relative flex flex-col overflow-hidden">
      <div ref={setRef} className="flex flex-1 min-h-0 flex-col overflow-y-auto">
        {showTopBar && <TopBar />}
        <ContextualPanelLayout
          renderPanel={({ mode, closePanel }) => (
            <div className={mode === 'inline' ? '2xl:sticky 2xl:top-0 2xl:h-svh 2xl:p-2' : 'h-full'}>
              <TeamPresencePanel
                items={items}
                onClose={mode === 'inline' ? () => panel.setInlinePanelOpen(false) : closePanel}
              />
            </div>
          )}
          inlinePanelOpen={panel.inlinePanelOpen}
          drawerOpen={panel.drawerOpen}
          onDrawerOpenChange={panel.setDrawerOpen}
          drawerAriaLabel={t('panelTitle')}
          drawerSide="right"
          drawerWidthClassName="w-[min(92vw,24rem)]"
          className="min-h-0 flex-1"
          inlineColumnsClassName="2xl:grid-cols-[minmax(0,1fr)_320px]"
          panelClassName="2xl:col-start-2 2xl:row-start-1"
          contentClassName="flex min-h-0 min-w-0 flex-col 2xl:col-start-1 2xl:row-start-1"
        >
          {children}
        </ContextualPanelLayout>
      </div>
    </SidebarInset>
    </TeamPresenceToggleProvider>
    </ReleaseNotesProvider>
  );
}

/**
 * R2 프로젝트 컨텍스트 SSOT — URL `?p=` 를 탭별 선택 프로젝트의 source of truth 로 삼는다.
 * effective = `?p=`(accessible) → sessionStorage backstop → 서버 prop(쿠키 유래). 모든
 * `useDashboardContext().projectId` 소비부가 이 값으로 자동 URL-aware 가 된다. fetch 인터셉터가
 * 같은 값을 `X-Project-Id` 헤더로 실어 mutation 을 탭의 URL 프로젝트에 바인딩(BE 가 멤버십 검증).
 */
function useProjectSsot(serverProjectId: string | undefined, memberships: DashboardProjectOption[]): string | undefined {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlProjectId = searchParams.get('p');

  const accessibleIds = useMemo(() => new Set(memberships.map((m) => m.projectId)), [memberships]);

  // 라이브 재현(2026-07-11, React fiber 실측) — sessionStorage(브라우저 전용)는 `typeof window`
  // 가드로만 갈리면 SSR(undefined→skip)과 첫 클라이언트 렌더(defined→읽음) 사이에서
  // effectiveProjectId 값이 바뀔 수 있다. 그 값이 서버 렌더 결과와 다르면 하이드레이션 직후
  // useEffect가 즉시 다른 URL로 replace를 걸어 자식(GlanceBoard 등) subtree를 다시 흔든다.
  // hydrated로 한 틱 미뤄 첫 렌더(서버+첫 클라이언트 둘 다)를 항상 동일하게 만들면 이 잦은
  // 재-replace 근원 하나가 사라진다 — router.replace 자체(2번째 소스)는 여전히 필요하면 실행.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => { startTransition(() => setHydrated(true)); }, []);

  const effectiveProjectId = resolveEffectiveProjectId(urlProjectId, serverProjectId, accessibleIds, hydrated);

  // ref 동기화 + 인터셉터 설치를 **렌더 단계**에서 — effect(자식→부모 순)에 두면 부모(DashboardShell)
  // 설치 effect 가 자식(app-sidebar·use-team-presence·kanban-board) 초기 fetch *후* 실행돼 첫 로드
  // fetch 가 X-Project-Id 없이 나간다(첫 페이지 무력화 RC). 부모 render 는 자식 render·effect 보다
  // 먼저 실행되므로 여기서 설치하면 첫 자식 fetch 전에 패치 완료. 멱등 guard + SSR 가드라 render 호출 안전.
  setEffectiveProjectId(effectiveProjectId);
  installProjectHeaderInterceptor();

  // 탭별 backstop 영속 + URL 정규화(`?p=` 누락/불일치 시 effective 로 replace → 링크 드롭에도 stale 방지).
  useEffect(() => {
    if (!effectiveProjectId || typeof window === 'undefined') return;
    window.sessionStorage.setItem(TAB_PROJECT_STORAGE_KEY, effectiveProjectId);
    if (urlProjectId !== effectiveProjectId) {
      const sp = new URLSearchParams(Array.from(searchParams.entries()));
      sp.set('p', effectiveProjectId);
      router.replace(`${pathname}?${sp.toString()}`);
    }
  }, [effectiveProjectId, urlProjectId, pathname, searchParams, router]);

  return effectiveProjectId;
}

export function DashboardShell({
  currentTeamMemberId,
  orgId,
  projectId,
  projectName,
  currentProjectSlug,
  userName,
  role,
  projectMemberships,
  orgMemberships,
  children,
}: DashboardShellProps) {
  const pathname = usePathname();
  const showTopBar = !pathname.startsWith('/settings');

  // R2: URL `?p=` = 탭별 SSOT. 서버 prop 대신 effective 를 컨텍스트/사이드바에 공급.
  const effectiveProjectId = useProjectSsot(projectId, projectMemberships);
  const effectiveProjectName = projectMemberships.find((m) => m.projectId === effectiveProjectId)?.projectName ?? projectName;
  // currentProjectSlug 는 server prop(me.project_id) 기준 — effectiveProjectId 가 탭 SSOT로
  // 갈렸으면 살짝 stale 할 수 있으나, "문서로 가기" 바로가기 링크 용도라 무해(틀려도 미들웨어
  // 리다이렉트 안전망이 받는다). 완전 동기화는 이 슬라이스 스코프 밖(over-engineering).

  return (
    <DashboardCtx.Provider value={{ currentTeamMemberId, orgId, projectId: effectiveProjectId, projectName: effectiveProjectName, currentProjectSlug, userName, role, projectMemberships, orgMemberships }}>
      <RefreshProvider>
      <RealtimeProvider currentTeamMemberId={currentTeamMemberId}>
        <TopBarProvider>
          <SidebarProvider className="h-svh">
            <AppSidebar
              currentTeamMemberId={currentTeamMemberId}
              projectId={effectiveProjectId}
              currentProjectSlug={currentProjectSlug}
              projectMemberships={projectMemberships}
              orgId={orgId}
              orgMemberships={orgMemberships}
              userName={userName}
            />
            <ScrollShell showTopBar={showTopBar}>
              {children}
            </ScrollShell>
          </SidebarProvider>
        </TopBarProvider>
        <SessionExpiredDialog />
      </RealtimeProvider>
      </RefreshProvider>
    </DashboardCtx.Provider>
  );
}
