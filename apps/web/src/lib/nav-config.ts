import {
  Award,
  BookOpen,
  Bot,
  Brain,
  ClipboardList,
  FlaskConical,
  GalleryVerticalEnd,
  HardDrive,
  Inbox,
  Layers,
  MessageSquare,
  Newspaper,
  Settings,
  Shield,
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

export interface NavItemConfig {
  id: string;
  labelKey: string;
  icon: LucideIcon;
  kind: NavItemKind;
  path: string;
  kbdHint?: string;
  // 배지 소스 — 현재 카운트 자체는 컴포넌트 상태(폴링·SSE)라 여기 값이 아니라 렌더 쪽이 채운다.
  badgeKey?: 'inbox' | 'chats';
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
      { id: 'org-briefing', labelKey: 'orgBriefing', icon: Newspaper, kind: 'static', path: '/org-briefing' },
      { id: 'inbox', labelKey: 'inbox', icon: Inbox, kind: 'static', path: '/inbox', badgeKey: 'inbox' },
      // story #3179(S3c) — 'dashboard'(대시보드, /dashboard) 항목 제거. attention(S3a)·
      // pulse(S3b)가 chat으로 이전되며 /dashboard는 폐합(redirect-only 스텁)됐다 — 같은
      // 목적지(chat)로 가는 nav 항목이 CHAT_CENTER_ITEM과 중복될 이유가 없다.
      // chats는 이 배열에 없다 — story #2930 I2가 구역 밖 1급 챗 center로 승격했다(아래
      // CHAT_CENTER_ITEM, app-sidebar.tsx가 NAV_GROUPS 순회와 별개로 직접 소비).
    ],
  },
  {
    id: 'work',
    labelKey: 'zoneWork',
    items: [
      { id: 'board', labelKey: 'board', icon: Workflow, kind: 'resource', path: 'flow', kbdHint: 'B' },
      { id: 'goals', labelKey: 'goals', icon: Layers, kind: 'resource', path: 'goals' },
      { id: 'loops', labelKey: 'loops', icon: FlaskConical, kind: 'resource', path: 'loops' },
      { id: 'standup', labelKey: 'standup', icon: Users, kind: 'resource', path: 'standup', kbdHint: 'S' },
      { id: 'retro', labelKey: 'retro', icon: Gauge, kind: 'resource', path: 'retro', kbdHint: 'R' },
    ],
  },
  {
    id: 'trust',
    labelKey: 'zoneTrust',
    items: [
      { id: 'activity', labelKey: 'activity', icon: ClipboardList, kind: 'static', path: '/activity' },
      // organization 흡수(시안 매핑표) — 신뢰 축의 실물이 이제 여기 있다(이전엔 organization
      // 그룹 소속). path 불변, 그룹 소속만 이동. 라벨도 zoneTrust와 겹치던 "신뢰"→"신뢰 센터"로
      // 정정(같은 구역 안에서 구역명과 항목명이 동어반복하지 않게, 시안 신뢰 센터 표기 그대로).
      { id: 'org-trust', labelKey: 'orgTrust', icon: Award, kind: 'static', path: '/organization/trust' },
    ],
  },
  {
    id: 'knowledge',
    labelKey: 'zoneKnowledge',
    items: [
      { id: 'docs', labelKey: 'docs', icon: BookOpen, kind: 'resource', path: 'docs' },
      { id: 'artifacts', labelKey: 'artifacts', icon: GalleryVerticalEnd, kind: 'resource', path: 'artifacts' },
      { id: 'storage', labelKey: 'storage', icon: HardDrive, kind: 'resource', path: 'storage' },
      // organization 흡수(시안 매핑표) — memory는 지식 축의 실물. path 불변, 그룹 소속만 이동.
      { id: 'org-memory', labelKey: 'orgMemory', icon: Brain, kind: 'static', path: '/organization/memory' },
    ],
  },
  {
    // story #2930 I1 — 관리 프레임(하단·1차 아님). org-trust/org-memory는 위 신뢰/지식으로
    // 흡수돼 빠졌고, 남은 조직 항목(멤버·워크포스·권한·이벤트)+설정만 남는다. 예전엔 이 그룹이
    // 배열 맨 앞(desktop "조직이 4구역 위 프레임")이었는데, 시안 확定으로 이제 4구역 «아래»
    // 프레임이라 배열 위치도 맨 뒤로 옮긴다(app-sidebar.tsx는 배열 순서 그대로 렌더하므로 —
    // MOBILE_HUB_GROUP_ORDER는 이미 예전부터 이 그룹을 knowledge 뒤에 뒀었다, 이번에 데스크톱이
    // 그 순서를 따라잡는 것뿐).
    id: 'organization',
    labelKey: 'zoneOrganization',
    items: [
      { id: 'org-members', labelKey: 'orgMembers', icon: Users2, kind: 'static', path: '/organization/members' },
      { id: 'org-workforce', labelKey: 'workforce', icon: Bot, kind: 'static', path: '/organization/workforce' },
      { id: 'org-roles', labelKey: 'orgRoles', icon: Shield, kind: 'static', path: '/organization/roles' },
      { id: 'org-events', labelKey: 'orgEvents', icon: Zap, kind: 'static', path: '/organization/events' },
    ],
  },
  {
    id: 'settings',
    items: [
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
export const MOBILE_HUB_GROUP_ORDER = ['now', 'work', 'trust', 'knowledge', 'organization', 'settings'];

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
