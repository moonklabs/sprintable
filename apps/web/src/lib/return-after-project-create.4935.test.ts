// story #4935 — the address a person returns to after making their first project from the home's «프로젝트 만들기». The `?next=` check itself (isSafeInternalNext) and its table are tested in lib/safe-internal-next.test.ts.
import { describe, expect, it } from 'vitest';
import { returnHrefAfterProjectCreate } from './return-after-project-create';

const ORIGIN = 'https://dev-app.sprintable.ai';

describe('returnHrefAfterProjectCreate — where the first project sends the person back to', () => {
  it('puts ?p=<new project> on the address they first pressed, and drops the proxy\'s retry mark', () => {
    expect(returnHrefAfterProjectCreate('/flow?_prRetry=1', 'P3', ORIGIN)).toBe('/flow?p=P3');
  });

  it('a next that already has a query keeps it and gets `p` by URL, not by string concatenation (no «?…?p=»)', () => {
    expect(returnHrefAfterProjectCreate('/goals?filter=a&_prRetry=1', 'P3', ORIGIN)).toBe('/goals?filter=a&p=P3');
    expect(returnHrefAfterProjectCreate('/docs?id=7', 'P3', ORIGIN)).toBe('/docs?id=7&p=P3');
  });

  it('an old `p` is replaced, not duplicated; a hash is kept', () => {
    expect(returnHrefAfterProjectCreate('/flow?p=OLD&story=9#x', 'P3', ORIGIN)).toBe('/flow?p=P3&story=9#x');
  });

  it('a bare path gets just `p`', () => {
    expect(returnHrefAfterProjectCreate('/flow', 'P3', ORIGIN)).toBe('/flow?p=P3');
  });

  it('⭐refuses what the one check refuses — nothing to go back to (null)', () => {
    for (const v of ['//evil.com', 'https://evil.com', '/\\evil.com', '%2F%2Fevil.com', 'javascript:alert(1)', '/\t/evil.com', '', null, undefined]) {
      expect(returnHrefAfterProjectCreate(v, 'P3', ORIGIN), String(v)).toBeNull();
    }
  });

  it('the answer is always an in-app path (starts with a single «/»)', () => {
    const r = returnHrefAfterProjectCreate('/flow?x=1', 'P3', ORIGIN)!;
    expect(r.startsWith('/') && !r.startsWith('//')).toBe(true);
  });
});
