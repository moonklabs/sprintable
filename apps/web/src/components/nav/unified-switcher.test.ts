import { describe, expect, it } from 'vitest';
import { withSwitchedSlugs } from './unified-switcher';

describe('withSwitchedSlugs (story #2039 AC4)', () => {
  it('replaces both org and project slug segments, preserving the rest of the path (current screen)', () => {
    expect(withSwitchedSlugs('/moonklabs/sprintable-content/docs', 'moonklabs', 'moonklabs', 'jangsawang'))
      .toBe('/moonklabs/jangsawang/docs');
  });

  it('preserves deep sub-paths (e.g. a specific doc slug) after switching project', () => {
    expect(withSwitchedSlugs('/moonklabs/sprintable-content/docs/my-doc', 'moonklabs', 'moonklabs', 'jangsawang'))
      .toBe('/moonklabs/jangsawang/docs/my-doc');
  });

  it('swaps the org segment too when switching org+project together', () => {
    expect(withSwitchedSlugs('/moonklabs/sprintable-content/board', 'moonklabs', 'other-org', 'other-project'))
      .toBe('/other-org/other-project/board');
  });

  it('returns null for paths that are not project-scoped (e.g. global routes), leaving the caller to fall back to the unmodified pathname', () => {
    expect(withSwitchedSlugs('/glance', 'moonklabs', 'moonklabs', 'jangsawang')).toBeNull();
    expect(withSwitchedSlugs('/inbox', 'moonklabs', 'moonklabs', 'jangsawang')).toBeNull();
  });

  it('returns null when the current org slug is unknown (avoids constructing a bogus path)', () => {
    expect(withSwitchedSlugs('/moonklabs/sprintable-content/docs', undefined, 'moonklabs', 'jangsawang')).toBeNull();
  });

  it("returns null when the path's first segment doesn't match the current org slug (stale/unexpected state)", () => {
    expect(withSwitchedSlugs('/some-other-org/proj/docs', 'moonklabs', 'moonklabs', 'jangsawang')).toBeNull();
  });
});
