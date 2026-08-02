/**
 * story #1933 회귀가드 — `new URL(x, request.url)`(또는 `req.url`) 처럼 request.url을
 * 상대경로의 base로 쓰면, Cloud Run에서 컨테이너가 실제로 받는 요청의 내부 주소가 그대로
 * 새어 나간다(플랫폼 성질, 개별 라우트의 우연이 아니다) — auth/native·internal-dogfood
 * 3곳(session/sign-out/stories)에서 잡혀 전부 `resolveAppUrl(null)` 기반으로 고쳤다.
 *
 * 이 가드는 그 네 곳을 다시 하나하나 예외 목록으로 만들지 않는다 — 고친 뒤 0건을 고정해
 * 새로 생기는 것만 막는다(#2340에서 겪은 "예외 목록 만들다 판정 못 바꾸는 25건 더 세기"와
 * 같은 길을 피한다). `new URL(request.url)`처럼 단일 인자로 자기 자신의 query만 읽는 자리는
 * 안전하다(밖으로 새는 base가 아니다) — 두 번째 인자에 request.url/req.url이 오는 경우만 잡는다.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export const REQUEST_URL_AS_BASE = /new URL\([^)]*,\s*(?:request|req)\.url\)/;

export function hasRequestUrlAsBase(content: string): boolean {
  return REQUEST_URL_AS_BASE.test(content);
}

const EXT_RE = /\.(tsx?|jsx?)$/;
const TEST_RE = /\.test\.[tj]sx?$/;

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (EXT_RE.test(entry) && !TEST_RE.test(entry)) {
      out.push(full);
    }
  }
}

const MIN_EXPECTED_FILES = 500;

function main(): void {
  const srcRoot = path.resolve(process.cwd(), 'src');
  const files: string[] = [];
  walk(srcRoot, files);

  if (files.length < MIN_EXPECTED_FILES) {
    console.error(
      `FAIL: 검사 대상 파일이 ${files.length}개뿐 — 경로/실행 위치가 틀렸을 가능성. 가드가 헛돌고 있다.`,
    );
    console.error(`  srcRoot=${srcRoot} (기대 최소 ${MIN_EXPECTED_FILES}개)`);
    process.exit(1);
  }

  const violations: string[] = [];
  for (const abs of files) {
    const rel = path.relative(srcRoot, abs).split(path.sep).join('/');
    const content = readFileSync(abs, 'utf8');
    if (hasRequestUrlAsBase(content)) violations.push(rel);
  }

  if (violations.length > 0) {
    console.error('FAIL: request.url을 상대경로 base로 쓴 자리 발견(story #1933 회귀 — Cloud Run 내부주소 유출):');
    for (const v of violations) console.error(`  - ${v}`);
    console.error(
      '\nCloud Run은 컨테이너에 내부 주소로 요청을 전달한다 — request.url을 new URL()의 base로 쓰면' +
        ' 그 내부 주소가 redirect Location 등으로 새어 나간다. resolveAppUrl(null)(@/services/app-url)을' +
        ' base로 쓴다.',
    );
    process.exit(1);
  }

  console.log('OK: request.url을 base로 쓰는 자리 0건');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
