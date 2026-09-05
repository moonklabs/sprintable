/**
 * story #3493(3436 묶음 9 후속, PO 確定 2026-09-05) — story #3486(#3834)이 마케팅
 * 콘텐츠·채널 연결 4 디렉터리(content/**·organization/channels/**·components/content/**·
 * components/channel-connect/**)만 가드하던 것을 **apps/web/src 전체**로 넓힌다. 그때
 * 미르코가 센 «범위 밖» 20+곳(PR #3834 본문 목록)이 이 스토리에서 자리마다 기록/약속으로
 * 갈라 정본 함수(formatRelativeTime/formatScheduledAt)로 전환됐다 — 전환 표는 PR #3493
 * 본문 참조.
 *
 * 이름도 스코프에 맞춰 개명한다: `verify:no-date-tolocalestring-marketing-surface` →
 * `verify:no-date-tolocalestring`. 옛 이름이 package.json/CI에 다시 등장하지 않는지는
 * 이 파일이 아니라 그 두 파일 자체를 보는 테스트(verify-no-date-tolocalestring.test.ts)가
 * 검산한다.
 *
 * 판정은 여전히 순수 문자열/줄 단위 grep이다(AST 파싱 미도입 — 기존 3486 가드와 동일
 * 한계 승계). ⛔이 가드가 못 보는 것(선언, 3486 원 문서와 동형) — ①주석·문자열 리터럴
 * 안의 단순 언급(테스트 파일은 이미 제외) ②숫자 포맷(`.toLocaleString('ko-KR')`류 —
 * krw·포인트 잔액 등)은 날짜가 아니지만 메서드명만으로는 날짜 호출과 구분이 안 되므로,
 * 알려진 소비처는 ALLOWLIST에 **file+line**으로 등재해 예외 처리한다(사유 없는 예외
 * 금지 — HANJA_EXCEPTIONS와 동형 원칙, reason·addedBy 필수). 등재분 4건은 이 스토리
 * grep으로 전수 확인한 값이다(rewards 포인트 잔액 2·ee billing KRW/AU 수량 2).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const EXT_RE = /\.(tsx?|ts)$/;
const TEST_RE = /\.test\.[tj]sx?$/;

const LOCALE_DATE_CALL_RE = /\.(toLocaleString|toLocaleDateString|toLocaleTimeString)\(/g;

export interface DateToLocaleStringHit {
  file: string;
  line: number;
}

export interface AllowlistEntry {
  file: string;
  line: number;
  reason: string;
  addedBy: string;
}

// story #3493 AC2 — 날짜가 아니라 숫자 포맷인 것으로 이 스토리에서 grep 전수 확인한 4곳.
// 새 항목을 등재하려면 reason·addedBy를 반드시 채울 것(사유 없는 예외 금지).
export const ALLOWLIST: AllowlistEntry[] = [
  { file: 'app/(authenticated)/rewards/page.tsx', line: 153, reason: '포인트 잔액(TJSB) 숫자 포맷 — 날짜 아님', addedBy: 'story #3493' },
  { file: 'app/(authenticated)/rewards/page.tsx', line: 224, reason: '포인트 잔액(TJSB) 숫자 포맷 — 날짜 아님', addedBy: 'story #3493' },
  { file: 'ee/components/billing/pricing-data.ts', line: 130, reason: 'KRW 금액 숫자 포맷(formatKrw) — 날짜 아님', addedBy: 'story #3493' },
  { file: 'ee/components/billing/billing-tab.tsx', line: 665, reason: '자동화 크레딧(AU) 수량 숫자 포맷 — 날짜 아님', addedBy: 'story #3493' },
];

function isAllowed(file: string, line: number): boolean {
  return ALLOWLIST.some((e) => e.file === file && e.line === line);
}

export function extractHits(content: string, file: string): DateToLocaleStringHit[] {
  const hits: DateToLocaleStringHit[] = [];
  const lines = content.split('\n');
  lines.forEach((lineText, i) => {
    LOCALE_DATE_CALL_RE.lastIndex = 0;
    if (LOCALE_DATE_CALL_RE.test(lineText) && !isAllowed(file, i + 1)) hits.push({ file, line: i + 1 });
  });
  return hits;
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (EXT_RE.test(entry) && !TEST_RE.test(entry)) {
      out.push(full);
    }
  }
}

function main(): number {
  const files: string[] = [];
  walk(SRC_ROOT, files);

  const hits: DateToLocaleStringHit[] = [];
  for (const abs of files) {
    const content = readFileSync(abs, 'utf8');
    const rel = path.relative(SRC_ROOT, abs).split(path.sep).join('/');
    hits.push(...extractHits(content, rel));
  }

  if (hits.length > 0) {
    console.log(`\n❌ apps/web/src 안 날짜 toLocaleString류 ${hits.length}건(story #3493 — formatRelativeTime(기록)/formatScheduledAt(약속) 정본을 쓸 것. 숫자 포맷이면 ALLOWLIST에 file+line+reason+addedBy로 등재):`);
    for (const h of hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
      console.log(`  - ${h.file}:${h.line}`);
    }
    return 1;
  }

  console.log(`OK: apps/web/src 안 날짜 toLocaleString류 0건(ALLOWLIST ${ALLOWLIST.length}건 제외 — 숫자 포맷)`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
