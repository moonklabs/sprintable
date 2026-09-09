import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_ROUTER_EXPORT_WHITELIST, ROUTE_FILE_BASENAME_RE, scanFileContent, scanRepo } from './verify-route-file-exports';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/app');

describe('ROUTE_FILE_BASENAME_RE — story #3760 AC1', () => {
  it('page/layout/template/loading/error/not-found/default.tsx 전부 매치한다', () => {
    for (const name of ['page.tsx', 'layout.tsx', 'template.tsx', 'loading.tsx', 'error.tsx', 'not-found.tsx', 'default.tsx']) {
      expect(ROUTE_FILE_BASENAME_RE.test(name)).toBe(true);
    }
  });

  // route.ts는 HTTP 메서드 named export가 정상 계약이라 이 가드의 대상 밖이어야 한다.
  it('route.ts는 매치하지 않는다(스캔 대상 밖 — HTTP 메서드 export가 정상)', () => {
    expect(ROUTE_FILE_BASENAME_RE.test('route.ts')).toBe(false);
  });

  it('무관 파일명은 매치하지 않는다', () => {
    expect(ROUTE_FILE_BASENAME_RE.test('component.tsx')).toBe(false);
    expect(ROUTE_FILE_BASENAME_RE.test('page.test.tsx')).toBe(false);
  });
});

describe('scanFileContent — story #3760 AC1/AC2(셀프테스트)', () => {
  // 양성대조(AC2) — 화이트리스트 밖 named export(#4105 실사고 재현: publishHistorySenderLabel류
  // 헬퍼)는 반드시 RED여야 한다.
  it('⭐화이트리스트 밖 named export function → RED(#4105 실사고 재현)', () => {
    const src = `
      export default function Page() { return null; }
      export function helper() { return 1; }
    `;
    const violations = scanFileContent(src, 'fake/page.tsx');
    expect(violations).toEqual([{ file: 'fake/page.tsx', line: 3, name: 'helper' }]);
  });

  it('⭐화이트리스트 밖 named export const → RED', () => {
    const src = `
      export default function Page() { return null; }
      export const notAllowed = 42;
    `;
    const violations = scanFileContent(src, 'fake/page.tsx');
    expect(violations).toEqual([{ file: 'fake/page.tsx', line: 3, name: 'notAllowed' }]);
  });

  // 음성대조(AC2) — Next.js 화이트리스트 4종(metadata·revalidate·viewport·generateMetadata)은
  // 전부 GREEN이어야 한다(지금 develop의 실제 9건과 동형).
  it('metadata/revalidate/viewport/generateMetadata → 전부 GREEN(위반 0)', () => {
    const src = `
      export const metadata = { title: 'x' };
      export const revalidate = 300;
      export const viewport = { width: 'device-width' };
      export async function generateMetadata() { return {}; }
      export default function Page() { return null; }
    `;
    expect(scanFileContent(src, 'fake/page.tsx')).toEqual([]);
  });

  it('나머지 화이트리스트(dynamic·dynamicParams·fetchCache·runtime·preferredRegion·maxDuration·generateStaticParams·experimental_ppr·generateViewport) 전부 GREEN', () => {
    const src = `
      export const dynamic = 'force-static';
      export const dynamicParams = true;
      export const fetchCache = 'auto';
      export const runtime = 'nodejs';
      export const preferredRegion = 'auto';
      export const maxDuration = 5;
      export async function generateStaticParams() { return []; }
      export const experimental_ppr = true;
      export function generateViewport() { return {}; }
    `;
    expect(scanFileContent(src, 'fake/page.tsx')).toEqual([]);
  });

  // 재수출 형(AC2) — `export { x }`가 화이트리스트 밖 이름이면 RED, 안이면 GREEN. 재명명
  // (`export { y as metadata }`)은 "밖에서 보이는 이름"(metadata) 기준으로 판정한다.
  it('⭐export { x } 재수출 — 화이트리스트 밖이면 RED', () => {
    const src = `
      const helper = () => 1;
      export { helper };
      export default function Page() { return null; }
    `;
    const violations = scanFileContent(src, 'fake/page.tsx');
    expect(violations).toEqual([{ file: 'fake/page.tsx', line: 3, name: 'helper' }]);
  });

  it('export { x as metadata } 재명명 — 밖에서 보이는 이름이 화이트리스트면 GREEN', () => {
    const src = `
      const meta = { title: 'x' };
      export { meta as metadata };
      export default function Page() { return null; }
    `;
    expect(scanFileContent(src, 'fake/page.tsx')).toEqual([]);
  });

  // export * from(AC2) — 타깃을 resolve 안 하므로 뭐가 나가는지 모른다. fail-closed RED.
  it('⭐export * from — 재수출 대상을 모르므로 fail-closed RED', () => {
    const src = `
      export * from './helpers';
      export default function Page() { return null; }
    `;
    const violations = scanFileContent(src, 'fake/page.tsx');
    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toBe('fake/page.tsx');
  });

  it('export default function/class/화살표(ExportAssignment) 전부 "default" 이름으로 화이트리스트 통과', () => {
    expect(scanFileContent('export default function Page() { return null; }', 'a.tsx')).toEqual([]);
    expect(scanFileContent('export default class Page {}', 'b.tsx')).toEqual([]);
    expect(scanFileContent('const Page = () => null;\nexport default Page;', 'c.tsx')).toEqual([]);
  });

  // 주석 속 가짜 export — AST가 주석을 노드로 안 보므로 오탐 0(구조적, 별도 필터 불요).
  it('⭐주석 안의 export는 안 잡힌다(오탐 0 — AST가 comment를 trivia로 자연 배제)', () => {
    const src = `
      // export function fakeCommentExport() {}
      /* export const alsoFake = 1; */
      export default function Page() { return null; }
    `;
    expect(scanFileContent(src, 'fake/page.tsx')).toEqual([]);
  });

  it('파싱 실패(문법 오류)면 조용히 통과하지 않고 throw한다(story #2710 AC4 동형)', () => {
    expect(() => scanFileContent('export function {{{ broken', 'broken.tsx')).toThrow(/파싱 실패/);
  });
});

describe('scanRepo — story #3760 AC1/AC4(실 트리 실행)', () => {
  // AC4 — 지금 develop 위반 0건(PO 실측 2026-09-09 23:37Z: 파일 100·named export 9·전부
  // 화이트리스트) pin. 되돌리면(화이트리스트 밖 export가 실 트리에 들어오면) RED.
  it('실 트리(apps/web/src/app) — 라우트 파일 100개·위반 0건', () => {
    const { violations, fileCount } = scanRepo(APP_ROOT);
    expect(fileCount).toBe(100);
    expect(violations).toEqual([]);
  });
});

describe('APP_ROUTER_EXPORT_WHITELIST — story #3760 AC1', () => {
  it('카드 본문이 명시한 14개와 정확히 일치한다(수 자체가 회귀가드 — 조용히 늘거나 줄면 걸림)', () => {
    expect([...APP_ROUTER_EXPORT_WHITELIST].sort()).toEqual([
      'default',
      'dynamic',
      'dynamicParams',
      'experimental_ppr',
      'fetchCache',
      'generateMetadata',
      'generateStaticParams',
      'generateViewport',
      'maxDuration',
      'metadata',
      'preferredRegion',
      'revalidate',
      'runtime',
      'viewport',
    ]);
  });
});
