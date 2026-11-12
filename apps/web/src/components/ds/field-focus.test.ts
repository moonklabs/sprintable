// UI-3(a9d56577) · 4906 — 글 칸의 초점 규칙 회귀가드: 글 칸(Input · Textarea · NativeSelect · 채팅 작성창 · 인라인 작성 상자)은 초점에 «파란 틀»(action 테두리 · action 고리)을 쓰지 않고 중립 테두리만 짙어진다.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIELD_FOCUS, FIELD_FOCUS_WITHIN } from './field-focus';

const SRC = join(__dirname, '..', '..');
function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === 'node_modules' || e === '.next') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|css)$/.test(e) && !/\.test\./.test(e)) out.push(p);
  }
  return out;
}

describe('글 칸 초점 규칙', () => {
  it('⭐상수: 초점 클래스에 action(파랑)이 없다 — 중립 ink-2 테두리 · 오류만 failed 고리', () => {
    expect(FIELD_FOCUS).toContain('focus-visible:border-ds-ink-2');
    expect(FIELD_FOCUS_WITHIN).toBe('focus-within:border-ds-ink-2');
    expect(`${FIELD_FOCUS} ${FIELD_FOCUS_WITHIN}`).not.toMatch(/action/);
    // 고리는 오류(aria-invalid)일 때만
    for (const token of FIELD_FOCUS.split(/\s+/).filter((t) => /ring/.test(t))) expect(token.startsWith('aria-invalid:'), token).toBe(true);
  });

  it('⭐쓰는 곳: 소스 어디에도 «focus-within + action 테두리/고리» 파란 상자가 없다(작성창 · 인라인 작성 상자가 상수를 쓴다)', () => {
    const offenders = walk(SRC).filter((f) => /focus-within:(border|ring)-ds-action/.test(readFileSync(f, 'utf8'))).map((f) => f.replace(SRC, ''));
    expect(offenders).toEqual([]);
  });

  it('⭐채팅 작성창 상자와 인라인 작성 상자가 상수를 쓴다(손으로 쓴 초점 클래스로 돌아가지 않는다)', () => {
    for (const f of ['components/chat/chat-input.tsx', 'components/kanban/list-story-composer.tsx']) {
      const src = readFileSync(join(SRC, f), 'utf8');
      expect(src, f).toContain('${FIELD_FOCUS_WITHIN}');
      expect(src, f).not.toMatch(/border-ds-action/);
    }
  });
});
