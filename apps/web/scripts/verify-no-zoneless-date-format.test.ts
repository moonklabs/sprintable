// story #4443 PR2a — the zoneless-date ratchet: it checks itself (positive and negative controls), the repository matches its
// baseline, a new place fails, and a frozen place that is gone fails (the ratchet only goes down).
import { describe, expect, it } from 'vitest';
import { compareWithBaseline, findZonelessDates, loadBaseline, runSelfTest, scanRepository } from './verify-no-zoneless-date-format';

describe('verify:no-zoneless-date-format — story #4443 PR2a', () => {
  it('self-test: every old shape is caught and every allowed shape passes', () => {
    expect(runSelfTest()).toEqual([]);
  });

  it('the repository matches its baseline (no new place · no stale line)', () => {
    const { fresh, stale } = compareWithBaseline(scanRepository(), loadBaseline());
    expect(fresh.map((h) => h.key)).toEqual([]);
    expect(stale.map((b) => b.key)).toEqual([]);
  });

  it('a new zoneless date fails · a frozen line that is gone fails', () => {
    const hit = findZonelessDates("const t = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).format(d);", 'components/x.tsx');
    expect(compareWithBaseline(hit, []).fresh).toHaveLength(1);
    expect(compareWithBaseline([], [{ key: 'components/x.tsx::zoneless-intl::gone', reason: 'r' }]).stale).toHaveLength(1);
  });

  it('the same line twice in a file gets two keys (one fix takes one line out)', () => {
    const hits = findZonelessDates('const a = resolveDisplayTimezone().tz;\nconst a = resolveDisplayTimezone().tz;', 'components/y.tsx');
    expect(hits.map((h) => h.key)).toEqual(['components/y.tsx::no-arg-display-tz::const a = resolveDisplayTimezone().tz;', 'components/y.tsx::no-arg-display-tz::const a = resolveDisplayTimezone().tz;#2']);
  });
});
