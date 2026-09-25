/**
 * story #4280(민 기기 · 배포 27) — `toISOString()`을 10자로 잘라 «날짜»를 만드는 자리(UTC 날짜 자르기) 전수 가드.
 *
 * 왜: 그 값은 UTC의 날짜라 KST(+9)에서는 00~09시에 «어제»가 된다. 활동 로그 · 팀 활동 기본 기간(끝 날짜가 어제)과 스토리지 «생성» 날짜가
 * 이것으로 틀렸다. 사람에게 보이는 날짜 · «오늘»은 표시 시간대 기준(`components/content/schedule-format.ts`의 toDateKey · todayDateKey ·
 * defaultPastDaysDateRange · dateKeysToInstants)으로 만든다.
 *
 * 규칙: 앱 코드(테스트 제외)에 새 UTC 날짜 자르기 0. UTC가 **의도**인 자리만 아래 허용 목록에 이유와 함께 둔다.
 * 양방향: 허용 목록 항목이 더는 코드에 없으면(고쳐졌거나 옮겨졌으면) 그것도 RED — 목록이 낡지 않게.
 *
 * 못 잡는 것(선언): 주석 줄(//, /*, * 로 시작 — 옛 코드를 인용하는 설명은 대상이 아니다)은 건너뛴다. 한 줄 안의 `toISOString()` 바로 뒤
 * 자르기만 본다 — 여러 줄에 걸친 체인이나 `const iso = d.toISOString(); iso.slice(0, 10)`처럼 변수를 거친 자르기는 못 잡는다.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');

// toISOString() 뒤 10자 자르기 세 형태: .slice(0, 10) · .substring(0, 10) · .split('T')[0]
const UTC_DATE_CUT = /toISOString\(\)\s*\.\s*(?:slice\(\s*0\s*,\s*10\s*\)|substring\(\s*0\s*,\s*10\s*\)|split\(\s*['"]T['"]\s*\)\s*\[\s*0\s*\])/;

/** 파일(src 기준) + 줄 내용(앞뒤 공백 제거) → 이유. 줄 번호가 아니라 내용으로 짚어 위아래 편집에 안 흔들린다. */
const ALLOWED: Array<{ file: string; line: string; reason: string }> = [
  {
    file: 'components/content/calendar-grid.tsx',
    line: 'keys.push(d.toISOString().slice(0, 10));',
    reason: '표시 시간대로 이미 만든 날짜 키(toDateKey)를 UTC 자정 Date에 실어 하루씩 더하는 순수 달력 산술 — 시각이 아니라 날짜를 되돌려 받는 것',
  },
  {
    file: 'services/monthly-agent-usage.ts',
    line: 'monthStart: requestedMonth.toISOString().slice(0, 10),',
    reason: 'Date.UTC(연, 월, 1)로 만든 달 첫날을 되돌려 받는 순수 달력 산술(사용량 달 경계는 UTC · monthStartIso와 같은 축)',
  },
  {
    file: 'services/monthly-agent-usage.ts',
    line: 'monthStart: monthStart.toISOString().slice(0, 10),',
    reason: '위와 같음(getUsageMonthRange)',
  },
  {
    file: 'services/sprint.ts',
    line: "const date = startDate ? new Date(startDate.getTime() + day * 86_400_000).toISOString().slice(0, 10) : String(day);",
    reason: 'getBurndown의 직접 DB 갈래 — 유일한 호출자(api/sprints/[id]/burndown)가 db를 넘기지 않아(dbClient = undefined) 토큰 없으면 이 줄 전에 빈 결과로 돌아간다(운영 도달 0). 날짜만 있는 start_date의 달력 산술이기도 함',
  },
  {
    file: 'services/sprint.ts',
    line: 'const today = new Date().toISOString().slice(0, 10);',
    reason: '위와 같은 직접 DB 갈래(운영 도달 0) — 살아나면 표시 시간대 «오늘»로 바꿔야 할 자리',
  },
  {
    file: 'services/sprint.ts',
    line: 'const startDateStr = startDate ? startDate.toISOString().slice(0, 10) : today;',
    reason: '위와 같은 직접 DB 갈래(운영 도달 0)',
  },
  {
    file: 'services/standup.ts',
    line: 'const today = new Date().toISOString().slice(0, 10);',
    reason: 'StandupService는 운영 코드 import 0(테스트만) — 죽은 코드. 살리면 표시 시간대 «오늘»로 바꿔야 할 자리',
  },
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'node_modules' || name === '__tests__') continue;
      sourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.(ts|tsx)$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

function findCuts(): Array<{ file: string; line: string; lineNo: number }> {
  const hits: Array<{ file: string; line: string; lineNo: number }> = [];
  for (const f of sourceFiles(SRC)) {
    readFileSync(f, 'utf8').split('\n').forEach((text, i) => {
      if (/^\s*(\/\/|\/\*|\*)/.test(text)) return; // 주석 줄
      if (UTC_DATE_CUT.test(text)) hits.push({ file: relative(SRC, f), line: text.trim(), lineNo: i + 1 });
    });
  }
  return hits;
}

describe('story #4280 — UTC 날짜 자르기(toISOString → 10자) 전수', () => {
  const hits = findCuts();
  const key = (h: { file: string; line: string }) => `${h.file} :: ${h.line}`;
  const allowedKeys = new Set(ALLOWED.map(key));

  it('스캐너가 실제로 찾는다(허용 목록 자리 수 이상 · 0건 거짓 PASS 방지)', () => {
    expect(hits.length).toBeGreaterThanOrEqual(ALLOWED.length);
    expect(ALLOWED.every((a) => a.reason.length > 0)).toBe(true);
  });

  it('⭐허용 목록 밖의 UTC 날짜 자르기 0 — 사람에게 보이는 날짜 · «오늘»은 schedule-format.ts의 표시 시간대 헬퍼로', () => {
    const offenders = hits.filter((h) => !allowedKeys.has(key(h))).map((h) => `${h.file}:${h.lineNo}  ${h.line}`);
    expect(offenders, `UTC 날짜 자르기:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('⭐허용 목록 항목은 전부 지금 코드에 있다(고쳐지거나 옮겨지면 목록에서 빼기)', () => {
    const hitKeys = new Set(hits.map(key));
    const stale = ALLOWED.filter((a) => !hitKeys.has(key(a))).map(key);
    expect(stale, `낡은 허용 항목:\n${stale.join('\n')}`).toEqual([]);
  });
});
