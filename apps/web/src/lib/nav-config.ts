import {
  Award,
  BookOpen,
  Bot,
  Brain,
  CalendarRange,
  ClipboardList,
  FlaskConical,
  GalleryVerticalEnd,
  HardDrive,
  Inbox,
  Layers,
  LayoutDashboard,
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

export const NAV_GROUPS: NavGroupConfig[] = [
  {
    id: 'organization',
    labelKey: 'zoneOrganization',
    items: [
      { id: 'org-members', labelKey: 'orgMembers', icon: Users2, kind: 'static', path: '/organization/members' },
      { id: 'org-workforce', labelKey: 'workforce', icon: Bot, kind: 'static', path: '/organization/workforce' },
      { id: 'org-roles', labelKey: 'orgRoles', icon: Shield, kind: 'static', path: '/organization/roles' },
      { id: 'org-trust', labelKey: 'orgTrust', icon: Award, kind: 'static', path: '/organization/trust' },
      { id: 'org-memory', labelKey: 'orgMemory', icon: Brain, kind: 'static', path: '/organization/memory' },
      { id: 'org-events', labelKey: 'orgEvents', icon: Zap, kind: 'static', path: '/organization/events' },
    ],
  },
  {
    id: 'now',
    labelKey: 'zoneNow',
    items: [
      { id: 'org-briefing', labelKey: 'orgBriefing', icon: Newspaper, kind: 'static', path: '/org-briefing' },
      { id: 'inbox', labelKey: 'inbox', icon: Inbox, kind: 'static', path: '/inbox', badgeKey: 'inbox' },
      { id: 'dashboard', labelKey: 'dashboard', icon: LayoutDashboard, kind: 'static', path: '/dashboard' },
      { id: 'chats', labelKey: 'chats', icon: MessageSquare, kind: 'static', path: '/chats', badgeKey: 'chats' },
    ],
  },
  {
    id: 'work',
    labelKey: 'zoneWork',
    items: [
      { id: 'flow', labelKey: 'flow', icon: Workflow, kind: 'resource', path: 'flow', kbdHint: 'B' },
      { id: 'sprints', labelKey: 'sprints', icon: CalendarRange, kind: 'resource', path: 'sprints' },
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
    ],
  },
  {
    id: 'knowledge',
    labelKey: 'zoneKnowledge',
    items: [
      { id: 'docs', labelKey: 'docs', icon: BookOpen, kind: 'resource', path: 'docs' },
      { id: 'artifacts', labelKey: 'artifacts', icon: GalleryVerticalEnd, kind: 'resource', path: 'artifacts' },
      { id: 'storage', labelKey: 'storage', icon: HardDrive, kind: 'resource', path: 'storage' },
    ],
  },
  {
    id: 'settings',
    items: [
      { id: 'settings', labelKey: 'settings', icon: Settings, kind: 'static', path: '/settings' },
    ],
  },
];
