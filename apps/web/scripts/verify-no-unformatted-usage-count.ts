/**
 * story #3808(페드루 PO 지적 2026-09-12 23:50Z, 배포 82 픽셀 실측) — 채널 연결 카드
 * 사용량 줄("오늘 사용량 {used}/{limit} · 플랫폼 공유")이 천 단위 구분(콤마) 없이
 * 나갔다("3200/10000") — 같은 화면의 금액("1,300원")은 formatMinorCurrency로 이미
 * 콤마가 붙어 두 표기가 어긋난 결함(2026-09-12 그라운딩·PR#4243류와 동형 계보).
 *
 * 처방=클래스로("사용량 줄" 그 자리 하나만 고치는 건 금지, 카드 원문) — BE 사용량
 * 응답 계약 `{used_units, limit_units, remaining_units, reset_at, scope}`(youtube-usage
 * BFF route.ts 주석, X도 같은 모양 재사용 예정)의 세 필드는 사람에게 보이는 자리에
 * 반드시 `formatCount()`(components/content/generation-budget-indicator.tsx — 금액용
 * formatMinorCurrency의 자매 함수, 둘 다 Intl.NumberFormat(locale) 한 곳만 거친다)를
 * 거쳐야 한다는 것을 이 필드명 자체로 정적으로 강제한다. 새 채널이 같은 계약 모양의
 * 사용량 표시를 만들 때도(필드명을 그대로 재사용하는 한) 자동으로 이 가드에 걸린다 —
 * "지정 경로만" 닫는 게 아니라 "이 계약 모양을 쓰는 모든 자리"를 닫는다.
 *
 * 판정은 줄 단위 grep이다(AST 미도입 — verify-no-date-tolocalestring.ts와 동형 한계
 * 승계). `.used_units`/`.limit_units`/`.remaining_units`처럼 **점(.) 뒤에 오는 실
 * 프로퍼티 접근**만 잡는다 — 타입 선언(`used_units: number;`, 점 없음)은 이 정규식
 * 자체가 구조적으로 못 걸므로 별도 제외 로직이 불요하다(실측: channels/page.tsx의
 * interface 선언 3줄은 실제로 안 걸리는 것을 확인했다).
 *
 * ⛔이 가드가 못 잡는 것 — ①문자열 그대로 템플릿 리터럴에 박아 넣는 자리(예:
 * `` `${obj.used_units}` ``도 걸리긴 한다 — 정규식이 `.used_units` 자체를 보므로
 * 백틱 안이든 JSX든 무관하게 잡는다, 실제 사각은 없음) ②완전히 다른 필드명으로
 * 우회 저장한 변수(예: `const u = usage.used_units; ...display(u)...`처럼 대입한
 * 다음 줄에서 formatCount 없이 쓰면, 대입 그 줄엔 formatCount가 없어도 되고 소비
 * 줄은 필드명 자체가 안 보여 이 가드가 못 본다 — verify-no-date-tolocalestring.ts의
 * "줄 단위 grep" 근본 한계와 동형, AST 도입 전까지는 승계).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');
const EXT_RE = /\.(tsx?|ts)$/;
const TEST_RE = /\.test\.[tj]sx?$/;

// story #3808 — youtube-usage BFF 응답 계약 {used_units, limit_units, remaining_units,
// reset_at, scope} 세 필드(reset_at·scope는 사람에게 «숫자»로 안 보이므로 대상 밖).
const USAGE_COUNT_FIELD_RE = /\.(used_units|limit_units|remaining_units)\b/g;
const FORMAT_COUNT_CALL_RE = /formatCount\(/;

export interface UnformattedUsageCountHit {
  file: string;
  line: number;
  field: string;
}

export function extractHits(content: string, file: string): UnformattedUsageCountHit[] {
  const hits: UnformattedUsageCountHit[] = [];
  const lines = content.split('\n');
  lines.forEach((lineText, i) => {
    USAGE_COUNT_FIELD_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = USAGE_COUNT_FIELD_RE.exec(lineText)) !== null) {
      if (!FORMAT_COUNT_CALL_RE.test(lineText)) {
        hits.push({ file, line: i + 1, field: m[1]! });
      }
    }
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

  const hits: UnformattedUsageCountHit[] = [];
  for (const abs of files) {
    const content = readFileSync(abs, 'utf8');
    const rel = path.relative(SRC_ROOT, abs).split(path.sep).join('/');
    hits.push(...extractHits(content, rel));
  }

  if (hits.length > 0) {
    console.log(
      `\n❌ apps/web/src 안 사용량 카운트 필드(used_units/limit_units/remaining_units)가 ` +
        `formatCount() 없이 쓰인 곳 ${hits.length}건(story #3808 — 천 단위 구분 누락, ` +
        `formatCount(n, locale) 정본을 거칠 것):`,
    );
    for (const h of hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
      console.log(`  - ${h.file}:${h.line} (${h.field})`);
    }
    return 1;
  }

  console.log('OK: apps/web/src 안 사용량 카운트 필드 전부 formatCount() 경유(콤마 없는 자리 0건)');
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
