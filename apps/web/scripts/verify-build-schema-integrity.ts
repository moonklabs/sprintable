/**
 * story d3dd358b 회귀가드 — SaaS FE 빌드 비결정성(shared 패키지 stale dist 소비로 zod 스키마
 * 신규 필드 silent strip) 재발 방지. crux 조사(2026-07-06/07) 결론: 원 가설(package.json
 * main→dist tracing)은 이미 #1373(transpilePackages)로 해소됐고, clean-checkout 빌드로
 * 반복 재확인됨(dist 참조 0·최근 스키마 필드 정상 컴파일). 이 스크립트는 그 수기 검증을
 * CI 자동화해 향후 재발(transpilePackages 설정 훼손·dist 참조 부활 등)을 잡는다.
 *
 * 전제: `pnpm build`(루트, turbo — 실 Docker 빌드와 동일 경로)가 이미 실행돼
 * `apps/web/.next/standalone`이 존재해야 한다. 빌드 자체는 실행하지 않는다(CI에서
 * Build 스텝 뒤에 별도 스텝으로 붙임 — 중복 빌드 방지).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// process.cwd() 기준(apps/web에서 실행 전제 — package.json "verify:build-schema-integrity"
// 스크립트로 호출되거나 `pnpm --filter web ...`로 실행하면 cwd가 apps/web).
const STANDALONE_ROOT = path.resolve(process.cwd(), '.next', 'standalone');

// packages/*/dist 참조가 standalone 번들 어디에도 있으면 안 된다 — transpilePackages가
// 깨지거나 누군가 package.json main을 dist로 되돌리면 이 문자열이 다시 나타난다.
const FORBIDDEN_PATTERNS = ['packages/shared/dist', '@sprintable/shared/dist'];

// 실제로 parseBody(...)가 소비하는 shared zod 스키마의 필드 중 "최근 추가돼 stale-dist
// 클래스 버그에 걸릴 뻔했던" 대표 필드 — 컴파일 산출물에 반드시 존재해야 한다.
// (updateDocSchema.slug_locked은 이제 docs PATCH가 thin-proxy로 우회해 실사용되지 않으므로
// 대표 필드에서 제외 — 대신 실제로 parseBody 경유하는 스키마/라우트 쌍을 쓴다.)
const PROBES: { routeFile: string; mustContain: string[] }[] = [
  {
    routeFile: 'apps/web/.next/server/app/api/stories/[id]/route.js',
    mustContain: ['assignee_ids'], // updateStorySchema(PR #1226)
  },
  {
    routeFile: 'apps/web/.next/server/app/api/docs/route.js',
    mustContain: ['is_folder', 'content_format'], // createDocSchema
  },
];

function fail(message: string): never {
  console.error(`\n❌ [d3dd358b 회귀가드] ${message}\n`);
  process.exit(1);
}

function walk(dir: string, onFile: (filePath: string) => void) {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, onFile);
    else onFile(full);
  }
}

function main() {
  if (!existsSync(STANDALONE_ROOT)) {
    fail(
      `${STANDALONE_ROOT} 이 없다 — 이 스크립트 전에 \`pnpm build\`(루트)가 먼저 실행돼야 한다.`,
    );
  }

  console.log('[d3dd358b 회귀가드] .next/standalone에서 stale dist 참조 검사 중…');
  let forbiddenHit: { file: string; pattern: string } | null = null;
  walk(STANDALONE_ROOT, (filePath) => {
    if (forbiddenHit) return;
    if (!/\.(js|json)$/.test(filePath)) return;
    let content: string;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch {
      return;
    }
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (content.includes(pattern)) {
        forbiddenHit = { file: filePath, pattern };
        return;
      }
    }
  });

  if (forbiddenHit) {
    const hit = forbiddenHit as { file: string; pattern: string };
    fail(
      `stale dist 참조 발견 — ${hit.file}에 "${hit.pattern}" 포함. transpilePackages가 깨졌거나 `
      + `package.json main이 dist를 가리키도록 되돌아간 것으로 의심된다.`,
    );
  }
  console.log('  ✓ packages/*/dist 참조 0건');

  console.log('[d3dd358b 회귀가드] 대표 shared 스키마 필드 컴파일 반영 검사 중…');
  for (const probe of PROBES) {
    const fullPath = path.join(STANDALONE_ROOT, probe.routeFile);
    if (!existsSync(fullPath)) {
      fail(`${probe.routeFile}이 standalone 산출물에 없다 — 라우트 경로가 바뀌었으면 이 스크립트도 갱신 필요.`);
    }
    const content = readFileSync(fullPath, 'utf8');
    for (const field of probe.mustContain) {
      if (!content.includes(field)) {
        fail(
          `${probe.routeFile}의 컴파일 산출물에 "${field}" 필드가 없다 — shared 스키마가 `
          + `stale 상태로 번들됐을 가능성(silent field strip, story d3dd358b 클래스).`,
        );
      }
    }
    console.log(`  ✓ ${probe.routeFile}: ${probe.mustContain.join(', ')} 확인`);
  }

  console.log('\n✅ [d3dd358b 회귀가드] 전부 통과 — shared 패키지가 stale dist 없이 정상 인라인됨.\n');
}

main();
