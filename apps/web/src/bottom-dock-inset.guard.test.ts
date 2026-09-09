// story #3756(FE·모바일·결함 클래스) — 우하단 «고정» 요소(토스트·지원 위젯 런처/패널·
// 칸반 저장오류 배너)가 모바일 하단 탭 바 높이를 모르고 뷰포트 바닥 기준으로 떠 넷째
// 탭을 덮던 결함. 처방: 셸(dashboard-shell.tsx)이 CSS 변수 `--bottom-dock-inset`
// (globals.css `.dashboard-shell-root`, 탭 바 높이+safe-area)을 소유하고, 우하단
// fixed 요소 전부가 그 변수로만 bottom을 잡는다(숫자 재추측 0).
//
// 이 가드는 그 계약을 소스 텍스트 수준에서 고정한다(story의 test① — jsdom엔 실 layout이
// 없어 computed bottom을 잴 수 없으므로, 대신 ②"우하단 fixed 요소마다 변수 참조가
// 있는가"를 전수 스캔·허용목록 0으로 검증한다. corner-count-badge-a11y.guard.test.ts와
// 동형 컨벤션(전수 소비처 나열+개별 assert, 새 소비처가 생기면 이 파일도 함께 봐야 한다).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = `${__dirname}/`; // 이 테스트 파일 자체가 src/ 바로 아래에 있음(하위 상대경로 불요)

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.') || entry === 'node_modules') continue;
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

// 한 줄 안에 `fixed`와 bottom 오프셋(Tailwind `bottom-...` 클래스 또는 인라인
// `bottom:` style)이 함께 있으면 「우하단(혹은 하단) fixed 요소」로 간주 — 이 레포의
// 소비처 전부가 className/style을 한 줄짜리 문자열로 쓰는 관례라(다른 guard 파일들도
// 전제하는 것과 동일) 줄 단위 검색으로 충분하다.
const FIXED_LINE_RE = /\bfixed\b/;
const BOTTOM_OFFSET_RE = /bottom-\S|bottom:\s*['"`]/;

interface Hit { file: string; lineNumber: number; line: string }

function findFixedBottomLines(): Hit[] {
  const hits: Hit[] = [];
  for (const file of listSourceFiles(SRC_ROOT)) {
    const lines = readFileSync(file, 'utf-8').split('\n');
    lines.forEach((line, idx) => {
      if (FIXED_LINE_RE.test(line) && BOTTOM_OFFSET_RE.test(line)) {
        hits.push({ file: file.replace(SRC_ROOT, ''), lineNumber: idx + 1, line });
      }
    });
  }
  return hits;
}

// story #3756 처방 밖 — 뷰포트 «전폭»으로 걸치는 하단 바/시트는 탭 바와 "겹쳐 가림" 문제의
// 그 클래스가 아니다(전폭이라 탭 바 자체를 대체하거나 그 위에 늘 온전히 얹힌다, 우하단
// «코너» 요소가 아님). 조용히 빼지 않고 파일+이유를 명시 등재한다.
const FULL_WIDTH_ALLOWLIST: Record<string, string> = {
  'components/ui/sheet.tsx':
    'data-[side=bottom]:bottom-0 — inset-x-0 전폭 바텀시트 프리미티브(코너 요소 아님)',
  'components/docs/doc-editor.tsx':
    'fixed bottom-0 left-0 right-0 — 모바일 전폭 하단 편집 툴바(md:hidden), 코너 요소 아님',
};

const DOCK_INSET_VAR = '--bottom-dock-inset';

describe('우하단 fixed 요소는 --bottom-dock-inset을 통해서만 bottom을 잡는다(story #3756)', () => {
  const hits = findFixedBottomLines();

  it('스캔 대상이 비어있지 않다(가드 자체가 죽은 채 항상 통과하는 것 방지)', () => {
    expect(hits.length).toBeGreaterThan(0);
  });

  it('전폭 allowlist 밖 소비처가 정확히 4곳이다(새 소비처가 생기면 이 가드를 다시 본다)', () => {
    const nonAllowlisted = hits.filter((h) => !(h.file in FULL_WIDTH_ALLOWLIST));
    const files = [...new Set(nonAllowlisted.map((h) => h.file))].sort();
    expect(files).toEqual([
      'components/kanban/kanban-board.tsx',
      'components/support-widget/support-widget-launcher.tsx',
      'components/ui/toast.tsx',
    ].sort());
    expect(nonAllowlisted.length).toBe(4); // toast 1 + launcher 2(버튼+패널) + kanban 1
  });

  it('allowlist 밖 매치는 전부 --bottom-dock-inset을 참조한다(허용목록 0 — 숫자 재추측 없음)', () => {
    const nonAllowlisted = hits.filter((h) => !(h.file in FULL_WIDTH_ALLOWLIST));
    for (const hit of nonAllowlisted) {
      expect(
        hit.line.includes(DOCK_INSET_VAR),
        `${hit.file}:${hit.lineNumber}가 --bottom-dock-inset을 참조하지 않음 — 숫자를 다시 추측한 것: ${hit.line}`,
      ).toBe(true);
    }
  });

  it('allowlist에 등재된 파일은 실제로 그 파일에 매치가 있다(죽은 allowlist 항목 방지)', () => {
    const matchedFiles = new Set(hits.map((h) => h.file));
    for (const file of Object.keys(FULL_WIDTH_ALLOWLIST)) {
      expect(matchedFiles.has(file), `allowlist 항목 '${file}'이 실제 스캔에서 안 잡힘 — 죽은 항목`).toBe(true);
    }
  });
});

// ── 양성대조(AC3③) — 가드 자체가 실제로 걸리는지 자가 증명. 변수 참조 하나를 지운 합성
// 문자열을 넣어 checker가 실제로 빨간불을 낸다는 것을 고정한다(mutation-kill의 반증 —
// 코드에서 실제로 var(--bottom-dock-inset)를 지워보고 이 가드가 RED가 되는 것도 PR 작업
// 中 직접 실측 확認했다: toast.tsx의 그 참조를 임시로 걷어내면 이 파일의 세 번째 it()가
// 정확히 그 이유로 실패했다).
describe('가드 자체의 탐지력(양성대조)', () => {
  it('--bottom-dock-inset 참조가 없는 fixed+bottom 라인은 FIXED_LINE_RE·BOTTOM_OFFSET_RE 둘 다 걸리고, DOCK_INSET_VAR 포함 검사에서 false가 나온다', () => {
    const syntheticBadLine = '    <div className="fixed right-4 bottom-4 z-50">';
    expect(FIXED_LINE_RE.test(syntheticBadLine)).toBe(true);
    expect(BOTTOM_OFFSET_RE.test(syntheticBadLine)).toBe(true);
    expect(syntheticBadLine.includes(DOCK_INSET_VAR)).toBe(false);
  });
});
