/**
 * story d3dd358b 회귀가드 — SaaS FE 빌드 비결정성(shared 패키지 stale dist 소비로 zod 스키마
 * 신규 필드 silent strip) 재발 방지. crux 조사(2026-07-06/07) 결론: 원 가설(package.json
 * main→dist tracing)은 이미 #1373(transpilePackages)로 해소됐고, clean-checkout 빌드로
 * 반복 재확인됨(dist 참조 0·최근 스키마 필드 정상 컴파일). 이 스크립트는 그 수기 검증을
 * CI 자동화해 향후 재발(transpilePackages 설정 훼손·dist 참조 부활 등)을 잡는다.
 *
 * story #3863(2026-09-14) 회귀가드 — PR #4272(story #3857)에서 CI가 거짓 RED를 냈다: probe가
 * `stories/[id]/route.js` **단일 파일**의 문자열만 봤는데, 그 route가 소비하는 shared
 * zod 스키마(updateStorySchema)가 번들러의 공용 chunk 분할 결정에 따라 route.js 파일
 * "안"이 아니라 별도 `.next/server/chunks/*.js`로 호이스팅될 수 있다(lib 파일이 커지거나
 * 여러 route가 같은 의존성을 공유하면 웹팩/터보팩이 그렇게 쪼갠다 — 정상적인 코드 스플리팅,
 * stale-dist 버그가 아니다). AC0 그라운딩(2026-09-14, 미르코) — `route.js.nft.json`(Next.js
 * Node File Trace 산출물, standalone 서버가 실행 시점에 실제로 필요로 하는 파일 전체 목록)이
 * `chunks/23166.js`·`chunks/31655.js`를 열거하고, 그 청크들이 실제로 "assignee_ids"를 담고
 * 있음을 실측 확인(가설 참) — probe를 **route.js + 그 route가 nft.json에 열거한 required
 * chunk 파일들**의 합집합으로 넓힌다(stale-dist FORBIDDEN_PATTERNS 검사는 무변 — 그건 이미
 * 트리 전체를 본다).
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
export const FORBIDDEN_PATTERNS = ['packages/shared/dist', '@sprintable/shared/dist'];

export interface Probe {
  routeFile: string;
  mustContain: string[];
}

// 실제로 parseBody(...)가 소비하는 shared zod 스키마의 필드 중 "최근 추가돼 stale-dist
// 클래스 버그에 걸릴 뻔했던" 대표 필드 — 컴파일 산출물(route.js 또는 그 route가 require하는
// chunk)에 반드시 존재해야 한다.
// (updateDocSchema.slug_locked은 이제 docs PATCH가 thin-proxy로 우회해 실사용되지 않으므로
// 대표 필드에서 제외 — 대신 실제로 parseBody 경유하는 스키마/라우트 쌍을 쓴다.)
export const PROBES: Probe[] = [
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

interface NftManifest {
  files?: string[];
}

/** story #3863(AC1) — `<routeFile>.nft.json`(Next.js Node File Trace, standalone 서버가
 * 실행 시점에 실제로 require하는 파일 전체 목록)에서 `.next/server/chunks/*.js` 항목만
 * 골라 절대경로로 돌려준다. nft.json이 없거나(구버전 산출물·경로 오류) 파싱에 실패하면
 * 빈 배열 — 그 경우 findMissingProbeFields는 route.js 단독 검사로 자연히 낙하한다(가드가
 * 조용히 통과하는 대신 route.js 자체에서 못 찾으면 여전히 FAIL — fail-open 아님, 기존
 * 검사 범위의 하한을 보존한다는 뜻일 뿐).
 */
export function loadNftRequiredChunkFiles(routeAbsPath: string): string[] {
  const nftPath = `${routeAbsPath}.nft.json`;
  if (!existsSync(nftPath)) return [];
  let parsed: NftManifest;
  try {
    parsed = JSON.parse(readFileSync(nftPath, 'utf8')) as NftManifest;
  } catch {
    return [];
  }
  const dir = path.dirname(routeAbsPath);
  return (parsed.files ?? [])
    .filter((f) => f.includes('/chunks/') && f.endsWith('.js'))
    .map((f) => path.resolve(dir, f));
}

/** route.js 자신 + 그 route의 nft.json이 열거한 required chunk 파일들(존재하는 것만) —
 * 이 목록의 합집합이 probe의 검사 대상이다(호이스팅 대응, story #3863 AC1). */
export function filesToCheckForProbe(standaloneRoot: string, probe: Probe): string[] {
  const routeAbs = path.join(standaloneRoot, probe.routeFile);
  const candidates = [routeAbs, ...loadNftRequiredChunkFiles(routeAbs)];
  return candidates.filter((f) => existsSync(f));
}

export interface ProbeCheckResult {
  missing: string[];
  checkedFiles: string[];
}

/** probe.mustContain의 각 필드가 route.js나 그 required chunk들 «어디든 하나에»라도 있으면
 * 통과 — 어느 파일에 실렸는지는 번들러의 코드 스플리팅 결정(구현 세부사항)이라 가드가
 * 신경 쓰지 않는다. 전부 안 보이면(route.js도, required chunk 전부도 안 보이면) missing에
 * 실린다. */
export function findMissingProbeFields(standaloneRoot: string, probe: Probe): ProbeCheckResult {
  const checkedFiles = filesToCheckForProbe(standaloneRoot, probe);
  const combined = checkedFiles.map((f) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } }).join('\n');
  const missing = probe.mustContain.filter((field) => !combined.includes(field));
  return { missing, checkedFiles };
}

function main(): number {
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

  console.log('[d3dd358b 회귀가드] 대표 shared 스키마 필드 컴파일 반영 검사 중(route.js + required chunks)…');
  for (const probe of PROBES) {
    const routeAbs = path.join(STANDALONE_ROOT, probe.routeFile);
    if (!existsSync(routeAbs)) {
      fail(`${probe.routeFile}이 standalone 산출물에 없다 — 라우트 경로가 바뀌었으면 이 스크립트도 갱신 필요.`);
    }
    const { missing, checkedFiles } = findMissingProbeFields(STANDALONE_ROOT, probe);
    const checkedRel = checkedFiles.map((f) => path.relative(STANDALONE_ROOT, f));
    if (missing.length > 0) {
      fail(
        `${probe.routeFile}(+ required chunks)의 컴파일 산출물에 "${missing.join(', ')}" 필드가 없다 — ` +
          `shared 스키마가 stale 상태로 번들됐을 가능성(silent field strip, story d3dd358b 클래스).\n` +
          `  검사한 파일(${checkedRel.length}개): ${checkedRel.join(', ')}`,
      );
    }
    console.log(`  ✓ ${probe.routeFile}(+ required chunks ${checkedRel.length - 1}개): ${probe.mustContain.join(', ')} 확인`);
  }

  console.log('\n✅ [d3dd358b 회귀가드] 전부 통과 — shared 패키지가 stale dist 없이 정상 인라인됨.\n');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
