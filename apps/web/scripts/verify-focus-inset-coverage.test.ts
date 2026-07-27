import { describe, expect, it } from 'vitest';
import { findFocusInsetViolations } from './verify-focus-inset-coverage';

describe('verify-focus-inset-coverage — story #2062 회귀가드', () => {
  it('패딩도 focus-inset도 없는 overflow-y-auto 컨테이너를 잡는다', () => {
    const violations = findFocusInsetViolations(`
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {items.map((i) => <button key={i.id}>{i.label}</button>)}
      </div>
    `);
    expect(violations).toHaveLength(1);
  });

  it('focus-inset이 있으면 안전으로 판정한다', () => {
    const violations = findFocusInsetViolations(`
      <div className="focus-inset flex min-h-0 flex-1 flex-col overflow-y-auto">
        {items.map((i) => <button key={i.id}>{i.label}</button>)}
      </div>
    `);
    expect(violations).toHaveLength(0);
  });

  it('패딩(p-*)이 있으면 안전으로 판정한다', () => {
    const violations = findFocusInsetViolations(`
      <div className="max-h-64 overflow-y-auto p-1.5">
        <button>ok</button>
      </div>
    `);
    expect(violations).toHaveLength(0);
  });

  it('템플릿 리터럴 className도 검사한다', () => {
    const violations = findFocusInsetViolations(
      '<div className={`flex flex-1 overflow-y-auto ${extra}`}><button>a</button></div>',
    );
    expect(violations).toHaveLength(1);
  });

  it('DialogContent는 자체 p-4 내장이라 패딩/focus-inset 없어도 안전하다', () => {
    const violations = findFocusInsetViolations(`
      <DialogContent className="max-h-[80vh] max-w-lg overflow-y-auto">
        <button>ok</button>
      </DialogContent>
    `);
    expect(violations).toHaveLength(0);
  });

  it('컨테이너 자신이 <pre>(코드/텍스트 렌더)면 안전으로 판정한다', () => {
    const violations = findFocusInsetViolations(`
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap">
        {streamText}
      </pre>
    `);
    expect(violations).toHaveLength(0);
  });

  it('컨테이너 바로 다음이 <table>이면 안전으로 판정한다(읽기전용 표)', () => {
    const violations = findFocusInsetViolations(`
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full">
          <tbody />
        </table>
      </div>
    `);
    expect(violations).toHaveLength(0);
  });

  it('KaTeX 렌더(className에 .katex 셀렉터)는 안전으로 판정한다', () => {
    const violations = findFocusInsetViolations(`
      <div className="flex justify-center overflow-x-auto [&_.katex]:text-foreground" />
    `);
    expect(violations).toHaveLength(0);
  });
});
