/**
 * story #2681(모바일 IA S1) 회귀가드 — nav-config.ts(src/lib/nav-config.ts)가 데스크톱
 * GNB+모바일 /more(S2)의 유일한 목적지 출처가 됐다. 그 데이터가 실제 라우트와 정합하지
 * 않으면(오타·삭제된 페이지·아직 안 만든 페이지) 죽은 링크가 두 서피스 모두에 동시에 퍼진다
 * — SSOT화의 장점(drift 차단)이 단점(오류도 함께 전파)이 되지 않게 이 가드가 막는다.
 *
 * 'static' 항목은 route group(`(authenticated)` 등)을 무시하고 실제 `page.tsx`가 있는지,
 * 'resource' 항목은 `(authenticated)/[ws]/[proj]/{resource}/page.tsx`가 있는지 검사한다.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { NAV_GROUPS, type NavGroupConfig } from '../src/lib/nav-config';

const APP_DIR = path.join(__dirname, '..', 'src', 'app');
// 정적 항목이 살 수 있는 route group 후보 — '' = group 없는 app 바로 아래(예: /dashboard).
const STATIC_ROUTE_ROOTS = ['(authenticated)', ''];

export interface RouteChecker {
  staticExists: (urlPath: string) => boolean;
  resourceExists: (resource: string) => boolean;
}

function staticPathExists(urlPath: string): boolean {
  const segments = urlPath.replace(/^\//, '').split('/');
  return STATIC_ROUTE_ROOTS.some((root) => {
    const dir = root ? path.join(APP_DIR, root, ...segments) : path.join(APP_DIR, ...segments);
    return existsSync(path.join(dir, 'page.tsx'));
  });
}

function resourcePathExists(resource: string): boolean {
  return existsSync(path.join(APP_DIR, '(authenticated)', '[ws]', '[proj]', resource, 'page.tsx'));
}

export const fsRouteChecker: RouteChecker = {
  staticExists: staticPathExists,
  resourceExists: resourcePathExists,
};

export interface BrokenNavEntry {
  groupId: string;
  itemId: string;
  kind: string;
  path: string;
}

export function findBrokenNavEntries(groups: NavGroupConfig[], checker: RouteChecker): BrokenNavEntry[] {
  const broken: BrokenNavEntry[] = [];
  for (const group of groups) {
    for (const item of group.items) {
      const ok = item.kind === 'static' ? checker.staticExists(item.path) : checker.resourceExists(item.path);
      if (!ok) broken.push({ groupId: group.id, itemId: item.id, kind: item.kind, path: item.path });
    }
  }
  return broken;
}

if (require.main === module) {
  const broken = findBrokenNavEntries(NAV_GROUPS, fsRouteChecker);
  if (broken.length > 0) {
    console.error(`FAIL: nav-config ${broken.length}건이 실제 라우트와 정합 안 됨:`);
    for (const b of broken) console.error(`  - [${b.kind}] ${b.groupId}/${b.itemId} → ${b.path}`);
    process.exit(1);
  }
  console.log(`OK: nav-config 전 ${NAV_GROUPS.flatMap((g) => g.items).length}항목이 실제 라우트와 정합.`);
}
