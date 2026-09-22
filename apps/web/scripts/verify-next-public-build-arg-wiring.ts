/**
 * story #3948 — 「NEXT_PUBLIC_* 소비처는 있는데 빌드 스테이지까지 안 옴」 클래스 봉쇄
 * (선례 3회: EE_ENABLED #2728 · TOSS_CLIENT_KEY #2758 · APP_URL #3947).
 *
 * Next.js는 `NEXT_PUBLIC_*`를 «빌드 시점»에 client 번들로 리터럴 인라인한다(실측:
 * #3947에서 `NEXT_PUBLIC_APP_URL=<marker>`로 `pnpm build` 뒤 `.next/static/chunks/`를
 * grep해 `"<marker>".trim()`으로 정확히 박혀 있는 것 확認). Cloud Run 런타임
 * `--update-env-vars`/cloudbuild substitution은 그 시점엔 이미 굳은 값에 닿지 않는다.
 * 그러므로 불변식은: 「소스가 참조하는 NEXT_PUBLIC 키 집합」 ⊆ 「Dockerfile ARG/ENV
 * 집합(빌드가 실제로 도는 스테이지만)」 ⊆ 「cloudbuild.yaml build-frontend 스텝의
 * --build-arg 집합」— 이 스크립트가 그 셋을 대조한다.
 *
 * 페드루 PO CHANGES①(PR#4354 리뷰) — Docker `ARG`는 «스테이지 단위» 스코프다. 이
 * 클래스의 이름 그대로("분기는 있는데 이 스테이지까지 안 옴") — `FROM … AS deps`나
 * `runner` 스테이지에 ARG를 선언해도 빌드가 실제로 도는 스테이지(예: `builder`)엔 안
 * 닿는데, 파일 전체를 훑는 순진한 스캔은 이걸 GREEN으로 잘못 본다. 그래서 `RUN … (pnpm|
 * next) build`가 있는 스테이지 «단 하나»를 찾아 그 스테이지 안 ARG만 센다(0개나 2개
 * 이상이면 그 자체가 RED — 스테이지 구조가 바뀌었는데 이 가드가 못 따라간 신호).
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
 *   ㉤cloudbuild `--build-arg=KEY=값`(한 줄 표기, `--build-arg` \\n `KEY=값` 두 줄이
 *     아닌 형)은 이 파서가 못 잡는다 — 그 경우 값 집합이 비어 fail-closed(RED 방향)로
 *     샌다(값이 있는데 없다고 오판하는 쪽 — "있는데 놓침"이 "없는데 있다고 착각"보다
 *     안전측이라 방치, 이 레포 cloudbuild.yaml은 항상 두 줄 표기라 실측 영향 0).
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
/** 이 스테이지 안에서 실제로 `next build`가 돈다 — ARG는 여기 스코프만 센다(CHANGES①). */
const BUILD_RUN_RE = /^RUN\b.*\b(pnpm|next)\b.*\bbuild\b/;

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
};

/**
 * story #3948 PO 판정(2026-09-16, 페드루) — 플래그로 켜지는 기능의 종속 키는 고정
 * 「PO 판정 대기」 제외가 아니라 규칙으로 모델링한다: `flagKey`가 cloudbuild
 * build-frontend에서 'true'로 해석되면 그 배열의 키들은 일반 필수 판정, 아니면(off·
 * 미배선 포함) 자동 제외(사유는 코드에서 일괄 생성 — 아래 참고).
 *
 * 현재 유일한 항목(develop 코드 재확認, 2026-09-16): `firebase-client.ts:15`
 * `FIREBASE_AUTH_ENABLED = NEXT_PUBLIC_FIREBASE_AUTH_ENABLED === 'true'`가 UX 노출
 * 게이트이고, `getFirebaseConfig()`는 4키 中 하나라도 없으면 throw 없이 null(스캐폴드
 * 무해 원칙, PO 인프라 lane 착지 前) — 지금 off인 건 조용히 깨진 게 아니라 의도적.
 */
export const FLAG_GATED_KEYS: Record<string, string[]> = {
  NEXT_PUBLIC_FIREBASE_AUTH_ENABLED: [
    'NEXT_PUBLIC_FIREBASE_API_KEY',
    'NEXT_PUBLIC_FIREBASE_APP_ID',
    'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
    'NEXT_PUBLIC_FIREBASE_PROJECT_ID',
  ],
};

function flagGatedOffReason(flagKey: string): string {
  return `flag off·scaffold 미프로비저닝(게이트 ${flagKey}가 'true'로 배선되지 않음 — off일 때 종속키 배선 불필요, on이면 이 목록에서 빠지고 일반 필수 판정으로 전환됨)`;
}

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

/** AC㉠ — Route Handler·Middleware·테스트 파일을 걸러낸다(listScanFiles의 필터 책임). */
export function isScannable(filePath: string): boolean {
  return EXT_RE.test(filePath) && !TEST_RE.test(filePath) && !ROUTE_HANDLER_RE.test(filePath) && !MIDDLEWARE_RE.test(filePath);
}

export function listScanFiles(roots: string[] = SCAN_ROOTS): string[] {
  const files: string[] = [];
  for (const root of roots) {
    const st = statSync(root, { throwIfNoEntry: false });
    if (!st) continue;
    if (st.isFile()) {
      files.push(root);
      continue;
    }
    walk(root, files);
  }
  return files.filter(isScannable);
}

export function extractSourceKeys(files: string[]): { refs: KeyRef[]; dynamicSites: { file: string; line: number }[] } {
  const refs: KeyRef[] = [];
  const dynamicSites: { file: string; line: number }[] = [];
  for (const full of files) {
    const rel = path.isAbsolute(full) ? path.relative(REPO_ROOT, full) : full;
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

export interface BuildStageArgs {
  defaults: Map<string, string | undefined>;
  buildStageName: string | null;
  /** 0 또는 2 이상이면 스테이지 구조가 애매하다는 뜻 — 호출부가 이걸 RED로 다뤄야 한다. */
  buildStageCount: number;
}

/**
 * story #3948 CHANGES①(페드루 PO) — Docker ARG는 스테이지 단위 스코프다. `FROM … AS
 * <name>` 경계로 스테이지를 나누고, `RUN … (pnpm|next) build`가 있는 스테이지 «단
 * 하나»의 `ARG NEXT_PUBLIC_*`만 유효로 센다. 그 스테이지가 0개나 2개 이상이면(스테이지
 * 구조가 바뀌어 이 가드가 못 따라간 신호) buildStageCount로 알린다 — 호출부가 RED 처리.
 */
export function findBuildStageArgs(dockerfilePath: string): BuildStageArgs {
  const lines = readFileSync(dockerfilePath, 'utf8').split('\n');
  const stages: { name: string; lines: string[] }[] = [];
  let current: { name: string; lines: string[] } | null = null;
  const argRe = /^ARG\s+(NEXT_PUBLIC_[A-Z0-9_]+)(?:=(.*))?$/;

  for (const raw of lines) {
    const trimmed = raw.trim();
    const from = /^FROM\s+\S+(?:\s+AS\s+(\S+))?/i.exec(trimmed);
    if (from) {
      current = { name: from[1] ?? `(anonymous:${stages.length})`, lines: [] };
      stages.push(current);
      continue;
    }
    if (current) current.lines.push(trimmed);
  }

  const buildStages = stages.filter((s) => s.lines.some((l) => BUILD_RUN_RE.test(l)));

  if (buildStages.length !== 1) {
    return { defaults: new Map(), buildStageName: null, buildStageCount: buildStages.length };
  }

  const defaults = new Map<string, string | undefined>();
  for (const line of buildStages[0]!.lines) {
    const m = argRe.exec(line);
    if (m) defaults.set(m[1]!, m[2]);
  }
  return { defaults, buildStageName: buildStages[0]!.name, buildStageCount: 1 };
}

export function extractDockerfileArgDefaults(dockerfilePath: string): Map<string, string | undefined> {
  return findBuildStageArgs(dockerfilePath).defaults;
}

export function extractDockerfileArgs(dockerfilePath: string): Set<string> {
  return new Set(extractDockerfileArgDefaults(dockerfilePath).keys());
}

/** cloudbuild.yaml 최상위 `substitutions:` 블록의 `_KEY: value` 쌍. */
export function extractCloudbuildSubstitutions(cloudbuildPath: string): Map<string, string> {
  const subs = new Map<string, string>();
  const lines = readFileSync(cloudbuildPath, 'utf8').split('\n');
  let inBlock = false;
  for (const raw of lines) {
    if (/^substitutions:\s*$/.test(raw)) {
      inBlock = true;
      continue;
    }
    if (inBlock) {
      if (/^\S/.test(raw)) break; // 들여쓰기 0인 다음 최상위 키 — 블록 끝
      const m = /^\s+(_[A-Z0-9_]+):\s*"?([^"#]*)"?\s*(?:#.*)?$/.exec(raw);
      if (m) subs.set(m[1]!, m[2]!.trim());
    }
  }
  return subs;
}

/**
 * cloudbuild.yaml의 `build-frontend` 스텝(dev·prod 공유 — 값은 substitution으로만
 * 갈리고 --build-arg 목록 자체는 하나) 안 `--build-arg` 다음 줄의 `KEY=값` 쌍을 뽑는다.
 * 값은 미해석 원문(예: `${_FIREBASE_AUTH_ENABLED}` 또는 리터럴 `true`) 그대로 — 해석은
 * resolveGateValue()가 substitutions 기본값과 조합해서 한다. 스텝 자체를 못 찾으면
 * stepFound=false(AC㉤ 관찰(b) — 빈 집합만으론 "스텝 없음"과 "스텝은 있는데 build-arg가
 * 0개"를 구분 못 해 호출부 에러 메시지가 오해를 부를 수 있었다).
 */
export interface CloudbuildBuildArgResult {
  values: Map<string, string>;
  stepFound: boolean;
}

export function extractCloudbuildFrontendBuildArgValues(cloudbuildPath: string, stepId = 'build-frontend'): CloudbuildBuildArgResult {
  const values = new Map<string, string>();
  const lines = readFileSync(cloudbuildPath, 'utf8').split('\n');
  let inStep = false;
  let stepIndent = -1;
  let prevWasBuildArgFlag = false;
  let stepFound = false;
  for (const raw of lines) {
    const trimmed = raw.trim();
    const idMatch = /^-\s+id:\s*(\S+)/.exec(trimmed);
    if (idMatch) {
      const indent = raw.length - raw.trimStart().length;
      if (inStep && indent <= stepIndent) inStep = false; // 다음 스텝 진입 — 이전 스텝 종료
      if (idMatch[1] === stepId) {
        inStep = true;
        stepFound = true;
        stepIndent = indent;
      }
      continue;
    }
    if (!inStep) continue;
    if (prevWasBuildArgFlag) {
      const kv = /^-\s+(NEXT_PUBLIC_[A-Z0-9_]+)=(.*)$/.exec(trimmed);
      if (kv) values.set(kv[1]!, kv[2]!);
      prevWasBuildArgFlag = false;
      continue;
    }
    if (/^-\s+--build-arg\s*$/.test(trimmed)) prevWasBuildArgFlag = true;
  }
  return { values, stepFound };
}

export function extractCloudbuildFrontendBuildArgs(cloudbuildPath: string, stepId = 'build-frontend'): Set<string> {
  return new Set(extractCloudbuildFrontendBuildArgValues(cloudbuildPath, stepId).values.keys());
}

/**
 * 플래그 게이트 키의 실효값을 해석한다 — cloudbuild build-arg RHS가 `${_VAR}` 형이면
 * substitutions 기본값으로, 리터럴이면 그대로. build-arg에 아예 없으면 Dockerfile ARG
 * 기본값으로 폴백. 어디에도 없으면 undefined(= 배선 자체가 없다 → off로 취급).
 */
export function resolveGateValue(
  gateKey: string,
  buildArgValues: Map<string, string>,
  substitutions: Map<string, string>,
  dockerfileDefaults: Map<string, string | undefined>,
): string | undefined {
  const rhs = buildArgValues.get(gateKey);
  if (rhs === undefined) return dockerfileDefaults.get(gateKey);
  const subRef = /^\$\{(_[A-Z0-9_]+)\}$/.exec(rhs);
  if (subRef) return substitutions.get(subRef[1]!);
  return rhs;
}

export interface WiringResult {
  missing: { key: string; refs: KeyRef[]; missingFrom: ('dockerfile' | 'cloudbuild')[] }[];
  excludedButNowWired: string[]; // EXCLUDED_KEYS/FLAG_GATED_KEYS인데 실은 이미 배선됨 — 목록 정리 대상(정보성)
  dynamicSites: { file: string; line: number }[];
  sourceKeyCount: number;
  scannedFileCount: number;
  /** null이면 정상(스테이지 정확히 1개). 문자열이면 그 자체가 RED 사유(0개/2개 이상). */
  dockerfileStageError: string | null;
  /** true면 cloudbuild.yaml에 build-frontend 스텝 자체가 없다는 뜻(AC㉤ 관찰(b)). */
  cloudbuildStepMissing: boolean;
  flagStates: { flagKey: string; resolved: string | undefined; on: boolean }[];
}

export interface CheckWiringOptions {
  files?: string[];
  dockerfilePath?: string;
  cloudbuildPath?: string;
}

export function checkWiring(options: CheckWiringOptions = {}): WiringResult {
  const files = options.files ?? listScanFiles();
  const dockerfilePath = options.dockerfilePath ?? DOCKERFILE;
  const cloudbuildPath = options.cloudbuildPath ?? CLOUDBUILD;

  const { refs, dynamicSites } = extractSourceKeys(files);
  const stageArgs = findBuildStageArgs(dockerfilePath);
  const dockerfileArgs = new Set(stageArgs.defaults.keys());
  const { values: buildArgValues, stepFound } = extractCloudbuildFrontendBuildArgValues(cloudbuildPath);
  const cloudbuildArgs = new Set(buildArgValues.keys());
  const substitutions = extractCloudbuildSubstitutions(cloudbuildPath);

  const dockerfileStageError =
    stageArgs.buildStageCount === 1
      ? null
      : `Dockerfile에서 "RUN … (pnpm|next) build"가 있는 스테이지가 ${stageArgs.buildStageCount}개 발견됨(정확히 1개여야 함) — ` +
        'ARG 스코프를 못 정한다. Dockerfile 멀티스테이지 구조가 바뀌었는지 확認하라.';

  const flagStates = Object.keys(FLAG_GATED_KEYS).map((flagKey) => {
    const resolved = resolveGateValue(flagKey, buildArgValues, substitutions, stageArgs.defaults);
    return { flagKey, resolved, on: resolved === 'true' };
  });

  const byKey = new Map<string, KeyRef[]>();
  for (const r of refs) {
    if (!byKey.has(r.key)) byKey.set(r.key, []);
    byKey.get(r.key)!.push(r);
  }

  // story #3948 PO 판정 — 플래그 게이트 키: on이면 일반 필수 판정, off면(게이트 자신
  // 포함) 자동 제외. off 상태는 정의상 "그 키가 아예 안 읽혀도 안전"(undefined →
  // 'true' 비교 실패 → false)이므로 꺼진 기능 하나 때문에 Dockerfile에 죽은 ARG를
  // 강제로 추가하게 만들지 않는다. 게이트가 실제로 'true'로 해석됐다면 그 값이 어디선가
  // 이미 배선돼 있었다는 뜻이라 게이트 자신이 missing으로 뜰 수 없다(항상 안전).
  const gatedExcluded = new Map<string, string>(); // key -> offReason(게이트 off일 때만)
  for (const { flagKey, on } of flagStates) {
    if (!on) {
      const reason = flagGatedOffReason(flagKey);
      gatedExcluded.set(flagKey, reason);
      for (const dep of FLAG_GATED_KEYS[flagKey]!) gatedExcluded.set(dep, reason);
    }
  }

  const missing: WiringResult['missing'] = [];
  const excludedButNowWired: string[] = [];
  for (const [key, keyRefs] of byKey) {
    const inDocker = dockerfileArgs.has(key);
    const inCloudbuild = cloudbuildArgs.has(key);
    if (key in EXCLUDED_KEYS || gatedExcluded.has(key)) {
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
    dockerfileStageError,
    cloudbuildStepMissing: !stepFound,
    flagStates,
  };
}

function main(): void {
  const result = checkWiring();
  console.log(`[#3948] 스캔 파일 ${result.scannedFileCount}개 · 소스 참조 NEXT_PUBLIC 키 ${result.sourceKeyCount}개`);
  console.log(`[#3948] 의도적 제외 목록 ${Object.keys(EXCLUDED_KEYS).length}개(사유 등재)`);
  for (const { flagKey, resolved, on } of result.flagStates) {
    const state = on ? 'ON(필수 판정 적용)' : `OFF(해석값=${resolved ?? '(미배선)'} — 제외)`;
    console.log(`[#3948] 플래그 게이트 ${flagKey}=${state} → 종속 ${FLAG_GATED_KEYS[flagKey]!.length}키`);
  }

  if (result.cloudbuildStepMissing) {
    console.error('\n[#3948] ⛔ cloudbuild.yaml에 "build-frontend" 스텝 자체를 못 찾음 — 아래 missing은 그래서 전부 뜬 것일 수 있다. 스텝 id가 바뀌었는지 확認하라.');
    process.exitCode = 1;
  }
  if (result.dockerfileStageError) {
    console.error(`\n[#3948] ⛔ ${result.dockerfileStageError}`);
    process.exitCode = 1;
  }

  if (result.dynamicSites.length > 0) {
    console.log(`\n[#3948] 동적 조합 process.env[...] 자리 ${result.dynamicSites.length}건(정적 해석 불가 — 수동 확認 필요, 목표 0):`);
    for (const s of result.dynamicSites) console.log(`  ${s.file}:${s.line}`);
  } else {
    console.log('[#3948] 동적 조합 process.env[...] 자리 0건');
  }

  if (result.excludedButNowWired.length > 0) {
    console.log(
      `\n[#3948] ℹ️ 제외 목록(EXCLUDED_KEYS/FLAG_GATED_KEYS)으로 안 세는데 이제 Dockerfile+cloudbuild 양쪽에 이미 배선됨(목록 정리 권장): ` +
        result.excludedButNowWired.join(', ')
    );
  }

  if (result.missing.length === 0) {
    console.log('\n[#3948] 삼자 대조 OK — 미배선 키 0건');
    return;
  }

  console.error(`\n[#3948] ⛔ Dockerfile ARG/ENV(빌드 스테이지 안) 또는 cloudbuild.yaml build-arg 어느 한쪽(또는 둘 다)에 없는 키 ${result.missing.length}건:`);
  for (const m of result.missing) {
    console.error(`  ${m.key}  (누락: ${m.missingFrom.join(', ')})`);
    for (const r of m.refs) console.error(`      ${r.file}:${r.line}`);
  }
  console.error(
    '\n  Next.js는 NEXT_PUBLIC_*를 빌드 시점에 client 번들로 리터럴 인라인한다 — 이 키가\n' +
      '  빠지면 배포 빌드는 조용히 undefined를 굽는다(#2728·#2758·#3947과 동형 사고).\n' +
      '  처방: ①apps/web/Dockerfile의 빌드 스테이지 안에 ARG/ENV 추가 ②cloudbuild.yaml\n' +
      '  build-frontend 스텝에 --build-arg 추가 ③정말 서버 전용 도달만이면(구조적으로\n' +
      '  route.ts/proxy.ts만, import 그래프로 재확認) EXCLUDED_KEYS에 사유와 함께 등재\n' +
      '  ④플래그로 켜지는 기능이면 FLAG_GATED_KEYS에 등재.\n' +
      '  ⛔이 가드를 고쳐 통과시키지 말 것.'
  );
  process.exitCode = 1;
}

// 하우스 관례(verify-frontend-docker-import-context.ts와 동형) — 테스트가 import 할 땐 안 돈다.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
