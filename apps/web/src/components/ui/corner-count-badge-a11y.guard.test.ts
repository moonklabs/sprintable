// story #3518(공용, 유나 #3861 Design 관찰) — CornerCountBadge는 aria-hidden이라 그
// 수를 보조기술에 전하는 책임은 호출부의 접근성 이름(보통 감싸는 버튼/링크의
// aria-label)에 있다(계약은 corner-count-badge.tsx 주석 참고). mobile-tab-bar.tsx만
// 이 계약을 안 지켜 그 수가 스크린리더에 안 갔다(이 스토리의 원인) — 새 소비처가
// 같은 실수를 하면 이 가드가 잡는다.
//
// ⚠️파일 전체에 aria-label이 «어딘가»(예: <nav aria-label=...>) 있는지만 보면 이 스토리의
// 실제 결함을 못 잡는다 — mobile-tab-bar.tsx는 이 결함이 있던 채로도 이미 nav 랜드마크
// aria-label을 갖고 있었다(파일 단위 검사로는 통과했을 것). 그래서 이 가드는 각
// `<CornerCountBadge` 등장 위치의 «가까운 앞뒤 윈도우»에 접근성 이름 배선이 있는지를
// 잰다 — 완전한 AST 스코프 분석은 아니지만(파서 의존성 추가를 피한다), "파일에 어딘가
// 존재하는가"보다는 훨씬 좁혀서 «그 배지 자리 근처»를 본다.
//
// ⚠️두 배선 방식을 둘 다 인정한다 — ①aria-label(아이콘 전용 소비처, 배지보다 앞서
// 여는 버튼/링크에 — bell·presence) ②sr-only 텍스트(보이는 라벨이 있는 소비처, WCAG
// 2.5.3 때문에 aria-label로 못 바꾸고 라벨 뒤에 «더하는» 방식이라 배지보다 뒤에 오는
// 경우가 많다 — mobile-tab-bar). 그래서 검색창은 배지 앞뒤 «양쪽」 다 본다. 정밀 판정은
// 소비처별 렌더 테스트(notification-bell.test.tsx §3466·3518, mobile-tab-bar-badge.
// test.tsx §3518)의 몫 — 이 가드는 "새 소비처가 그 배선 자체를 통째로 빠뜨리는" 가장
// 흔한 회귀만 잡는다.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(__dirname, '../../');
// 배지 렌더 지점 앞뒤로 이만큼(문자수) 안에서 접근성 이름 배선을 찾는다 — 이 레포의
// 세 소비처 모두 그 배선이 배지로부터 최대 수십 줄 안에 있다(관찰값의 3~5배 여유).
const WINDOW_CHARS = 800;
const A11Y_WIRING_MARKERS = ['aria-label', 'sr-only'];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (/\.tsx?$/.test(entry) && !entry.includes('.test.')) {
      out.push(full);
    }
  }
  return out;
}

const CORNER_COUNT_BADGE_IMPORT = /from ['"]@\/components\/ui\/corner-count-badge['"]/;

function findConsumers(): string[] {
  return listSourceFiles(SRC_ROOT).filter((f) => CORNER_COUNT_BADGE_IMPORT.test(readFileSync(f, 'utf-8')));
}

/** 파일 안의 모든 `<CornerCountBadge` 등장 위치 각각에 대해, 그 앞뒤 WINDOW_CHARS
 * 구간에 접근성 이름 배선(aria-label 또는 sr-only)이 있는지 판정한다. 등장 위치가
 * 하나도 없으면(import만 하고 실제로는 안 쓰는 죽은 import) 빈 배열. */
function checkEachUsage(content: string): { index: number; hasNearbyA11yWiring: boolean }[] {
  const results: { index: number; hasNearbyA11yWiring: boolean }[] = [];
  const re = /<CornerCountBadge/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const windowStart = Math.max(0, m.index - WINDOW_CHARS);
    const windowEnd = Math.min(content.length, m.index + WINDOW_CHARS);
    const window = content.slice(windowStart, windowEnd);
    results.push({ index: m.index, hasNearbyA11yWiring: A11Y_WIRING_MARKERS.some((marker) => window.includes(marker)) });
  }
  return results;
}

describe('CornerCountBadge 접근성 이름 계약(story #3518) — 소비처 전수', () => {
  const consumers = findConsumers();

  it('스캔 대상이 비어있지 않다(가드 자체가 죽은 채 항상 통과하는 것 방지)', () => {
    expect(consumers.length).toBeGreaterThan(0);
  });

  it('현재 소비처가 정확히 3곳이다(새 소비처가 생기면 이 숫자를 갱신하며 이 가드를 다시 본다)', () => {
    expect(consumers.map((f) => f.replace(SRC_ROOT, ''))).toEqual(
      expect.arrayContaining([
        'components/presence/team-presence-toggle.tsx',
        'components/nav/notification-bell.tsx',
        'components/nav/mobile-tab-bar.tsx',
      ]),
    );
    expect(consumers.length).toBe(3);
  });

  for (const file of findConsumers()) {
    const relative = file.replace(SRC_ROOT, '');
    it(`${relative} — <CornerCountBadge 등장 지점마다 그 근처에 접근성 이름 배선(aria-label 또는 sr-only)이 있다`, () => {
      const content = readFileSync(file, 'utf-8');
      const usages = checkEachUsage(content);
      expect(usages.length).toBeGreaterThan(0); // 이 파일이 왜 스캔 대상인지(import만 하고 안 쓰면 죽은 import).
      for (const usage of usages) {
        expect(usage.hasNearbyA11yWiring).toBe(true);
      }
    });
  }
});
