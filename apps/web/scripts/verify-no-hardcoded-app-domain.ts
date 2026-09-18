/**
 * story #3905(PO 눈 리뷰, 3901 캡처 그라운딩) — 온보딩 1/4·조직 만들기 대화상자의 URL 슬러그
 * 미리보기 캡션이 리터럴 `sprintable.app`(실 제품 도메인 아님, 실 도메인은 sprintable.ai)을
 * 하드코딩하고 있었다 — 신규 가입자의 첫 화면에 존재하지 않는 도메인이 찍히는 첫인상 결함.
 * `apps/web/src/lib/public-app-host.ts`의 `getPublicAppHost()`(NEXT_PUBLIC_APP_URL 1원천)로
 * 옮긴 뒤의 회귀가드 — `apps/web/src` 안에 리터럴 `sprintable.app`이 새로 생기면 FAIL.
 *
 * GRANDFATHER 없음 — 이 스토리가 알려진 2곳(onboarding-form.tsx·create-organization-dialog.tsx)
 * 을 전부 고친 뒤의 첫 스캔이 0건이라 clean-slate로 연다.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const EXT_RE = /\.(tsx?|jsx?)$/;

const HARDCODED_APP_DOMAIN_RE = /sprintable\.app/g;

export interface HardcodedAppDomainHit {
  file: string;
  line: number;
  snippet: string;
}

export function findHardcodedAppDomain(content: string): { line: number; snippet: string }[] {
  const hits: { line: number; snippet: string }[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    HARDCODED_APP_DOMAIN_RE.lastIndex = 0;
    if (HARDCODED_APP_DOMAIN_RE.test(line)) hits.push({ line: i + 1, snippet: line.trim() });
  }
  return hits;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (EXT_RE.test(entry)) out.push(full);
  }
}

export function scanRepository(): HardcodedAppDomainHit[] {
  const files: string[] = [];
  walk(SRC_ROOT, files);
  const hits: HardcodedAppDomainHit[] = [];
  for (const abs of files) {
    const content = readFileSync(abs, 'utf8');
    const rel = path.relative(SRC_ROOT, abs).split(path.sep).join('/');
    for (const h of findHardcodedAppDomain(content)) hits.push({ file: rel, ...h });
  }
  return hits;
}

function main(): void {
  const hits = scanRepository();
  if (hits.length > 0) {
    console.log(`\nFAIL: 하드코딩 sprintable.app ${hits.length}건 — getPublicAppHost()(NEXT_PUBLIC_APP_URL 1원천)로 옮길 것:`);
    for (const h of hits) console.log(`  - ${h.file}:${h.line} ${h.snippet}`);
    process.exit(1);
  }
  console.log('OK: apps/web/src 안 리터럴 sprintable.app 0건');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
