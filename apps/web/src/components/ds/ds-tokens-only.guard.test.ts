// UI-3(a9d56577) — 새 부품(components/ds/)은 새 뜻 이름(`ds-*`)만 쓴다. 옛 shadcn · Proofline · brand 색 클래스가 새 부품에 스며들면 «별칭 없이 따로» 원칙이 깨진다.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const OLD_COLOR = /(?<![\w-])(?:bg|text|border|ring|fill|stroke|from|to|via|outline|divide|shadow)-(?:background|foreground|muted(?:-foreground)?|card(?:-foreground)?|primary(?:-foreground)?|secondary(?:-foreground)?|accent(?:-foreground)?|destructive|popover|input|ring|border|success|warning|info|proof-[\w-]+|brand(?:-[\w-]+)?|sidebar(?:-[\w-]+)?)(?![\w-])/;
const files = readdirSync(__dirname).filter((f) => /\.(tsx?|css)$/.test(f) && !/\.test\./.test(f));

describe('components/ds — 옛 색 클래스 없음', () => {
  it('검사 대상이 있다', () => {
    expect(files.length).toBeGreaterThanOrEqual(4);
  });
  for (const f of files) {
    it(`${f}에 옛 색 클래스가 없다`, () => {
      const text = readFileSync(join(__dirname, f), 'utf8')
        .split('\n')
        .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*') && !l.trim().startsWith('/*'))
        .join('\n');
      const m = text.match(new RegExp(OLD_COLOR, 'g'));
      expect(m ?? []).toEqual([]);
    });
  }
});
