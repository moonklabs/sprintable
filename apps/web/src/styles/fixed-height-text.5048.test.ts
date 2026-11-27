// story 5048 ③c — 글자 든 고정 높이: 가장 작은 글자가 16(줄높이 24)이라 `h-4`(16) · `h-5`(20) 칸에 글자를 담으면 줄이 칸보다 커서 위아래로 넘친다(②d · ③a에서 배지 몇 곳을 고친 그 결함).
// 같은 className 문자열에 `h-4`/`h-5`와 글자 크기 · 굵기 클래스가 함께 있으면 줄높이를 칸에 맞춘다 — `leading-none`(글자 한 줄) · `leading-4` · `leading-5` — 또는 높이가 늘어나게(`min-h-*`) 한다.
// (`h-6`=24 이상은 줄높이 24가 들어가 넘치지 않는다. 아이콘 칸 `h-4 w-4`처럼 글자 클래스가 없는 곳은 대상이 아니다 — 글자색만 있는 것은 글자가 아님.)
// 되돌리면 RED. 글자가 «자식»에 있는 칸은 정적으로 못 보므로 이 시험의 몫이 아니다 — 화면 레이아웃 시험(넘침 · 잘림 0)이 지킨다.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');
const OUT_OF_BOUNDARY = [/^components\/nav\//]; // 민(C1)의 nav/* — 경계 제외

const SEG = /["'`]([^"'`]*(?<![A-Za-z0-9:-])h-[45](?![0-9.A-Za-z-])[^"'`]*)["'`]/g;
const TEXT = /(?<![A-Za-z0-9-])(?:text-(?:xs|sm|base|micro|ds-(?:title|card-title|body|small|mono-lg|mono-md|mono-sm)|editorial-[a-z]+)|font-(?:medium|semibold|bold|mono))(?![A-Za-z0-9-])/;
const FITS = /(?<![A-Za-z0-9:-])(?:leading-(?:none|3|4|5)|min-h-[0-9a-z[]+)(?![A-Za-z0-9-])/;

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { if (name === 'node_modules') continue; yield* sources(p); continue; }
    if (!/\.tsx$/.test(name) || /\.(test|spec)\./.test(name)) continue;
    yield p;
  }
}

describe('글자 든 고정 높이(h-4 · h-5)는 줄높이를 칸에 맞춘다 — 5048 ③c', () => {
  const offenders: string[] = [];
  for (const file of sources(SRC)) {
    const rel = relative(SRC, file);
    if (OUT_OF_BOUNDARY.some((r) => r.test(rel))) continue;
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      for (const m of line.matchAll(SEG)) {
        const seg = m[1]!;
        if (TEXT.test(seg) && !FITS.test(seg)) offenders.push(`${rel}:${i + 1} ${seg.slice(0, 90)}`);
      }
    });
  }
  it('⭐같은 className에 h-4/h-5 + 글자 클래스가 있는데 줄높이를 안 맞춘 곳 0', () => {
    expect(offenders).toEqual([]);
  });
});
