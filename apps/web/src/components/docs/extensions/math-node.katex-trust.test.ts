// story #4338 — KaTeX는 문서 글쓴이 입력을 믿지 않는다(`trust: false` 명시): `\href` · `\url`이 링크를 만들지 않고, `\htmlClass` 같은
// HTML 명령도 요소를 만들지 않는다. 기본값이 false여도 기본값에 기대지 않는다 — 뮤테이션: `trust: true`면 아래가 RED.
import katex from 'katex';
import { describe, expect, it, vi } from 'vitest';
import { renderKatex } from './math-node';

describe('renderKatex — trust: false', () => {
  it.each([
    ['\\href{javascript:alert(1)}{x}', false],
    ['\\href{https://example.com}{x}', true],
    ['\\url{javascript:alert(1)}', false],
    ['\\url{https://example.com}', true],
  ])('⭐%j → 링크 0', async (latex, display) => {
    const { html } = await renderKatex(latex, display, 'err');
    expect(html).not.toMatch(/<a[\s>]/);
    expect(html).not.toContain('href=');
    expect(html).not.toContain('javascript:');
  });

  it('\\htmlClass · \\htmlId도 요소 속성을 만들지 않는다', async () => {
    for (const latex of ['\\htmlClass{evil}{x}', '\\htmlId{evil}{x}']) {
      const { html } = await renderKatex(latex, false, 'err');
      expect(html, latex).not.toMatch(/class="[^"]*\bevil\b/);
      expect(html, latex).not.toContain('id="evil"');
    }
  });

  it('대조: 보통 수식은 그대로 그려진다', async () => {
    const { html, error } = await renderKatex('x^2 + 1', false, 'err');
    expect(error).toBeUndefined();
    expect(html).toContain('katex');
  });

  // 까디르 4705 ⑥ — KaTeX 기본 trust가 이미 false라 위 출력 검사는 `trust: false`를 지워도 초록이다. 인자 자체를 단언해 «적어 둔다»를 지킨다.
  it('⭐renderToString에 `trust: false`를 명시해 넘긴다(기본값 기대 금지 — 줄을 지우면 RED)', async () => {
    const spy = vi.spyOn(katex, 'renderToString');
    try {
      await renderKatex('x^2', false, 'err');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]![1]).toHaveProperty('trust', false);
    } finally {
      spy.mockRestore();
    }
  });
});
