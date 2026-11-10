import {
  Award,
  BookOpen,
  Bot,
  ClipboardList,
  Cpu,
  FileText,
  FlaskConical,
  GalleryVerticalEnd,
  HardDrive,
  History,
  Inbox,
  KeyRound,
  Layers,
  ListChecks,
  MessageSquare,
  MessagesSquare,
  Monitor,
  Newspaper,
  Settings,
  Share2,
  Shield,
  Trophy,
  TrendingUp,
  Users2,
  Workflow,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import type { NavV3Flags } from './nav-v3-destinations';

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

// story #4885 (UI-2 AC4 PR 1, PO 결정 11-10) — 사이드바 · 모바일 «전체»(/more) · ⌘K 팔레트가 읽는 **정보 구조 한 벌**. 화면(라우트)은 하나도 옮기지 않고 입구만 다시 묶는다.
// 이전 세대(4구역 → 5항목 + 「더보기」 서랍 17개 → v3 플래그 병기)를 걷어 낸 모양이다. 새 셸은 플래그 없이 하나 — 정본은 지금 서 있는 화면(/org-briefing · /chats · /flow),
// v3 쪽(/today · /chat · /work-list · /connect-rules)은 켜지도 떼지도 않는다(이 파일이 더는 가리키지 않을 뿐, 옮기지 않는 것으로 자연도태 — 라우트 정리는 화면 주인과 화면이 선 뒤).
// 설계 근거: doc ui2-4885-ac3-ia-draft-v0(AC3 v1) §2·§3 — 매일 다섯(오늘 · 대화 · 일감 · 팀/에이전트 · 지식)이 위에 1단으로, 조직 항목은 접힌 «조직» 안에, 설정, 그리고 «전체».
//
// «팀» ↔ «에이전트»: 아래 TEAM_VARIANT 한 줄이 이름 · 묶음 · 구성원 항목의 자리를 함께 정한다. 선생님 결정(11-10) = «팀». 대안 꼴(«에이전트»)도 시험이 서 있어 한 줄로 되돌릴 수 있다.
export type TeamVariant = 'agent' | 'team';
export const TEAM_VARIANT: TeamVariant = 'team';

const ITEM_ORG_BRIEFING: NavItemConfig = { id: 'org-briefing', labelKey: 'zoneNow', descriptionKey: 'descOrgBriefing', icon: Newspaper, kind: 'static', path: '/org-briefing' };
// 결재: «오늘» 화면이 받은 함 하나로 합쳐지기 전(오늘 화면 주인 UI-5 몫)까지 결재의 입구다 — 폰 하단 «결재» 탭과 같은 이름 · 같은 착지(게이트 탭) · 같은 배지(내가 지정된 대기 결재 수). 알림 목록은 알림 종과 같은 화면의 다른 탭.
// 사이드바에 «결재»가 없어 웹의 입구가 알림 종 하나뿐이던 것(UI-2 AC1)을 막는다. 막다른 곳을 만들지 않으려고 «오늘» 바로 아래에 둔다.
const ITEM_INBOX: NavItemConfig = { id: 'inbox', labelKey: 'approvals', descriptionKey: 'descInbox', icon: Inbox, kind: 'static', path: '/inbox?tab=gates', badgeKey: 'inbox' };
const ITEM_BOARD: NavItemConfig = { id: 'board', labelKey: 'zoneDev', descriptionKey: 'descBoard', icon: Workflow, kind: 'resource', path: 'flow', scope: 'project' };
// 목표 · 실행은 일감의 탭줄로 올라가기 전까지(후속 칸) 일감 바로 아래에서 입구를 갖는다.
const ITEM_GOALS: NavItemConfig = { id: 'goals', labelKey: 'goals', descriptionKey: 'descGoals', icon: Layers, kind: 'resource', path: 'goals', scope: 'project' };
const ITEM_LOOPS: NavItemConfig = { id: 'loops', labelKey: 'loops', descriptionKey: 'descLoops', icon: FlaskConical, kind: 'resource', path: 'loops', scope: 'project' };
const ITEM_MEMBERS: NavItemConfig = { id: 'org-members', labelKey: 'orgMembers', descriptionKey: 'descOrgMembers', icon: Users2, kind: 'static', path: '/organization/members', scope: 'org' };
const ITEM_WORKFORCE: NavItemConfig = { id: 'org-workforce', labelKey: 'workforce', descriptionKey: 'descWorkforce', icon: Bot, kind: 'static', path: '/organization/workforce' };
const ITEM_WORKFORCE_RUNS: NavItemConfig = { id: 'org-workforce-runs', labelKey: 'workforceRuns', descriptionKey: 'descWorkforceRuns', icon: History, kind: 'static', path: '/organization/workforce/runs' };
const ITEM_WORKFORCE_KEYS: NavItemConfig = { id: 'org-workforce-api-keys', labelKey: 'workforceApiKeys', descriptionKey: 'descWorkforceApiKeys', icon: KeyRound, kind: 'static', path: '/organization/workforce/api-keys' };

// 팀/에이전트 묶음 — TEAM_VARIANT에 따라 «팀»(사람 + 에이전트 한 목록, 머리글 «팀») 또는 «에이전트»(머리글 없는 에이전트 묶음, 구성원은 조직 아래).
const TEAM_ITEMS: Record<TeamVariant, NavItemConfig[]> = {
  agent: [ITEM_WORKFORCE, ITEM_WORKFORCE_RUNS, ITEM_WORKFORCE_KEYS],
  team: [ITEM_MEMBERS, ITEM_WORKFORCE, ITEM_WORKFORCE_RUNS, ITEM_WORKFORCE_KEYS],
};
const TEAM_HEADER: Record<TeamVariant, Pick<NavGroupConfig, 'labelKey'>> = { agent: {}, team: { labelKey: 'zoneTeam' } };
// «조직» 안의 구성원은 «에이전트» 꼴일 때만(«팀» 꼴은 팀 묶음 안으로 올라간다).
const ORG_MEMBERS_ITEMS: Record<TeamVariant, NavItemConfig[]> = { agent: [ITEM_MEMBERS], team: [] };

// 두 꼴을 다 세울 수 있게 함수로 — 시험이 «팀»/«에이전트» 둘 다 같은 규칙(영역 · 순서 · orphan 0)을 지키는지 본다.
export function buildNavGroups(variant: TeamVariant): NavGroupConfig[] {
  return [
  { id: 'now', items: [ITEM_ORG_BRIEFING, ITEM_INBOX] },
  { id: 'dev', items: [ITEM_BOARD, ITEM_GOALS, ITEM_LOOPS] },
  { id: 'team', ...TEAM_HEADER[variant], items: TEAM_ITEMS[variant] },
  {
    id: 'knowledge',
    labelKey: 'zoneKnowledge',
    items: [
      { id: 'docs', labelKey: 'docs', descriptionKey: 'descDocs', icon: BookOpen, kind: 'resource', path: 'docs', scope: 'project' },
      { id: 'artifacts', labelKey: 'artifacts', descriptionKey: 'descArtifacts', icon: GalleryVerticalEnd, kind: 'resource', path: 'artifacts', scope: 'project' },
      { id: 'storage', labelKey: 'storage', descriptionKey: 'descStorage', icon: HardDrive, kind: 'resource', path: 'storage', scope: 'project' },
    ],
  },
  {
    // 조직 — 기본 접힘(사람이 펼치면 기억). 결과 · 연결·규칙 · 권한 · 이력 · 콘텐츠.
    id: 'org',
    labelKey: 'zoneOrganization',
    items: [
      { id: 'org-insights-board', labelKey: 'navResults', descriptionKey: 'descOrgInsightsBoard', icon: TrendingUp, kind: 'static', path: '/organization/insights-board', scope: 'org' },
      { id: 'org-channels', labelKey: 'orgChannels', descriptionKey: 'descOrgChannels', icon: Share2, kind: 'static', path: '/organization/channels', scope: 'org' },
      // story #4116(#4112 유나 시안 55a04e8d) — 채널 연결의 형제 화면. «연결»(계정 링크)과 «커넥터»(자격 등록)는 용어 구분이 곧 메커니즘 구분(유나 canon, §8) — 통일 대신 병치.
      { id: 'org-generation-connectors', labelKey: 'orgGenerationConnectors', descriptionKey: 'descOrgGenerationConnectors', icon: Cpu, kind: 'static', path: '/organization/generation-connectors', scope: 'org' },
      { id: 'org-content-rules', labelKey: 'orgContentRules', descriptionKey: 'descOrgContentRules', icon: ListChecks, kind: 'static', path: '/organization/content-rules', scope: 'org' },
      { id: 'org-events', labelKey: 'orgEvents', descriptionKey: 'descOrgEvents', icon: Zap, kind: 'static', path: '/organization/events', scope: 'org' },
      { id: 'org-trust', labelKey: 'orgTrust', descriptionKey: 'descOrgTrust', icon: Award, kind: 'static', path: '/organization/trust', scope: 'org' },
      { id: 'org-roles', labelKey: 'orgRoles', descriptionKey: 'descOrgRoles', icon: Shield, kind: 'static', path: '/organization/roles', scope: 'org' },
      ...ORG_MEMBERS_ITEMS[variant],
      { id: 'activity', labelKey: 'activity', descriptionKey: 'descActivity', icon: ClipboardList, kind: 'static', path: '/activity', scope: 'project' },
      // 콘텐츠(채널 글 · 캠페인)는 일감이 아니라 «만들어 내보내는 일» — 조직 아래 따로(PO 결정 11-10 · 유나 판단).
      { id: 'content', labelKey: 'content', descriptionKey: 'descContent', icon: FileText, kind: 'static', path: '/content', scope: 'org' },
      { id: 'channel-posts', labelKey: 'channelPosts', descriptionKey: 'descChannelPosts', icon: Share2, kind: 'static', path: '/content/channel-posts', scope: 'org' },
    ],
  },
  { id: 'settings', items: [{ id: 'settings', labelKey: 'settings', descriptionKey: 'descSettings', icon: Settings, kind: 'static', path: '/settings' }] },
  ];
}
export const NAV_GROUPS: NavGroupConfig[] = buildNavGroups(TEAM_VARIANT);

// 데스크톱 앱 · 연결된 기기(/desktop)는 그 화면이 `DESKTOP_DOWNLOAD_ENABLED`가 꺼지면 되돌려 보내는 화면이라, 켜진 곳에서만 설정 묶음에 항목을 낸다(story #4524) — 버전 플래그가 아니라 화면 존재 플래그.
export function resolveNavGroups(flags: NavV3Flags): NavGroupConfig[] {
  if (!flags.desktopDownloadEnabled) return NAV_GROUPS;
  const desktopItem: NavItemConfig = {
    id: 'desktop-app', labelKey: 'desktopApp', descriptionKey: 'descDesktopApp', icon: Monitor, kind: 'static', path: '/desktop', scope: 'org',
  };
  return NAV_GROUPS.map((group) => (group.id === 'settings' ? { ...group, items: [...group.items, desktopItem] } : group));
}

// «팀» 탭줄(story #4885 · UI-2 AC4 · 선생님 «팀» 결정 → 갈래 1): 구성원 화면과 에이전트(워크포스) 화면들을 한 줄로 잇는 입구 배치 — 라우트 이동 0 · 두 화면을 한 목록으로 합치지 않음.
// 이름은 «가는 화면이 이미 쓰는 낱말» 그대로(한 사물에 낱말 둘 0): 구성원(길잡이 «팀» 첫 항목) · 에이전트 · 실행 기록 · API 키 · 채용(에이전트 화면 안 «채용» 탭이 쓰는 낱말; AC3 표의 «모집»). «전체»(사람 + 에이전트 한 목록)는 한 목록 화면이 서는 뒤(화면 재건축 칸)의 몫이라 이번엔 없다.
// 경로의 쿼리(?tab=recruit)는 «지금 여기» 판정(nav-active)이 읽는다 — 에이전트 화면은 탭 없이도 «에이전트»가 켜지고 ?tab=recruit이면 «채용»이 이긴다.
export interface TeamTabConfig { id: string; ns: 'nav' | 'agents'; labelKey: string; path: string }
export const TEAM_TABS: readonly TeamTabConfig[] = [
  { id: 'agents', ns: 'nav', labelKey: 'workforce', path: '/organization/workforce' },
  { id: 'people', ns: 'nav', labelKey: 'orgMembers', path: '/organization/members' },
  { id: 'runs', ns: 'nav', labelKey: 'workforceRuns', path: '/organization/workforce/runs' },
  { id: 'keys', ns: 'nav', labelKey: 'workforceApiKeys', path: '/organization/workforce/api-keys' },
  { id: 'recruit', ns: 'agents', labelKey: 'recruitTab', path: '/organization/workforce?tab=recruit' },
];

// «전체»(/more) 맨 아래 «그 밖» — 메뉴 입구를 따로 만들지 않는 화면들(쓰임을 우리가 모르거나 아직 준비 중인 화면; PO 결정 11-10: 막다른 곳은 만들지 않는다).
export const OTHER_NAV_ITEMS: NavItemConfig[] = [
  { id: 'rewards', labelKey: 'rewards', descriptionKey: 'descRewards', icon: Trophy, kind: 'static', path: '/rewards' },
  { id: 'channel-chat', labelKey: 'channelChat', descriptionKey: 'descChannelChat', icon: MessagesSquare, kind: 'static', path: '/channel' },
];

// 모바일 «전체»의 구역 순서(story #4885 · 폰 탭 넷): 하단 탭이 홈 · 대화 · 일감을 덮으니 탭에 없는 매일 구역 **팀 · 지식이 맨 위 두 구역**, 그 다음 **설정**, 그 뒤에 홈 · 일감 쪽에 남은 항목(결재 · 목표 · 실행) · 조직(사이드바 순서와 다르다 — 사이드바는 탭이 없어 홈 · 일감이 위).
// 설정이 조직 뒤(맨 아래 근처)이던 때는 폰 390에서 설정 줄이 y 1819(보이는 높이 780)라 쓸기 3번이었다 — 조직이 줄 10개(약 700px)다. 설정을 지식 바로 뒤로 올려 짧게 한 번(문서는 첫 화면 그대로 — 문서보다 위로는 안 올린다).
// 탭바가 이미 depth 1로 커버하는 목적지(홈 · 대화 · 일감)는 허브에서 뺀다(탭바가 지금 그리는 탭 기준, mobile-tab-bar.tsx) — 결재 화면은 이제 탭이 아니라 «전체» 목록(+ 홈 본문 · 알림 종)에서 열린다.
export const MOBILE_HUB_GROUP_ORDER = ['team', 'knowledge', 'settings', 'now', 'dev', 'org'];
export const MOBILE_HUB_EXCLUDE_IDS = new Set(['org-briefing', 'board', 'chats']);

// 사이드바 맨 아래 «전체» 항목(→ /more)과 챗 center. 챗은 구역 밖 1급 카드(story #2930 I2)로 «오늘» 바로 뒤에 선다 — NAV_GROUPS에는 실리지 않는다.
// 사이드바가 flatHref로 감싸 그린다(`path` 속성 = 내비 설정 경로, flat-link 래칫의 EXEMPT와 같은 취급).
export const ALL_SCREENS_ITEM = { id: 'all-screens', labelKey: 'navAll', path: '/more' } as const;
export const CHAT_CENTER_ITEM: NavItemConfig = {
  id: 'chats', labelKey: 'chats', descriptionKey: 'descChats', icon: MessageSquare, kind: 'static', path: '/chats', badgeKey: 'chats',
};

// 새 정보 구조의 «사람이 닿을 수 있는 모든 입구» — 시험 · 가드가 라우트 커버리지를 셀 때 쓴다(NAV_GROUPS + 그 밖 + 챗 + 데스크톱 항목).
// «데스크톱 앱» 항목은 그 화면이 켜진 곳(DESKTOP_DOWNLOAD_ENABLED)에서만 사이드바 · 전체에 선다 — 이 기본값(켜짐)은 «켜진 곳 기준으로 센다»는 뜻이다(꺼진 곳에선 /desktop이 되돌려 보내므로 입구도 없다).
// ⌘K 팔레트는 예전부터 플래그 없이 NAV_GROUPS를 그대로 읽어 데스크톱 항목을 싣지 않는다(story #4524 · nav-config-4524-desktop.test.ts가 고정) — 이번 변경으로 바뀌지 않는다.
export function allNavItems(flags: NavV3Flags = { todayV3Enabled: false, chatV3Enabled: false, connectRulesV3Enabled: false, desktopDownloadEnabled: true }): NavItemConfig[] {
  return [...resolveNavGroups(flags).flatMap((group) => group.items), CHAT_CENTER_ITEM, ...OTHER_NAV_ITEMS];
}
