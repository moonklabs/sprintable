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
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const EXT_RE = /\.(tsx?|ts)$/;
const TEST_RE = /\.test\.[tj]sx?$/;

const RAW_FETCH_WITH_AUTH_RE = /\bfetchWithAuth\(\s*([`'"])((?:(?!\1).)*)/g;

export interface DirectV2CallHit {
  file: string;
  urlPrefix: string;
  key: string;
}

function stablePrefix(url: string): string {
  const idx = url.indexOf('${');
  return idx === -1 ? url : url.slice(0, idx);
}

export function extractDirectV2Calls(content: string, file: string): DirectV2CallHit[] {
  const hits: DirectV2CallHit[] = [];
  for (const m of content.matchAll(RAW_FETCH_WITH_AUTH_RE)) {
    const url = m[2] ?? '';
    if (!url.startsWith('/api/v2/')) continue;
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
