// @vitest-environment jsdom
//
// story #4833 — a bell line about an agent's usage limit opens «오늘» (the deep-link list's target=now) through the root `/` — whose address follows the nav flags,
// so the bell does not spell it; it opened nothing before. Other agent notices
// (an agent joining) keep opening nothing — the rule is for the two limit notices only.
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));

const { getEntityHref } = await import('./notification-bell');

const base = { source_entity_type: 'agent', source_entity_id: 'agent-1', target_project_id: null, target_doc_slug: null } as const;

describe('bell link for the agent limit notices (story #4833)', () => {
  it('limit_paused and limit_lifted open the Today screen (the root, which sends a signed-in person there)', () => {
    expect(getEntityHref({ ...base, event_type: 'dispatched', payload: { event_type: 'agent.limit_paused' } })).toBe('/');
    expect(getEntityHref({ ...base, event_type: 'dispatched', payload: { event_type: 'agent.limit_lifted' } })).toBe('/');
    expect(getEntityHref({ ...base, event_type: 'agent.limit_paused', payload: null })).toBe('/');
  });

  it('negative control — another agent notice, and a limit notice with no entity, open nothing', () => {
    expect(getEntityHref({ ...base, event_type: 'dispatched', payload: { event_type: 'agent_joined' } })).toBeNull();
    expect(getEntityHref({ ...base, source_entity_id: null, event_type: 'dispatched', payload: { event_type: 'agent.limit_paused' } })).toBeNull();
  });
});
