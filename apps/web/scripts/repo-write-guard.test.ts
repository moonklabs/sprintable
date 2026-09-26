// story #4333 — 테스트가 저장소 트리에 쓰면 즉시 실패하는 가드(vitest.repo-write-guard.ts · setupFiles 맨 앞)의 양성 · 음성 대조.
// 예전: 실 트리 스캐너 테스트(verify-no-* · i18n · 한국어 UI 문구 …)와 실 트리에 표본을 잠깐 쓰는 테스트가 같은 전체 판에서 겹쳐
// 까닭 없이 RED(4686 · 4679). 쓰는 쪽은 격리 루트로 옮겼고, 이 가드가 다시 트리에 쓰는 테스트를 그 자리에서 막는다.
import fs, { mkdirSync, mkdtempSync, openSync, closeSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, RepoWriteError, isRepoPath } from '../../../vitest.repo-write-guard';

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

  it('음성 — 임시 디렉터리 쓰기 · 트리 읽기 열기는 통과', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'repo-write-guard-'));
    try {
      writeFileSync(path.join(dir, 'ok.ts'), 'x');
      expect(fs.readFileSync(path.join(dir, 'ok.ts'), 'utf8')).toBe('x');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const fd = openSync(path.join(REPO_ROOT, 'package.json'), 'r');
    closeSync(fd);
  });

  it('경로 판정 — 저장소 안 · 임시 · 저장소 밖', () => {
    expect(isRepoPath(path.join(REPO_ROOT, 'apps/web/src/x.ts'))).toBe(true);
    expect(isRepoPath(path.join(tmpdir(), 'x.ts'))).toBe(false);
    expect(isRepoPath(path.join(path.dirname(REPO_ROOT), '__outside__', 'x.ts'))).toBe(false);
  });
});
