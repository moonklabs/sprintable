/**
 * story #2484 — advisory 넛지(⛔blocker 아님, PO 확定): FE가 `error?.code`를 안 갈라
 * 서버 raw `error.message`/`json.detail`을 그대로 화면에 노출하는 자리가 #2441·#2470·
 * create-organization-dialog로 3번 반복됐다(같은 병).
 *
 * 이 스크립트는 그 병의 «85% 단순형»(주변에 `.code` 토큰이 아예 없는 경우)만 정밀하게
 * 잡는 grep tripwire다. 나머지 15%(code 체크는 있는데 그 분기 자체가 raw를 쓰는 경우·
 * 의도적 raw 노출 정책·구조상 절대 안 새는 죽은 필드 오탐)는 grep으로 못 가른다 —
 * `raw-error-message-baseline.json`에 그 파일들을 등재해 놓쳐도 되는 것으로 다룬다.
 *
 * ⛔이 스크립트는 CI를 실패시키지 않는다(항상 exit 0) — PO 확定: "advisory 넛지, blocker
 * 아님". baseline 밖의 «새» 자리가 나오면 로그로만 알린다. baseline에 없는 새 파일이
 * 이 패턴으로 새로 생기면, 리뷰어가 이 로그를 보고 판단한다(#2441/#2470/create-org와
 * 같은 병인지 사람이 확認).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const BASELINE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), './raw-error-message-baseline.json');

const RAW_PATTERN = /\berror\??\.\s*message\b|\bjson\??\.\s*detail\b/;
const CODE_TOKEN = /\.code\b/;
const CONTEXT_WINDOW = 15;

interface Baseline {
  knownDebt: string[];
  deliberateByDesign: string[];
  deadFieldFalsePositive: string[];
  reviewedSafe: string[];
}

function loadBaseline(): Set<string> {
  const raw = JSON.parse(readFileSync(BASELINE_PATH, 'utf-8')) as Baseline;
  return new Set([...raw.knownDebt, ...raw.deliberateByDesign, ...raw.deadFieldFalsePositive, ...raw.reviewedSafe]);
}

function listTsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === '.next') continue;
      out.push(...listTsxFiles(full));
    } else if (/\.tsx$/.test(entry) && !entry.endsWith('.test.tsx')) {
      out.push(full);
    }
  }
  return out;
}

export interface RawErrorFinding {
  relPath: string;
  line: number;
}

export function findRawErrorSites(files: { relPath: string; content: string }[]): RawErrorFinding[] {
  const findings: RawErrorFinding[] = [];
  for (const { relPath, content } of files) {
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (!RAW_PATTERN.test(lines[i]!)) continue;
      const start = Math.max(0, i - CONTEXT_WINDOW);
      const end = Math.min(lines.length, i + CONTEXT_WINDOW);
      const window = lines.slice(start, end).join('\n');
      if (CODE_TOKEN.test(window)) continue; // 근처에 .code 분기가 있으면 85% 형태가 아니다 — 넘어간다.
      findings.push({ relPath, line: i + 1 });
    }
  }
  return findings;
}

function main(): number {
  const baseline = loadBaseline();
  const appDir = path.join(SRC_ROOT, 'app');
  const componentsDir = path.join(SRC_ROOT, 'components');
  const files = [...listTsxFiles(appDir), ...listTsxFiles(componentsDir)].map((abs) => ({
    relPath: `src/${path.relative(SRC_ROOT, abs)}`,
    content: readFileSync(abs, 'utf-8'),
  }));

  const findings = findRawErrorSites(files);
  const newFindings = findings.filter((f) => !baseline.has(f.relPath));
  const baselineHits = new Set(findings.filter((f) => baseline.has(f.relPath)).map((f) => f.relPath));

  console.log(`[story #2484 advisory] error.code 미분기 raw 노출 패턴(단순형) 스캔 — 파일 ${files.length}개`);
  console.log(`  baseline 등재 ${baselineHits.size}개 파일(알려진 채무, #2485에서 정리 예정) — 넛지 대상 아님`);

  if (newFindings.length === 0) {
    console.log('OK: baseline 밖의 새 자리 0건.');
    return 0;
  }

  console.log(`\n⚠️  ${newFindings.length}건 — baseline 밖의 새 자리(리뷰어 확認 권장, blocker 아님):`);
  for (const f of newFindings) {
    console.log(`  - ${f.relPath}:${f.line}`);
  }
  console.log('\n#2441/#2470/create-organization-dialog와 같은 병(error.code 미분기 raw 노출)인지 리뷰에서 사람이 판단한다.');
  return 0; // advisory — CI를 절대 실패시키지 않는다(PO 確定).
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
