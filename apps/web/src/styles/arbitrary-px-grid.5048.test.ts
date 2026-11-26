// story 5048 ③a 둘째 — 임의 크기 `h-[Npx]` 같은 박힌 값 중 «N이 4의 배수»인 것은 간격 단계(`h-N/4`)와 같은 값이라 새로 쓰지 않는다.
// 44는 이름 있는 `ds-touch`. 4의 배수가 아닌 값(15 · 30 · 18 …)은 아직 걷지 않았다 — 그 숫자는 ③d 래칫이 줄기만 하게 못 박는다(이 시험의 몫이 아님).
// 되돌리면 RED: 어느 소스 파일에서든 `min-h-[44px]`나 `w-[280px]`로 돌아가면 아래가 잡는다.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..');
// 민(C1)의 nav/* 파일은 이 단계에서 건드리지 않는다(경계) — 다음 단계에서 그쪽 임자가 걷는다. 이유가 «토큰 밖이 맞아서»가 아니므로 허용 목록이 아니라 경계 제외다.
const OUT_OF_BOUNDARY = [/^components\/nav\//];

const PROPS = ['min-h', 'max-h', 'min-w', 'max-w', 'h', 'w', 'size', 'px', 'py', 'pt', 'pb', 'pl', 'pr', 'ps', 'pe', 'p', 'mx', 'my', 'mt', 'mb', 'ml', 'mr', 'ms', 'me', 'm', 'gap-x', 'gap-y', 'gap', 'top', 'bottom', 'left', 'right', 'start', 'end', 'inset-x', 'inset-y', 'inset', 'space-x', 'space-y', 'basis'];
const RX = new RegExp(`(?<![A-Za-z0-9_\\[\\]-])(?:[a-z0-9@\\[\\]()_.:&>*=%-]+:)*-?(?:${[...PROPS].sort((a, b) => b.length - a.length).join('|')})-\\[(\\d+)px\\](?![A-Za-z0-9_-])`, 'g');

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) { if (name === 'node_modules') continue; yield* sources(p); continue; }
    if (!/\.(tsx?|css)$/.test(name) || /\.(test|spec)\./.test(name)) continue;
    yield p;
  }
}

describe('임의 크기 4의 배수는 간격 단계로 쓴다 — 5048 ③a 둘째', () => {
  const offenders: string[] = [];
  for (const file of sources(SRC)) {
    const rel = relative(SRC, file);
    if (OUT_OF_BOUNDARY.some((r) => r.test(rel))) continue;
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(RX)) {
      const n = Number(m[1]);
      if (n > 0 && n % 4 === 0) offenders.push(`${rel}: ${m[0]}`);
    }
  }
  it('⭐4의 배수 px를 대괄호로 쓴 곳 0 — `w-[280px]` → `w-70` · `min-h-[44px]` → `min-h-ds-touch`', () => {
    expect(offenders).toEqual([]);
  });
});
