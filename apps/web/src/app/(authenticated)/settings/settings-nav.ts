// story 5037 (C7) — the groups are now 조직 · 사람과 역할 · 연결 · 프로젝트 관리 · 콘텐츠 규칙 · 청구 · 모양 (between «내 계정» on top and the danger row at the bottom). NOTHING is dropped or renamed: every tab id of before is still a row (an old `?tab=` address
// opens the same pane — settings-nav.test.ts holds the list of old ids), and the organization screens that the placement table (nav-placement.json) puts in this place get their door HERE as link rows — read from the nav catalog by id (`navId`), so no route string is written in this file.
// story 4891 (UI-8 AC4 · first screen rebuild) — WHICH sections the settings list draws, as one pure function. It used to be ~130 lines of inline conditions in page.tsx (admin · feature flags · the phone app); pulled out so «every
// section that can be seen is in the list» is a test per combination, not a hope. The order, the headings and the conditions are exactly the page's old ones — only where they live changed.
import type { IconName } from '@/components/ds/icon-paths';
import { HIDDEN_SETTINGS_TABS } from './settings-tab';

export interface SettingsNavGates {
  /** the person's role has been read (before that the rows that depend on it are placeholders) */
  adminChecked: boolean;
  /** organization admin / owner */
  isAdmin: boolean;
  /** inside the phone app (story 4762): the «이 폰» section exists */
  inPhoneApp: boolean;
  /** story 4994: the guest desktop app is a computer — its tab says «이 컴퓨터» */
  deviceKind?: 'phone' | 'computer';
  /** isSupportWidgetEnabled() */
  supportWidget: boolean;
  /** isEEEnabled() — the billing section exists */
  billing: boolean;
}

export interface SettingsNavItem {
  /** a `tab` selects the pane of the same id on this page · a `link` goes to another page */
  kind: 'tab' | 'link';
  id: string;
  /** key in the `settings` messages */
  labelKey: string;
  icon: IconName;
  danger?: boolean;
  /** story 5037: a `link` with a `navId` goes to that nav-catalog screen (nav-config.ts `id`) and is named by the label that screen already uses (messages `nav`) — one thing, one word. A `link` without one is the «연동» page. */
  navId?: string;
  /** which messages the `labelKey` is a key of — `settings` unless said */
  ns?: 'nav';
}

export interface SettingsNavGroup {
  id: string;
  /** key in the `settings` messages */
  labelKey: string;
  items: SettingsNavItem[];
  /** placeholder rows to draw while the role is being read */
  pending: number;
}

export function settingsNavGroups(g: SettingsNavGates): SettingsNavGroup[] {
  const workflowDrawn = !HIDDEN_SETTINGS_TABS.has('workflow');
  const orgMembersDrawn = !HIDDEN_SETTINGS_TABS.has('org-members');
  const groups: SettingsNavGroup[] = [];

  // 내 계정 — the person's own (unchanged but «모양», which is a group of its own below)
  const account: SettingsNavItem[] = [
    { kind: 'tab', id: 'profile', labelKey: 'tabProfile', icon: 'person' },
    { kind: 'tab', id: 'notifications', labelKey: 'tabNotifications', icon: 'notifications' },
    { kind: 'tab', id: 'desktop', labelKey: 'desktopTab', icon: 'desktop_windows' }, // reopens the onboarding's «get the desktop app» (story 4668) — no flag
  ];
  if (g.inPhoneApp) {
    // story 4762 (story 4994: the guest desktop app is a computer — «이 컴퓨터»; the two labels are written out whole so the dead-key scan sees both)
    account.push(g.deviceKind === 'computer'
      ? { kind: 'tab', id: 'this-phone', labelKey: 'tabThisComputer', icon: 'desktop_windows' }
      : { kind: 'tab', id: 'this-phone', labelKey: 'tabThisPhone', icon: 'smartphone' });
  }
  if (g.supportWidget) account.push({ kind: 'tab', id: 'support', labelKey: 'tabSupport', icon: 'support' });
  groups.push({ id: 'account', labelKey: 'myAccount', items: account, pending: 0 });

  // 조직
  const org: SettingsNavItem[] = [];
  if (g.adminChecked) {
    org.push({ kind: 'tab', id: 'organization', labelKey: 'tabOrganization', icon: 'domain' });
    if (orgMembersDrawn) org.push({ kind: 'tab', id: 'org-members', labelKey: 'tabOrgMembers', icon: 'groups' });
  }
  groups.push({ id: 'organization', labelKey: 'organizationSettings', items: org, pending: g.adminChecked ? 0 : 1 + (orgMembersDrawn ? 1 : 0) });

  // 사람과 역할 — the project's members tab, then the two organization screens about people (the screens read their own role gates, as they did from the old side list)
  const people: SettingsNavItem[] = [];
  if (g.adminChecked) people.push({ kind: 'tab', id: 'members', labelKey: 'tabMembers', icon: 'groups' });
  people.push({ kind: 'link', id: 'org-members-list', navId: 'org-members', ns: 'nav', labelKey: 'orgMembers', icon: 'badge' });
  people.push({ kind: 'link', id: 'org-roles', navId: 'org-roles', ns: 'nav', labelKey: 'orgRoles', icon: 'manage_accounts' });
  groups.push({ id: 'people', labelKey: 'groupPeopleRoles', items: people, pending: g.adminChecked ? 0 : 1 });

  // 연결 — «연동» first (what it was), then the channel · connector · recipe screens
  groups.push({
    id: 'connections',
    labelKey: 'groupConnections',
    items: [
      { kind: 'link', id: 'integrations', labelKey: 'tabIntegrations', icon: 'webhook' },
      { kind: 'link', id: 'org-channels', navId: 'org-channels', ns: 'nav', labelKey: 'orgChannels', icon: 'share' },
      { kind: 'link', id: 'org-generation-connectors', navId: 'org-generation-connectors', ns: 'nav', labelKey: 'orgGenerationConnectors', icon: 'memory' },
      { kind: 'link', id: 'org-events', navId: 'org-events', ns: 'nav', labelKey: 'orgEvents', icon: 'bolt' },
    ],
    pending: 0,
  });

  // 프로젝트 관리
  const project: SettingsNavItem[] = [];
  if (g.adminChecked) {
    project.push({ kind: 'tab', id: 'projects', labelKey: 'tabProjects', icon: 'folder' });
    if (g.isAdmin && workflowDrawn) project.push({ kind: 'tab', id: 'workflow', labelKey: 'tabWorkflow', icon: 'account_tree' });
    if (g.isAdmin) project.push({ kind: 'tab', id: 'workflow-policies', labelKey: 'tabWorkflowPolicies', icon: 'verified_user' });
  }
  groups.push({ id: 'project', labelKey: 'groupProjectManagement', items: project, pending: g.adminChecked ? 0 : 2 + (workflowDrawn ? 1 : 0) });

  // 콘텐츠 규칙
  groups.push({ id: 'content-rules', labelKey: 'groupContentRules', items: [{ kind: 'link', id: 'org-content-rules', navId: 'org-content-rules', ns: 'nav', labelKey: 'orgContentRules', icon: 'checklist' }], pending: 0 });

  // 청구 (the group keeps its heading «결제» — the word the billing screens use)
  if (!g.adminChecked) {
    groups.push({ id: 'billing', labelKey: 'billing', items: [], pending: 2 });
  } else if (g.isAdmin) {
    const billing: SettingsNavItem[] = [];
    if (g.billing) billing.push({ kind: 'tab', id: 'billing', labelKey: 'tabBilling', icon: 'credit_card' });
    billing.push({ kind: 'tab', id: 'usage', labelKey: 'tabUsage', icon: 'bar_chart' });
    groups.push({ id: 'billing', labelKey: 'billing', items: billing, pending: 0 });
  }

  // 모양 — the theme AND the language (story #4413)
  groups.push({ id: 'appearance', labelKey: 'groupAppearance', items: [{ kind: 'tab', id: 'appearance', labelKey: 'tabDisplay', icon: 'palette' }], pending: 0 });

  groups.push({ id: 'danger', labelKey: 'dangerZone', items: [{ kind: 'tab', id: 'danger', labelKey: 'deleteAccount', icon: 'delete', danger: true }], pending: 0 });
  return groups;
}

/** the ids of every section a person can be on in this combination (the tab ones) */
export function settingsNavTabIds(g: SettingsNavGates): string[] {
  return settingsNavGroups(g).flatMap((grp) => grp.items.filter((i) => i.kind === 'tab').map((i) => i.id));
}
