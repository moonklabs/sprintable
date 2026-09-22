import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scanAllScreens, scanFileForNavFixedWidth } from './verify-nav-v3-narrow-width-single-source';

describe('scanFileForNavFixedWidth — story #4006 AC2 픽스처', () => {
  it('w-[216px]가 없으면 위반 0', () => {
    const clean = `export function X() { return <aside className="flex flex-col" />; }`;
    expect(scanFileForNavFixedWidth('x.tsx', clean)).toHaveLength(0);
  });

  it('className="...w-[216px]..." — 위반 1건, 줄 번호 정확', () => {
    const content = `line1\nline2\nexport function X() {\n  return <aside className="flex w-[216px] shrink-0" />;\n}`;
    const violations = scanFileForNavFixedWidth('x.tsx', content);
    expect(violations).toHaveLength(1);
    expect(violations[0]!.line).toBe(4);
  });

  it('w-[212px]류 인접 픽셀값도 잡는다(21X 패턴)', () => {
    const content = `<aside className="w-[212px]" />`;
    expect(scanFileForNavFixedWidth('x.tsx', content)).toHaveLength(1);
  });

  it('주석 속 백틱 인용(`w-[216px]`)은 className 속성이 아니라 위반 0', () => {
    const content = `// 리터럴 \`w-[216px]\` 금지\nexport function X() { return <aside className="flex" />; }`;
    expect(scanFileForNavFixedWidth('x.tsx', content)).toHaveLength(0);
  });

  it('무관 폭 값(w-[392px])은 위반 아님(nav 폭만 스캔 대상)', () => {
    const content = `<section className="w-[392px] shrink-0" />`;
    expect(scanFileForNavFixedWidth('x.tsx', content)).toHaveLength(0);
  });

  it('한 파일에 2곳 있으면 2건', () => {
    const content = `<a className="w-[216px]" />\n<b className="w-[216px]" />`;
    expect(scanFileForNavFixedWidth('x.tsx', content)).toHaveLength(2);
  });
});

describe('scanAllScreens — 실 소스 스캔(story #4006 착지 후 상태)', () => {
  it('오늘·대화·연결·규칙 3화면 실 소스에 w-[216px] 0건(NavV3Sidebar로 이관 완료)', () => {
    const violations = scanAllScreens();
    expect(violations).toEqual([]);
  });

  it('⭐음성대조 — 임시 디렉터리에 위반 파일을 심으면 실제로 RED', () => {
    const tmpRoot = mkdtempSync(path.join(tmpdir(), 'nav-v3-narrow-width-'));
    try {
      const targetDir = path.join(tmpRoot, 'src/components/today-v3');
      mkdirSync(targetDir, { recursive: true });
      writeFileSync(
        path.join(targetDir, 'today-v3-screen.tsx'),
        `<aside className="flex w-[216px] shrink-0" />`,
      );
      mkdirSync(path.join(tmpRoot, 'src/components/chat-v3'), { recursive: true });
      writeFileSync(path.join(tmpRoot, 'src/components/chat-v3/chat-v3-screen.tsx'), `<div />`);
      mkdirSync(path.join(tmpRoot, 'src/components/connect-rules-v3'), { recursive: true });
      writeFileSync(path.join(tmpRoot, 'src/components/connect-rules-v3/connect-rules-v3-screen.tsx'), `<div />`);

      const violations = scanAllScreens(tmpRoot);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0]!.file).toContain('today-v3-screen.tsx');
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
