/**
 * story #3305(P0 핫픽스 #3701 재발 가드, AC3) — `fetchWithAuth('/api/v2/...')`처럼 BFF
 * route(`/api/...`) 없이 백엔드 `/api/v2/*`를 직접 겨냥하는 클라이언트 호출을 막는다.
 *
 * verify-no-new-raw-fetch-api.ts(story #2689/#2691)와는 다른 결함 클래스다 — 그 가드는
 * "raw fetch() vs fetchWithAuth()"(401 재시도 유무)를 잡고, 이건 "fetchWithAuth()가
 * 맞는 유틸을 쓰고도 URL 자체가 BFF를 건너뛰는" 자리를 잡는다(#3300 실사고 — domain-labels
 * 훅이 `/api/v2/organizations/{org}/domain-labels`를 직접 호출해 Next.js에 미등록 라우트로
 * 새서(500) fetchWithAuth의 401→refresh→재시도 경로가 SessionExpiredDialog를 반복
 * 트리거했다 — dev 앱 「로그인하자마자 세션 만료」의 근본원인).
 *
 * `fetchWithAuth`는 `@/lib/db/client`의 브라우저 전용 유틸(서버사이드 파일은 절대 안 씀 —
 * 서버는 이미 자기 프로세스 안에서 backend를 직접 부를 이유가 없다·route-resolve.ts/
 * db/server.ts/agent-routing-rule.ts 등은 전부 raw `fetch`를 쓴다) — 그래서 이 판정은
 * `fetch(` 전체가 아니라 `fetchWithAuth(` 호출 하나만 봐도 false positive가 없다.
 *
 * grandfather baseline 없음(의도적) — 이 글을 쓰는 시점 codebase 전수 grep으로 기존 위반
 * 0건을 확認했다(story #3705 조사). 새로 생기는 모든 위반을 즉시 막는다.
 *
 * ⛔story #4089(2026-09-21) 정정 — 원래 판정은 `fetchWithAuth(` 바로 뒤 문자열 리터럴이
 * `/api/v2/`로 *시작*하는지만 봤다. use-material-lineage.ts 등 3개 훅은 URL을 호출부에
 * 직접 안 쓰고 `const XXX_API_PATH = '/api/v2/...'`로 한 번 거친 뒤 템플릿 리터럴
 * `` `${XXX_API_PATH}...` `` 로 보간해서 불렀다 — 리터럴이 `${`로 시작해 원 판정을
 * 구조적으로 피해 갔다(재발 가드가 있었는데도 실제 재발을 놓친 사고). 파일 내
 * `const <IDENT> = '/api/v2/...'`(top-level, 문자열 리터럴 우변만) 선언을 먼저 모으고,
 * `fetchWithAuth(\`${<IDENT>}...\`)` 형태(보간의 첫 식별자가 그 IDENT와 정확히 일치)도
 * 같은 판정에 포함한다 — IDENT가 fetchWithAuth 호출에서 실제로 안 쓰이면(다른 용도) 과판정
 * 하지 않는다(양성대조 테스트로 고정).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const EXT_RE = /\.(tsx?|ts)$/;
const TEST_RE = /\.test\.[tj]sx?$/;

const RAW_FETCH_WITH_AUTH_RE = /\bfetchWithAuth\(\s*([`'"])((?:(?!\1).)*)/g;
// story #4089 — `const <IDENT> = '/api/v2/...'`(또는 "..."/`...`) top-level 선언. 우변이
// v2 문자열 리터럴인 것만 모은다 — 다른 타입/표현식 우변은 판정 대상이 아니다.
const V2_CONST_DECL_RE = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(['"`])(\/api\/v2\/[^'"`]*)\2/g;

export interface DirectV2CallHit {
  file: string;
  urlPrefix: string;
  key: string;
}

function stablePrefix(url: string): string {
  const idx = url.indexOf('${');
  return idx === -1 ? url : url.slice(0, idx);
}

function collectV2ConstDecls(content: string): Map<string, string> {
  const decls = new Map<string, string>();
  for (const m of content.matchAll(V2_CONST_DECL_RE)) {
    decls.set(m[1]!, m[3]!);
  }
  return decls;
}

export function extractDirectV2Calls(content: string, file: string): DirectV2CallHit[] {
  const hits: DirectV2CallHit[] = [];
  const v2Consts = collectV2ConstDecls(content);
  for (const m of content.matchAll(RAW_FETCH_WITH_AUTH_RE)) {
    let url = m[2] ?? '';
    if (!url.startsWith('/api/v2/')) {
      // story #4089 — 리터럴이 `${<IDENT>}`로 시작하고 그 IDENT가 파일 안에서 v2 경로
      // 문자열로 선언돼 있으면, 그 선언값으로 치환한 뒤 같은 판정을 그대로 적용한다.
      const indirect = /^\$\{([A-Za-z_$][\w$]*)\}/.exec(url);
      const resolved = indirect ? v2Consts.get(indirect[1]!) : undefined;
      if (resolved === undefined) continue;
      url = resolved + url.slice(indirect![0].length);
    }
    const prefix = stablePrefix(url);
    hits.push({ file, urlPrefix: prefix, key: `${file}::${prefix}` });
  }
  return hits;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (path.relative(SRC_ROOT, full) === 'app/api') continue; // BFF 프록시 라우트 자신 제외(정당하게 /api/v2/*를 부른다).
      walk(full, out);
    } else if (EXT_RE.test(entry) && !TEST_RE.test(entry)) {
      out.push(full);
    }
  }
}

function main(): void {
  const files: string[] = [];
  walk(SRC_ROOT, files);

  const hits: DirectV2CallHit[] = [];
  for (const abs of files) {
    const content = readFileSync(abs, 'utf8');
    const rel = path.relative(SRC_ROOT, abs).split(path.sep).join('/');
    hits.push(...extractDirectV2Calls(content, rel));
  }

  if (hits.length > 0) {
    console.log(`\n❌ fetchWithAuth('/api/v2/*') 직접호출 ${hits.length}건 — BFF route(/api/...)를 만들고 그쪽을 부를 것(story #3300/#3701 재발):`);
    for (const h of hits.sort((a, b) => a.key.localeCompare(b.key))) {
      console.log(`  - ${h.file} → "${h.urlPrefix}"`);
    }
    process.exit(1);
  }

  console.log('OK: fetchWithAuth(\'/api/v2/*\') 직접호출 0건');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
