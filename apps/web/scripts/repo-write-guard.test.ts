// story #4333 — 테스트가 저장소 트리에 쓰면 즉시 실패하는 가드(vitest.repo-write-guard.ts · setupFiles 맨 앞)의 양성 · 음성 대조.
// 예전: 실 트리 스캐너 테스트(verify-no-* · i18n · 한국어 UI 문구 …)와 실 트리에 표본을 잠깐 쓰는 테스트가 같은 전체 판에서 겹쳐
// 까닭 없이 RED(4686 · 4679). 쓰는 쪽은 격리 루트로 옮겼고, 이 가드가 다시 트리에 쓰는 테스트를 그 자리에서 막는다.
import fs, { mkdirSync, mkdtempSync, openSync, closeSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, RepoWriteError, isRepoPath, isWriteOpenFlag } from '../../../vitest.repo-write-guard';

const inRepo = (name: string) => path.join(REPO_ROOT, 'apps/web/src', `__repo-write-guard-${name}__.ts`);

describe('저장소 트리 쓰기 가드(story #4333)', () => {
  it('⭐양성 — 트리 안 쓰기는 파일을 만들기 전에 던진다(ESM 이름 가져오기 · fs 객체 · promises · 디렉터리)', async () => {
    const target = inRepo('sync');
    expect(() => writeFileSync(target, 'x'), 'ESM 이름 가져오기').toThrow(RepoWriteError);
    expect(() => fs.writeFileSync(target, 'x'), 'fs 객체').toThrow(RepoWriteError);
    expect(() => fs.appendFileSync(target, 'x'), '붙이기').toThrow(RepoWriteError);
    expect(() => mkdirSync(path.join(REPO_ROOT, 'apps/web/src/__repo-write-guard-dir__')), '디렉터리').toThrow(RepoWriteError);
    expect(() => openSync(target, 'w'), '쓰기로 열기').toThrow(RepoWriteError);
    await expect(fs.promises.writeFile(inRepo('async'), 'x'), 'promises').rejects.toThrow(RepoWriteError);
    expect(fs.existsSync(target), '던지기 전에 아무것도 안 만들었다').toBe(false);
  });

  it('⭐양성(까디르 4701 ②) — 스트림 · 자르기 · 링크 · 콜백/Promise open · 숫자 플래그 · fd 쓰기는 쓰기 fd를 얻는 자리에서 막힌다', async () => {
    const target = inRepo('more');
    const existing = path.join(REPO_ROOT, 'package.json'); // 자르기 · 링크 원본(읽기만 · 가드가 먼저 던진다)
    expect(() => fs.createWriteStream(target), '스트림').toThrow(RepoWriteError);
    expect(() => fs.truncateSync(existing, 0), '자르기').toThrow(RepoWriteError);
    await expect(fs.promises.truncate(existing, 0), 'promises 자르기').rejects.toThrow(RepoWriteError);
    const outside = mkdtempSync(path.join(tmpdir(), 'repo-write-guard-link-'));
    try {
      writeFileSync(path.join(outside, 'src.txt'), 'x');
      expect(() => fs.linkSync(path.join(outside, 'src.txt'), target), '하드 링크(도착이 트리)').toThrow(RepoWriteError);
      await expect(fs.promises.link(path.join(outside, 'src.txt'), target), 'promises 하드 링크').rejects.toThrow(RepoWriteError);
      await expect(fs.promises.symlink(path.join(outside, 'src.txt'), target), 'promises 심볼릭 링크').rejects.toThrow(RepoWriteError);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
    expect(() => fs.open(target, 'w', () => {}), '콜백 open(w)').toThrow(RepoWriteError);
    await expect(fs.promises.open(target, 'a'), 'promises open(a) — FileHandle.write를 얻는 길').rejects.toThrow(RepoWriteError);
    expect(() => openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT), '숫자 플래그').toThrow(RepoWriteError);
    expect(fs.existsSync(target), '아무것도 안 만들었다').toBe(false);
    expect(fs.statSync(existing).size, '자르기가 실제로 안 일어났다').toBeGreaterThan(0);
  });

  it('여는 플래그 판정 — 읽기(기본 · r · O_RDONLY)는 통과 · 쓰기(w · a · r+ · 쓰기 비트)는 막음', () => {
    for (const f of [undefined, 'r', 'rs', fs.constants.O_RDONLY, () => {}]) expect(isWriteOpenFlag(f), String(f)).toBe(false);
    for (const f of ['w', 'wx', 'a', 'a+', 'r+', fs.constants.O_WRONLY, fs.constants.O_RDWR, fs.constants.O_APPEND, fs.constants.O_CREAT, fs.constants.O_TRUNC]) {
      expect(isWriteOpenFlag(f), String(f)).toBe(true);
    }
  });

  it('음성 — 임시 디렉터리 쓰기 · 트리 읽기 열기는 통과', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'repo-write-guard-'));
    try {
      writeFileSync(path.join(dir, 'ok.ts'), 'x');
      expect(fs.readFileSync(path.join(dir, 'ok.ts'), 'utf8')).toBe('x');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const fd = openSync(path.join(REPO_ROOT, 'package.json'), 'r');
    closeSync(fd);
    const fh = await fs.promises.open(path.join(REPO_ROOT, 'package.json'));
    await fh.close();
    await new Promise<void>((resolve, reject) => fs.open(path.join(REPO_ROOT, 'package.json'), (err, fd2) => (err ? reject(err) : (closeSync(fd2), resolve()))));
  });

  it('경로 판정 — 저장소 안 · 임시 · 저장소 밖', () => {
    expect(isRepoPath(path.join(REPO_ROOT, 'apps/web/src/x.ts'))).toBe(true);
    expect(isRepoPath(path.join(tmpdir(), 'x.ts'))).toBe(false);
    expect(isRepoPath(path.join(path.dirname(REPO_ROOT), '__outside__', 'x.ts'))).toBe(false);
  });
});
