/**
 * story #3731 회귀가드 — 「apps/web 안 파일이 «프런트 Docker 빌드 컨텍스트 밖»을 상대
 * import하면」 CI가 잡는다. 배포 58 실사고(#3729)가 이 클래스의 첫 인스턴스다.
 *
 * ⭐정본은 Dockerfile 자신이다. 허용 디렉터리를 여기에 손으로 적으면 Dockerfile이 바뀔 때
 * 조용히 어긋난다 — builder 스테이지의 COPY를 파싱해 허용 집합을 «파생»시킨다.
 *
 * AC — 이 가드가 «못 잡는 것» 다섯. 선언 안 하면 다음 사람이 "이게 다 본다"로 읽는다.
 *   ㉠비-상대 import(`@/…` 별칭·패키지명) — 워크스페이스로 풀리며 컨텍스트 안이 정상.
 *   ㉡런타임 동적 경로(`import(변수)`·`fs.readFileSync(join(...))`) — 정적으로 못 푼다.
 *   ㉢builder 스테이지 밖(deps·runner)의 COPY — 다단계 구조가 바뀌면 STAGE도 같이 고칠 것.
 *   ㉣`.dockerignore` — COPY 대상이라도 무시 패턴에 걸리면 실제로는 안 실린다(후속 축).
 *   ㉤주석 속 import 문자열 — 커밋③(story #3731)에서 닫았다: 공유 파서
 *     (packages/scripts/i18n-key-parser.js, 커밋②로 이관 완료)의 stripComments()를
 *     스캔 前에 적용한다. 커밋①에서 바로 안 붙인 이유 — 이관 前엔 그 파서가 아직
 *     레포 루트 scripts/에 있어, 여기서 import하면 이 가드 자신이 자기가 막으려는
 *     «Docker 빌드 컨텍스트 밖 참조»를 저지르는 부트스트랩 역설이었다.
 *
 * 쓰기: tsx apps/web/scripts/verify-frontend-docker-import-context.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripComments } from '../../../packages/scripts/i18n-key-parser.js';

const APPS_WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(APPS_WEB, '../..');
const DOCKERFILE = path.join(APPS_WEB, 'Dockerfile');
/** 빌드 타입체크가 도는 스테이지. AC㉢ — 여기 밖 COPY는 안 센다. */
const STAGE = 'builder';
/** builder 안에서 레포 루트에 해당하는 경로(이 Dockerfile은 /app 에 편다). */
const IMAGE_ROOT = '/app';

const EXT_RE = /\.(tsx?|mts|jsx?)$/;
const TEST_RE = /\.(test|spec)\.[tj]sx?$/;
const SKIP_DIRS = new Set(['node_modules', '.next', 'e2e', 'dist', '.turbo']);

export interface EscapingImport {
  file: string;      // repo-relative
  specifier: string; // 소스에 적힌 그대로
  resolved: string;  // repo-relative 로 푼 것
}

/**
 * Dockerfile builder 스테이지가 만드는 «이미지 안 트리»의 repo-relative 접두 목록.
 * ⭐src가 아니라 «결과 경로»를 센다(위 「두 번 틀렸다」 참조).
 *   Docker 의미론: dst가 `/`로 끝나고 src가 `/`로 안 끝나면 결과는 `dst/basename(src)`,
 *   그 밖엔 `dst`(디렉터리 «내용»이 놓인다). dst는 그 시점 WORKDIR 기준이다.
 */
export function parseCopiedPrefixes(dockerfile: string, stage = STAGE): string[] {
  const prefixes: string[] = [];
  let inStage = false;
  let workdir = '/';
  for (const raw of dockerfile.split('\n')) {
    const line = raw.trim();
    const from = /^FROM\s+\S+(?:\s+AS\s+(\S+))?/i.exec(line);
    if (from) { inStage = (from[1] ?? '').toLowerCase() === stage.toLowerCase(); workdir = '/'; continue; }
    if (!inStage) continue;
    const wd = /^WORKDIR\s+(\S+)/i.exec(line);
    if (wd) { workdir = path.posix.resolve(workdir, wd[1]); continue; }
    if (!/^COPY\s/i.test(line)) continue;
    const args = line.replace(/^COPY\s+/i, '').split(/\s+/).filter((a) => !a.startsWith('--'));
    if (args.length < 2) continue;
    const dst = args[args.length - 1];
    const dstIsDir = dst.endsWith('/') || dst === '.' || dst === './';
    for (const src of args.slice(0, -1)) {
      const landed = dstIsDir && !src.endsWith('/')
        ? path.posix.join(dst, path.posix.basename(src))
        : dst;
      const abs = path.posix.resolve(workdir, landed);
      if (abs === '/' || abs === IMAGE_ROOT) { prefixes.push(''); continue; } // 레포 전체
      if (!abs.startsWith(IMAGE_ROOT + '/')) continue; // 이미지 루트 밖 — 레포 경로와 무관
      prefixes.push(abs.slice(IMAGE_ROOT.length + 1).replace(/\/$/, ''));
    }
  }
  return [...new Set(prefixes)];
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (EXT_RE.test(name) && !TEST_RE.test(name)) out.push(full);
  }
  return out;
}

/** `from '…'` / `import('…')` / `require('…')` 의 «상대» 스펙만 뽑는다(AC㉠). */
export function parseRelativeSpecifiers(source: string): string[] {
  const specs: string[] = [];
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"](\.[^'"]+)['"]/g;
  for (const m of source.matchAll(re)) specs.push(m[1]);
  return specs;
}

/** 푼 경로가 허용 접두 중 하나 «안»인가. 빈 문자열 접두(COPY . .)는 전부 허용. */
export function isInsideContext(resolvedRepoRel: string, prefixes: string[]): boolean {
  return prefixes.some((p) => p === '' || resolvedRepoRel === p || resolvedRepoRel.startsWith(p + '/'));
}

export function scanRepository(): { violations: EscapingImport[]; scanned: number; prefixes: string[] } {
  const prefixes = parseCopiedPrefixes(readFileSync(DOCKERFILE, 'utf8'));
  const files = walk(APPS_WEB);
  const violations: EscapingImport[] = [];
  for (const full of files) {
    const rel = path.relative(REPO_ROOT, full);
    const source = stripComments(readFileSync(full, 'utf8')) as string; // AC㉤ — 주석 속 import 문자열 제외
    for (const spec of parseRelativeSpecifiers(source)) {
      if (!spec.startsWith('..')) continue; // 아래로만 내려가면 절대 못 벗어난다
      const resolved = path.relative(REPO_ROOT, path.resolve(path.dirname(full), spec));
      if (resolved.startsWith('..')) { // 레포 밖 — 무조건 위반
        violations.push({ file: rel, specifier: spec, resolved });
        continue;
      }
      if (!isInsideContext(resolved, prefixes)) violations.push({ file: rel, specifier: spec, resolved });
    }
  }
  return { violations, scanned: files.length, prefixes };
}

function main(): void {
  const { violations, scanned, prefixes } = scanRepository();
  console.log(`[#3731] Dockerfile(${STAGE}) COPY 접두: ${prefixes.join(' · ') || '(없음)'}`);
  console.log(`[#3731] apps/web 비-테스트 파일 ${scanned}개 스캔`);
  if (violations.length === 0) { console.log('[#3731] 컨텍스트 밖 상대 import 0건 — OK'); return; }
  console.error(`\n[#3731] ⛔ 프런트 Docker 빌드 컨텍스트 «밖»을 import 하는 자리 ${violations.length}건:`);
  for (const v of violations) console.error(`  ${v.file}\n      ${v.specifier}  →  ${v.resolved}`);
  console.error(
    '\n  이 import 는 CI(전체 체크아웃)에선 풀리지만 Docker 안에선 없다 — 배포가 죽는다(#3729).\n' +
    '  처방: ①그 모듈을 packages/ 로 옮겨 워크스페이스로 쓰거나 ②Dockerfile builder 에 그\n' +
    '  디렉터리를 COPY 하거나 ③apps/web 안으로 옮긴다(단, 정의가 둘 되면 안 된다).\n' +
    '  ⛔이 가드를 고쳐 통과시키지 말 것.',
  );
  process.exitCode = 1;
}

// 하우스 관례(verify-no-i18n-phrase-collision.ts)와 같은 형 — 테스트가 import 할 땐 안 돈다.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
