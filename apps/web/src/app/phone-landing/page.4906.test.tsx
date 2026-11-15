// story 4906 (F) — the phone landing's «nothing to open instead» is the person's HOME: the proxy hands the site root over as `next` and this page turns it into the nav flags' «오늘» address
// directly (the root only redirects there — one hop less on every app opening). Any other `next` is passed through as before (the component checks it).
import { describe, expect, it, vi } from 'vitest';

const flags = vi.hoisted(() => ({ value: { todayV3Enabled: false, chatV3Enabled: false, connectRulesV3Enabled: false } }));
vi.mock('@/lib/nav-v3-flags-server', () => ({ readNavV3FlagsFromEnv: () => flags.value }));
vi.mock('@/components/desktop/phone-landing', () => ({ PhoneLanding: () => null }));

const { default: PhoneLandingPage } = await import('./page');

const props = async (next: string | string[] | undefined) => {
  const el = await PhoneLandingPage({ searchParams: Promise.resolve({ next }) });
  return (el as unknown as { props: { next: string | null; chatsHref: string } }).props;
};

describe('PhoneLandingPage (story 4906 F)', () => {
  it('next = the site root → the «오늘» address (flags off: /org-briefing · flags on: /today) — not the root, not a project board', async () => {
    flags.value = { todayV3Enabled: false, chatV3Enabled: false, connectRulesV3Enabled: false };
    expect((await props('/')).next).toBe('/org-briefing');
    flags.value = { todayV3Enabled: true, chatV3Enabled: false, connectRulesV3Enabled: false };
    expect((await props('/')).next).toBe('/today');
  });

  it('any other next is passed through untouched; a missing or repeated next is null (the component then goes to the root itself)', async () => {
    flags.value = { todayV3Enabled: false, chatV3Enabled: false, connectRulesV3Enabled: false };
    expect((await props('/moonklabs/sprintable/flow')).next).toBe('/moonklabs/sprintable/flow');
    expect((await props(undefined)).next).toBeNull();
    expect((await props(['/', '/x'])).next).toBeNull();
  });
});
