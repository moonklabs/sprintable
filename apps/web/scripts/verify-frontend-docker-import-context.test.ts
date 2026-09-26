// story #3731 — 배포 58 실사고(#3729) 재발 차단. apps/web 안 비-테스트 파일이 Docker
// 빌드 컨텍스트 밖(Dockerfile builder 스테이지 COPY 밖)을 상대 import하면 next build
// 타입체크가 죽는다 — CI(전체 체크아웃)는 이 축을 안 재서 배포 시점에야 터진다.
//
// 개발 중 두 번 틀렸다(유나 실측·2026-09-09) — 그 자리가 이 가드의 급소라 양성대조로 고정한다.
//   ① src가 아니라 «결과 경로»(dst)를 세야 한다 — packages/를 src로 잘못 세면
//     COPY --from=deps /app/packages ./packages가 빠져 packages/가 허용 밖(오탐)이 된다.
//   ② dst를 그대로 접두로 쓰면 안 된다 — `COPY package.json ./`의 dst가 이미지 루트(/app)라
//     레포 전체가 허용으로 열려 실 위반이 조용히 통과한다(가드가 아무것도 안 잡는 최악 형).
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseCopiedPrefixes,
  parseRelativeSpecifiers,
  isInsideContext,
  scanRepository,
} from './verify-frontend-docker-import-context';

describe('parseCopiedPrefixes — builder 스테이지 COPY를 «결과 경로» 기준으로 파싱한다', () => {
  it('(a) #3729 前 Dockerfile 픽스처(COPY scripts/ scripts/ 없음) — 실 사고와 동형 접두 집합', () => {
    const dockerfile = `
FROM base AS deps
WORKDIR /app
COPY package.json ./
COPY packages/ packages/
RUN pnpm install

FROM base AS builder
WORKDIR /app
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY apps/web/ apps/web/
COPY ee/ ee/
WORKDIR /app/apps/web
RUN pnpm build
`;
    const prefixes = parseCopiedPrefixes(dockerfile);
    expect(prefixes.sort()).toEqual(['apps/web', 'ee', 'node_modules', 'package.json', 'packages'].sort());
    expect(prefixes).not.toContain('scripts');
  });

  it('(b) 급소② — `COPY package.json ./`의 dst는 이미지 루트(/app)가 아니라 `package.json` 파일 하나다(레포 전체 개방 금지)', () => {
    const dockerfile = `
FROM base AS builder
WORKDIR /app
COPY package.json ./
`;
    const prefixes = parseCopiedPrefixes(dockerfile);
    expect(prefixes).toEqual(['package.json']);
    expect(prefixes).not.toContain(''); // ''는 "레포 전체 허용" — 이게 나오면 가드가 죽은 것
  });

  it('급소① — packages/는 deps 스테이지가 아니라 builder 스테이지의 `COPY --from=deps` «결과»로 잡혀야 한다', () => {
    const dockerfile = `
FROM base AS deps
WORKDIR /app
COPY packages/ packages/

FROM base AS builder
WORKDIR /app
COPY --from=deps /app/packages ./packages
`;
    const prefixes = parseCopiedPrefixes(dockerfile);
    expect(prefixes).toContain('packages');
  });

  it('WORKDIR가 바뀌면 그 뒤 COPY dst가 새 WORKDIR 기준으로 풀린다', () => {
    const dockerfile = `
FROM base AS builder
WORKDIR /app
COPY apps/web/ apps/web/
WORKDIR /app/apps/web
COPY scripts/ scripts/
`;
    const prefixes = parseCopiedPrefixes(dockerfile);
    expect(prefixes).toContain('apps/web');
    expect(prefixes).toContain('apps/web/scripts');
  });

  it('STAGE 밖(deps만 있고 builder 없음)의 COPY는 안 잡힌다(AC㉢)', () => {
    const dockerfile = `
FROM base AS deps
WORKDIR /app
COPY only-in-deps/ only-in-deps/
`;
    const prefixes = parseCopiedPrefixes(dockerfile);
    expect(prefixes).toEqual([]);
  });
});

describe('parseRelativeSpecifiers — 상대 import/require/dynamic-import 스펙만 뽑는다(AC㉠)', () => {
  it('from/require/동적 import 셋 다 잡는다', () => {
    const source = `
import { x } from '../../../scripts/y.js';
const z = require('../z.js');
const w = import('../../w.js');
import { alias } from '@/lib/thing';
import pkg from 'some-package';
`;
    const specs = parseRelativeSpecifiers(source);
    expect(specs).toEqual(['../../../scripts/y.js', '../z.js', '../../w.js']);
  });
});

describe('isInsideContext — 접두 매칭', () => {
  it('빈 문자열 접두(COPY . .류)는 전부 허용', () => {
    expect(isInsideContext('anything/deep/path.ts', [''])).toBe(true);
  });

  it('정확히 일치하거나 그 접두의 하위 경로만 허용 — 우연한 문자열 접두 매칭 배제', () => {
    expect(isInsideContext('apps/web/foo.ts', ['apps/web'])).toBe(true);
    expect(isInsideContext('apps/web2/foo.ts', ['apps/web'])).toBe(false); // "apps/web"이 "apps/web2"의 접두여도 배제
  });
});

// (c) 실사고 재현+회귀가드 — 배포 58을 일으킨 정확한 import(#3729 前 상태)를 합성 픽스처로
// 재현한다. 현재 develop(3729 착지 뒤)은 이 위반이 없어야 한다는 것도 같이 고정.
describe('scanRepository — 실 저장소 스캔(현재 develop 기준)', () => {
  // story #3902 — 부하 시 vitest 기본 5000ms를 넘길 수 있는 실 전수 스캔(측정: apps/web
  // 전체 스위트 동시부하 재현 5회 = 276·278·325·241·274ms 중 최댓값 325ms → ×3 ≈ 975ms →
  // 1000ms로 반올림). CI 리포터가 기본값이라 개별 테스트 duration이 로그에 안 남아 전체
  // 스위트 동시부하 재현치를 대체 자로 씀.
  it('apps/web 비-테스트 파일 전수 스캔 — 컨텍스트 밖 상대 import 0건(#3729 핫픽스+#3731 이관 뒤)', () => {
    const { violations, scanned } = scanRepository();
    expect(scanned).toBeGreaterThan(1000); // 유나 실측 1,233개 규모 — 큰 폭 감소는 walk 로직 회귀 신호
    expect(violations).toEqual([]);
  }, 1000);
});

// AC㉤(커밋③) — 주석 속 import 문자열은 stripComments()로 제외된다. 이 자체는 scanRepository
// 내부 파일 IO를 거치므로 여기선 parseRelativeSpecifiers+stripComments 조합을 직접 재확認한다
// (파일시스템 픽스처 없이 순수 함수 레벨에서 mutation-kill 가능하게).
describe('AC㉤ — 주석 속 import 문자열은 위반으로 안 잡힌다(story #3731 커밋③)', () => {
  it('줄 주석 안의 상대 import 문자열은 파스 대상에서 빠진다', async () => {
    const { stripComments } = await import('../../../packages/scripts/i18n-key-parser.js');
    const source = "// import { x } from '../../../scripts/dead-example.js';\nimport { y } from '../lib/real.js';";
    const specs = parseRelativeSpecifiers(stripComments(source) as string);
    expect(specs).toEqual(['../lib/real.js']);
  });

  it('블록 주석 안의 상대 import 문자열도 빠진다', async () => {
    const { stripComments } = await import('../../../packages/scripts/i18n-key-parser.js');
    const source = "/* import { x } from '../../../scripts/dead-example.js'; */\nimport { y } from '../lib/real.js';";
    const specs = parseRelativeSpecifiers(stripComments(source) as string);
    expect(specs).toEqual(['../lib/real.js']);
  });

  // scanRepository() 자신이 실제로 stripComments를 거치는지(단순 유틸 정확성이 아니라 «배선»)까지 재는 통합 테스트. mutation-kill:
  // scanRepository 안 stripComments 호출을 지우면 RED(주석 속 `../../../` import가 격리 루트 밖 = 저장소 밖으로 풀려 위반).
  // story #4333 — 예전엔 픽스처를 apps/web 실 트리에 썼다 → 같은 전체 판의 다른 실 트리 스캐너가 그 임시 파일을 세어 까닭 없이 RED.
  // 이제 os.tmpdir() 아래 격리 루트에 쓰고 scanRepository에 그 파일만 넘긴다.
  describe('scanRepository 통합 — 배선 확認(격리 루트 픽스처)', () => {
    let dir = '';
    afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

    it('주석 속 컨텍스트 밖 import는 위반으로 안 잡힌다 · 주석 밖이면 잡힌다(대조)', () => {
      dir = mkdtempSync(path.join(tmpdir(), 'docker-ctx-'));
      const inComment = path.join(dir, '__ac40-fixture.ts');
      const live = path.join(dir, '__ac40-live.ts');
      writeFileSync(inComment, "// import { x } from '../../../outside-context-in-a-comment.js';\nexport const noop = 1;\n");
      writeFileSync(live, "import { x } from '../../../outside-context-live.js';\nexport const y = x;\n");
      const { violations } = scanRepository({ files: [inComment, live] });
      expect(violations.some((v) => v.file.endsWith('__ac40-fixture.ts'))).toBe(false);
      expect(violations.some((v) => v.file.endsWith('__ac40-live.ts')), '주석 밖 import는 잡혀야 대조가 선다').toBe(true);
    });
  });
});
