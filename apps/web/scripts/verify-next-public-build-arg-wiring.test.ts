// story #3948 — 「NEXT_PUBLIC_* 소비처는 있는데 빌드 스테이지까지 안 옴」 클래스 봉쇄
// (선례 3회: EE_ENABLED #2728 · TOSS_CLIENT_KEY #2758 · APP_URL #3947).
//
// 페드루 PO CHANGES(PR#4354 리뷰 1라운드) C1 — 이 브랜치는 #3947(PR#4352) 착지 前
// develop 기준이라 실 레포 스캔은 NEXT_PUBLIC_APP_URL을 정상적으로 RED 잡는다. 그
// 사실 자체를 테스트 단언으로 못박으면 #3947 착지+rebase 뒤 이 테스트가 뒤집힌다 —
// 그래서 AC2①(ARG 부재 재현)은 실 레포가 아니라 «합성 미니 레포 픽스처»로 고정하고,
// 실 레포 통합 테스트는 `missing.length === 0`을 단언한다(#3947 착지 前엔 이 테스트가
// 실패하는 게 «정답» — 착지 순서로 푸는 것이지 가드를 느슨하게 푸는 게 아니다).
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { writeFileSync, unlinkSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  extractSourceKeys,
  extractCloudbuildFrontendBuildArgValues,
  extractCloudbuildSubstitutions,
  findBuildStageArgs,
  resolveGateValue,
  checkWiring,
  listScanFiles,
  isScannable,
  EXCLUDED_KEYS,
  FLAG_GATED_KEYS,
} from './verify-next-public-build-arg-wiring';

// ── 합성 미니 레포 픽스처 헬퍼 ───────────────────────────────────────────────
// C1 — 실 Dockerfile/cloudbuild.yaml 대신 통제된 합성 파일로 양성대조를 고정한다
// (cleanup-ci-artifacts.test.sh·run-with-stall-detection.test.sh와 동형 원칙).
function makeFixtureRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), '3948-fixture-'));
  return {
    dir,
    dockerfilePath: path.join(dir, 'Dockerfile'),
    cloudbuildPath: path.join(dir, 'cloudbuild.yaml'),
    srcPath: path.join(dir, 'src-file.ts'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const STANDARD_DOCKERFILE = [
  'FROM base AS deps',
  'WORKDIR /app',
  'RUN pnpm install',
  '',
  'FROM base AS builder',
  'WORKDIR /app',
  'ARG NEXT_PUBLIC_FASTAPI_URL',
  'ENV NEXT_PUBLIC_FASTAPI_URL=${NEXT_PUBLIC_FASTAPI_URL}',
  'RUN pnpm build',
  '',
  'FROM base AS runner',
  'WORKDIR /app',
].join('\n');

const STANDARD_CLOUDBUILD = [
  'substitutions:',
  '  _FASTAPI_URL: https://api.example.com',
  '  _FIREBASE_AUTH_ENABLED: "false"',
  'steps:',
  '  - id: build-frontend',
  '    args:',
  '      - --build-arg',
  '      - NEXT_PUBLIC_FASTAPI_URL=${_FASTAPI_URL}',
].join('\n');

describe('findBuildStageArgs — Docker ARG는 스테이지 스코프(story #3948 CHANGES①)', () => {
  it('빌드가 도는 스테이지(builder) 안 ARG만 잡는다 — 정상 구조', () => {
    const dir = mkdtempSync(path.join(tmpdir(), '3948-stage-'));
    writeFileSync(path.join(dir, 'Dockerfile'), STANDARD_DOCKERFILE);
    const result = findBuildStageArgs(path.join(dir, 'Dockerfile'));
    rmSync(dir, { recursive: true, force: true });
    expect(result.buildStageCount).toBe(1);
    expect(result.buildStageName).toBe('builder');
    expect([...result.defaults.keys()]).toEqual(['NEXT_PUBLIC_FASTAPI_URL']);
  });

  it('C2 양성대조 — 같은 키를 builder 밖(runner) 스테이지에만 두면 안 잡힌다(GREEN 오판 방지)', () => {
    const dockerfile = [
      'FROM base AS builder',
      'RUN pnpm build',
      '',
      'FROM base AS runner',
      'ARG NEXT_PUBLIC_LEAKED_INTO_WRONG_STAGE',
    ].join('\n');
    const dir = mkdtempSync(path.join(tmpdir(), '3948-stage-'));
    writeFileSync(path.join(dir, 'Dockerfile'), dockerfile);
    const result = findBuildStageArgs(path.join(dir, 'Dockerfile'));
    rmSync(dir, { recursive: true, force: true });
    expect(result.buildStageCount).toBe(1);
    expect(result.defaults.has('NEXT_PUBLIC_LEAKED_INTO_WRONG_STAGE')).toBe(false);
  });

  it('빌드 RUN이 있는 스테이지가 0개면 buildStageCount=0(호출부가 RED로 다뤄야 함)', () => {
    const dockerfile = ['FROM base AS deps', 'RUN pnpm install'].join('\n');
    const dir = mkdtempSync(path.join(tmpdir(), '3948-stage-'));
    writeFileSync(path.join(dir, 'Dockerfile'), dockerfile);
    const result = findBuildStageArgs(path.join(dir, 'Dockerfile'));
    rmSync(dir, { recursive: true, force: true });
    expect(result.buildStageCount).toBe(0);
  });

  it('빌드 RUN이 있는 스테이지가 2개면 buildStageCount=2(스테이지 구조 애매 — RED)', () => {
    const dockerfile = [
      'FROM base AS builder1',
      'RUN pnpm build',
      '',
      'FROM base AS builder2',
      'RUN next build',
    ].join('\n');
    const dir = mkdtempSync(path.join(tmpdir(), '3948-stage-'));
    writeFileSync(path.join(dir, 'Dockerfile'), dockerfile);
    const result = findBuildStageArgs(path.join(dir, 'Dockerfile'));
    rmSync(dir, { recursive: true, force: true });
    expect(result.buildStageCount).toBe(2);
  });

  it('실 apps/web/Dockerfile — 정확히 1개 빌드 스테이지(builder), 회귀가드', () => {
    const dockerfilePath = path.resolve(__dirname, '..', 'Dockerfile');
    const result = findBuildStageArgs(dockerfilePath);
    expect(result.buildStageCount).toBe(1);
    expect(result.buildStageName).toBe('builder');
  });
});

describe('extractCloudbuildFrontendBuildArgValues — build-frontend 스텝 경계·스텝 부재 감지', () => {
  it('build-frontend 스텝 안의 키=값만 뽑는다(앞뒤 스텝 오염 없음)', () => {
    const fixture = [
      'steps:',
      '  - id: build-backend',
      '    args:',
      '      - --build-arg',
      '      - NEXT_PUBLIC_SHOULD_NOT_LEAK=1',
      '  - id: build-frontend',
      '    args:',
      '      - --build-arg',
      '      - NEXT_PUBLIC_FASTAPI_URL=${_FASTAPI_URL}',
      '      - --build-arg',
      '      - NEXT_PUBLIC_LITERAL_TRUE=true',
      '  - id: push-frontend',
      '    args:',
      '      - --build-arg',
      '      - NEXT_PUBLIC_SHOULD_NOT_LEAK_EITHER=1',
    ].join('\n');
    const dir = mkdtempSync(path.join(tmpdir(), '3948-cloudbuild-'));
    const file = path.join(dir, 'cloudbuild.yaml');
    writeFileSync(file, fixture);
    const { values, stepFound } = extractCloudbuildFrontendBuildArgValues(file);
    rmSync(dir, { recursive: true, force: true });
    expect(stepFound).toBe(true);
    expect([...values.entries()].sort()).toEqual(
      [
        ['NEXT_PUBLIC_FASTAPI_URL', '${_FASTAPI_URL}'],
        ['NEXT_PUBLIC_LITERAL_TRUE', 'true'],
      ].sort(),
    );
  });

  it('AC㉤(b) — build-frontend 스텝 자체가 없으면 stepFound=false(빈 값과 구분)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), '3948-cloudbuild-'));
    const file = path.join(dir, 'cloudbuild.yaml');
    writeFileSync(file, ['steps:', '  - id: build-backend', '    args: []'].join('\n'));
    const { values, stepFound } = extractCloudbuildFrontendBuildArgValues(file);
    rmSync(dir, { recursive: true, force: true });
    expect(stepFound).toBe(false);
    expect(values.size).toBe(0);
  });
});

describe('extractCloudbuildSubstitutions·resolveGateValue — 게이트 실효값 해석', () => {
  it('substitutions 블록의 _KEY: value 쌍을 뽑는다', () => {
    const dir = mkdtempSync(path.join(tmpdir(), '3948-subs-'));
    const file = path.join(dir, 'cloudbuild.yaml');
    writeFileSync(file, STANDARD_CLOUDBUILD);
    const subs = extractCloudbuildSubstitutions(file);
    rmSync(dir, { recursive: true, force: true });
    expect(subs.get('_FIREBASE_AUTH_ENABLED')).toBe('false');
  });

  it('build-arg RHS가 ${_VAR}면 substitutions 기본값으로 해석', () => {
    const buildArgValues = new Map([['NEXT_PUBLIC_FIREBASE_AUTH_ENABLED', '${_FIREBASE_AUTH_ENABLED}']]);
    const subs = new Map([['_FIREBASE_AUTH_ENABLED', 'true']]);
    expect(resolveGateValue('NEXT_PUBLIC_FIREBASE_AUTH_ENABLED', buildArgValues, subs, new Map())).toBe('true');
  });

  it('build-arg RHS가 리터럴이면 그대로', () => {
    const buildArgValues = new Map([['NEXT_PUBLIC_FIREBASE_AUTH_ENABLED', 'true']]);
    expect(resolveGateValue('NEXT_PUBLIC_FIREBASE_AUTH_ENABLED', buildArgValues, new Map(), new Map())).toBe('true');
  });

  it('build-arg에 아예 없으면 Dockerfile ARG 기본값으로 폴백', () => {
    const dockerfileDefaults = new Map([['NEXT_PUBLIC_FIREBASE_AUTH_ENABLED', 'false']]);
    expect(resolveGateValue('NEXT_PUBLIC_FIREBASE_AUTH_ENABLED', new Map(), new Map(), dockerfileDefaults)).toBe('false');
  });

  it('어디에도 없으면 undefined(off로 취급)', () => {
    expect(resolveGateValue('NEXT_PUBLIC_UNKNOWN', new Map(), new Map(), new Map())).toBeUndefined();
  });
});

describe('extractSourceKeys — dot·bracket 표기 둘 다', () => {
  it('dot 표기·bracket 표기 둘 다 같은 키로 잡는다', () => {
    const dir = mkdtempSync(path.join(tmpdir(), '3948-src-'));
    const file = path.join(dir, 'both-notations.ts');
    writeFileSync(
      file,
      "const a = process.env.NEXT_PUBLIC_FOO;\nconst b = process.env['NEXT_PUBLIC_FOO'];\nconst c = process.env[\"NEXT_PUBLIC_BAR\"];\n",
    );
    const { refs } = extractSourceKeys([file]);
    rmSync(dir, { recursive: true, force: true });
    expect(refs.map((r) => r.key).sort()).toEqual(['NEXT_PUBLIC_BAR', 'NEXT_PUBLIC_FOO', 'NEXT_PUBLIC_FOO']);
  });

  it('동적 조합(process.env[변수])은 키를 못 뽑고 dynamicSites로만 잡는다(AC㉡)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), '3948-src-'));
    const file = path.join(dir, 'dynamic.ts');
    writeFileSync(file, 'const key = "NEXT_PUBLIC_" + suffix;\nconst v = process.env[key];\n');
    const { refs, dynamicSites } = extractSourceKeys([file]);
    rmSync(dir, { recursive: true, force: true });
    expect(refs).toEqual([]);
    expect(dynamicSites.length).toBe(1);
  });
});

// C4 — "못 틀리는 대조" 제거: route.ts/proxy.ts가 실제로 걸러지는지 listScanFiles로 실측.
describe('listScanFiles/isScannable — Route Handler·Middleware·테스트 파일 제외(AC㉠, C4)', () => {
  it('isScannable — route.ts·proxy.ts·middleware.ts·*.test.ts는 false, 일반 .ts/.tsx는 true', () => {
    expect(isScannable('/repo/apps/web/src/app/api/foo/route.ts')).toBe(false);
    expect(isScannable('/repo/apps/web/src/proxy.ts')).toBe(false);
    expect(isScannable('/repo/apps/web/src/middleware.ts')).toBe(false);
    expect(isScannable('/repo/apps/web/src/lib/foo.test.ts')).toBe(false);
    expect(isScannable('/repo/apps/web/src/lib/foo.ts')).toBe(true);
    expect(isScannable('/repo/apps/web/src/components/Bar.tsx')).toBe(true);
  });

  it('실 레포 스캔 결과에 route.ts·proxy.ts·middleware.ts가 단 하나도 없다(필터가 실제로 배선됐는지)', () => {
    const files = listScanFiles();
    expect(files.length).toBeGreaterThan(500); // 회귀 감지용 하한(현재 881개 규모)
    expect(files.some((f) => /[\\/]route\.tsx?$/.test(f))).toBe(false);
    expect(files.some((f) => /(^|[\\/])(proxy|middleware)\.tsx?$/.test(f))).toBe(false);
  }, 3000);
});

// C1 — AC2① 양성대조를 실 레포 시점 의존 없이 합성 미니 레포로 고정.
describe('checkWiring — 합성 미니 레포 픽스처(AC2①②③, 시점 무관 고정)', () => {
  it('AC2① — Dockerfile에 ARG 자체가 없으면(3947 착지 前 실사고 형) 그 키가 RED로 뜬다', () => {
    const f = makeFixtureRepo();
    writeFileSync(f.dockerfilePath, STANDARD_DOCKERFILE); // NEXT_PUBLIC_APP_URL ARG 없음
    writeFileSync(f.cloudbuildPath, STANDARD_CLOUDBUILD); // build-arg에도 없음
    writeFileSync(f.srcPath, "export const host = process.env.NEXT_PUBLIC_APP_URL;\n");
    const result = checkWiring({ files: [f.srcPath], dockerfilePath: f.dockerfilePath, cloudbuildPath: f.cloudbuildPath });
    f.cleanup();
    const appUrl = result.missing.find((m) => m.key === 'NEXT_PUBLIC_APP_URL');
    expect(appUrl).toBeDefined();
    expect(appUrl?.missingFrom.sort()).toEqual(['cloudbuild', 'dockerfile']);
  });

  it('이미 정상 배선된 키(FASTAPI_URL)는 missing에 안 뜬다(합성 픽스처, 회귀 없음)', () => {
    const f = makeFixtureRepo();
    writeFileSync(f.dockerfilePath, STANDARD_DOCKERFILE);
    writeFileSync(f.cloudbuildPath, STANDARD_CLOUDBUILD);
    writeFileSync(f.srcPath, "export const api = process.env.NEXT_PUBLIC_FASTAPI_URL;\n");
    const result = checkWiring({ files: [f.srcPath], dockerfilePath: f.dockerfilePath, cloudbuildPath: f.cloudbuildPath });
    f.cleanup();
    expect(result.missing).toEqual([]);
  });

  // AC2② — 신규 프로브 키 주입.
  it('AC2② — 신규 키 참조를 심으면 즉시 RED(무관 키 이름 아무거나 — 회귀 감지가 이름에 안 묶임)', () => {
    const f = makeFixtureRepo();
    writeFileSync(f.dockerfilePath, STANDARD_DOCKERFILE);
    writeFileSync(f.cloudbuildPath, STANDARD_CLOUDBUILD);
    writeFileSync(f.srcPath, 'export const probe = process.env.NEXT_PUBLIC_ZZZ_PROBE;\n');
    const result = checkWiring({ files: [f.srcPath], dockerfilePath: f.dockerfilePath, cloudbuildPath: f.cloudbuildPath });
    f.cleanup();
    expect(result.missing.some((m) => m.key === 'NEXT_PUBLIC_ZZZ_PROBE')).toBe(true);
  });

  // AC2③(C3) — 플래그 true인데 종속키가 없으면 RED.
  it('AC2③ — FLAG_GATED_KEYS 게이트가 build-arg에서 true로 배선되고 종속키가 0개면 4키 전부 RED', () => {
    const f = makeFixtureRepo();
    writeFileSync(f.dockerfilePath, STANDARD_DOCKERFILE);
    writeFileSync(
      f.cloudbuildPath,
      [
        'substitutions:',
        '  _FASTAPI_URL: https://api.example.com',
        'steps:',
        '  - id: build-frontend',
        '    args:',
        '      - --build-arg',
        '      - NEXT_PUBLIC_FASTAPI_URL=${_FASTAPI_URL}',
        '      - --build-arg',
        '      - NEXT_PUBLIC_FIREBASE_AUTH_ENABLED=true',
      ].join('\n'),
    );
    writeFileSync(
      f.srcPath,
      [
        "export const a = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;",
        "export const b = process.env.NEXT_PUBLIC_FIREBASE_APP_ID;",
        "export const c = process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN;",
        "export const d = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;",
      ].join('\n'),
    );
    const result = checkWiring({ files: [f.srcPath], dockerfilePath: f.dockerfilePath, cloudbuildPath: f.cloudbuildPath });
    f.cleanup();
    for (const key of Object.values(FLAG_GATED_KEYS)[0]!) {
      expect(result.missing.some((m) => m.key === key)).toBe(true);
    }
  });

  it('게이트가 off(합성 픽스처, 기본 false)면 종속키가 없어도 missing에 안 뜬다', () => {
    const f = makeFixtureRepo();
    writeFileSync(f.dockerfilePath, STANDARD_DOCKERFILE);
    writeFileSync(f.cloudbuildPath, STANDARD_CLOUDBUILD); // _FIREBASE_AUTH_ENABLED: "false"인데 사실 build-arg에 참조도 안 함 → resolveGateValue undefined → off 취급
    writeFileSync(f.srcPath, 'export const a = process.env.NEXT_PUBLIC_FIREBASE_API_KEY;\n');
    const result = checkWiring({ files: [f.srcPath], dockerfilePath: f.dockerfilePath, cloudbuildPath: f.cloudbuildPath });
    f.cleanup();
    expect(result.missing.some((m) => m.key === 'NEXT_PUBLIC_FIREBASE_API_KEY')).toBe(false);
  });

  it('빌드 스테이지가 0개/2개면 dockerfileStageError가 채워진다(RED 신호)', () => {
    const f = makeFixtureRepo();
    writeFileSync(f.dockerfilePath, ['FROM base AS deps', 'RUN pnpm install'].join('\n'));
    writeFileSync(f.cloudbuildPath, STANDARD_CLOUDBUILD);
    writeFileSync(f.srcPath, 'export const noop = 1;\n');
    const result = checkWiring({ files: [f.srcPath], dockerfilePath: f.dockerfilePath, cloudbuildPath: f.cloudbuildPath });
    f.cleanup();
    expect(result.dockerfileStageError).not.toBeNull();
  });

  it('cloudbuild.yaml에 build-frontend 스텝이 없으면 cloudbuildStepMissing=true', () => {
    const f = makeFixtureRepo();
    writeFileSync(f.dockerfilePath, STANDARD_DOCKERFILE);
    writeFileSync(f.cloudbuildPath, ['steps:', '  - id: build-backend', '    args: []'].join('\n'));
    writeFileSync(f.srcPath, 'export const noop = 1;\n');
    const result = checkWiring({ files: [f.srcPath], dockerfilePath: f.dockerfilePath, cloudbuildPath: f.cloudbuildPath });
    f.cleanup();
    expect(result.cloudbuildStepMissing).toBe(true);
  });
});

// C5 — 실 레포 전수 스캔은 describe당 1회만(story #4346 클래스: 반복 스캔이 CI RED를 냄).
describe('checkWiring — 실 develop HEAD 통합(1회 계산 공유, story #4346 패턴)', () => {
  let sharedResult: ReturnType<typeof checkWiring>;

  // story #3902/#4346 패턴 — 전수 스캔(881파일)은 vitest 기본 5000ms를 넘길 수 있어
  // 넉넉한 예산을 준다(로컬 실측 800ms대, CI 변동 감안 3배 여유).
  beforeAll(() => {
    sharedResult = checkWiring();
  }, 3000);

  // C1 — #3947(PR#4352) 착지 前엔 이 단언이 실패하는 게 «정답»이다(가드가 실제로
  // 재는 그 실사고를 지금 이 순간 잡고 있다는 뜻). 착지+rebase 뒤 GREEN 전환.
  it('AC4 — 삼자 대조 미배선 키 0건(#3947/PR#4352 착지+rebase 後 GREEN 전제)', () => {
    expect(sharedResult.missing).toEqual([]);
  });

  it('EXCLUDED_KEYS 등재 키(예: COOKIE_DOMAIN)는 실제로 미배선이어도 missing에 안 뜬다', () => {
    expect(sharedResult.missing.some((m) => m.key === 'NEXT_PUBLIC_COOKIE_DOMAIN')).toBe(false);
    expect(EXCLUDED_KEYS['NEXT_PUBLIC_COOKIE_DOMAIN']).toBeTruthy();
  });

  it('FLAG_GATED_KEYS(FIREBASE_AUTH_ENABLED 게이트, 현재 develop에서 off) 종속키도 missing에 안 뜬다', () => {
    for (const key of [
      'NEXT_PUBLIC_FIREBASE_AUTH_ENABLED',
      ...FLAG_GATED_KEYS['NEXT_PUBLIC_FIREBASE_AUTH_ENABLED']!,
    ]) {
      expect(sharedResult.missing.some((m) => m.key === key)).toBe(false);
    }
  });

  it('Dockerfile 빌드 스테이지·cloudbuild 스텝 둘 다 정상 발견됨(실 레포)', () => {
    expect(sharedResult.dockerfileStageError).toBeNull();
    expect(sharedResult.cloudbuildStepMissing).toBe(false);
  });

  // AC2② — 실 레포 경로에 프로브 키를 실제로 심어(임시 픽스처, listScanFiles가 도는
  // 실경로) RED로 잡히는지, 원복하면 다시 사라지는지 — 이 케이스만 파일시스템을
  // 건드리므로 beforeAll 공유 결과와 별도로 자기만의 checkWiring() 호출을 쓴다.
  describe('AC2② — 실 레포 경로 프로브 주입(원복 시 no-op)', () => {
    const fixturePath = path.resolve(__dirname, '../src/__3948-probe-fixture.ts');

    afterEach(() => {
      if (existsSync(fixturePath)) unlinkSync(fixturePath);
    });

    it('process.env.NEXT_PUBLIC_ZZZ_PROBE 참조를 심으면 missing에 즉시 뜬다', () => {
      writeFileSync(fixturePath, 'export const probe = process.env.NEXT_PUBLIC_ZZZ_PROBE;\n');
      const result = checkWiring();
      const probe = result.missing.find((m) => m.key === 'NEXT_PUBLIC_ZZZ_PROBE');
      expect(probe).toBeDefined();
      expect(probe?.refs.some((r) => r.file.endsWith('__3948-probe-fixture.ts'))).toBe(true);
    }, 3000);

    it('픽스처를 지우면(원복) 더 이상 안 뜬다 — 무관 PR no-op', () => {
      writeFileSync(fixturePath, 'export const probe = process.env.NEXT_PUBLIC_ZZZ_PROBE;\n');
      unlinkSync(fixturePath);
      const result = checkWiring();
      expect(result.missing.some((m) => m.key === 'NEXT_PUBLIC_ZZZ_PROBE')).toBe(false);
    }, 3000);
  });
});
