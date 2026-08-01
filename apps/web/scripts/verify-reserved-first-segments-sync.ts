/**
 * story #2393 AC3 — `src/lib/route-resolve.ts`의 `RESERVED_FIRST_SEGMENTS`는 두 축으로
 * 나뉜다: ①레거시 리소스명(`legacy-resource-tables.ts`에서 파생, 스냅샷 아님) ②라이브
 * top-level 페이지 라우트 + Next.js 메타데이터 파일 라우트(손 스냅샷, 의도적).
 *
 * ②를 `readdirSync`로 자동파생하지 않는 이유 — `route-resolve.ts`는 `proxy.ts`(Next.js
 * 미들웨어)에 import돼 **edge 런타임 번들에 들어간다**. edge 런타임은 `node:fs`를 지원하지
 * 않아, 그 파일 모듈 최상단에 `readdirSync`를 넣으면 빌드/배포가 깨질 위험을 진다 — 실 요청
 * 라우팅을 다루는 자리에서 그 위험을 질 이유가 없다(PO 판단: "틀리면 사용자 요청이 다른
 * 데로 간다"). 그래서 ②는 손 스냅샷으로 «남기고», 이 스크립트(순수 Node.js 프로세스로
 * 돌아 `fs`가 안전한 CI 전용 자리)가 그 스냅샷과 실제 `app/` 구조의 어긋남을 매 빌드마다
 * 잡는다 — "남겨 둔다"로 끝내지 않는다(AC3).
 *
 * AC1 실측(2026-08-01) — 이 가드를 짜기 전 스냅샷이 이미 6곳 어긋나 있었다: `gates`·`more`
 * (라이브 디렉터리인데 목록에 없었음) · `apple-icon.png`·`manifest.webmanifest`(Next.js
 * 메타데이터 파일 라우트, 목록에 없었음 — `manifest.ts`가 소스인데 서빙 경로는 다른 이름).
 * `flow`·`goals`는 레거시 리소스명 축(①) 미적용으로 인한 어긋남이었다(이번 판에서 ①을
 * 파생으로 바꿔 해결). 지금은 `route-resolve.ts`에 6개 다 반영해 0건이다.
 */
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MIGRATED_RESOURCES, RENAMED_RESOURCES, RETIRED_RESOURCES } from '../src/lib/legacy-resource-tables';
import { RESERVED_FIRST_SEGMENTS } from '../src/lib/route-resolve';

// story #2387/#2393 관례 — 스크립트 자기 위치(import.meta.url) 기준으로 SRC_ROOT를 잡는다.
// process.cwd() 기준으로 잡으면 `pnpm --filter web`(cwd=apps/web)과 monorepo 루트에서 도는
// `pnpm vitest run`(CI) 사이에서 어긋난다(#2387이 실 CI에서 겪은 함정, PR #2774).
const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const APP_ROOT = path.resolve(SRC_ROOT, 'app');
const AUTHENTICATED_ROOT = path.resolve(APP_ROOT, '(authenticated)');

function listTopLevelDirs(dir: string): string[] {
  return readdirSync(dir).filter((entry) => statSync(path.join(dir, entry)).isDirectory());
}

function listTopLevelFiles(dir: string): string[] {
  return readdirSync(dir).filter((entry) => statSync(path.join(dir, entry)).isFile());
}

// Next.js 메타데이터 파일 컨벤션 — 소스 파일명이 실제 서빙 경로와 다를 수 있다(2026-08-01
// `pnpm build` 라우트 표 실측 대조: `manifest.ts` → `/manifest.webmanifest`). 이 매핑은
// Next.js 자체 컨벤션 표라 여기서 손으로 유지한다(컨벤션이 늘면 이 표에도 추가해야 한다 —
// AC5 blind spot으로 파일 하단 주석에 선언).
export const METADATA_FILE_ROUTES: Record<string, string> = {
  'favicon.ico': 'favicon.ico',
  'icon.svg': 'icon.svg',
  'apple-icon.png': 'apple-icon.png',
  'manifest.ts': 'manifest.webmanifest',
};

export interface SyncCheckResult {
  liveDirs: string[];
  liveMetadataRoutes: string[];
  derivedLegacyNames: string[];
  missing: string[];
}

export function checkReservedFirstSegmentsSync(): SyncCheckResult {
  const liveDirs = [
    ...listTopLevelDirs(APP_ROOT).filter((d) => d !== '(authenticated)'),
    ...listTopLevelDirs(AUTHENTICATED_ROOT).filter((d) => d !== '[ws]'),
  ];

  const appRootFiles = listTopLevelFiles(APP_ROOT);
  const liveMetadataRoutes = appRootFiles
    .filter((f) => f in METADATA_FILE_ROUTES)
    .map((f) => METADATA_FILE_ROUTES[f]!);

  const derivedLegacyNames = new Set<string>([
    ...Object.keys(MIGRATED_RESOURCES),
    ...Object.keys(RENAMED_RESOURCES),
    ...Object.keys(RETIRED_RESOURCES),
  ]);

  const missing: string[] = [];
  for (const dir of liveDirs) {
    if (derivedLegacyNames.has(dir)) continue; // 파생 축(①)이 이미 덮는다
    if (!RESERVED_FIRST_SEGMENTS.has(dir)) missing.push(`routeWithoutReservation:${dir}`);
  }
  for (const route of liveMetadataRoutes) {
    if (!RESERVED_FIRST_SEGMENTS.has(route)) missing.push(`metadataRouteWithoutReservation:${route}`);
  }

  return { liveDirs, liveMetadataRoutes, derivedLegacyNames: [...derivedLegacyNames], missing };
}

function main(): void {
  const { liveDirs, liveMetadataRoutes, derivedLegacyNames, missing } = checkReservedFirstSegmentsSync();

  if (missing.length > 0) {
    console.error(`❌ RESERVED_FIRST_SEGMENTS가 실 app/ 구조와 어긋났습니다(${missing.length}건):`);
    missing.forEach((m) => console.error(`  - ${m}`));
    console.error(
      '\nsrc/lib/route-resolve.ts의 RESERVED_FIRST_SEGMENTS(② 손 스냅샷 부분)에 위 항목을 추가하세요 — ' +
        '이 항목이 예약되지 않으면 워크스페이스 slug로 오인될 수 있습니다(사용자 요청이 다른 데로 감).',
    );
    process.exit(1);
  }

  console.log(
    `OK: RESERVED_FIRST_SEGMENTS 어긋남 0건 ` +
      `(라이브 디렉터리 ${liveDirs.length}개 + 메타데이터 라우트 ${liveMetadataRoutes.length}개 ` +
      `전부 예약됨, 레거시 리소스명 ${derivedLegacyNames.length}개는 파생 축)`,
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

// AC5 — 이 가드가 못 잡는 것: `METADATA_FILE_ROUTES`에 없는 새 Next.js 메타데이터 컨벤션
// (예: robots.ts, sitemap.ts, opengraph-image.tsx, twitter-image.tsx)이 app root에 추가되면
// 이 스크립트는 그 파일의 실제 서빙 경로를 모른 채 조용히 통과한다 — 그 컨벤션을 쓰기 시작할
// 때 위 매핑에 손으로 추가해야 한다(Next.js 자체 문서가 SSOT, 이 스크립트가 추론하지 않는다).
