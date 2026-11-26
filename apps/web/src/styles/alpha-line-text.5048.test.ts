// story 5048 ③b-1 — 테두리 · 링 · 글자 색에 «알파»(`border-border/60` · `text-foreground/80` …)를 새로 쓰지 않는다. 키트: 선과 글자는 불투명 역할 색(대비는 조상 opacity를 곱해도 읽히는 값만 믿을 수 있다).
// 걷은 규칙: 테두리 `/N` → 같은 색 불투명 · 강조(primary · brand) 테두리 · 링 N≥50 → `ds-action`, 미만 → `ds-line-control` · 글자 foreground ≥85 → `text-foreground`, 60–84 → `ds-ink-2`.
// 되돌리면 RED: 어느 소스 파일에서든 이 범주의 알파가 돌아오면 아래가 잡는다. 남은 자리(범주 밖 — 배경 알파 · 스크림 글자 · 장식 밑줄 · 문서 본문 어둠 보정)는 ③b-2/③b-3/③d 래칫 몫이라 여기 세지 않는다.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');
// 민(C1)의 nav/* · 사이드바 파일은 이 단계에서 건드리지 않는다(경계) — 허용 목록이 아니라 경계 제외.
const OUT_OF_BOUNDARY = [/^components\/nav\//, /(^|\/)app-sidebar/, /(^|\/)nav-rail/, /(^|\/)nav-placement/];
// 알파가 «의도»라 불투명 토큰이 없는 단 한 자리: 문서 본문 다크 어둠 보정(story 2967 · `bodyEmphasis` 속성). → ③d 래칫 기준선.
const KEPT = new Set(['components/docs/doc-content-renderer.tsx::text-foreground/92']);

const STATUS = ['destructive', 'success', 'info', 'warning', 'ds-failed', 'ds-info', 'ds-done', 'ds-needs-hand', 'proof-blue', 'proof-green', 'proof-red', 'proof-amber'];
const LINE_COLORS = ['border', 'input', 'primary', 'brand', ...STATUS];
const RING_COLORS = ['primary', 'brand', 'ring', ...STATUS];
const TEXT_COLORS = ['foreground', 'muted-foreground', 'card-foreground', 'primary', 'brand', 'brand-text', ...STATUS];
const RX = /(?<![A-Za-z0-9_-])((?:[a-z0-9@\[\]()_.:&>*=%-]+:)*)(border(?:-[trblxy])?|divide|ring|outline|decoration|text)-([a-z][a-z0-9-]*)\/(\d+)(?![A-Za-z0-9_-])/g;

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name === 'node_modules') continue; yield* sources(p); continue; }
    if (!/\.(tsx?|css)$/.test(name) || /\.(test|spec)\./.test(name)) continue;
    yield p;
  }
}

describe('테두리 · 링 · 글자에 알파를 쓰지 않는다 — 5048 ③b-1', () => {
  const offenders: string[] = [];
  for (const file of sources(SRC)) {
    const rel = relative(SRC, file);
    if (OUT_OF_BOUNDARY.some((r) => r.test(rel))) continue;
    for (const m of readFileSync(file, 'utf8').matchAll(RX)) {
      const [, , util, color] = m;
      const covered = util === 'text' ? TEXT_COLORS.includes(color) : util === 'ring' ? RING_COLORS.includes(color) : LINE_COLORS.includes(color);
      if (!covered) continue;
      if (KEPT.has(`${rel}::${util}-${color}/${m[4]}`)) continue;
      offenders.push(`${rel}: ${m[0]}`);
    }
  }
  it('⭐범주 안(선 · 링 · 글자 × 역할 색) 알파 0 — `border-border/60` → `border-border` · `text-foreground/80` → `text-ds-ink-2`', () => {
    expect(offenders).toEqual([]);
  });
});
