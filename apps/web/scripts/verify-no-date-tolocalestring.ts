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
 * 알려진 소비처는 ALLOWLIST에 등재해 예외 처리한다(사유 없는 예외 금지 — HANJA_
 * EXCEPTIONS와 동형 원칙, reason·addedBy 필수). 등재분 4건은 이 스토리 grep으로
 * 전수 확인한 값이다(rewards 포인트 잔액 2·ee billing KRW/AU 수량 2).
 *
 * story #3611(CI 후속, #3609와 같은 클래스) — 허용 목록이 원래 file+line(줄번호) 키였다.
 * #3609 실사고(3592가 events/page.tsx에 줄을 추가하자 그 파일의 뒷줄 2개가 줄번호만
 * 밀려 develop·열린 PR 전부 거짓 빨강)와 정확히 같은 구조적 위험 — 이 4파일 어디든
 * 무관한 줄이 허용 줄 «위»에 추가되는 순간 이 가드도 똑같이 깨진다. 키를 «파일 +
 * strip한 줄 내용 완전 일치»로 바꾼다(lint_fe_error_envelope_detail_mismatch.py의
 * #3609 처방과 동형) — 줄번호가 몇 번이든 그 파일에 그 정확한 텍스트가 있으면 허용.
 * reason·addedBy 구조 필드는 이 파일의 기존 관례(HANJA_EXCEPTIONS 동형)를 그대로
 * 유지한다 — #3609가 인라인 주석으로 사유를 적은 것과 달리 여기는 이미 구조화된
 * 필드가 있어 그걸 없앨 이유가 없다(둘 다 "사유 필수"라는 같은 목적, 형만 다름).
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
  /** story #3611 — 줄번호가 아니라 그 줄의 strip()된 내용 전체 일치(키가 «파일+내용»
   * 이라 위쪽에 무관한 줄이 추가돼 실제 줄번호가 밀려도 안 깨진다). */
  lineContent: string;
  reason: string;
  addedBy: string;
}

// story #3493 AC2 — 날짜가 아니라 숫자 포맷인 것으로 이 스토리에서 grep 전수 확인한 4곳.
// 새 항목을 등재하려면 reason·addedBy를 반드시 채울 것(사유 없는 예외 금지).
// story #3611 — lineContent는 develop 원문 그대로를 strip()해 등재(줄번호 무관).
export const ALLOWLIST: AllowlistEntry[] = [
  { file: 'app/(authenticated)/rewards/page.tsx', lineContent: "{e.balance >= 0 ? '+' : ''}{e.balance.toLocaleString()} TJSB", reason: '포인트 잔액(TJSB) 숫자 포맷 — 날짜 아님', addedBy: 'story #3493' },
  { file: 'app/(authenticated)/rewards/page.tsx', lineContent: "{e.amount >= 0 ? '+' : ''}{e.amount.toLocaleString()} TJSB", reason: '포인트 잔액(TJSB) 숫자 포맷 — 날짜 아님', addedBy: 'story #3493' },
  { file: 'ee/components/billing/pricing-data.ts', lineContent: "return `${krw.toLocaleString('ko-KR')}원`;", reason: 'KRW 금액 숫자 포맷(formatKrw) — 날짜 아님', addedBy: 'story #3493' },
  { file: 'ee/components/billing/billing-tab.tsx', lineContent: "? t('packDialogAutomationAmount', { amount: (AUTOMATION_PACK.auPerPack * target.quantity).toLocaleString('ko-KR') })", reason: '자동화 크레딧(AU) 수량 숫자 포맷 — 날짜 아님', addedBy: 'story #3493' },
];

function isAllowed(file: string, lineText: string): boolean {
  const trimmed = lineText.trim();
  return ALLOWLIST.some((e) => e.file === file && e.lineContent === trimmed);
}

export function extractHits(content: string, file: string): DateToLocaleStringHit[] {
  const hits: DateToLocaleStringHit[] = [];
  const lines = content.split('\n');
  lines.forEach((lineText, i) => {
    LOCALE_DATE_CALL_RE.lastIndex = 0;
    if (LOCALE_DATE_CALL_RE.test(lineText) && !isAllowed(file, lineText)) hits.push({ file, line: i + 1 });
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
