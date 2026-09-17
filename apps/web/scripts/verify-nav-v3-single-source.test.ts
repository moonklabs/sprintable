// story #4017 CHANGES 2(페드루 PO 지적, 2026-09-17 15:31Z) — env 이름·목적지 리터럴이
// 각자 한 곳에서만 나오는지 고정한 가드의 단위테스트. 실 저장소 스캔(①) + 합성 fixture
// 트리로 뮤테이션 RED 확認(②).
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  scan,
  ENV_NAMES,
  DEST_LITERALS,
  DEST_ALLOWED_NON_TEST_FILES,
  ENV_ALLOWED_NON_TEST_FILES,
} from './verify-nav-v3-single-source';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '../../..');

describe('verify-nav-v3-single-source — 실 저장소 스캔(story #4017 CHANGES 2)', () => {
  it('⭐지금 develop(이 브랜치) — env 이름·목적지 리터럴 위반 0건', () => {
    const result = scan(REPO_ROOT);
    expect(result.envViolations).toEqual([]);
    expect(result.destViolations).toEqual([]);
  });
});

let tmpDir: string | null = null;

function makeFixtureRepo(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'nav-v3-guard-'));
  tmpDir = root;
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, 'apps/web', rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf-8');
  }
  return root;
}

afterEach(() => {
  if (tmpDir) { rmSync(tmpDir, { recursive: true, force: true }); tmpDir = null; }
});

describe('verify-nav-v3-single-source — 합성 fixture(뮤테이션 RED 확認)', () => {
  it('⭐env 이름을 헬퍼 파일 밖(임의 라우트)에서 읽으면 위반으로 잡힌다', () => {
    const root = makeFixtureRepo({
      'src/lib/nav-v3-flags-server.ts': `export function readNavV3FlagsFromEnv() { return { todayV3Enabled: process.env['TODAY_V3_ENABLED'] === 'true' }; }`,
      'src/app/rogue/page.tsx': `export default function Page() { const on = process.env['CHAT_V3_ENABLED'] === 'true'; return on; }`,
    });
    const result = scan(root);
    expect(result.envViolations).toEqual([{ file: 'src/app/rogue/page.tsx', names: ['CHAT_V3_ENABLED'] }]);
  });

  it('⭐목적지 리터럴을 모듈 밖(임의 라우트)에서 다시 조립하면 위반으로 잡힌다', () => {
    const root = makeFixtureRepo({
      'src/lib/nav-v3-destinations.ts': `export const x = '/chats';`,
      'src/app/rogue/page.tsx': `export default function Page() { return on ? '/chat' : '/chats'; }`,
    });
    const result = scan(root);
    expect(result.destViolations).toEqual([{ file: 'src/app/rogue/page.tsx', literals: expect.arrayContaining(['/chat', '/chats']) }]);
  });

  it('*.test.ts(tsx) 파일은 env·목적지 리터럴 둘 다 항상 허용(기대값 assert가 본업)', () => {
    const root = makeFixtureRepo({
      'src/lib/nav-v3-flags-server.ts': `export function x() {}`,
      'src/lib/nav-v3-destinations.ts': `export function y() {}`,
      'src/app/rogue/page.test.tsx': `test('x', () => { expect(process.env['TODAY_V3_ENABLED']).toBe('true'); expect(href).toBe('/today'); });`,
    });
    const result = scan(root);
    expect(result.envViolations).toEqual([]);
    expect(result.destViolations).toEqual([]);
  });

  it('주석 안 언급(프로즈)은 위반으로 안 잡는다(코드 값만 본다)', () => {
    const root = makeFixtureRepo({
      'src/lib/nav-v3-flags-server.ts': `export function x() {}`,
      'src/lib/nav-v3-destinations.ts': `export function y() {}`,
      'src/app/rogue/page.tsx': `// story #1234 — /chats로 착지한다(CHAT_V3_ENABLED 참고).\nexport default function Page() {}`,
    });
    const result = scan(root);
    expect(result.envViolations).toEqual([]);
    expect(result.destViolations).toEqual([]);
  });

  it('ALLOWED 목록에 등재된 파일은 통과(근거 있는 예외)', () => {
    const root = makeFixtureRepo({
      'src/lib/nav-v3-flags-server.ts': `export function x() {}`,
      'src/lib/nav-v3-destinations.ts': `export function y() {}`,
      'src/app/(authenticated)/chats/layout.tsx': `export const isListRoute = (p: string) => p === '/chats';`,
    });
    const result = scan(root);
    expect(result.destViolations).toEqual([]);
  });
});

describe('ALLOWED 목록 자체의 위생(story #4017 CHANGES 2)', () => {
  it('DEST_ALLOWED_NON_TEST_FILES의 모든 키는 *.test.* 파일이 아니다(테스트는 자동 허용이라 이 목록에 있으면 안 됨)', () => {
    for (const f of Object.keys(DEST_ALLOWED_NON_TEST_FILES)) {
      expect(f, `${f}는 이미 *.test.* 자동 허용 대상이라 이 목록에 중복 등재할 필요가 없음`).not.toMatch(/\.test\.tsx?$/);
    }
  });

  it('DEST_ALLOWED_NON_TEST_FILES·ENV_ALLOWED_NON_TEST_FILES 각 값(근거)은 빈 문자열이 아니다', () => {
    for (const reason of Object.values(DEST_ALLOWED_NON_TEST_FILES)) expect(reason.length).toBeGreaterThan(0);
    for (const reason of Object.values(ENV_ALLOWED_NON_TEST_FILES)) expect(reason.length).toBeGreaterThan(0);
  });

  it('ENV_NAMES·DEST_LITERALS는 story #4003/#4016/#4017 그라운딩이 확定한 값 그대로(하드코딩 재발 감지용 고정)', () => {
    expect(ENV_NAMES).toEqual(['TODAY_V3_ENABLED', 'CHAT_V3_ENABLED', 'CONNECT_RULES_V3_ENABLED']);
    expect(DEST_LITERALS).toEqual(['/today', '/org-briefing', '/chats', '/chat', '/connect-rules']);
  });
});
