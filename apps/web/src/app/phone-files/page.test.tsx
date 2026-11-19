// story 4983 (P5): the page hands on `setup_id` + `agent_id` ONLY when both are well-formed ids — nothing else from the address ever reaches the screen.
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/components/desktop/phone-files-page', () => ({ PhoneFilesPage: () => null }));
const { default: Route } = await import('./page');

const S = '11111111-2222-4333-8444-555555555555';
const A = '22222222-3333-4444-8555-666666666666';
const entryOf = async (q: Record<string, string | string[] | undefined>) => ((await Route({ searchParams: Promise.resolve(q) })) as { props: { entry?: unknown; homeHref: string } }).props;

describe('/phone-files address', () => {
  it('both ids well formed → the entry', async () => {
    expect((await entryOf({ setup_id: S, agent_id: A })).entry).toEqual({ setupId: S, agentId: A });
  });
  it('anything else → no entry (a missing one · a malformed one · a list · a path)', async () => {
    for (const q of [{}, { setup_id: S }, { agent_id: A }, { setup_id: 'x', agent_id: A }, { setup_id: S, agent_id: '../etc' }, { setup_id: [S, S], agent_id: A }, { setup_id: S, agent_id: `${A}/x` }]) {
      expect((await entryOf(q as Record<string, string | string[]>)).entry, JSON.stringify(q)).toBeUndefined();
    }
  });
  it('the way home is always the server\'s own', async () => {
    expect(typeof (await entryOf({})).homeHref).toBe('string');
  });
});
