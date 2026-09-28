// @vitest-environment jsdom
//
// story #4168 — 셸 스플래시 해제 신호(content-painted). 로드당 정확히 1회, 재렌더·재마운트로
// 재송신 0, 브릿지 없으면 무동작, 그리고 루트 레이아웃 한 곳에서만 보낸다는 배선을 고정한다.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let ContentPaintedSignal: () => null;

beforeEach(async () => {
  // native-shell-bridge의 «로드당 1회» 상태는 모듈 상태 — 케이스마다 새 로드로 만든다.
  vi.resetModules();
  ({ ContentPaintedSignal } = await import('./content-painted-signal'));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  delete window.ReactNativeWebView;
});

describe('ContentPaintedSignal (story #4168)', () => {
  it('셸 안에서 첫 렌더에 {type:"content-painted"}를 정확히 1회 보낸다', async () => {
    const postMessage = vi.fn();
    window.ReactNativeWebView = { postMessage };
    await act(async () => { root.render(createElement(ContentPaintedSignal)); });
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(JSON.stringify({ type: 'content-painted' }));
  });

  it('재렌더로 다시 보내지 않는다', async () => {
    const postMessage = vi.fn();
    window.ReactNativeWebView = { postMessage };
    await act(async () => { root.render(createElement(ContentPaintedSignal)); });
    await act(async () => { root.render(createElement(ContentPaintedSignal)); });
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it('같은 로드 안에서 다시 마운트돼도(클라이언트 이동) 다시 보내지 않는다', async () => {
    const postMessage = vi.fn();
    window.ReactNativeWebView = { postMessage };
    await act(async () => { root.render(createElement(ContentPaintedSignal)); });
    await act(async () => { root.unmount(); });
    root = createRoot(container);
    await act(async () => { root.render(createElement(ContentPaintedSignal)); });
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  it('셸 밖(브릿지 없음)에서는 아무 일도 안 한다', async () => {
    await expect(act(async () => { root.render(createElement(ContentPaintedSignal)); })).resolves.not.toThrow();
  });
});

const SRC_ROOT = join(__dirname, '../..');

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.tsx?$/.test(entry) && !entry.includes('.test.')) out.push(full);
  }
  return out;
}

describe('content-painted 배선 — 루트 레이아웃 한 곳(story #4168)', () => {
  it('루트 레이아웃이 <ContentPaintedSignal />를 마운트한다(모든 진입 화면이 지나는 자리)', () => {
    const layout = readFileSync(join(SRC_ROOT, 'app/layout.tsx'), 'utf8');
    expect(layout).toMatch(/<ContentPaintedSignal\s*\/>/);
  });

  it('notifyContentPainted() 호출부는 ContentPaintedSignal 하나뿐이다(화면별 호출 재분산 방지)', () => {
    const callers = listSourceFiles(SRC_ROOT)
      .filter((f) => /(?<!function )\bnotifyContentPainted\(\)/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(SRC_ROOT.length + 1));
    expect(callers).toEqual(['components/providers/content-painted-signal.tsx']);
  });
});
