// story #3731 — 배포 58 실사고(#3729) 재발 차단. apps/web 안 비-테스트 파일이 Docker
// 빌드 컨텍스트 밖(Dockerfile builder 스테이지 COPY 밖)을 상대 import하면 next build
// 타입체크가 죽는다 — CI(전체 체크아웃)는 이 축을 안 재서 배포 시점에야 터진다.
//
// 개발 중 두 번 틀렸다(유나 실측·2026-09-09) — 그 자리가 이 가드의 급소라 양성대조로 고정한다.
//   ① src가 아니라 «결과 경로»(dst)를 세야 한다 — packages/를 src로 잘못 세면
//     COPY --from=deps /app/packages ./packages가 빠져 packages/가 허용 밖(오탐)이 된다.
//   ② dst를 그대로 접두로 쓰면 안 된다 — `COPY package.json ./`의 dst가 이미지 루트(/app)라
//     레포 전체가 허용으로 열려 실 위반이 조용히 통과한다(가드가 아무것도 안 잡는 최악 형).
import { describe, expect, it } from 'vitest';
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
  it('apps/web 비-테스트 파일 전수 스캔 — 컨텍스트 밖 상대 import 0건(#3729 핫픽스+#3731 이관 뒤)', () => {
    const { violations, scanned } = scanRepository();
    expect(scanned).toBeGreaterThan(1000); // 유나 실측 1,233개 규모 — 큰 폭 감소는 walk 로직 회귀 신호
    expect(violations).toEqual([]);
  });
});
