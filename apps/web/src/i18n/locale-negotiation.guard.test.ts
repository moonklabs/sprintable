// @vitest-environment node
// story #4289 AC2 — 언어를 정하는 규칙은 locale-negotiation.ts 하나(사본 0). 웹 소스 전수를 **줄 단위**로 훑는다
// (까디르 codex · 2026-09-25: 파일 통째 면제면 옛 사본이 살던 request.ts · proxy.ts 안에 새 사본을 써도 통과했다):
//   R1 Accept-Language 헤더를 읽는 줄은 같은 줄에서 resolveLocale(또는 pickFromAcceptLanguage)에 넘기거나, 허용된 그 한 줄이어야 한다.
//   R2 `locale` 쿠키를 읽는 줄도 같은 줄에서 헬퍼에 넘겨야 한다(쿠키 우선 규칙의 사본 방지).
//   R3 지원 언어 목록(['en', 'ko'] 등)은 헬퍼에만.
//   R4 옛 판정 모양(`acceptLang.includes(` · `.includes(locale)`)은 어디에도 없다.
// 양성 대조는 정규식 조각이 아니라, 실제 파일 내용에 사본을 넣은 가상 트리를 이 검사에 넣어 RED를 본다.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '..');
const HELPER = 'i18n/locale-negotiation.ts';
// 헤더를 읽지만 언어를 정하지 않는 줄 — 파일이 아니라 그 한 줄만, 이유와 함께.
const ALLOWED_LINES: Array<{ file: string; line: string; reason: string }> = [
  {
    file: 'lib/fastapi-proxy.ts',
    line: "const fallback = request.headers.get('Accept-Language');",
    reason: 'getLocale()이 실패했을 때(RSC 밖) 원 요청의 Accept-Language를 BE로 그대로 넘기는 통과 — 언어 판정 아님',
  },
];

const HEADER_READ_RE = /\.get\(\s*['"`]accept-language['"`]\s*\)/i;
const COOKIE_READ_RE = /\.get\(\s*['"`]locale['"`]\s*\)/;
const HELPER_CALL_RE = /\b(?:resolveLocale|pickFromAcceptLanguage)\(/;
const LOCALE_LIST_RE = /\[\s*['"`](?:en|ko)['"`]\s*,\s*['"`](?:en|ko)['"`]\s*\]/;
const OLD_MATCH_RE = /acceptLang\w*\.includes\(|\.includes\(\s*locale\s*\)/;

type SrcFile = { rel: string; text: string };

export function findLocaleRuleViolations(files: SrcFile[]): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (f.rel === HELPER) continue;
    f.text.split('\n').forEach((raw, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(raw)) return;
      const line = raw.trim();
      const at = `${f.rel}:${i + 1}`;
      if (HEADER_READ_RE.test(line) && !HELPER_CALL_RE.test(line) && !ALLOWED_LINES.some((a) => a.file === f.rel && a.line === line)) {
        out.push(`R1 헤더를 헬퍼 밖에서 읽음 ${at}`);
      }
      if (COOKIE_READ_RE.test(line) && !HELPER_CALL_RE.test(line)) out.push(`R2 locale 쿠키를 헬퍼 밖에서 읽음 ${at}`);
      if (LOCALE_LIST_RE.test(line)) out.push(`R3 지원 목록 사본 ${at}`);
      if (OLD_MATCH_RE.test(line)) out.push(`R4 옛 includes 판정 ${at}`);
    });
  }
  return out;
}

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir)) {
    const full = path.join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx?|jsx?)$/.test(e) && !/\.test\.(tsx?|jsx?)$/.test(e)) out.push(full);
  }
}
const files: SrcFile[] = (() => {
  const out: string[] = [];
  walk(SRC, out);
  return out.map((abs) => ({ rel: path.relative(SRC, abs).split(path.sep).join('/'), text: readFileSync(abs, 'utf8') }));
})();
const withEdit = (rel: string, edit: (text: string) => string): SrcFile[] =>
  files.map((f) => (f.rel === rel ? { rel, text: edit(f.text) } : f));

describe('locale-negotiation 사본 0 가드(story #4289 AC2 · 줄 단위)', () => {
  it('지금 소스는 위반 0', () => {
    expect(findLocaleRuleViolations(files)).toEqual([]);
  });
  it('허용 줄이 실제로 그 파일에 있다(낡은 허용 0)', () => {
    for (const a of ALLOWED_LINES) {
      const f = files.find((x) => x.rel === a.file);
      expect(f?.text.split('\n').some((l) => l.trim() === a.line)).toBe(true);
    }
  });
});

describe('양성 대조 — 면제 · 헬퍼 호출이 있는 파일에 실제 사본을 넣으면 RED', () => {
  it('request.ts에 옛 includes 루프 사본(헬퍼 호출은 그대로 둔 채)', () => {
    const v = findLocaleRuleViolations(withEdit('i18n/request.ts', (t) => `${t}
export async function getLocaleCopy(): Promise<string> {
  const headerStore = await headers();
  const acceptLang = headerStore.get('accept-language') ?? '';
  for (const locale of ['en', 'ko']) {
    if (acceptLang.includes(locale)) return locale;
  }
  return 'en';
}
`));
    expect(v.some((x) => x.startsWith('R1'))).toBe(true);
    expect(v.some((x) => x.startsWith('R3'))).toBe(true);
    expect(v.some((x) => x.startsWith('R4'))).toBe(true);
  });
  it('proxy.ts에 includes 없는 손 파싱 사본 — 옛 가드(파일 통째 면제 · includes만)는 못 잡던 모양', () => {
    const v = findLocaleRuleViolations(withEdit('proxy.ts', (t) => `${t}
function copyLocale(request: NextRequest): string {
  const al = request.headers.get('accept-language') ?? '';
  const first = al.split(',')[0]?.split('-')[0];
  return first === 'ko' ? 'ko' : 'en';
}
`));
    expect(v).toEqual([expect.stringMatching(/^R1 헤더를 헬퍼 밖에서 읽음 proxy\.ts:/)]);
  });
  it('request.ts에 쿠키 우선 규칙 사본', () => {
    const v = findLocaleRuleViolations(withEdit('i18n/request.ts', (t) => `${t}
async function cookieFirstCopy() {
  const cookieStore = await cookies();
  const c = cookieStore.get('locale')?.value;
  return c ?? null;
}
`));
    expect(v).toEqual([expect.stringMatching(/^R2 locale 쿠키를 헬퍼 밖에서 읽음 i18n\/request\.ts:/)]);
  });
  it('허용 파일(fastapi-proxy)이라도 허용 줄이 아닌 헤더 읽기는 잡는다', () => {
    const v = findLocaleRuleViolations(withEdit('lib/fastapi-proxy.ts', (t) => `${t}
export function pickLang(request: Request): string {
  const lang = request.headers.get('accept-language') ?? '';
  return lang.startsWith('ko') ? 'ko' : 'en';
}
`));
    expect(v).toEqual([expect.stringMatching(/^R1 헤더를 헬퍼 밖에서 읽음 lib\/fastapi-proxy\.ts:/)]);
  });
});
