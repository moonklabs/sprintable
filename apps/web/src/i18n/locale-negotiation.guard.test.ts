// @vitest-environment node
// story #4289 AC2 — 언어를 정하는 규칙은 locale-negotiation.ts 하나(사본 0). 웹 소스 전수를 훑어:
//   ① Accept-Language 헤더를 읽는 자리는 resolveLocale(또는 pickFromAcceptLanguage)에 넘기거나, 허용 목록(이유)에 있어야 한다.
//   ② 지원 언어 목록(['en', 'ko'] 등)은 locale-negotiation.ts에만 — 두 번째 목록이 생기면 규칙 사본의 씨앗.
//   ③ 옛 모양(`acceptLang.includes(` · 지원 목록을 돌며 `.includes(locale)`)이 어디에도 없어야 한다.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '..');
const HELPER = 'i18n/locale-negotiation.ts';
// 헤더를 읽지만 언어를 정하지 않는 자리 — 이유와 함께.
const HEADER_READ_ALLOWED: Record<string, string> = {
  'lib/fastapi-proxy.ts': 'getLocale()이 실패했을 때(RSC 밖) 원 요청의 Accept-Language를 BE로 그대로 넘기는 통과 — 언어 판정 아님',
};

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir)) {
    const full = path.join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|jsx?)$/.test(e) && !/\.test\.(tsx?|jsx?)$/.test(e)) out.push(full);
  }
}
const files = (() => {
  const out: string[] = [];
  walk(SRC, out);
  return out.map((abs) => ({ rel: path.relative(SRC, abs).split(path.sep).join('/'), text: readFileSync(abs, 'utf8') }));
})();
const codeLines = (text: string) => text.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));

export const HEADER_READ_RE = /\.get\(\s*['"`]accept-language['"`]\s*\)/i;
export const LOCALE_LIST_RE = /\[\s*['"`](?:en|ko)['"`]\s*,\s*['"`](?:en|ko)['"`]\s*\]/;
export const OLD_MATCH_RE = /acceptLang\w*\.includes\(|\.includes\(\s*locale\s*\)/;

describe('locale-negotiation 사본 0 가드(story #4289 AC2)', () => {
  it('Accept-Language를 읽는 자리는 헬퍼에 넘기거나 허용 목록(이유)에 있다', () => {
    const bad = files
      .filter((f) => f.rel !== HELPER && codeLines(f.text).some((l) => HEADER_READ_RE.test(l)))
      .filter((f) => !/\b(resolveLocale|pickFromAcceptLanguage)\(/.test(f.text) && !HEADER_READ_ALLOWED[f.rel])
      .map((f) => f.rel);
    expect(bad).toEqual([]);
  });
  it('지원 언어 목록은 헬퍼 한 곳에만', () => {
    const lists = files.filter((f) => codeLines(f.text).some((l) => LOCALE_LIST_RE.test(l))).map((f) => f.rel);
    expect(lists).toEqual([HELPER]);
  });
  it('옛 판정 모양(includes 부분 문자열)이 어디에도 없다', () => {
    const old = files.filter((f) => codeLines(f.text).some((l) => OLD_MATCH_RE.test(l))).map((f) => f.rel);
    expect(old).toEqual([]);
  });
  it('허용 목록의 파일이 실제로 헤더를 읽는다(낡은 허용 0)', () => {
    for (const rel of Object.keys(HEADER_READ_ALLOWED)) {
      const f = files.find((x) => x.rel === rel);
      expect(f && codeLines(f.text).some((l) => HEADER_READ_RE.test(l))).toBe(true);
    }
  });
  it('양성 대조 — 옛 사본 모양을 세 패턴이 잡는다', () => {
    const oldCopy = [
      "const CONNECT_GUIDE_SUPPORTED_LOCALES = ['en', 'ko'] as const;",
      "  const acceptLang = request.headers.get('accept-language') ?? '';",
      '    if (acceptLang.includes(locale)) return locale;',
    ];
    expect(LOCALE_LIST_RE.test(oldCopy[0]!)).toBe(true);
    expect(HEADER_READ_RE.test(oldCopy[1]!)).toBe(true);
    expect(OLD_MATCH_RE.test(oldCopy[2]!)).toBe(true);
  });
});
