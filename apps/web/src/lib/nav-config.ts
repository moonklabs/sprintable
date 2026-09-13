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
  // story #fddd0e6b(IA·⑦ 전체 메뉴, 유나 시안 ⑦ 판b 036c983a) — 「무엇이 여기 있나」 한 줄.
  // /more 허브가 소비(팔레트는 이 카드 스코프 밖). 필수 — board·inbox는 /more에서 안
  // 렌더되지만(MOBILE_HUB_EXCLUDE_IDS) «계약상 예약»이라 이 둘도 값을 가진다(제외가
  // 풀리는 날 설명이 조용히 비지 않게 — 완전성 테스트가 23개 전부를 잰다).
  descriptionKey: string;
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
// story #3824(UX-v3·FE 1, 페드루 PO 確定 2026-09-13, doc a699be00 §② 흡수 지도) —
// 5항목(오늘·대화·일감·결과·연결·규칙)으로 축소. path는 전부 불변(라우트 보존·
// 딥링크/북마크 무손상) — 이 슬라이스는 재그룹+재라벨만. 「대화」는 이 배열에 없다
// (기존 그대로 CHAT_CENTER_ITEM — 구역 밖 1급 챗 center, 아래 참고).
//
// 5항목 중 4개(오늘·일감·결과)는 목적지가 하나뿐이라 라벨 없는 헤더리스 1항목
// 그룹(옛 'settings' 그룹과 동형 관례)으로 표현한다 — group.labelKey가 없으면
// app-sidebar.tsx가 접기 토글·그룹 헤더 자체를 안 그리므로(isCollapsible = Boolean
// (group.labelKey)) 화면엔 항목 라벨 하나만 보인다. 「연결·규칙」만 하위 둘(채널
// 연결/콘텐츠 규칙)을 가진 진짜 라벨 그룹이다 — NavItemConfig가 중첩 하위메뉴를
// 지원 안 해(app-sidebar.tsx는 group.items를 평평하게 순회) "항목 하나·하위 둘"은
// 이 레포 관례상 "라벨 그룹 안 항목 2개"로 표현하는 것이 유일한 길이다.
//
// 오늘·일감의 라벨키는 새로 만들지 않고 기존 zoneNow("오늘"/"Today")·zoneDev
// ("일감"/"Work") 그룹 라벨 값을 그대로 재사용한다(이미 정확히 그 낱말이었다 —
// #f81657f8이 이미 "일감"/Work로 개명해 둔 값). 「결과」는 기존 orgInsightsBoard
// ("성과 보드")를 그대로 리라벨하면 insight-snapshot-block.tsx:174의 `tNav(
// 'orgInsightsBoard')` CTA 문장("...에서 보기")이 조용히 "결과에서 보기"로 같이
// 바뀐다(다른 문맥·다른 문장) — 새 labelKey `navResults`로 분리해 그 CTA는 안 건드린다.
export const NAV_GROUPS: NavGroupConfig[] = [
  {
    id: 'now',
    items: [
      { id: 'org-briefing', labelKey: 'zoneNow', descriptionKey: 'descOrgBriefing', icon: Newspaper, kind: 'static', path: '/org-briefing' },
    ],
  },
  {
    id: 'dev',
    items: [
      { id: 'board', labelKey: 'zoneDev', descriptionKey: 'descBoard', icon: Workflow, kind: 'resource', path: 'flow', kbdHint: 'B', scope: 'project' },
    ],
  },
  {
    id: 'results',
    items: [
      { id: 'org-insights-board', labelKey: 'navResults', descriptionKey: 'descOrgInsightsBoard', icon: TrendingUp, kind: 'static', path: '/organization/insights-board', scope: 'org' },
    ],
  },
  {
    id: 'connect-rules',
    labelKey: 'zoneConnectRules',
    items: [
      { id: 'org-channels', labelKey: 'orgChannels', descriptionKey: 'descOrgChannels', icon: Share2, kind: 'static', path: '/organization/channels', scope: 'org' },
      { id: 'org-content-rules', labelKey: 'orgContentRules', descriptionKey: 'descOrgContentRules', icon: ListChecks, kind: 'static', path: '/organization/content-rules', scope: 'org' },
    ],
  },
];

// story #3824 — 5항목 축소로 사이드바에서 빠지는 17개 목적지. 라우트는 전부 그대로
// 살아있다(북마크·딥링크 무손상, path 불변) — 이 배열이 이제 이들의 1급 진입점
// (커맨드 팔레트 ⌘K, command-palette.tsx가 NAV_GROUPS와 나란히 소비)이다.
// kind:'resource' 7개(goals·loops·standup·retro·docs·artifacts·storage)는 이
// 배열 자체의 `kind: 'resource', path: '...'` 리터럴이 verify-no-orphan-resource-
// routes(story #2376)의 조합 진입점 축(extractNavConfigResourceTargets, 파일
// 전체 스캔이라 소속 배열 무관)이라 이 배열에 남아 있는 한 그 가드가 계속
// 그린이다 — 지우면 그 7개가 routeWithoutEntry로 즉시 RED(가드 완화 금지, 카드
// AC2 명시). 라벨·설명·아이콘은 전부 기존 값 그대로 재사용(뜻 무변, 자리만 이동).
export const LEGACY_NAV_ITEMS: NavItemConfig[] = [
  { id: 'goals', labelKey: 'goals', descriptionKey: 'descGoals', icon: Layers, kind: 'resource', path: 'goals', scope: 'project' },
  { id: 'loops', labelKey: 'loops', descriptionKey: 'descLoops', icon: FlaskConical, kind: 'resource', path: 'loops', scope: 'project' },
  { id: 'standup', labelKey: 'standup', descriptionKey: 'descStandup', icon: Users, kind: 'resource', path: 'standup', scope: 'project' },
  { id: 'retro', labelKey: 'retro', descriptionKey: 'descRetro', icon: Gauge, kind: 'resource', path: 'retro', scope: 'project' },
  { id: 'docs', labelKey: 'docs', descriptionKey: 'descDocs', icon: BookOpen, kind: 'resource', path: 'docs', scope: 'project' },
  { id: 'artifacts', labelKey: 'artifacts', descriptionKey: 'descArtifacts', icon: GalleryVerticalEnd, kind: 'resource', path: 'artifacts', scope: 'project' },
  { id: 'storage', labelKey: 'storage', descriptionKey: 'descStorage', icon: HardDrive, kind: 'resource', path: 'storage', scope: 'project' },
  { id: 'activity', labelKey: 'activity', descriptionKey: 'descActivity', icon: ClipboardList, kind: 'static', path: '/activity', scope: 'project' },
  { id: 'org-trust', labelKey: 'orgTrust', descriptionKey: 'descOrgTrust', icon: Award, kind: 'static', path: '/organization/trust', scope: 'org' },
  { id: 'org-memory', labelKey: 'orgMemory', descriptionKey: 'descOrgMemory', icon: Brain, kind: 'static', path: '/organization/memory', scope: 'org' },
  { id: 'content', labelKey: 'content', descriptionKey: 'descContent', icon: FileText, kind: 'static', path: '/content', scope: 'org' },
  { id: 'channel-posts', labelKey: 'channelPosts', descriptionKey: 'descChannelPosts', icon: Share2, kind: 'static', path: '/content/channel-posts', scope: 'org' },
  { id: 'org-members', labelKey: 'orgMembers', descriptionKey: 'descOrgMembers', icon: Users2, kind: 'static', path: '/organization/members', scope: 'org' },
  { id: 'org-workforce', labelKey: 'workforce', descriptionKey: 'descWorkforce', icon: Bot, kind: 'static', path: '/organization/workforce' },
  { id: 'org-roles', labelKey: 'orgRoles', descriptionKey: 'descOrgRoles', icon: Shield, kind: 'static', path: '/organization/roles', scope: 'org' },
  { id: 'org-events', labelKey: 'orgEvents', descriptionKey: 'descOrgEvents', icon: Zap, kind: 'static', path: '/organization/events', scope: 'org' },
  // story #1981 배지 축(inboxPendingCount)은 app-sidebar.tsx에 그대로 남는다(다음
  // 카드 #3823 「오늘」 배지가 재사용) — 이 항목 자체가 사이드바에서 빠져도 그
  // 폴링·SSE 재조회 로직은 안 건든다(다음 카드가 그 값을 소비할 자리를 다시 연결).
  { id: 'inbox', labelKey: 'inbox', descriptionKey: 'descInbox', icon: Inbox, kind: 'static', path: '/inbox', badgeKey: 'inbox' },
  { id: 'settings', labelKey: 'settings', descriptionKey: 'descSettings', icon: Settings, kind: 'static', path: '/settings' },
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
// story #3824(UX-v3·FE 1, 페드루 PO 確定 2026-09-13 조건②) — NAV_GROUPS가 5항목(now·
// dev·results·connect-rules)으로 줄며 옛 marketing·trust·knowledge·organization·
// settings 그룹 자체가 사라졌다 — 이 순서 상수도 그 4개만 남긴다(더는 없는 그룹 id는
// more/page.tsx의 `.find()`가 그냥 undefined로 걸러낼 뿐 에러는 아니지만, 죽은 이름을
// 남겨 두면 다음 사람이 "이 그룹이 아직 있나" 헷갈린다). 5항목 밖으로 빠진 17개
// (LEGACY_NAV_ITEMS)는 이 순서 상수가 아니라 more/page.tsx가 그 배열을 직접 얹는
// «그 밖의 화면» 카드 하나로 뒤에 따라붙는다(모바일 회귀 0, PO 조건②).
export const MOBILE_HUB_GROUP_ORDER = ['now', 'dev', 'results', 'connect-rules'];

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
  // story #fddd0e6b(IA·⑦ 전체 메뉴) — chats는 NAV_GROUPS 밖(구역 없는 1급 승격)이라
  // /more의 23개 완전성 대상은 아니지만, NavItemConfig 타입 자체는 descriptionKey를
  // 요구한다(팔레트 등 다른 소비처가 이 항목도 같은 타입으로 다룬다) — 값은 채운다.
  id: 'chats', labelKey: 'chats', descriptionKey: 'descChats', icon: MessageSquare, kind: 'static', path: '/chats', badgeKey: 'chats',
};

// story #d986fd6c(IA·S4)의 «뷰포트 높이 역산 접힘» 전제(필요 높이(px) = 615.5 + 32×N)는
// 이 스토리(#f81657f8, 선생님 決 2026-09-09 01:28Z 「그냥 디폴트를 다 펼쳐두고 접을 수 있게
// 하면 좋을 것 같다」)로 폐기됐다 — 기본값은 이제 뷰포트/활성 구역과 완전히 무관한 빈 Set
// (전부 펼침)이다. 관계식·GroupItemCount·computeActiveZoneCollapsedGroupIds는 코드고고학이
// 필요하면 git 이력(이 커밋 이전)에서 찾을 것 — 살아있는 추상으로 남겨두지 않는다.
// 구역별 접기 토글+사람별 기억(app-sidebar.tsx의 collapsedOverrides)은 그대로다.
