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

  const account: SettingsNavItem[] = [
    { kind: 'tab', id: 'profile', labelKey: 'tabProfile', icon: 'person' },
    { kind: 'tab', id: 'appearance', labelKey: 'tabDisplay', icon: 'palette' }, // the theme AND the language (story #4413)
    { kind: 'tab', id: 'notifications', labelKey: 'tabNotifications', icon: 'notifications' },
    { kind: 'tab', id: 'desktop', labelKey: 'desktopTab', icon: 'desktop_windows' }, // reopens the onboarding's «get the desktop app» (story 4668) — no flag
  ];
  if (g.inPhoneApp) account.push({ kind: 'tab', id: 'this-phone', labelKey: 'tabThisPhone', icon: 'smartphone' }); // story 4762
  if (g.supportWidget) account.push({ kind: 'tab', id: 'support', labelKey: 'tabSupport', icon: 'support' });
  groups.push({ id: 'account', labelKey: 'myAccount', items: account, pending: 0 });

  const project: SettingsNavItem[] = [];
  if (g.adminChecked) {
    project.push({ kind: 'tab', id: 'members', labelKey: 'tabMembers', icon: 'groups' });
    if (g.isAdmin && workflowDrawn) project.push({ kind: 'tab', id: 'workflow', labelKey: 'tabWorkflow', icon: 'account_tree' });
    if (g.isAdmin) project.push({ kind: 'tab', id: 'workflow-policies', labelKey: 'tabWorkflowPolicies', icon: 'verified_user' });
  }
  groups.push({ id: 'project', labelKey: 'projectSettings', items: project, pending: g.adminChecked ? 0 : 2 + (workflowDrawn ? 1 : 0) });

  const org: SettingsNavItem[] = [];
  if (g.adminChecked) {
    org.push({ kind: 'tab', id: 'organization', labelKey: 'tabOrganization', icon: 'domain' });
    if (orgMembersDrawn) org.push({ kind: 'tab', id: 'org-members', labelKey: 'tabOrgMembers', icon: 'groups' });
    org.push({ kind: 'tab', id: 'projects', labelKey: 'tabProjects', icon: 'folder' });
  }
  groups.push({ id: 'organization', labelKey: 'organizationSettings', items: org, pending: g.adminChecked ? 0 : 2 + (orgMembersDrawn ? 1 : 0) });

  if (!g.adminChecked) {
    groups.push({ id: 'billing', labelKey: 'billing', items: [], pending: 2 });
  } else if (g.isAdmin) {
    const billing: SettingsNavItem[] = [];
    if (g.billing) billing.push({ kind: 'tab', id: 'billing', labelKey: 'tabBilling', icon: 'credit_card' });
    billing.push({ kind: 'tab', id: 'usage', labelKey: 'tabUsage', icon: 'bar_chart' });
    groups.push({ id: 'billing', labelKey: 'billing', items: billing, pending: 0 });
  }

  groups.push({ id: 'integrations', labelKey: 'tabIntegrations', items: [{ kind: 'link', id: 'integrations', labelKey: 'tabIntegrations', icon: 'webhook' }], pending: 0 });
  groups.push({ id: 'danger', labelKey: 'dangerZone', items: [{ kind: 'tab', id: 'danger', labelKey: 'deleteAccount', icon: 'delete', danger: true }], pending: 0 });
  return groups;
}

/** the ids of every section a person can be on in this combination (the tab ones) */
export function settingsNavTabIds(g: SettingsNavGates): string[] {
  return settingsNavGroups(g).flatMap((grp) => grp.items.filter((i) => i.kind === 'tab').map((i) => i.id));
}
