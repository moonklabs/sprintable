'use client';

import { createContext, useContext, useCallback, useEffect, useMemo, useRef, useState, startTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  TAB_PROJECT_STORAGE_KEY,
  bumpOrgSyncVersion,
  installProjectHeaderInterceptor,
  resolveEffectiveOrgId,
  resolveEffectiveProjectId,
  setEffectiveProjectId,
  setEffectiveOrgId,
} from '@/lib/project-context-client';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import { RealtimeProvider } from '@/components/realtime-provider';
import { SessionExpiredDialog } from '@/components/auth/session-expired-dialog';
import { AppSidebar } from '@/components/nav/app-sidebar';
import { MobileTabBar } from '@/components/nav/mobile-tab-bar';
import { TopBar } from '@/components/nav/top-bar';
import { TopBarProvider, useTopBar } from '@/components/nav/top-bar-context';
import { SidebarProvider, SidebarInset } from '@/components/ui/sidebar';
import { ContextualPanelLayout, useContextualPanelState } from '@/components/ui/contextual-panel-layout';
import { TeamPresencePanel } from '@/components/presence/team-presence-panel';
import { useTeamPresence } from '@/components/presence/use-team-presence';
import { useAgentAuthFailures } from '@/components/presence/use-agent-auth-failures';
import { useChatUnreadTotal } from '@/hooks/use-chat-unread-total';
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
  // story #2103 — BE가 여러 write action을 "휴먼 멤버만 가능"으로 명시 거부한다(게이트/HITL
  // 승인·거부, 각종 삭제 등). URL과 무관한 순수 계정 속성이라 #2093의 pathOrgId류와 달리
  // 별도 override가 필요 없다 — 항상 서버 me.type 그대로.
  currentMemberType?: 'human' | 'agent';
  projectMemberships: DashboardProjectOption[];
  orgMemberships: OrgSwitcherItem[];
  // story #2587 AC3 — 「진짜 권한없음 403」을 정직하게 끝내려면 소비 화면이 "org-sync가
  // 아직 이 경로에 대해 성립할 여지가 있는가"를 알아야 한다(있으면 403이 stale일 수 있어
  // 로딩 유지가 맞고, 없으면 403은 진짜다). pathOrgId가 없거나(flat 라우트) 이미
  // actualTokenOrgId와 같으면(재발급이 발화조차 안 함, 아래 switch-org effect의 조기
  // return 조건과 정확히 대칭) org-sync는 이 경로에 대해 아무 것도 안 한다 — false.
  // ⛔optional — DashboardShellProps가 이 interface를 extends해 필수면 서버 레이아웃이
  // 이걸 prop으로 넘겨야 하는 것처럼 보인다. 실제로는 DashboardShell 내부에서만 계산해
  // Provider value에 싣는 값이라 외부 prop 계약에선 없어도 된다.
  orgSyncPending?: boolean;
}

const DashboardCtx = createContext<DashboardContext>({ projectMemberships: [], orgMemberships: [], orgSyncPending: false });

export function useDashboardContext() {
  return useContext(DashboardCtx);
}

interface DashboardShellProps extends DashboardContext {
  // story #2093 — proxy.ts가 `[ws]/[proj]` 경로를 서버측에서 resolve한 결과(x-resolved-*
  // 헤더 유래). 계정 상태(orgId/projectId, 위 DashboardContext 필드)는 "다음에 어디로 갈지"의
  // 기본값이고, 이 둘은 "지금 이 URL이 실제로 가리키는 것"이다 — 화면 표시(top-bar 칩 등)는
  // 이 값을 우선한다. 경로 세그먼트가 없는 flat 라우트(/glance 등)에선 undefined.
  pathOrgId?: string;
  pathProjectId?: string;
  // story #2545(카디르 라이브 재QA) — JWT `app_metadata.org_id` 클레임을 직접 읽은 값
  // (getServerSession, 신규 fetch 0). #2544가 "top-level org_id"라 부른 바로 그 필드
  // (backend/app/dependencies/auth.py의 `jwt_org_id = auth.claims.get("app_metadata",
  // {}).get("org_id")`와 동일 — "top-level"은 app_metadata 안에서 org_id가 최상위라는
  // 뜻이지 JWT payload 자체의 최상위 필드라는 뜻이 아니다). `orgId`(=me?.org_id)는 실제로는
  // 주로 `app_metadata.project_id` 클레임으로 찾은 TeamMember 행의 org라 두 클레임이
  // 부분적으로 stale하면(org_id는 reset·project_id는 옛 org 그대로) `orgId`와 갈릴 수 있다 — 아래
  // 자동 switch-org effect의 불일치 판정은 이 값을 우선한다(없으면 `orgId`로 폴백).
  jwtOrgId?: string;
  children: React.ReactNode;
}

// story #1958(P2-S2) 유나 노트⑶: 768~1023(태블릿, lg 미만)은 모바일 IA를 유지하되 콘텐츠만
// 640 중앙폭으로 밀도 조정(시안 511bc035 v2 "태블릿 세로 768" 프레임 — `.tablet .content{max-width:640px}`).
// 2단 그리드 미도입 — 4탭 루트(지금·결재함·채팅·전체)에만 적용, /board 등 기존 데스크톱 페이지는 제외.
const TAB_ROOT_PREFIXES = ['/glance', '/inbox', '/chats', '/more'];

function isTabRootPage(pathname: string): boolean {
  return TAB_ROOT_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

// story #2078(E-ARCH 0단계) 결함수정 — AppSidebar/ScrollShell이 필요로 하는 chatUnreadTotal을
// 예전엔 DashboardShell 함수 바디 최상단(<RealtimeProvider> JSX 인스턴스화 *이전*)에서
// useChatUnreadTotal()로 계산했다. 그 훅이 내부에서 useChatSse → useSseMultiplexerContext()를
// 부르는데, React Context는 실제 렌더 트리상 Provider의 자식에게만 전파된다 — 이 호출은
// Provider의 형제/조상 위치에서 실행되므로 mux가 항상 null이 되어, 플래그 값과 무관하게
// 이 경로만 영구히 독립 EventSource 폴백을 탔다(민군 실측: 탭당 2연결, 그중 하나가 이 경로).
// AppSidebar·ScrollShell은 이미 <RealtimeProvider> 자식이므로, 이 래퍼를 그 안에 두고
// 훅 호출도 함께 옮기면 mux 컨텍스트를 정상적으로 받는다(chat-list-view.tsx·chat-view.tsx의
// useChatSse 호출과 동일한 위치 조건이 된다).
function ShellBody({
  currentTeamMemberId, showTopBar, tabletCentered, orgId, orgMemberships, projectId, projectMemberships,
  currentProjectSlug, userName, children,
}: {
  currentTeamMemberId?: string;
  showTopBar: boolean;
  tabletCentered: boolean;
  orgId?: string;
  orgMemberships: OrgSwitcherItem[];
  projectId?: string;
  projectMemberships: DashboardProjectOption[];
  currentProjectSlug?: string;
  userName?: string;
  children: React.ReactNode;
}) {
  const chatUnreadTotal = useChatUnreadTotal(currentTeamMemberId);
  return (
    <>
      <AppSidebar
        projectId={projectId}
        currentProjectSlug={currentProjectSlug}
        projectMemberships={projectMemberships}
        orgId={orgId}
        orgMemberships={orgMemberships}
        userName={userName}
        chatUnreadTotal={chatUnreadTotal}
      />
      <ScrollShell
        showTopBar={showTopBar}
        tabletCentered={tabletCentered}
        chatUnreadTotal={chatUnreadTotal}
        orgId={orgId}
        orgMemberships={orgMemberships}
        projectId={projectId}
        projectMemberships={projectMemberships}
      >
        {children}
      </ScrollShell>
    </>
  );
}

function ScrollShell({
  showTopBar, tabletCentered, chatUnreadTotal, orgId, orgMemberships, projectId, projectMemberships, children,
}: {
  showTopBar: boolean;
  tabletCentered: boolean;
  chatUnreadTotal: number;
  orgId?: string;
  orgMemberships: OrgSwitcherItem[];
  projectId?: string;
  projectMemberships: DashboardProjectOption[];
  children: React.ReactNode;
}) {
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
  // story #2852(2836 FE 조각) — presence 패널은 전역 상시 마운트라 「인증 실패」 뱃지 원자료도
  // 여기서 함께 폴한다(org-briefing 진입과 무관하게 늘 최신).
  const authFailureByMember = useAgentAuthFailures(true);

  return (
    <ReleaseNotesProvider userId={currentTeamMemberId}>
    <TeamPresenceToggleProvider value={{ toggle: panel.togglePanel, workingCount, open: panel.inlinePanelOpen || panel.drawerOpen }}>
    <SidebarInset className="relative flex flex-col overflow-hidden">
      <div ref={setRef} className="flex flex-1 min-h-0 flex-col overflow-y-auto">
        {showTopBar && (
          <TopBar
            orgId={orgId}
            orgMemberships={orgMemberships}
            projectId={projectId}
            projectMemberships={projectMemberships}
          />
        )}
        <ContextualPanelLayout
          renderPanel={({ mode, closePanel }) => (
            <div className={mode === 'inline' ? '2xl:sticky 2xl:top-0 2xl:h-svh 2xl:p-2' : 'h-full'}>
              <TeamPresencePanel
                items={items}
                authFailureByMember={authFailureByMember}
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
          contentClassName={cn(
            'flex min-h-0 min-w-0 flex-col 2xl:col-start-1 2xl:row-start-1',
            tabletCentered && 'min-[768px]:mx-auto min-[768px]:w-full min-[768px]:max-w-[640px] lg:max-w-none lg:mx-0',
          )}
        >
          {children}
        </ContextualPanelLayout>
      </div>
      {/* story #1958(P2-S2): <1024(lg 미만) 전용 하단 탭바 — SidebarInset의 flex-col 안에서
          scroll 컨테이너의 형제(자식 아님)로 둬야 콘텐츠가 스크롤돼도 탭바가 자기 flex row를
          유지한다(position:fixed 오버레이+패딩 보정 불요 — 시안 511bc035의 flex 레이아웃과 동형). */}
      <MobileTabBar chatUnreadTotal={chatUnreadTotal} />
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
function useProjectSsot(
  serverProjectId: string | undefined,
  memberships: DashboardProjectOption[],
  pathProjectId: string | undefined,
): string | undefined {
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

  // story #2093 — pathProjectId(경로 `[ws]/[proj]` 서버측 resolve 결과)가 최우선. `?p=`는
  // 경로 세그먼트가 없는 flat 라우트에서만 실질적인 SSOT로 남는다(project-context-client.ts 참고).
  const effectiveProjectId = resolveEffectiveProjectId(urlProjectId, serverProjectId, accessibleIds, hydrated, pathProjectId);

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
  currentMemberType,
  projectMemberships,
  orgMemberships,
  pathOrgId,
  pathProjectId,
  jwtOrgId,
  children,
}: DashboardShellProps) {
  const pathname = usePathname();
  const router = useRouter();
  const showTopBar = !pathname.startsWith('/settings');
  const tabletCentered = isTabRootPage(pathname);

  // ⚠️카디르 라이브 재QA(2026-08-10, qa:changes) — 세션의 "현재 org" 정본은 `orgId`(me?.org_id)가
  // 아니라 `jwtOrgId`다. `orgId`는 실제로는 대개 `app_metadata.project_id` 클레임으로 찾은
  // TeamMember 행의 org라 `app_metadata.org_id` 클레임(=jwtOrgId)과 다른 신호다 — 부분-stale
  // JWT(org_id는 reset됐는데 project_id는 옛 org를 여전히 가리키는 경우) 라이브 재현에서
  // orgId가 pathOrgId와 "우연히" 같아져 아래 org-sync effect가 조기 return했다. jwtOrgId
  // (getServerSession이 jwtVerify 직후 읽어둔 그 클레임)를 우선하고, 그 클레임이 없는
  // 인증경로(Firebase 세션 — db/server.ts 참고)에서만 orgId(project-chain 파생)로 폴백한다.
  const actualTokenOrgId = jwtOrgId ?? orgId;
  // story #2093 — 경로(`[ws]/[proj]`) resolve 결과가 최우선(화면이 실제로 그리는 것의 정본).
  // story #2873 — flat 라우트(pathOrgId 없음)의 계정 상태 폴백도 project-chain 파생값
  // (orgId)이 아니라 jwtOrgId(위 actualTokenOrgId와 동일 우선순위 — resolveEffectiveOrgId
  // 참고)를 쓴다. 0-프로젝트 org로 전환하면 switch-org가 CURRENT_PROJECT_COOKIE를 지워(그
  // org엔 앵커할 project가 없어) project-chain 파생값(orgId)이 새 org로 영영 못 넘어가는데도,
  // 새로 발급된 JWT의 org_id 클레임 자체는 정확히 갱신되어 있었다(BE 실측 확認, 디디군) —
  // 그런데 flat 라우트는 org-sync effect(아래)가 pathOrgId 부재로 조기 return해 그 정본을 못
  // 쓰고 orgId로만 폴백하다 보니, X-Org-Id 헤더가 전환 前 org에 갇혀 "새 프로젝트" 같은
  // 요청이 조용히 옛 org로 갔다(라이브 재현: SK Leak Test로 전환 후 생성한 프로젝트가
  // 뭉클랩에 떨어짐). resolveEffectiveOrgId를 쓰면 flat 라우트든 아니든 X-Org-Id가 항상
  // 실제 세션 org를 정확히 반영한다.
  const effectiveOrgId = resolveEffectiveOrgId(pathOrgId, jwtOrgId, orgId);
  // story #2497 — 인터셉터가 X-Project-Id 옆에 X-Org-Id도 함께 실어야 하는 자리(fire #2486
  // 근본원인: 멀티-org 유저의 stale JWT org가 탭의 실제 org와 달라 has_project_access가
  // 엉뚱한 org로 검증됨). setEffectiveProjectId와 동일하게 렌더 단계에서 동기화 —
  // 인터셉터 설치(useProjectSsot 내부)보다 먼저 ref가 채워져 있어야 첫 자식 fetch도 커버된다.
  setEffectiveOrgId(effectiveOrgId);

  // story #2545 — pathOrgId(URL이 그리는 org)가 실제 토큰의 org와 다르면 displayOrg는 이미
  // pathOrgId로 "현재 조직"처럼 보이는데(바로 위 effectiveOrgId), 그건 X-Org-Id **헤더
  // 오버라이드**일 뿐 실제 토큰은 여전히 다른 org일 수 있다. #2544 grounding(dev Cloud Run
  // 로그 실측)이 보인 대로 이 헤더 경로는 컴포넌트별 마운트 타이밍에 따라 레이스가 나
  // 간헐적으로 403이 난다. 근본: 헤더로 매 요청 우회하는 대신, 불일치를 발견하는 즉시 실제
  // 토큰을 pathOrgId로 재발급해 그 뒤 모든 요청(헤더 有無 무관)이 처음부터 맞게 만든다 —
  // AC2가 명시 허용한 두 방법(헤더 신뢰 / 토큰 재발급) 중 후자.
  // story #2587 AC3 — 아래 switch-org effect의 조기 return 조건(`!pathOrgId ||
  // pathOrgId === actualTokenOrgId`)과 정확히 대칭인 부정형. true인 동안은 재발급이
  // 시도됐거나 시도될 예정이라 이 순간의 403은 stale일 수 있다(로딩 유지가 맞음) — false면
  // org-sync가 이 경로에 대해 아무 것도 할 게 없다는 뜻이라 그 순간의 403은 진짜다.
  const orgSyncPending = !!pathOrgId && pathOrgId !== actualTokenOrgId;
  const orgSyncAttemptedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!pathOrgId || pathOrgId === actualTokenOrgId) return;
    if (orgSyncAttemptedRef.current === pathOrgId) return;
    orgSyncAttemptedRef.current = pathOrgId;
    void (async () => {
      try {
        const res = await fetch('/api/switch-org', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ org_id: pathOrgId }),
        });
        const json = await res.json().catch(() => null) as { data?: { ok?: boolean } } | null;
        if (res.ok && json?.data?.ok) {
          // story #2545(카디르 라이브 재QA 2단계) — router.refresh()는 서버 컴포넌트만
          // 재실행한다. `useEffect(fetch, [projectId])`형 클라이언트 fetch(hypotheses·goals
          // 등)는 project는 안 바뀌어 재요청이 안 되고 switch-org 前 확定된 403/404에
          // 고정된다 — bumpOrgSyncVersion()으로 그걸 구독하는 컴포넌트만 재요청시킨다
          // (project-context-client.ts 참고, 전체 fetch 게이트는 스코프 밖).
          bumpOrgSyncVersion();
          router.refresh();
        }
      } catch {
        // best-effort — 실패해도 기존 X-Org-Id 헤더 오버라이드가 그대로 폴백.
      }
    })();
  }, [pathOrgId, actualTokenOrgId, router]);
  // R2: URL `?p=` = flat 라우트의 탭별 SSOT. pathProjectId(경로 resolve)가 있으면 그게 최우선.
  const effectiveProjectId = useProjectSsot(projectId, projectMemberships, pathProjectId);
  const effectiveProjectName = projectMemberships.find((m) => m.projectId === effectiveProjectId)?.projectName ?? projectName;
  // currentProjectSlug 는 server prop(me.project_id) 기준 — effectiveProjectId 가 탭 SSOT로
  // 갈렸으면 살짝 stale 할 수 있으나, "문서로 가기" 바로가기 링크 용도라 무해(틀려도 미들웨어
  // 리다이렉트 안전망이 받는다). 완전 동기화는 이 슬라이스 스코프 밖(over-engineering).

  // story #2007(perf·서버부하): GNB 채팅 unread 총합을 AppSidebar+MobileTabBar가 각자
  // useChatUnreadTotal()을 호출해 SSE(EventSource) 연결을 독립적으로 2개 열던 것을 한
  // 곳에서만 계산해 두 표면에 값만 prop으로 내려준다. story #2078 결함수정(위 ShellBody 주석
  // 참고) — 이 훅 호출은 <RealtimeProvider> 자식 위치(ShellBody 안)로 옮겨졌다.

  return (
    <DashboardCtx.Provider value={{ currentTeamMemberId, orgId: effectiveOrgId, projectId: effectiveProjectId, projectName: effectiveProjectName, currentProjectSlug, userName, role, currentMemberType, projectMemberships, orgMemberships, orgSyncPending }}>
      <RefreshProvider>
      <RealtimeProvider currentTeamMemberId={currentTeamMemberId}>
        <TopBarProvider>
          <SidebarProvider className="h-svh">
            <ShellBody
              currentTeamMemberId={currentTeamMemberId}
              showTopBar={showTopBar}
              tabletCentered={tabletCentered}
              orgId={effectiveOrgId}
              orgMemberships={orgMemberships}
              projectId={effectiveProjectId}
              projectMemberships={projectMemberships}
              currentProjectSlug={currentProjectSlug}
              userName={userName}
            >
              {children}
            </ShellBody>
          </SidebarProvider>
        </TopBarProvider>
        <SessionExpiredDialog />
      </RealtimeProvider>
      </RefreshProvider>
    </DashboardCtx.Provider>
  );
}
