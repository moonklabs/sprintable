import { describe, expect, it } from 'vitest';
import { getUsageAlertScopeNotice } from './usage-alert-scope';

describe('usage alert scope notice', () => {
  it('marks the alert section as org-wide when all projects are selected', () => {
    expect(getUsageAlertScopeNotice({
      projectId: 'all',
      projectLabel: 'All projects',
      allProjectsValue: 'all',
    })).toEqual({
      badge: 'ORG-WIDE',
      titleKey: 'alertScopeOrgWideTitle',
      bodyKey: 'alertScopeAllProjectsBody',
    });
  });

  it('makes project-selected query/export scope distinct from org-wide alerts', () => {
    expect(getUsageAlertScopeNotice({
      projectId: 'project-1',
      projectLabel: 'Apollo',
      allProjectsValue: 'all',
    })).toEqual({
      badge: 'ORG-WIDE',
      titleKey: 'alertScopeOrgWideTitle',
      bodyKey: 'alertScopeSelectedProjectBody',
      bodyValues: { project: 'Apollo' },
    });
  });
});
