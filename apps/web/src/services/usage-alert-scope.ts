export interface UsageAlertScopeNotice {
  badge: 'ORG-WIDE';
  titleKey: 'alertScopeOrgWideTitle';
  bodyKey: 'alertScopeAllProjectsBody' | 'alertScopeSelectedProjectBody';
  bodyValues?: { project: string };
}

export function getUsageAlertScopeNotice(input: {
  projectId: string;
  projectLabel: string;
  allProjectsValue: string;
}): UsageAlertScopeNotice {
  if (input.projectId === input.allProjectsValue) {
    return {
      badge: 'ORG-WIDE',
      titleKey: 'alertScopeOrgWideTitle',
      bodyKey: 'alertScopeAllProjectsBody',
    };
  }

  return {
    badge: 'ORG-WIDE',
    titleKey: 'alertScopeOrgWideTitle',
    bodyKey: 'alertScopeSelectedProjectBody',
    bodyValues: { project: input.projectLabel },
  };
}
