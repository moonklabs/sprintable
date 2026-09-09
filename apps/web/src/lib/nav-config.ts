import {
  Award,
  BookOpen,
  Bot,
  Brain,
  ClipboardList,
  FileText,
  FlaskConical,
  GalleryVerticalEnd,
  HardDrive,
  Inbox,
  Layers,
  ListChecks,
  MessageSquare,
  Newspaper,
  Settings,
  Share2,
  Shield,
  TrendingUp,
  Users,
  Users2,
  Workflow,
  Zap,
  Gauge,
  type LucideIcon,
} from 'lucide-react';

// story #2681(모바일 IA S1, doc mobile-ia-full-completion-2678) — 데스크톱 GNB(app-sidebar.tsx)와
// 모바일 /more 허브(S2에서 착수)가 「한 정의」에서 파생되도록 이 파일이 그 SSOT다. 두 벌 목적지
// 목록이 따로 살면 하나만 갱신되고 다른 하나가 뒤처지는 drift가 원천적으로 생긴다 — 이 파일이
// 유일한 목적지 카탈로그이고, 렌더 쪽(app-sidebar.tsx)은 오직 이 데이터를 순회만 한다.
//
// kind 구분(app-sidebar.tsx의 기존 두 링크 계산 방식과 정확히 대응):
//   'static'   — 절대 경로 그대로(org/project 슬러그와 무관). path = 전체 href.
//   'resource' — /{ws}/{proj}/{resource} 파생 대상(resourceLink() 소비). path = resource 이름뿐
//                (앞 슬래시 없음 — 슬래시 유무로 kind를 오인하지 않게 값 자체로 구분).
export type NavItemKind = 'static' | 'resource';

// story #9c5e82dc(IA·S3, PO 確定 2026-09-08) — 「프로젝트를 바꿨을 때 내용이 실제로
// 바뀌는가」로 잰 값(추정이 아니라 각 화면의 실 데이터 페칭 코드를 읽어 확認 — activity가
// kind:'static'인데도 project_id로 실제 필터되는 것을 이렇게 잡아 8→9로 정정했다).
// undefined(필드 자체를 안 씀) = 애매(inbox·settings — 화면 개념이 project/org 어느 한쪽으로
// 안 떨어짐, AC2 "화면은 모르는 것을 단정하지 않는다") — 사이드바가 이 값을 몰라야 «표식을
// 안 붙인다»는 사실 자체가 코드로 드러난다(기본값으로 org를 깔고 안 보여주는 게 아니다).
export type NavItemScope = 'project' | 'org';

export interface NavItemConfig {
  id: string;
  labelKey: string;
  icon: LucideIcon;
  kind: NavItemKind;
  path: string;
  kbdHint?: string;
  // 배지 소스 — 현재 카운트 자체는 컴포넌트 상태(폴링·SSE)라 여기 값이 아니라 렌더 쪽이 채운다.
  badgeKey?: 'inbox' | 'chats';
  scope?: NavItemScope;
}

export interface NavGroupConfig {
  id: string;
  // undefined = 라벨 없는 유틸 그룹(설정 footer — ia-4zone 확定: zone 라벨 없음).
  labelKey?: string;
  items: NavItemConfig[];
}

// story #2930(P0-G, doc ia-4zone-redesign-2930) I1 — 12+메뉴 → 오늘/워크스페이스/신뢰/지식
// 4구역+챗 center(구역 밖 1급, I2가 그린다)+조직·설정 관리 프레임(하단, 1차 아님). path는
// 전부 불변(라우트 보존·딥링크/북마크 무손상) — 이 슬라이스는 재그룹+재라벨만.
//
// ⚠️ 'inbox' 항목 라벨은 시안(6242dffb)의 "주의 큐" 대신 기존 "알림"을 그대로 둔다 — bare
// `/inbox`는 여전히 notifications 탭에 착지한다(story #2923 AQ3 그라운딩에서 확認한 대로
// B3 미확定 — attention 탭 기본화는 notifications 최종 거처 결정과 한 몸이라 보류 중). 지금
// "주의 큐"로 개명하면 inbox-labels.test.ts(#2164)의 "진입점 라벨=착지 탭 이름 일치" 규율을
// 그대로 위반한다(라벨만 앞서가고 착지는 그대로라 다시 어긋남) — B3 확定 후 착지가
// attention으로 바뀌는 시점에 라벨도 같이 바꾼다.
//
// story #2930 I3(doc ia-4zone-redesign-2930, PO 스코프 확定 2026-08-22) — work 존 6항목
// (flow/sprints/goals/loops/standup/retro) 재편:
// ①=ⓒ flow+sprints를 1차 메뉴에서 「보드」 단일 항목으로 접는다(id 'board', path는 기존
//   'flow' 그대로 — 라우트 불변). sprints 라우트 자체는 안 건드리고(URL 직접 진입 가능)
//   1차 nav 항목만 뺀다. "에픽"(시안 3뷰 중 하나)은 코드상 단독 표면이 없어(analytics API만
//   존재) 이 슬라이스 스코프 밖(PO: 신규 페이지 제작은 I3=nav 프레임 스코프 밖·후속 스토리로
//   별도 등재). /flow·/sprints 페이지 상단엔 WorkspaceFrameTabs(신규 공유 컴포넌트)로 두
//   라우트를 오가는 얕은 「뷰」 전환처럼 보이는 프레임을 얹는다(flow 자체의 기존 3탭
//   가설/갈래/칸반은 안 건드림 — 그건 다른 층, E-FLOW-V4 기 확定 기능).
// ②=ⓐ→되돌림(유나 QA·PO 확定, 2026-08-22): standup/retro를 1차 메뉴에서 빼려 했으나 CI
//   orphan 가드(verify-no-orphan-resource-routes, story #2376)가 routeWithoutEntry로
//   막았다 — sprints와 달리 standup/retro는 command-palette.tsx에도 대체 entry가 없어
//   nav서 빼면 «URL 직접 진입만 가능한 진짜 orphan»(그 URL을 아는 사람만 도달, 가드가
//   정확히 잡으려던 바로 그 상황)이 된다. 「자동 리듬 표면」(doc B2, 구현 PO)이 아직 없어서
//   생긴 커플링 — FAB↔B3·배지↔4탭과 동형 패턴("표면이 설 때 nav서 뺀다", 오늘 세 번째
//   사례). 그래서 standup/retro는 nav에 그대로 남긴다(work 존 6→3이 아니라 6→5 — board가
//   flow+sprints를 흡수한 만큼만 준다).
export const NAV_GROUPS: NavGroupConfig[] = [
  {
    id: 'now',
    labelKey: 'zoneNow',
    items: [
      // story #9c5e82dc(IA·S3, 카디르 QA 지적 반영·PO 정정 2026-09-08) — 애매(scope 필드
      // 없음)로 재분류. 옛 판정(org)이 틀렸다 — org-briefing-shell.tsx의 「지금」(Now) 패널은
      // org 전체 요청 집계지만, 같은 화면의 「실험실」(LoopFace)·「워크포스」(WorkforceFace)
      // 패널은 projectId 없으면 스켈레톤만 그리고 있으면 project_id로 실 데이터를 건다
      // (loop-face.tsx:26 `/api/hypotheses?project_id=`·workforce-face.tsx:30 `/api/stories?
      // ...&project_id=`) — 화면 «일부»만 project라 표식이 "화면 전체에 대한 약속"을 못
      // 지킨다(PO 원칙: 혼합 화면은 project로도 org로도 정직할 수 없어 무표식).
      { id: 'org-briefing', labelKey: 'orgBriefing', icon: Newspaper, kind: 'static', path: '/org-briefing' },
      // story #9c5e82dc(IA·S3, PO 確定) — inbox는 scope 필드를 안 쓴다(애매). 메인 조회
      // (/api/notifications)가 project_id·org_id 둘 다 안 걸어 순수 사용자 개인 알림이다 —
      // project도 org도 아닌 계정 축이라 AC2 "화면은 모르는 것을 단정하지 않는다"로 무표식.
      { id: 'inbox', labelKey: 'inbox', icon: Inbox, kind: 'static', path: '/inbox', badgeKey: 'inbox' },
      // story #3179(S3c) — 'dashboard'(대시보드, /dashboard) 항목 제거. attention(S3a)·
      // pulse(S3b)가 chat으로 이전되며 /dashboard는 폐합(redirect-only 스텁)됐다 — 같은
      // 목적지(chat)로 가는 nav 항목이 CHAT_CENTER_ITEM과 중복될 이유가 없다.
      // chats는 이 배열에 없다 — story #2930 I2가 구역 밖 1급 챗 center로 승격했다(아래
      // CHAT_CENTER_ITEM, app-sidebar.tsx가 NAV_GROUPS 순회와 별개로 직접 소비).
    ],
  },
  {
    // story #a2b004f9(IA·S1, 유나 3600 부록 E·선생님 2026-09-07 IA 재검토 지시) — 예전
    // 'work'(zoneWork·「워크스페이스」)에서 마케팅 실물(content·channel-posts)이 「마케팅」
    // 구역으로 빠지며 남은 5항목(board·goals·loops·standup·retro)이 이 구역의 전부다 —
    // id·labelKey도 그 실체(개발/운영 리듬 도구)에 맞게 개명한다. path는 전부 불변.
    //
    // story #f81657f8(IA·S4/S1 후속, 유나 § 2026-09-09) — 구역 이름 축을 «누가 쓰나(팀)»에서
    // «다루는 대상」으로 교체하며 ko/en 값만 「일감」/"Work"로 바꿨다 — id('dev')·labelKey
    // ('zoneDev')는 그대로다(app-sidebar.tsx의 sidebar_group_collapsed localStorage가 id로
    // 접힘 기억을 저장해서 개명하면 사람들 기억이 조용히 초기화된다). 이 id/labelKey 이름은
    // 옛 축(팀)의 잔재 — 뜻은 카탈로그 값(라벨)이 SSOT다.
    id: 'dev',
    labelKey: 'zoneDev',
    items: [
      { id: 'board', labelKey: 'board', icon: Workflow, kind: 'resource', path: 'flow', kbdHint: 'B', scope: 'project' },
      { id: 'goals', labelKey: 'goals', icon: Layers, kind: 'resource', path: 'goals', scope: 'project' },
      { id: 'loops', labelKey: 'loops', icon: FlaskConical, kind: 'resource', path: 'loops', scope: 'project' },
      { id: 'standup', labelKey: 'standup', icon: Users, kind: 'resource', path: 'standup', kbdHint: 'S', scope: 'project' },
      { id: 'retro', labelKey: 'retro', icon: Gauge, kind: 'resource', path: 'retro', kbdHint: 'R', scope: 'project' },
    ],
  },
  {
    // story #a2b004f9(IA·S1) — 신규 「마케팅」 구역(안 A). 워크스페이스의 발행 실물
    // (content·channel-posts)과 조직 프레임에 흩어져 있던 마케팅 실물(org-channels·
    // org-content-rules·org-insights-board)을 도메인 축 하나로 묶는다 — 항목 5,
    // path는 전부 불변(묶음만 이동, 라우트 0).
    //
    // story #f81657f8 후속(유나 § 2026-09-09) — id/labelKey 유지 이유는 위 'dev' 구역 주석과
    // 동일(localStorage 접힘 기억 보존). ko 값은 「마케팅」→「콘텐츠·채널」(en "Content &
    // Channels")로 교체 — 「발행」은 ko.json에 이미 93줄이 «행위» 의미로 굳어 있어 기각.
    id: 'marketing',
    labelKey: 'zoneMarketing',
    items: [
      // story #3368(Phase0·마케팅운영 S4, doc phase0-post-manager-screen-design §5-2) — 호스팅
      // 블로그 글 관리(story #ee78b047 IA·S2, 2026-09-08, PO 確定으로 라벨은 「블로그
      // 포스트」 — 「콘텐츠 규칙」과 접두 관계이던 옛 「콘텐츠」에서 개명). site-posts
      // drafts는 org 스코프(프로젝트 무관, backend organizations/{org_id}/site-posts/
      // drafts)라 org-connectors(/organization/connectors)와 동형으로 kind:'static'·
      // top-level 경로다. 「지식」 문서 트리(parent_id 계층) 밑에 두지 않는 이유는 §5-2
      // 그대로 — 상태·발행 URL 열을 가진 목록이 문서 하나로 오독되는 것을 막기 위함.
      // 「관리」 구역의 org-connectors로도 옮기지 않는다 — 연결은 owner의 설정 행위,
      // 운영은 마케터의 일상 행위라는 가름(§5-2)이 그대로 적용된다.
      // 근거: content/page.tsx 주석이 직접 "project 슬러그 불필요"라 명시(org_id 단일 스코프,
      // site-posts drafts backend가 organizations/{org_id}/... 경로), project 필터 0건.
      { id: 'content', labelKey: 'content', icon: FileText, kind: 'static', path: '/content', scope: 'org' },
      // story #3402(Phase1·마케팅운영, PO 결정 2026-09-03 23:17Z) — 채널 포스트(Threads)
      // 관리 화면. NavItemConfig에 중첩 하위메뉴 구조가 없어(app-sidebar.tsx는 group.items를
      // 평평하게 순회) "블로그 포스트 아래" 배치는 이 배열에서 content 바로 뒤에 두는 것으로
      // 표현한다 — content(호스팅 블로그, org 스코프)와 같은 이유로 kind:'static'·top-level
      // 경로(channel_post_drafts도 org 스코프, project 무관).
      // 근거: content/channel-posts/page.tsx에 project 관련 키워드 grep 0건(channel_post_
      // drafts도 content와 동형 org 단일 스코프).
      { id: 'channel-posts', labelKey: 'channelPosts', icon: Share2, kind: 'static', path: '/content/channel-posts', scope: 'org' },
      // story #3376(페드루 PO 確定 2026-09-03) — 소셜 채널 OAuth 연결(조직이 소유한 외부
      // 계정·토큰). 예전 organization 구역에서 이관 — 「연결」 행위 자체는 마케터가 채널을
      // 붙이는 일상 실물이라 도메인 축(마케팅)으로 옮긴다(path 불변). story #ee78b047
      // (IA·S2, 2026-09-08, PO 確定) — 라벨은 「채널 연결」(옛 「채널」이 이웃 「채널
      // 포스트」의 접두어였다 — 이름이 스스로 갈라야 한다는 S2 AC1).
      // 근거: organization/channels/page.tsx에 project 관련 키워드 grep 0건 — 채널 OAuth
      // 연결은 org가 소유(project 무관).
      { id: 'org-channels', labelKey: 'orgChannels', icon: Share2, kind: 'static', path: '/organization/channels', scope: 'org' },
      // story #3472(페드루 PO 確定 2026-09-05) — 콘텐츠 규칙(금칙어·UTM 필수·톤·택소노미·
      // 채널 우선순위·브랜드 킷). 예전 organization 구역에서 이관 — path 불변.
      // 근거: organization/content-rules/page.tsx에 project 관련 키워드 grep 0건 — 규칙 세트가
      // org 단일 스코프(금칙어·톤·택소노미 등 조직 공통 정책).
      { id: 'org-content-rules', labelKey: 'orgContentRules', icon: ListChecks, kind: 'static', path: '/organization/content-rules', scope: 'org' },
      // story #3503(성과 보드 화면) — 발행된 글의 D+1/D+7 성과 표. 예전 organization
      // 구역에서 이관 — path 불변.
      // 근거: organization/insights-board/page.tsx에 project 관련 키워드 grep 0건 — 발행 글
      // 성과가 org 전체 집계(project로 안 거름).
      { id: 'org-insights-board', labelKey: 'orgInsightsBoard', icon: TrendingUp, kind: 'static', path: '/organization/insights-board', scope: 'org' },
    ],
  },
  {
    id: 'trust',
    labelKey: 'zoneTrust',
    items: [
      // story #9c5e82dc(IA·S3, PO 確定) — kind:'static'(고정 경로)라 겉보기엔 org스러웠지만
      // 실제 데이터 페칭(activity-log-view.tsx)이 useDashboardContext().projectId로
      // `/api/activity-logs?project_id=...`를 건다 — project 전환 시 내용이 실제로 바뀐다.
      // 3600 문서의 "실측 8"은 구현 前 추정이었고(kind:'resource' 8항목만 셈), 이 화면은
      // kind가 'static'이라 그 신호에서 빠졌다 — 실 코드가 정본이라 project로 정정(8→9).
      { id: 'activity', labelKey: 'activity', icon: ClipboardList, kind: 'static', path: '/activity', scope: 'project' },
      // organization 흡수(시안 매핑표) — 신뢰 축의 실물이 이제 여기 있다(이전엔 organization
      // 그룹 소속). path 불변, 그룹 소속만 이동. 라벨도 zoneTrust와 겹치던 "신뢰"→"신뢰 센터"로
      // 정정(같은 구역 안에서 구역명과 항목명이 동어반복하지 않게, 시안 신뢰 센터 표기 그대로).
      // 근거(#9c5e82dc 카디르 QA 재감사 2026-09-08) — trust/page.tsx가 project_id를 쓰긴
      // 하나(line 39) 실질 콘텐츠(rosterRows·groupedRoster, /api/trust-scores/org-summary)는
      // project 무관이고, project_id는 team-members 조회로 표시 이름을 채우는 데만 쓰인다
      // (mergeMemberLookup 이름 보완 — 부수적) — 목록 자체는 project 전환에 안 바뀌므로 org
      // 유지(org-briefing·org-workforce와 달리 "일부 패널이 project"가 아니라 "이름표만").
      { id: 'org-trust', labelKey: 'orgTrust', icon: Award, kind: 'static', path: '/organization/trust', scope: 'org' },
    ],
  },
  {
    id: 'knowledge',
    labelKey: 'zoneKnowledge',
    items: [
      { id: 'docs', labelKey: 'docs', icon: BookOpen, kind: 'resource', path: 'docs', scope: 'project' },
      { id: 'artifacts', labelKey: 'artifacts', icon: GalleryVerticalEnd, kind: 'resource', path: 'artifacts', scope: 'project' },
      { id: 'storage', labelKey: 'storage', icon: HardDrive, kind: 'resource', path: 'storage', scope: 'project' },
      // organization 흡수(시안 매핑표) — memory는 지식 축의 실물. path 불변, 그룹 소속만 이동.
      // 근거: memory/page.tsx에 project 관련 키워드 grep 0건 — 조직 공유 기억(org 단일 스코프).
      { id: 'org-memory', labelKey: 'orgMemory', icon: Brain, kind: 'static', path: '/organization/memory', scope: 'org' },
    ],
  },
  {
    // story #2930 I1 — 관리 프레임(하단·1차 아님). org-trust/org-memory는 위 신뢰/지식으로
    // 흡수돼 빠졌고, 남은 조직 항목(멤버·워크포스·권한·이벤트)+설정만 남는다. 예전엔 이 그룹이
    // 배열 맨 앞(desktop "조직이 4구역 위 프레임")이었는데, 시안 확定으로 이제 4구역 «아래»
    // 프레임이라 배열 위치도 맨 뒤로 옮긴다(app-sidebar.tsx는 배열 순서 그대로 렌더하므로 —
    // MOBILE_HUB_GROUP_ORDER는 이미 예전부터 이 그룹을 knowledge 뒤에 뒀었다, 이번에 데스크톱이
    // 그 순서를 따라잡는 것뿐).
    //
    // story #a2b004f9(IA·S1) — org-channels·org-content-rules·org-insights-board 3항목이
    // 「마케팅」 구역으로 이관(위 참고, path 불변) — 8→5항목.
    id: 'organization',
    labelKey: 'zoneOrganization',
    items: [
      // 근거: OrgMembersSection의 project_ids는 초대할 때 «대상 프로젝트를 고르는» 액션
      // 파라미터일 뿐(org-members-section.tsx:144), 멤버 목록 자체를 현재 project로 거르지
      // 않는다 — 화면 콘텐츠가 project 전환에 안 바뀌므로 org.
      { id: 'org-members', labelKey: 'orgMembers', icon: Users2, kind: 'static', path: '/organization/members', scope: 'org' },
      // story #9c5e82dc(IA·S3, 카디르 QA 지적 반영·PO 정정 2026-09-08) — 애매로 재분류.
      // agents-page-tabs.tsx 4탭 중 기본(manage)·access는 project 무관(access는 오히려 «전
      // project를 한 매트릭스로» 보여줌)인데, stats 탭(agent-performance-panel.tsx:97-99
      // team-members/velocity-history/leaderboard 전부 `project_id=`)과 recruit 탭은
      // project 걸림 — 탭에 따라 갈리는 혼합 화면이라 무표식.
      { id: 'org-workforce', labelKey: 'workforce', icon: Bot, kind: 'static', path: '/organization/workforce' },
      // 근거: role-member.tsx류 권한 목록이 org_id 스코프(팀 전체 권한 매트릭스), project
      // 필터 없음.
      { id: 'org-roles', labelKey: 'orgRoles', icon: Shield, kind: 'static', path: '/organization/roles', scope: 'org' },
      // 근거: 조직 이벤트 정의(org 레벨 웹훅/트리거 카탈로그), project 필터 없음.
      { id: 'org-events', labelKey: 'orgEvents', icon: Zap, kind: 'static', path: '/organization/events', scope: 'org' },
      // story #3743(UI 재설계 ③, 페드루 PO 決) — 4180f67f가 열었던 org-connectors 항목을
      // 여기서 걷는다. 커넥터 화면(organization/connectors)이 채널 연결(organization/
      // channels)로 흡수·리다이렉트됐다 — nav에 같은 목적지 둘을 안 남긴다(⑦ IA 25→24
      // 실물). 라우트 자체는 남아 리다이렉트만 한다(북마크·딥링크 무회귀).
    ],
  },
  {
    id: 'settings',
    items: [
      // story #9c5e82dc(IA·S3, PO 確定) — scope 필드를 안 쓴다(애매). 화면 전체 개념은
      // 계정 설정인데, 팀원 관리 탭 하나만 project_id를 쓴다(섞인 화면) — AC2 "화면은
      // 모르는 것을 단정하지 않는다"로 org/project 어느 쪽 표식도 안 붙인다.
      { id: 'settings', labelKey: 'settings', icon: Settings, kind: 'static', path: '/settings' },
    ],
  },
];

// story #2682(S2)에서 more/page.tsx 로컬 상수였던 것을 story #2684(S4)에서 이리 옮긴다 —
// 모바일 허브 그룹 순서·제외 목록도 nav-config.ts의 SSOT 일부다(그래야 depth 가드가 더보기
// 렌더러 내부를 몰라도 이 파일 하나만 보고 「도달 depth ≤2」를 판정할 수 있다).
//
// story #2930 I1 — 데스크톱 NAV_GROUPS 배열 순서가 이 모바일 순서를 따라잡아(organization을
// 맨 뒤로) 이제 둘이 정확히 같은 순서다(둘 다 "4구역→관리→설정"). 이 상수 자체는 그대로 두되
// (모바일이 자기 순서를 자기 상수로 명시하는 SSOT 원칙은 무변화), 예전 "데스크톱과 다르다"는
// 전제였던 주석은 더 이상 사실이 아니라 정정한다.
//
// story #a2b004f9(IA·S1) — 'work'가 'dev'로 개명되고 신규 'marketing'이 그 바로 뒤에
// 등재된다(데스크톱 NAV_GROUPS 순서와 동일하게 유지 — I1 원칙 그대로).
export const MOBILE_HUB_GROUP_ORDER = ['now', 'dev', 'marketing', 'trust', 'knowledge', 'organization', 'settings'];

// flow·inbox·chats는 바텀 탭(지금/결재/채팅)이 이미 depth 1로 커버한다(doc §2.2 "자주" 축) —
// 허브에 또 실으면 같은 목적지로 가는 진입점이 두 개가 되고 "몇 탭"의 의미가 흐려진다.
// story #2930 I2 — chats가 NAV_GROUPS 배열 자체에서 빠지므로(사이드바 챗 center로 승격) 이
// id는 이제 실질적으로 no-op이지만, 모바일 탭바(I4가 다룰 영역)가 chat을 FAB로 승격하며 같은
// "허브에 중복 진입점 금지" 원칙이 유효하므로 방어적으로 남겨둔다(제거해도 부작용 없음).
// story #2930 I3 — 'flow'는 id가 'board'로 접혔다(work 존 재편, 위 참고). depth-1 취급
// 의도는 그대로(빠른 접근 대상)라 exclude id도 같이 개명.
export const MOBILE_HUB_EXCLUDE_IDS = new Set(['board', 'inbox', 'chats']);

// story #2930(P0-G) I2 — 챗은 4구역 밖 1급 「center」(중심 꽃, 선생님 확定). NAV_GROUPS
// 배열엔 없다(구역에 묻지 않는다는 게 이 승격의 요점) — 데스크톱 사이드바 상단 고정 카드
// (app-sidebar.tsx)와 모바일 FAB(I4가 배선)가 이 한 항목을 직접 소비한다. path/badgeKey는
// 옛 'now' 그룹 소속이던 시절과 완전히 동일(불변) — 위치만 승격.
export const CHAT_CENTER_ITEM: NavItemConfig = {
  id: 'chats', labelKey: 'chats', icon: MessageSquare, kind: 'static', path: '/chats', badgeKey: 'chats',
};

// story #d986fd6c(IA·S4)의 «뷰포트 높이 역산 접힘» 전제(필요 높이(px) = 615.5 + 32×N)는
// 이 스토리(#f81657f8, 선생님 決 2026-09-09 01:28Z 「그냥 디폴트를 다 펼쳐두고 접을 수 있게
// 하면 좋을 것 같다」)로 폐기됐다 — 기본값은 이제 뷰포트/활성 구역과 완전히 무관한 빈 Set
// (전부 펼침)이다. 관계식·GroupItemCount·computeActiveZoneCollapsedGroupIds는 코드고고학이
// 필요하면 git 이력(이 커밋 이전)에서 찾을 것 — 살아있는 추상으로 남겨두지 않는다.
// 구역별 접기 토글+사람별 기억(app-sidebar.tsx의 collapsedOverrides)은 그대로다.
