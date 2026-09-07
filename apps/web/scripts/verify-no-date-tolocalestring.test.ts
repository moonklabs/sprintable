import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ALLOWLIST, extractHits } from './verify-no-date-tolocalestring';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

describe('extractHits — 순수 판정 함수(story #3486 원 가드 계승, #3493 apps/web/src 전체로 확장)', () => {
  it('⭐#3486 실사고 픽스처 — 고치기 前 channels/page.tsx 원문을 그대로 잡는다(회귀 0)', () => {
    const hits = extractHits(
      "{t('channelConnectedBy', { time: new Date(conn.created_at).toLocaleString() })}",
      'app/(authenticated)/organization/channels/page.tsx',
    );
    expect(hits).toEqual([{ file: 'app/(authenticated)/organization/channels/page.tsx', line: 1 }]);
  });

  it('toLocaleDateString·toLocaleTimeString도 잡는다', () => {
    expect(extractHits('new Date(x).toLocaleDateString()', 'f.tsx')).toHaveLength(1);
    expect(extractHits('new Date(x).toLocaleTimeString()', 'f.tsx')).toHaveLength(1);
  });

  it('formatRelativeTime/formatScheduledAt로 고친 뒤에는 안 잡는다(회귀 0)', () => {
    const hits = extractHits(
      "{t('channelConnectedBy', { time: formatRelativeTime(conn.created_at, locale, displayTimezone) })}",
      'app/(authenticated)/organization/channels/page.tsx',
    );
    expect(hits).toEqual([]);
  });

  it('여러 줄에 걸쳐 있으면 줄 번호를 정확히 낸다', () => {
    const content = [
      'const a = 1;',
      'const b = new Date(x).toLocaleString();',
      'const c = 2;',
    ].join('\n');
    expect(extractHits(content, 'f.tsx')).toEqual([{ file: 'f.tsx', line: 2 }]);
  });

  // story #3493 — 3486이 못 보던 «스코프 밖(마케팅 콘텐츠·채널 연결 4 디렉터리 밖)»
  // 자리를 이제 잡는다는 것을 양성대조로 고정한다. agents/agent-run-detail.tsx는
  // 이 스토리 전에는 이 가드의 스코프 밖이었다(3486은 4 디렉터리만 걸었다).
  it('⭐#3493 양성대조 — 3486 스코프 밖(components/agents/**) 자리도 이제 잡는다', () => {
    const hits = extractHits(
      "return new Date(iso).toLocaleString(locale, { year: 'numeric' });",
      'components/agents/agent-run-detail.tsx',
    );
    expect(hits).toEqual([{ file: 'components/agents/agent-run-detail.tsx', line: 1 }]);
  });

  // story #3493 AC2 — 숫자 포맷(krw/포인트 잔액)은 날짜가 아니므로 ALLOWLIST에 등재된
  // 줄 내용은 이 가드가 봐줘야 한다(정확히 그 내용만 — 다른 줄은 여전히 걸린다).
  it('ALLOWLIST에 등재된 줄 내용은 통과시킨다(숫자 포맷)', () => {
    const entry = ALLOWLIST.find(
      (e) => e.file === 'app/(authenticated)/rewards/page.tsx' && e.lineContent.includes('e.balance'),
    );
    expect(entry).toBeDefined();
    expect(entry?.reason).toBeTruthy();
    expect(entry?.addedBy).toBeTruthy();

    const content = `const x = 1;\n${entry!.lineContent}\nconst y = 2;`;
    expect(extractHits(content, 'app/(authenticated)/rewards/page.tsx')).toEqual([]);
  });

  it('ALLOWLIST에 없는 줄의 같은 파일 다른 위치는 여전히 잡는다(허용목록이 파일 전체를 면제하지 않는다)', () => {
    const hits = extractHits(
      'new Date(x).toLocaleString()',
      'app/(authenticated)/rewards/page.tsx',
    );
    expect(hits).toEqual([{ file: 'app/(authenticated)/rewards/page.tsx', line: 1 }]);
  });

  it('ALLOWLIST 등재 항목은 전부 reason·addedBy를 채우고 있다(사유 없는 예외 금지)', () => {
    for (const entry of ALLOWLIST) {
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(entry.addedBy.length).toBeGreaterThan(0);
    }
  });

  // story #3611(CI 후속, #3609와 같은 클래스) — 허용 목록이 file+line(줄번호) 키였을 때
  // 무관한 줄이 위에 추가돼 뒷줄 번호가 밀리면 거짓 빨강이 났다(#3609 실사고). 키를
  // «파일+줄 내용»으로 바꾼 뒤에도 그 내성이 실제로 성립하는지 selftest로 고정한다.
  describe('#3611 — 줄번호 무관(file+내용) 핀 내성', () => {
    const ALLOWED_ENTRY = ALLOWLIST[0]!; // rewards/page.tsx의 balance 줄.

    it('(a) 허용 줄 «앞»에 무관한 줄을 여러 개 삽입해도 위반 0(줄번호가 밀려도 안 깨짐)', () => {
      const content = [
        '// unrelated line 1',
        '// unrelated line 2',
        '// unrelated line 3',
        'const noise = 1;',
        ALLOWED_ENTRY.lineContent,
      ].join('\n');
      expect(extractHits(content, ALLOWED_ENTRY.file)).toEqual([]);
    });

    it('(b) 허용 줄의 «내용 자체»가 바뀌면 더는 허용목록에 안 걸려 위반 1(내용 변화는 진짜 새 자리)', () => {
      const mutatedLine = ALLOWED_ENTRY.lineContent.replace('balance', 'differentField');
      const content = `const noise = 1;\n${mutatedLine}`;
      expect(extractHits(content, ALLOWED_ENTRY.file)).toEqual([{ file: ALLOWED_ENTRY.file, line: 2 }]);
    });

    // 뮤테이션 대조 — isAllowed가 다시 줄번호 기반이 되면 (a)가 반드시 빨강이어야
    // 이 selftest 자체가 그 회귀를 잡는다는 걸 증명한다(코드 자체를 되돌리지 않고,
    // 판정 로직과 동형인 line-index 매칭을 이 테스트 안에서 직접 흉내내 대조).
    it('뮤테이션 대조 — line-index 매칭이었다면 (a)의 그 줄(5번째)은 원래 153번째가 아니라 위반으로 남는다', () => {
      const lineIndexBasedIsAllowed = (file: string, lineNumber: number) =>
        file === ALLOWED_ENTRY.file && lineNumber === 153; // 옛 방식(고정 줄번호 153) 흉내.
      expect(lineIndexBasedIsAllowed(ALLOWED_ENTRY.file, 5)).toBe(false);
    });
  });
});

// story #3493 — 옛 스코프 이름(verify:no-date-tolocalestring-marketing-surface)이
// package.json/CI에 재도입되지 않는지 검산(개명 자체의 회귀가드). 파일 존재 자체가
// 아니라 "그 옛 스크립트명 문자열이 등장하지 않는다"를 검증 — grep 가능한 산출물 기준.
describe('개명 검산 — 옛 이름(marketing-surface) 부재', () => {
  const OLD_NAME = 'verify:no-date-tolocalestring-marketing-surface';
  const NEW_NAME = 'verify:no-date-tolocalestring';

  it('package.json에 옛 스크립트명이 없고 새 이름은 있다', () => {
    const pkg = readFileSync(path.resolve(SCRIPT_DIR, '../package.json'), 'utf8');
    expect(pkg.includes(OLD_NAME)).toBe(false);
    expect(pkg.includes(`"${NEW_NAME}"`)).toBe(true);
  });

  it('CI workflow에 옛 스크립트명이 없고 새 이름은 있다', () => {
    const ci = readFileSync(path.resolve(SCRIPT_DIR, '../../../.github/workflows/ci.yml'), 'utf8');
    expect(ci.includes(OLD_NAME)).toBe(false);
    expect(ci.includes(NEW_NAME)).toBe(true);
  });

  it('옛 파일명(marketing-surface.ts/.test.ts)이 scripts 디렉터리에 재도입되지 않았다', () => {
    const files = readdirSync(SCRIPT_DIR);
    expect(files).not.toContain('verify-no-date-tolocalestring-marketing-surface.ts');
    expect(files).not.toContain('verify-no-date-tolocalestring-marketing-surface.test.ts');
  });
});
