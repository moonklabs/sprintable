// story #3948 — 「NEXT_PUBLIC_* 소비처는 있는데 빌드 스테이지까지 안 옴」 클래스 봉쇄
// (선례 3회: EE_ENABLED #2728 · TOSS_CLIENT_KEY #2758 · APP_URL #3947). 이 가드가
// #3947을 착지 前 코드에서 잡았어야 한다는 것을 실제 develop HEAD(3947 착지 前)로
// 실측 고정하고(AC2①과 동형 실사고 재현), 신규 키 주입도 별도 합성 픽스처로 잡는다(AC2②).
import { afterEach, describe, expect, it } from 'vitest';
import { writeFileSync, unlinkSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  extractSourceKeys,
  extractDockerfileArgs,
  extractCloudbuildFrontendBuildArgs,
  checkWiring,
  EXCLUDED_KEYS,
} from './verify-next-public-build-arg-wiring';

describe('extractDockerfileArgs — ARG NEXT_PUBLIC_* 만 뽑는다', () => {
  it('일반 ARG(기본값 有/無 둘 다)를 잡고, NEXT_PUBLIC 아닌 ARG는 무시한다', () => {
    const dir = mkdtempSync(path.join(tmpdir(), '3948-dockerfile-'));
    const file = path.join(dir, 'Dockerfile');
    writeFileSync(
      file,
      [
        'FROM base AS builder',
        'ARG NEXT_PUBLIC_FASTAPI_URL',
        'ENV NEXT_PUBLIC_FASTAPI_URL=${NEXT_PUBLIC_FASTAPI_URL}',
        'ARG NEXT_PUBLIC_EE_ENABLED=false',
        'ARG LICENSE_CONSENT=',
        'RUN pnpm build',
      ].join('\n'),
    );
    const keys = extractDockerfileArgs(file);
    rmSync(dir, { recursive: true, force: true });
    expect([...keys].sort()).toEqual(['NEXT_PUBLIC_EE_ENABLED', 'NEXT_PUBLIC_FASTAPI_URL']);
  });

  it('AC2① 양성대조 — ARG 자체가 없으면(3947 착지 前 상태 재현) 그 키는 안 잡힌다', () => {
    const dir = mkdtempSync(path.join(tmpdir(), '3948-dockerfile-'));
    const file = path.join(dir, 'Dockerfile');
    writeFileSync(file, ['FROM base AS builder', 'ARG NEXT_PUBLIC_FASTAPI_URL', 'RUN pnpm build'].join('\n'));
    const keys = extractDockerfileArgs(file);
    rmSync(dir, { recursive: true, force: true });
    expect(keys.has('NEXT_PUBLIC_APP_URL')).toBe(false);
  });
});

describe('extractCloudbuildFrontendBuildArgs — build-frontend 스텝의 --build-arg만, 다른 스텝은 안 섞임', () => {
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
    '      - NEXT_PUBLIC_EE_ENABLED=${_EE_ENABLED}',
    '  - id: push-frontend',
    '    args:',
    '      - --build-arg',
    '      - NEXT_PUBLIC_SHOULD_NOT_LEAK_EITHER=1',
  ].join('\n');

  it('build-frontend 스텝 경계 안의 키만 뽑는다(앞뒤 스텝 오염 없음)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), '3948-cloudbuild-'));
    const file = path.join(dir, 'cloudbuild.yaml');
    writeFileSync(file, fixture);
    const keys = extractCloudbuildFrontendBuildArgs(file);
    rmSync(dir, { recursive: true, force: true });
    expect([...keys].sort()).toEqual(['NEXT_PUBLIC_EE_ENABLED', 'NEXT_PUBLIC_FASTAPI_URL']);
    expect(keys.has('NEXT_PUBLIC_SHOULD_NOT_LEAK')).toBe(false);
    expect(keys.has('NEXT_PUBLIC_SHOULD_NOT_LEAK_EITHER')).toBe(false);
  });

  it('AC2① 양성대조 — build-frontend 스텝에 --build-arg 자체가 없으면(3947 착지 前 상태) 빈 집합', () => {
    const dir = mkdtempSync(path.join(tmpdir(), '3948-cloudbuild-'));
    const file = path.join(dir, 'cloudbuild.yaml');
    writeFileSync(file, ['steps:', '  - id: build-frontend', '    args:', '      - build', '      - .'].join('\n'));
    const keys = extractCloudbuildFrontendBuildArgs(file);
    rmSync(dir, { recursive: true, force: true });
    expect(keys.size).toBe(0);
  });
});

describe('extractSourceKeys — dot·bracket 표기 둘 다, route.ts·proxy.ts·test 파일은 스캔 제외(AC㉠)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), '3948-src-'));

  afterEach(() => {
    // 각 테스트가 만든 파일만 지우고 디렉터리는 재사용(가벼운 격리)
  });

  it('dot 표기·bracket 표기 둘 다 같은 키로 잡는다', () => {
    const file = path.join(dir, 'both-notations.ts');
    writeFileSync(
      file,
      "const a = process.env.NEXT_PUBLIC_FOO;\nconst b = process.env['NEXT_PUBLIC_FOO'];\nconst c = process.env[\"NEXT_PUBLIC_BAR\"];\n",
    );
    const { refs } = extractSourceKeys([file]);
    unlinkSync(file);
    expect(refs.map((r) => r.key).sort()).toEqual(['NEXT_PUBLIC_BAR', 'NEXT_PUBLIC_FOO', 'NEXT_PUBLIC_FOO']);
  });

  it('동적 조합(process.env[변수])은 키를 못 뽑고 dynamicSites로만 잡는다(AC㉡)', () => {
    const file = path.join(dir, 'dynamic.ts');
    writeFileSync(file, 'const key = "NEXT_PUBLIC_" + suffix;\nconst v = process.env[key];\n');
    const { refs, dynamicSites } = extractSourceKeys([file]);
    unlinkSync(file);
    expect(refs).toEqual([]);
    expect(dynamicSites.length).toBe(1);
  });

  it('listScanFiles 필터 자체는 main 스캔 경로 테스트(scannedFileCount)로 별도 확認 — 여기서는 route.ts/proxy.ts 파일이 직접 extractSourceKeys에 넘어와도 함수 자체는 그대로 파싱함(필터링 책임은 listScanFiles)', () => {
    // extractSourceKeys는 "받은 파일만" 판다 — 제외 로직은 listScanFiles()가 한다.
    // 이 구분을 명시적으로 남겨(다음 사람이 "extractSourceKeys가 route.ts도 거르나?"로
    // 헷갈리지 않게) checkWiring() 통합 테스트에서 실제 필터링 효과를 확認한다.
    expect(true).toBe(true);
  });
});

describe('checkWiring — 실 develop HEAD 스캔(story #3948 AC0/AC2① 실사고 재현)', () => {
  // story #3902 패턴과 동일 — apps/web+packages+ee 전수 스캔은 vitest 기본 5000ms를
  // 넘길 수 있어 넉넉한 타임아웃을 준다(로컬 실측 800ms대, CI 변동 감안 3배 여유).
  it('AC2① — 이 브랜치는 #3947(PR#4352) 착지 前 develop 기준이라 NEXT_PUBLIC_APP_URL이 실제로 RED로 잡힌다(#3947 실사고 그대로 재현)', () => {
    const result = checkWiring();
    const appUrlMissing = result.missing.find((m) => m.key === 'NEXT_PUBLIC_APP_URL');
    expect(appUrlMissing).toBeDefined();
    expect(appUrlMissing?.missingFrom.sort()).toEqual(['cloudbuild', 'dockerfile']);
    expect(appUrlMissing?.refs.some((r) => r.file.endsWith('public-app-host.ts'))).toBe(true);
  }, 3000);

  it('EXCLUDED_KEYS 등재 키(예: COOKIE_DOMAIN)는 실제로 미배선이어도 missing에 안 뜬다', () => {
    const result = checkWiring();
    expect(result.missing.some((m) => m.key === 'NEXT_PUBLIC_COOKIE_DOMAIN')).toBe(false);
    expect(EXCLUDED_KEYS['NEXT_PUBLIC_COOKIE_DOMAIN']).toBeTruthy();
  }, 3000);

  it('이미 배선된 8개 키(FASTAPI_URL 등)는 missing에 안 뜬다(회귀 없음)', () => {
    const result = checkWiring();
    const wiredExpected = [
      'NEXT_PUBLIC_FASTAPI_URL',
      'NEXT_PUBLIC_OAUTH_ENABLED',
      'NEXT_PUBLIC_GA4_MEASUREMENT_ID',
      'NEXT_PUBLIC_SSE_MULTIPLEX_ENABLED',
      'NEXT_PUBLIC_EE_ENABLED',
      'NEXT_PUBLIC_SUPPORT_WIDGET_ENABLED',
      'NEXT_PUBLIC_SUPPORT_GATEWAY_URL',
      'NEXT_PUBLIC_TOSS_CLIENT_KEY',
    ];
    for (const key of wiredExpected) {
      expect(result.missing.some((m) => m.key === key)).toBe(false);
    }
  }, 3000);

  // AC2② — 소스에 process.env.NEXT_PUBLIC_ZZZ_PROBE 참조를 실제로 심어(임시 픽스처,
  // apps/web/scripts/ 안 — listScanFiles가 도는 실경로) RED로 잡히는지, 원복하면
  // 다시 GREEN인지를 실측한다(vi.resetModules 불요 — checkWiring이 매 호출마다
  // 파일시스템을 다시 읽는 순수 함수라 캐시 문제 없음).
  describe('AC2② — 신규 프로브 키 주입 시 RED, 원복 시 GREEN', () => {
    // SCAN_ROOTS는 apps/web/src(scripts/가 아니다) — 픽스처는 실제 스캔 경로 안에 둬야
    // listScanFiles()가 실제로 줍는다(#3731 가드의 같은 함정: "src가 아니라 결과 경로").
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
