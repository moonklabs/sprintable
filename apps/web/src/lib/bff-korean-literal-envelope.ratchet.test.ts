/**
 * story #4320(유나 디자인 판정 · PO) — BFF(lib · app/api)에서 `apiError(코드, '한글 문장')` 모양이 **새로** 생기면 RED.
 *
 * 왜: BFF가 스스로 지은 봉투 문장은 BE i18n 카탈로그를 안 거쳐 화면이 `error.message`를 그대로 띄우면 영어 로케일에도 한국어가 뜬다
 * (2982 · 3786 · 4320). 문장은 messages 키로(상류 오류 봉투는 `bffEnvelopeError`).
 *
 * 세는 모양: `apiError`의 둘째 인자가 한글을 담은 문자열 · 템플릿 리터럴. 세지 않는 것: 주석 · 변수 · t() 결과 · 테스트 파일.
 * 기준선(BASELINE)은 지금 남은 자리 — 늘면 RED, 줄면 RED(기준선을 같이 줄일 것 · 래칫).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const WEB_ROOT = path.resolve(__dirname, '../..');
const ROOTS = ['src/lib', 'src/app/api'];
const HANGUL = /[가-힣]/;

/** 남은 자리(파일 → 수). 첨부 변환의 두 문장은 이 카드 밖(파일 뷰어는 자기 i18n 문장을 띄운다) — 옮기면 여기서 지운다. */
const BASELINE: Record<string, number> = {
  'src/app/api/attachments/convert/route.ts': 2,
};

export function countKoreanLiteralApiErrors(fileName: string, text: string): number {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  let n = 0;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'apiError' && node.arguments.length >= 2) {
      const msg = node.arguments[1];
      if ((ts.isStringLiteral(msg) || ts.isNoSubstitutionTemplateLiteral(msg) || ts.isTemplateExpression(msg)) && HANGUL.test(msg.getText(sf))) n += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return n;
}

function bffFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) bffFiles(full, out);
    else if (entry.isFile() && /\.tsx?$/.test(entry.name) && !/\.(test|spec)\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

describe('BFF 봉투 문장에 한글 리터럴을 새로 박지 않는다(story #4320 · 래칫)', () => {
  it('양성 — 문자열 · 템플릿 · 보간 템플릿 · 여러 줄 호출', () => {
    expect(countKoreanLiteralApiErrors('x.ts', "return apiError('X', '실패했습니다', 500);")).toBe(1);
    expect(countKoreanLiteralApiErrors('x.ts', 'return apiError("X", `실패`, 500);')).toBe(1);
    expect(countKoreanLiteralApiErrors('x.ts', 'return apiError("X", `${n}건 실패`, 500);')).toBe(1);
    expect(countKoreanLiteralApiErrors('x.ts', "return apiError(\n  'X',\n  '느려요',\n  503,\n);")).toBe(1);
  });

  it('음성 — 영어 문장 · 변수 · t() · 주석 · 첫째 인자 · 다른 함수', () => {
    expect(countKoreanLiteralApiErrors('x.ts', "return apiError('X', 'Failed', 500);")).toBe(0);
    expect(countKoreanLiteralApiErrors('x.ts', 'return apiError("X", message, 500);')).toBe(0);
    expect(countKoreanLiteralApiErrors('x.ts', "return apiError('X', t('failed'), 500);")).toBe(0);
    expect(countKoreanLiteralApiErrors('x.ts', "// apiError('X', '실패')\nreturn apiError('X', 'Failed');")).toBe(0);
    expect(countKoreanLiteralApiErrors('x.ts', "return other('X', '실패');")).toBe(0);
  });

  it('⭐실 트리 — 기준선과 같다(늘면 RED · 줄면 기준선도 줄일 것)', () => {
    const files = ROOTS.flatMap((r) => bffFiles(path.join(WEB_ROOT, r)));
    expect(files.length, 'BFF 파일을 실제로 모았다').toBeGreaterThan(500);
    const found: Record<string, number> = {};
    for (const f of files) {
      const n = countKoreanLiteralApiErrors(f, readFileSync(f, 'utf8'));
      if (n) found[path.relative(WEB_ROOT, f).split(path.sep).join('/')] = n;
    }
    expect(found, '새 한글 봉투 문장은 messages 키로(상류 오류는 bffEnvelopeError)').toEqual(BASELINE);
  }, 60_000);
});
