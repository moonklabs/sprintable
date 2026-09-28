/**
 * story #4333 — 테스트가 **저장소 트리**에 파일을 쓰지 못하게 한다(쓰기 = 즉시 실패).
 *
 * 왜: 실 트리를 훑는 스캐너 테스트(verify-no-* · i18n · 한국어 UI 문구 …)와, 표본 파일을 실 트리(src · messages …)에 잠깐 썼다 지우는
 * 테스트가 같은 전체 판에서 동시에 돌면, 스캐너가 남의 임시 파일을 세어 까닭 없이 RED가 났다(4686 i18n grandfather · 4679 verify-no-* 넷).
 * 전체 판이 이유 없이 붉으면 «CI와 같은 범위 로컬 검증»을 믿을 수 없다. 재시도 · 시한 늘리기 · 순서 고정은 처방이 아니다 — 쓰는 쪽을
 * 격리 루트(os.tmpdir())로 옮기고, 이 가드가 다시 트리에 쓰는 테스트를 그 자리에서 막는다.
 *
 * 판정: `node:fs`의 쓰기 함수(파일 쓰기 · 붙이기 · 만들기 · 복사 · 이름 바꾸기 · 지우기 · 동기/비동기/promises)의 대상 경로가
 * **저장소 루트 안**이고 **임시 디렉터리 밖**이면 던진다. `REPO_WRITE_GUARD=log`면 던지지 않고 기록만(전수 조사용 · 기록 파일은 임시 디렉터리).
 * 명시적 우회는 없다 — 트리에 써야 하는 테스트는 없어야 한다(설정 · 스냅샷 갱신 등 vitest 자체 쓰기는 이 워커 코드 경로 밖).
 */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';

export const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url));
const TMP_ROOTS = [os.tmpdir(), fs.realpathSync(os.tmpdir())].map((p) => path.resolve(p));
const LOG_MODE = process.env.REPO_WRITE_GUARD === 'log';
const LOG_FILE = path.join(os.tmpdir(), 'repo-write-guard.log');

/** 경로가 저장소 트리 안(임시 디렉터리 밖)인가. */
export function isRepoPath(target: unknown): boolean {
  if (typeof target !== 'string' && !(target instanceof URL) && !Buffer.isBuffer(target)) return false;
  const raw = target instanceof URL ? fileURLToPath(target) : String(target);
  const abs = path.resolve(raw);
  if (TMP_ROOTS.some((t) => abs === t || abs.startsWith(t + path.sep))) return false;
  return abs === REPO_ROOT || abs.startsWith(REPO_ROOT + path.sep);
}

export class RepoWriteError extends Error {}

function currentTestFile(): string {
  try {
    // vitest 워커 안에서만 — 테스트 밖(모듈 로드 시점 등)이면 알 수 없음.
    const testPath = expect.getState().testPath;
    return testPath ? path.relative(REPO_ROOT, testPath) : '?';
  } catch {
    return '?';
  }
}

function report(fn: string, target: unknown): void {
  const rel = path.relative(REPO_ROOT, path.resolve(target instanceof URL ? fileURLToPath(target) : String(target)));
  const msg = `${currentTestFile()} ${fn} ${rel}`;
  if (LOG_MODE) {
    original.appendFileSync(LOG_FILE, msg + '\n');
    return;
  }
  throw new RepoWriteError(
    `테스트가 저장소 트리에 쓰려 했다(story #4333): ${msg} — 표본 파일은 os.tmpdir() 아래 격리 루트에 쓰고, 스캐너에는 그 루트를 넘길 것.`,
  );
}

// 첫 인자 = 대상 경로. copy/rename/link는 두 번째(도착)도 본다.
// 까디르 4701 ② — 스트림(createWriteStream) · 자르기(truncate) · 하드 링크(link) · 비동기 심볼릭 링크 · 콜백/Promise open을 더했다.
// fd로 쓰는 함수(write/writeSync/writev · FileHandle.write)는 경로가 없어 여기서 못 본다 — 대신 **쓰기 fd를 얻는 길을 전부 막는다**
// (openSync · open · promises.open · createWriteStream). 저장소 경로에 쓰기로 연 fd가 생기지 않으니 fd 쓰기는 트리에 닿지 못한다.
const TARGET_ARGS: Record<string, number[]> = {
  writeFileSync: [0], appendFileSync: [0], mkdirSync: [0], mkdtempSync: [0], copyFileSync: [1], cpSync: [1],
  renameSync: [0, 1], rmSync: [0], rmdirSync: [0], unlinkSync: [0], symlinkSync: [1], openSync: [0],
  truncateSync: [0], linkSync: [1], createWriteStream: [0],
  writeFile: [0], appendFile: [0], mkdir: [0], mkdtemp: [0], copyFile: [1], cp: [1], rename: [0, 1], rm: [0], rmdir: [0], unlink: [0],
  symlink: [1], link: [1], truncate: [0], open: [0],
};
/** 여는 함수(openSync · open · promises.open)는 쓰기 플래그일 때만(읽기 열기는 통과). 숫자 플래그(fs.constants)도 푼다 — 문자열로만 보면
 *  `O_WRONLY | O_CREAT`가 숫자 문자열이 돼 새어 나갔다. */
const OPENERS = new Set(['openSync', 'open']);
const WRITE_FLAG_BITS = fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_TRUNC;
export function isWriteOpenFlag(flags: unknown): boolean {
  if (typeof flags === 'number') return (flags & WRITE_FLAG_BITS) !== 0;
  if (flags === undefined || flags === null || typeof flags === 'function') return false; // 기본 'r' · open(path, cb)
  return /[wa+]/.test(String(flags));
}

const original = { appendFileSync: fs.appendFileSync.bind(fs) };

function wrap<T extends (...args: unknown[]) => unknown>(name: string, fn: T, asPromise = false): T {
  const positions = TARGET_ARGS[name];
  if (asPromise) {
    // fs.promises — 호출자는 await하므로 막힘도 거부된 promise로(동기로 던지면 promise 계약이 깨진다).
    return function guardedAsync(this: unknown, ...args: unknown[]) {
      if (OPENERS.has(name) && !isWriteOpenFlag(args[1])) return fn.apply(this, args);
      for (const i of positions) {
        if (isRepoPath(args[i])) {
          try { report(name, args[i]); } catch (err) { return Promise.reject(err); }
        }
      }
      return fn.apply(this, args);
    } as T;
  }
  return function guarded(this: unknown, ...args: unknown[]) {
    if (OPENERS.has(name) && !isWriteOpenFlag(args[1])) return fn.apply(this, args);
    for (const i of positions) {
      if (isRepoPath(args[i])) report(name, args[i]);
    }
    return fn.apply(this, args);
  } as T;
}

let installed = false;
export function installRepoWriteGuard(): void {
  if (installed) return;
  installed = true;
  const target = fs as unknown as Record<string, unknown>;
  const promises = fs.promises as unknown as Record<string, unknown>;
  for (const name of Object.keys(TARGET_ARGS)) {
    if (typeof target[name] === 'function') target[name] = wrap(name, target[name] as (...a: unknown[]) => unknown);
    if (typeof promises[name] === 'function') promises[name] = wrap(name, promises[name] as (...a: unknown[]) => unknown, true);
  }
  // `import { writeFileSync } from 'node:fs'`(ESM 이름 가져오기)도 새 함수를 보게.
  syncBuiltinESMExports();
}

installRepoWriteGuard();
