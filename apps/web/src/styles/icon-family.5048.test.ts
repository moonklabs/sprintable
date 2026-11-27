// story 5048 ④ (PO 11-27: «한 집안 = lucide») — 아이콘은 한 집안(lucide: 끝 둥근 선 · 굵기 2 · 24 격자)이다. 키트 아이콘은 PO가 캡처(kit-sidebar-1-332.png)를 눈으로 읽은 값이지 수치 실측이 아니다.
//  ① ds `Icon`의 글리프 표(icon-paths.ts)는 lucide 컴포넌트만 가리킨다 — Material 경로 문자열(`d: '…'`)이 다시 들어오면 RED.
//  ② 크기 단계 sm 16 · md 20 · lg 24 가 TS(ICON_SIZE)와 CSS 토큰(`--spacing-ds-icon-*`) 두 곳에서 같다.
//  ③ lucide 호출에 `strokeWidth` 를 직접 주지 않는다 — 굵기는 2 하나(체크 · 봉인 등 13곳을 2로 모음). nav/*(민)는 경계라 제외.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ICON_SIZE } from '@/components/ds/icon';

const SRC = join(__dirname, '..');
const OUT_OF_BOUNDARY = [/^components\/nav\//]; // 민(C1)의 nav/* — 경계

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name === 'node_modules') continue; yield* sources(p); continue; }
    if (!/\.tsx$/.test(name) || /\.(test|spec)\./.test(name)) continue;
    yield p;
  }
}

describe('아이콘은 한 집안(lucide) — 5048 ④', () => {
  it('⭐ds Icon의 글리프 표는 lucide 컴포넌트만 가리킨다(경로 문자열 0)', () => {
    const src = readFileSync(join(SRC, 'components/ds/icon-paths.ts'), 'utf8');
    expect(src).toMatch(/from 'lucide-react'/);
    expect(src).not.toMatch(/\bd:\s*'[Mm]/); // 옛 Material 경로(`d: 'M…'`)가 돌아오면 RED
  });

  it('⭐크기 단계 16 · 20 · 24 — TS(ICON_SIZE)와 CSS 토큰이 같다', () => {
    expect(ICON_SIZE).toEqual({ sm: 16, md: 20, lg: 24 });
    const css = readFileSync(join(SRC, 'styles/design-system.css'), 'utf8');
    const rem = (n: string) => Number(new RegExp(`--spacing-ds-icon-${n}:\\s*([\\d.]+)rem`).exec(css)?.[1]) * 16;
    expect([rem('sm'), rem('md'), rem('lg')]).toEqual([16, 20, 24]);
  });

  it('⭐lucide 호출에 strokeWidth를 직접 주지 않는다(굵기는 2 하나)', () => {
    const hits: string[] = [];
    for (const file of sources(SRC)) {
      const rel = relative(SRC, file);
      if (OUT_OF_BOUNDARY.some((r) => r.test(rel))) continue;
      const text = readFileSync(file, 'utf8');
      // 대문자로 시작하는 컴포넌트 태그(lucide · ds)에 붙은 strokeWidth — 소문자 svg 원소(path · polyline · line · rect · circle)는 차트 · 그림이라 대상이 아니다.
      for (const m of text.matchAll(/<([A-Z][A-Za-z0-9]*)\b[^<>]*?\sstrokeWidth=/g)) hits.push(`${rel}: <${m[1]}>`);
    }
    expect(hits).toEqual([]);
  });
});
