// story #4226(PO 판단 23:19Z) — `?p=` 없이 flat 목적지로 가는 앱 내부 이동의 래칫. flat 목적지 = `app/(authenticated)` 아래 `[` 로 시작하지
// 않는 최상위 폴더(새 flat 라우트가 생기면 자동 포함). 셈법은 4226 전수와 같다: Link `href="/…"`·`href={`/…`}` · `router.push/replace('/…')` ·
// 객체 `href: '/…'` · nav 설정 `path: '/…'`. `useFlatHref()`(hooks/use-flat-href)로 감싼 자리는 리터럴이 아니라 세지 않는다.
// 이 수가 **늘면 RED**(새 bare flat 링크 금지). 줄였으면 BASELINE도 같이 낮출 것(래칫) — 후속 카드 #4231이 0까지 내린다.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const BASELINE = 120;

const SRC = path.resolve(__dirname, '..');
const AUTH = path.join(SRC, 'app/(authenticated)');

function flatRoutes(): string[] {
  return readdirSync(AUTH).filter((d) => !d.startsWith('[') && statSync(path.join(AUTH, d)).isDirectory()).sort();
}

function pattern(routes: string[]): RegExp {
  const alt = routes.map((r) => r.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')).join('|');
  return new RegExp(String.raw`(href=\{?[\`'"]|router\.(?:push|replace)\([\`'"]|href:\s*[\`'"]|path:\s*[\`'"])/(${alt})(?=[/?\`'"$])`, 'g');
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !name.includes('.test.') && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

function countBareFlatLinks(): { total: number; byFile: Record<string, number> } {
  const re = pattern(flatRoutes());
  const byFile: Record<string, number> = {};
  let total = 0;
  for (const file of sourceFiles(SRC)) {
    const n = readFileSync(file, 'utf8').match(re)?.length ?? 0;
    if (n) { byFile[path.relative(SRC, file)] = n; total += n; }
  }
  return { total, byFile };
}

describe('`?p=` 없는 flat 링크 래칫(story #4226 → #4231)', () => {
  it('양성대조 — 셈법이 네 모양을 모두 센다 · useFlatHref로 감싼 자리는 안 센다', () => {
    const re = pattern(flatRoutes());
    const sample = [
      `<Link href="/inbox?tab=gates">`,
      'router.push(`/chats/${id}`)',
      `const x = { href: '/organization/events' }`,
      `{ id: 'more', path: '/more' }`,
      "<Link href={flatHref('/inbox?tab=gates')}>",
      '<Link href={`/${ws}/${proj}/flow`}>',
    ].join('\n');
    expect(sample.match(re)?.length).toBe(4);
    expect(flatRoutes()).toEqual(expect.arrayContaining(['inbox', 'chats', 'more', 'organization']));
  });

  it(`⭐bare flat 링크 수 = 기준값 ${BASELINE}(늘면 RED · 줄였으면 BASELINE도 낮출 것)`, () => {
    const { total, byFile } = countBareFlatLinks();
    expect(
      total,
      `bare flat 링크 ${total}개(기준 ${BASELINE}). 늘었으면 새 링크를 useFlatHref()로 감쌀 것 · 줄었으면 BASELINE을 ${total}로 낮출 것.\n`
        + JSON.stringify(byFile, null, 1),
    ).toBe(BASELINE);
  });
});
