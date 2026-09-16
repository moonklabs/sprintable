/**
 * story #3948 — 「NEXT_PUBLIC_* 소비처는 있는데 빌드 스테이지까지 안 옴」 클래스 봉쇄
 * (선례 3회: EE_ENABLED #2728 · TOSS_CLIENT_KEY #2758 · APP_URL #3947).
 *
 * Next.js는 `NEXT_PUBLIC_*`를 «빌드 시점»에 client 번들로 리터럴 인라인한다(실측:
 * #3947에서 `NEXT_PUBLIC_APP_URL=<marker>`로 `pnpm build` 뒤 `.next/static/chunks/`를
 * grep해 `"<marker>".trim()`으로 정확히 박혀 있는 것 확認). Cloud Run 런타임
 * `--update-env-vars`/cloudbuild substitution은 그 시점엔 이미 굳은 값에 닿지 않는다.
 * 그러므로 불변식은: 「소스가 참조하는 NEXT_PUBLIC 키 집합」 ⊆ 「Dockerfile ARG/ENV
 * 집합」 ⊆ 「cloudbuild.yaml build-frontend 스텝의 --build-arg 집합」— 이 스크립트가
 * 그 셋을 대조한다.
 *
 * ⭐이 가드가 «못 잡는 것» — 선언 안 하면 다음 사람이 "이게 다 본다"로 읽는다.
 *   ㉠Route Handler(`app/**\/route.ts`)·Middleware(`proxy.ts`)만 참조하는 키 — Next.js
 *     App Router 계약상 이 둘은 항상 서버/엣지 전용이라 클라 번들에 안 들어간다(구조적
 *     사실, import 그래프 추적 불요) — 스캔 대상에서 원천 제외.
 *   ㉡동적 조합(`process.env[변수]`) — 정적으로 키 이름을 못 뽑는다. 그런 자리가 있으면
 *     "해석 불가" 목록으로 별도 출력만 하고(목표 0), RED 판정에는 안 넣는다.
 *   ㉢`ee/` 오버레이가 실제 Docker 빌드에서 `apps/web/src`와 어떻게 병합되는지(심볼릭
 *     링크·별도 빌드 변형)는 이 스크립트의 관심사가 아니다 — 소스에 리터럴로 적힌 참조만
 *     본다(그 파일이 이 특정 빌드에 실제로 편입되는지는 별개 축).
 *   ㉣import 그래프 상 "그 키를 참조하는 파일이 실제로 client 컴포넌트에서 도달 가능한가"는
 *     안 짼다(㉠의 구조적 제외만 함) — 서버 전용 lib 파일이 route.ts에서만 쓰여도, 그
 *     파일 자체가 스캔 대상이면 걸린다. 그런 자리는 EXCLUDED_KEYS에 사유와 함께 명시
 *     등재한다(카운트-핀, grandfather 목표 0).
 *
 * 쓰기: tsx apps/web/scripts/verify-next-public-build-arg-wiring.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APPS_WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(APPS_WEB, '../..');
const DOCKERFILE = path.join(APPS_WEB, 'Dockerfile');
const CLOUDBUILD = path.join(REPO_ROOT, 'cloudbuild.yaml');

/** 스캔 루트(story #3948 AC0 지정 — "web 번들에 들어가는 경로"). */
const SCAN_ROOTS = [
  path.join(APPS_WEB, 'src'),
  path.join(APPS_WEB, 'next.config.ts'),
  path.join(REPO_ROOT, 'packages'),
  path.join(REPO_ROOT, 'ee'),
];

const EXT_RE = /\.(tsx?|mts|jsx?)$/;
const TEST_RE = /\.(test|spec)\.[tj]sx?$/;
/** AC㉠ — Route Handler·Middleware는 Next.js 계약상 항상 서버/엣지 전용. */
const ROUTE_HANDLER_RE = /[\\/]route\.tsx?$/;
const MIDDLEWARE_RE = /(^|[\\/])(proxy|middleware)\.tsx?$/;
const SKIP_DIRS = new Set(['node_modules', '.next', 'e2e', 'dist', '.turbo', '.git']);

const STATIC_KEY_RE = /process\.env(?:\.(NEXT_PUBLIC_[A-Z0-9_]+)|\[['"](NEXT_PUBLIC_[A-Z0-9_]+)['"]\])/g;
/** AC㉡ — 동적 조합(변수·템플릿 리터럴 등)이라 정적으로 키를 못 뽑는 자리. */
const DYNAMIC_ACCESS_RE = /process\.env\[(?!['"])[^\]]+\]/g;

export interface KeyRef {
  key: string;
  file: string; // repo-relative
  line: number;
}

/**
 * story #3948 AC0 그라운딩(HEAD 재측, 2026-09-16) — 구조적으로 서버/엣지 전용 도달만
 * 확인된 키. 각 항목은 실제 importer 추적으로 검증했다(그라운딩 없이 등재 금지).
 */
export const EXCLUDED_KEYS: Record<string, string> = {
  NEXT_PUBLIC_COOKIE_DOMAIN:
    '서버 전용 도달 확認 — 유일한 참조처 apps/web/src/lib/auth/cookies.ts는 ' +
    'proxy.ts(Middleware)·app/api/**/route.ts(Route Handler)에서만 import됨(grep 전수, ' +
    'page/component importer 0). ee/apps/web/src/proxy.ts도 동형(Middleware).',
  NEXT_PUBLIC_POLAR_PRODUCT_PRO_MONTHLY:
    '서버 전용 도달 확認 — 유일한 참조처 ee/apps/web/src/lib/polar-products.ts의 유일한 ' +
    'importer는 ee/apps/web/src/app/api/webhooks/polar/route.ts(Route Handler) 하나뿐(grep 전수).',
  NEXT_PUBLIC_POLAR_PRODUCT_PRO_YEARLY: '위와 동일 파일·동일 근거(polar-products.ts).',
  NEXT_PUBLIC_POLAR_PRODUCT_TEAM_MONTHLY: '위와 동일 파일·동일 근거(polar-products.ts).',
  NEXT_PUBLIC_POLAR_PRODUCT_TEAM_YEARLY: '위와 동일 파일·동일 근거(polar-products.ts).',
  NEXT_PUBLIC_SUPABASE_URL:
    '데드코드 확認 — 유일한 참조처 packages/db/src/client.ts(supabaseClient 스텁, ' +
    '"실제 구현은 @supabase/supabase-js 연동 시 교체" 주석)를 index.ts가 re-export하지만, ' +
    '@sprintable/db 패키지 자체를 apps/web·ee·다른 packages/* 어디서도 import하지 않음' +
    '(레포 전수 grep 0건 — package.json 의존 선언도 자기 자신뿐). 삭제는 이 카드 스코프 밖.',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: '위와 동일 파일·동일 근거(packages/db/src/client.ts, 데드코드).',
  // story #3948 발견(신규, 이 카드 스코프 밖) — firebase-client.ts('use client')가
  // apps/web/src/app/login/page.tsx·reset-password/page.tsx에서 실제 import돼 client
  // 도달이 실측 확認됨(cookies.ts/polar-products.ts류의 "서버 전용" 사유가 성립 안 함).
  // 다만 배포 파이프라인(cloudbuild.yaml·GHA) 어디에도 NEXT_PUBLIC_FIREBASE_* 실 시크릿
  // 자체가 없다(_FIREBASE_OAUTH_HANDOFF_ENABLED만 존재, 별개 BE-side 플래그) — 임의로
  // 값을 지어내거나 조용히 안전기본값을 넣는 대신 PO 판정 요청(신규 시크릿 프로비저닝 vs
  // 기능 자체 제거)까지 임시 등재. 판정 나면 이 5줄은 지우거나(배선) 사유를 "의도적
  // 기능 보류"로 확定한다(같은 5줄 유지는 무한 연장 금지 — 다음 스프린트 재검토).
  NEXT_PUBLIC_FIREBASE_API_KEY: 'PO 판정 대기(story #3948 발견) — client 도달 확認, 실 시크릿 파이프라인 부재.',
  NEXT_PUBLIC_FIREBASE_APP_ID: 'PO 판정 대기(story #3948 발견) — 위와 동일 사유.',
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: 'PO 판정 대기(story #3948 발견) — 위와 동일 사유.',
  NEXT_PUBLIC_FIREBASE_AUTH_ENABLED: 'PO 판정 대기(story #3948 발견) — 위와 동일 사유.',
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'PO 판정 대기(story #3948 발견) — 위와 동일 사유(db/server.ts의 서버측 참조도 겸함).',
};

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // ee/가 없는 체크아웃 등 — 조용히 스킵(존재하면 스캔, 없으면 대상 0)
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function listScanFiles(): string[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    if (!statSync(root, { throwIfNoEntry: false })) continue;
    if (statSync(root).isFile()) {
      files.push(root);
      continue;
    }
    walk(root, files);
  }
  return files.filter((f) => EXT_RE.test(f) && !TEST_RE.test(f) && !ROUTE_HANDLER_RE.test(f) && !MIDDLEWARE_RE.test(f));
}

export function extractSourceKeys(files: string[] = listScanFiles()): { refs: KeyRef[]; dynamicSites: { file: string; line: number }[] } {
  const refs: KeyRef[] = [];
  const dynamicSites: { file: string; line: number }[] = [];
  for (const full of files) {
    const rel = path.relative(REPO_ROOT, full);
    const source = readFileSync(full, 'utf8');
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      for (const m of line.matchAll(STATIC_KEY_RE)) {
        refs.push({ key: (m[1] ?? m[2])!, file: rel, line: i + 1 });
      }
      for (const _m of line.matchAll(DYNAMIC_ACCESS_RE)) {
        dynamicSites.push({ file: rel, line: i + 1 });
      }
    }
  }
  return { refs, dynamicSites };
}

export function extractDockerfileArgs(dockerfilePath = DOCKERFILE): Set<string> {
  const keys = new Set<string>();
  const re = /^ARG\s+(NEXT_PUBLIC_[A-Z0-9_]+)/;
  for (const raw of readFileSync(dockerfilePath, 'utf8').split('\n')) {
    const m = re.exec(raw.trim());
    if (m) keys.add(m[1]!);
  }
  return keys;
}

/**
 * cloudbuild.yaml의 `build-frontend` 스텝(dev·prod 공유 — 값은 substitution으로만
 * 갈리고 --build-arg 목록 자체는 하나) 안 `--build-arg` 다음 줄의 `KEY=...` 만 뽑는다.
 */
export function extractCloudbuildFrontendBuildArgs(cloudbuildPath = CLOUDBUILD, stepId = 'build-frontend'): Set<string> {
  const keys = new Set<string>();
  const lines = readFileSync(cloudbuildPath, 'utf8').split('\n');
  let inStep = false;
  let stepIndent = -1;
  let prevWasBuildArgFlag = false;
  for (const raw of lines) {
    const trimmed = raw.trim();
    const idMatch = /^-\s+id:\s*(\S+)/.exec(trimmed);
    if (idMatch) {
      const indent = raw.length - raw.trimStart().length;
      if (inStep && indent <= stepIndent) inStep = false; // 다음 스텝 진입 — 이전 스텝 종료
      if (idMatch[1] === stepId) {
        inStep = true;
        stepIndent = indent;
      }
      continue;
    }
    if (!inStep) continue;
    if (prevWasBuildArgFlag) {
      const kv = /^-\s+(NEXT_PUBLIC_[A-Z0-9_]+)=/.exec(trimmed);
      if (kv) keys.add(kv[1]!);
      prevWasBuildArgFlag = false;
      continue;
    }
    if (/^-\s+--build-arg\s*$/.test(trimmed)) prevWasBuildArgFlag = true;
  }
  return keys;
}

export interface WiringResult {
  missing: { key: string; refs: KeyRef[]; missingFrom: ('dockerfile' | 'cloudbuild')[] }[];
  excludedButNowWired: string[]; // EXCLUDED_KEYS인데 실은 이미 배선됨 — 목록 정리 대상(정보성)
  dynamicSites: { file: string; line: number }[];
  sourceKeyCount: number;
  scannedFileCount: number;
}

export function checkWiring(): WiringResult {
  const files = listScanFiles();
  const { refs, dynamicSites } = extractSourceKeys(files);
  const dockerfileArgs = extractDockerfileArgs();
  const cloudbuildArgs = extractCloudbuildFrontendBuildArgs();

  const byKey = new Map<string, KeyRef[]>();
  for (const r of refs) {
    if (!byKey.has(r.key)) byKey.set(r.key, []);
    byKey.get(r.key)!.push(r);
  }

  const missing: WiringResult['missing'] = [];
  const excludedButNowWired: string[] = [];
  for (const [key, keyRefs] of byKey) {
    const inDocker = dockerfileArgs.has(key);
    const inCloudbuild = cloudbuildArgs.has(key);
    if (key in EXCLUDED_KEYS) {
      if (inDocker && inCloudbuild) excludedButNowWired.push(key);
      continue;
    }
    if (!inDocker || !inCloudbuild) {
      const missingFrom: ('dockerfile' | 'cloudbuild')[] = [];
      if (!inDocker) missingFrom.push('dockerfile');
      if (!inCloudbuild) missingFrom.push('cloudbuild');
      missing.push({ key, refs: keyRefs, missingFrom });
    }
  }

  return {
    missing: missing.sort((a, b) => a.key.localeCompare(b.key)),
    excludedButNowWired,
    dynamicSites,
    sourceKeyCount: byKey.size,
    scannedFileCount: files.length,
  };
}

function main(): void {
  const result = checkWiring();
  console.log(`[#3948] 스캔 파일 ${result.scannedFileCount}개 · 소스 참조 NEXT_PUBLIC 키 ${result.sourceKeyCount}개`);
  console.log(`[#3948] 의도적 제외 목록 ${Object.keys(EXCLUDED_KEYS).length}개(사유 등재)`);

  if (result.dynamicSites.length > 0) {
    console.log(`\n[#3948] 동적 조합 process.env[...] 자리 ${result.dynamicSites.length}건(정적 해석 불가 — 수동 확認 필요, 목표 0):`);
    for (const s of result.dynamicSites) console.log(`  ${s.file}:${s.line}`);
  } else {
    console.log('[#3948] 동적 조합 process.env[...] 자리 0건');
  }

  if (result.excludedButNowWired.length > 0) {
    console.log(
      `\n[#3948] ℹ️ EXCLUDED_KEYS로 등재됐지만 이제 Dockerfile+cloudbuild 양쪽에 이미 배선됨(목록 정리 권장): ` +
        result.excludedButNowWired.join(', ')
    );
  }

  if (result.missing.length === 0) {
    console.log('\n[#3948] 삼자 대조 OK — 미배선 키 0건');
    return;
  }

  console.error(`\n[#3948] ⛔ Dockerfile ARG/ENV 또는 cloudbuild.yaml build-arg 어느 한쪽(또는 둘 다)에 없는 키 ${result.missing.length}건:`);
  for (const m of result.missing) {
    console.error(`  ${m.key}  (누락: ${m.missingFrom.join(', ')})`);
    for (const r of m.refs) console.error(`      ${r.file}:${r.line}`);
  }
  console.error(
    '\n  Next.js는 NEXT_PUBLIC_*를 빌드 시점에 client 번들로 리터럴 인라인한다 — 이 키가\n' +
      '  빠지면 배포 빌드는 조용히 undefined를 굽는다(#2728·#2758·#3947과 동형 사고).\n' +
      '  처방: ①apps/web/Dockerfile에 ARG/ENV 추가 ②cloudbuild.yaml build-frontend 스텝에\n' +
      '  --build-arg 추가 ③정말 서버 전용 도달만이면(구조적으로 route.ts/proxy.ts만, import\n' +
      '  그래프로 재확認) EXCLUDED_KEYS에 사유와 함께 등재.\n' +
      '  ⛔이 가드를 고쳐 통과시키지 말 것.'
  );
  process.exitCode = 1;
}

// 하우스 관례(verify-frontend-docker-import-context.ts와 동형) — 테스트가 import 할 땐 안 돈다.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
