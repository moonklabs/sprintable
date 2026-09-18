/**
 * story #3557(유나 §17-20① 확定, 페드루 PO 2026-09-06) — 「목록 안 반복 컨트롤의
 * aria-label을 하드코딩 영문 템플릿 리터럴로 짓지 않는다」를 정적 스캔으로 고정한다.
 * #3899가 TagChip 하나를 i18n 키로 옮겼는데 같은 부류 3곳(content-rules 이동 버튼 2·
 * story-detail-panel 라벨 제거 1)이 유나 §17 #3912 리뷰 中 전수에서 뒤늦게 드러났다 —
 * "같은 이유로 …전부" 규율(#3899 리뷰가 스코프를 TagChip 파일 하나로 좁혀 놓친 클래스).
 *
 * 판별 = PO 지정 그대로: `aria-label={`` 뒤에 영문 대문자로 시작하는 템플릿 리터럴이
 * 오는 자리(`` `Move ${item} up` ``류) — t(...) 호출은 이 모양에 안 걸린다.
 *
 * GRANDFATHER 없음 — #3557이 알려진 3곳을 전부 고친 뒤의 첫 스캔이 0건이라 clean-slate로
 * 연다(#2367/#2376류와 달리 "고칠 수 없는 기존 채무"가 없다). 새로 생기면 즉시 FAIL.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const EXT_RE = /\.(tsx?|jsx?)$/;
const TEST_RE = /\.(test|spec)\.[tj]sx?$/;

// aria-label={`Xyz...`} — 템플릿 리터럴이 영문 대문자로 시작. t('key') 호출이나
// 한국어 문자열(§17-20 낱말 축은 한국어가 기본이라 이 스캔의 관심사가 아니다)은
// 이 모양에 안 걸린다.
const HARDCODED_ARIA_LABEL_RE = /aria-label=\{`[A-Z]/g;

export interface HardcodedAriaLabelHit {
  file: string;
  line: number;
  snippet: string;
}

export function findHardcodedAriaLabels(content: string): { line: number; snippet: string }[] {
  const hits: { line: number; snippet: string }[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    HARDCODED_ARIA_LABEL_RE.lastIndex = 0;
    if (HARDCODED_ARIA_LABEL_RE.test(line)) hits.push({ line: i + 1, snippet: line.trim() });
  }
  return hits;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (EXT_RE.test(entry) && !TEST_RE.test(entry)) out.push(full);
  }
}

export function scanRepository(): HardcodedAriaLabelHit[] {
  const files: string[] = [];
  walk(SRC_ROOT, files);
  const hits: HardcodedAriaLabelHit[] = [];
  for (const abs of files) {
    const content = readFileSync(abs, 'utf8');
    const rel = path.relative(SRC_ROOT, abs).split(path.sep).join('/');
    for (const h of findHardcodedAriaLabels(content)) hits.push({ file: rel, ...h });
  }
  return hits;
}

function main(): void {
  const hits = scanRepository();
  if (hits.length > 0) {
    console.log(`\n❌ 하드코딩 영문 aria-label ${hits.length}건 — t(...) i18n 키로 옮길 것:`);
    for (const h of hits) console.log(`  - ${h.file}:${h.line} ${h.snippet}`);
    process.exit(1);
  }
  console.log('OK: 하드코딩 영문 aria-label 0건');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
