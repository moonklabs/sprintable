import { describe, expect, it } from 'vitest';
import { previewTarget } from './doc-link-target';

// story 4892 — where `/docs?id=` sends the reader: the current project only when the answer's project id IS the current one; otherwise the
// document's own project slug; never a guess; nothing the server names goes into a path unchecked.
const cur = 'proj-cur';
const t = (d: Parameters<typeof previewTarget>[0], current: string | undefined = cur) => previewTarget(d, 'moonklabs', 'sprintable', current);

describe('previewTarget', () => {
  it('the current project (same project id) → the current slugs', () => {
    expect(t({ slug: 'prd', projectId: cur, orgSlug: 'moonklabs', projectSlug: 'sprintable' })).toBe('/moonklabs/sprintable/docs/prd');
    expect(t({ slug: 'prd', projectId: cur, orgSlug: null, projectSlug: null })).toBe('/moonklabs/sprintable/docs/prd');
  });
  it("another project → its OWN slug (the document's project, not the current one)", () => {
    expect(t({ slug: 'runbook', projectId: 'proj-x', orgSlug: 'moonklabs', projectSlug: 'other-proj' })).toBe('/moonklabs/other-proj/docs/runbook');
  });
  it('another project WITHOUT a slug → null (no guess, no 404 and no same-name document of the current project)', () => {
    expect(t({ slug: 'runbook', projectId: 'proj-x', orgSlug: 'moonklabs', projectSlug: null })).toBeNull();
    expect(t({ slug: 'runbook', projectId: null, orgSlug: 'moonklabs', projectSlug: null })).toBeNull();
    expect(t({ slug: 'runbook', projectId: 'proj-x', orgSlug: 'moonklabs', projectSlug: '' })).toBeNull();
  });
  it('the current project id is not known (layout without one) → only a named project slug works', () => {
    // (not through `t`: its default would turn an explicit undefined back into the current id)
    expect(previewTarget({ slug: 'a', projectId: cur, orgSlug: 'moonklabs', projectSlug: null }, 'moonklabs', 'sprintable', undefined)).toBeNull();
    expect(previewTarget({ slug: 'a', projectId: cur, orgSlug: 'moonklabs', projectSlug: 'named' }, 'moonklabs', 'sprintable', undefined)).toBe('/moonklabs/named/docs/a');
  });
  it("another project's answer that names a project slug but no org slug fails closed (the current workspace is not assumed for it)", () => {
    expect(t({ slug: 'd', projectId: 'proj-x', orgSlug: null, projectSlug: 'other-proj' })).toBeNull();
    expect(t({ slug: 'd', projectId: 'proj-x', orgSlug: '', projectSlug: 'other-proj' })).toBeNull();
  });
  it('the current workspace / project (route parameters) must look like slugs too, also for the current project', () => {
    for (const bad of ['a?b', 'a/b', '..', '//x', '']) {
      expect(previewTarget({ slug: 'd', projectId: cur }, bad, 'sprintable', cur), `ws ${bad}`).toBeNull();
      expect(previewTarget({ slug: 'd', projectId: cur }, 'moonklabs', bad, cur), `proj ${bad}`).toBeNull();
    }
  });
  it('org / project values that are not slugs are refused (path injection · open redirect shapes)', () => {
    for (const bad of ['../x', 'a/b', '//evil', 'a\\b', '.', '..', ' x', 'a b', 'a?b', 'a#b', '%2e%2e', '-lead']) {
      expect(t({ slug: 'd', projectId: 'p', orgSlug: bad, projectSlug: 'ok' }), `org ${bad}`).toBeNull();
      expect(t({ slug: 'd', projectId: 'p', orgSlug: 'moonklabs', projectSlug: bad }), `project ${bad}`).toBeNull();
    }
  });
  it('a document slug: Korean passes as the tree passes it · / ? # % are escaped · "." and ".." are refused · blank is refused', () => {
    expect(t({ slug: '측정용-문서-id-링크-2', projectId: cur })).toBe('/moonklabs/sprintable/docs/측정용-문서-id-링크-2');
    expect(t({ slug: 'a/b?c#d%e', projectId: cur })).toBe('/moonklabs/sprintable/docs/a%2Fb%3Fc%23d%25e');
    // a backslash is read as «/» by URL parsing (`..\\x` would climb out of the docs route) — it goes escaped too
    expect(t({ slug: '..\\flow', projectId: cur })).toBe('/moonklabs/sprintable/docs/..%5Cflow');
    expect(t({ slug: 'a\\b', projectId: cur })).toBe('/moonklabs/sprintable/docs/a%5Cb');
    for (const bad of ['.', '..', '', '   ', null, undefined]) expect(t({ slug: bad as never, projectId: cur }), String(bad)).toBeNull();
  });
  it('Korean org / project slugs are slugs', () => {
    expect(t({ slug: 'd', projectId: 'p', orgSlug: '문서팀', projectSlug: '프로젝트-1' })).toBe('/문서팀/프로젝트-1/docs/d');
  });
});
