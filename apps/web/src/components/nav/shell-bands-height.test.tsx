// 4913(UI-R5) 셸 — 띠 셋이 먹은 높이를 셸 뿌리의 --shell-bands-h에 쓰는 한 곳. 띠가 생기고 사라지면 값이 따라 바뀐다.
// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SHELL_BANDS_VAR, useShellBandsHeight, watchShellBandsHeight } from './shell-bands-height';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let observers: Array<{ cb: () => void; disconnected: boolean }> = [];
let height = 0;
beforeEach(() => {
  observers = [];
  height = 0;
  vi.stubGlobal('ResizeObserver', class {
    rec: { cb: () => void; disconnected: boolean };
    constructor(cb: () => void) { this.rec = { cb, disconnected: false }; observers.push(this.rec); }
    observe() { /* the test drives the callback itself */ }
    disconnect() { this.rec.disconnected = true; }
  });
});
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });

function mountDom() {
  const root = document.createElement('div');
  root.className = 'dashboard-shell-root';
  const bands = document.createElement('div');
  bands.getBoundingClientRect = () => ({ height } as DOMRect);
  root.appendChild(bands);
  document.body.appendChild(root);
  return { root, bands };
}
const val = (root: HTMLElement) => root.style.getPropertyValue(SHELL_BANDS_VAR);

describe('watchShellBandsHeight', () => {
  it('⭐처음에 바로 쓴다(그리기 前) — 띠 없음 = 0px', () => {
    const { root, bands } = mountDom();
    watchShellBandsHeight(bands);
    expect(val(root)).toBe('0px');
  });

  it('⭐띠가 생기면 값이 따라 오르고 사라지면(«가입 완료» 닫기 · 5/5) 0으로 내린다 — 소수 높이는 올림(넘침 1px도 안 남긴다)', () => {
    const { root, bands } = mountDom();
    watchShellBandsHeight(bands);
    height = 33.4; observers[0]!.cb();
    expect(val(root)).toBe('34px');
    height = 102; observers[0]!.cb();
    expect(val(root)).toBe('102px');
    height = 0; observers[0]!.cb();
    expect(val(root)).toBe('0px');
  });

  it('⭐정리하면 관찰을 끝내고 값을 지운다(셸이 사라진 뒤 옛 값이 남지 않는다)', () => {
    const { root, bands } = mountDom();
    height = 40;
    const stop = watchShellBandsHeight(bands);
    expect(val(root)).toBe('40px');
    stop();
    expect(observers[0]!.disconnected).toBe(true);
    expect(val(root)).toBe('');
  });

  it('셸 뿌리(.dashboard-shell-root) 밖이면 아무 일도 안 한다', () => {
    const lone = document.createElement('div');
    document.body.appendChild(lone);
    const stop = watchShellBandsHeight(lone);
    expect(observers).toHaveLength(0);
    expect(() => stop()).not.toThrow();
  });

  it('ResizeObserver가 없는 환경에서도 첫 값은 쓴다(관찰만 빠진다)', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const { root, bands } = mountDom();
    height = 50;
    const stop = watchShellBandsHeight(bands);
    expect(val(root)).toBe('50px');
    stop();
    expect(val(root)).toBe('');
  });
});

describe('useShellBandsHeight', () => {
  let container: HTMLDivElement;
  let reactRoot: Root;
  beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); reactRoot = createRoot(container); });
  afterEach(async () => { await act(async () => { reactRoot.unmount(); }); });

  function Probe() {
    const ref = useRef<HTMLDivElement>(null);
    useShellBandsHeight(ref);
    return <div ref={ref} data-testid="bands" />;
  }

  it('⭐첫 그림 前: 같은 컴포넌트에서 «먼저» 선언된 일반(passive) 효과가 돌 때 값이 이미 서 있다 — layout 효과는 모든 passive 효과보다 먼저 돈다(넘침이 한 번 번쩍이지 않게)', async () => {
    const shell = document.createElement('div');
    shell.className = 'dashboard-shell-root';
    document.body.appendChild(shell);
    shell.appendChild(container);
    height = 34;
    HTMLElement.prototype.getBoundingClientRect = function () { return { height: this.getAttribute('data-testid') === 'bands' ? height : 0 } as DOMRect; };
    const seen: string[] = [];
    function Early() {
      const ref = useRef<HTMLDivElement>(null);
      useEffect(() => { seen.push(val(shell)); }); // declared BEFORE the hook: a passive hook would run after this one
      useShellBandsHeight(ref);
      return <div ref={ref} data-testid="bands" />;
    }
    await act(async () => { reactRoot.render(<Early />); });
    expect(seen[0]).toBe('34px');
    await act(async () => { reactRoot.unmount(); });
    reactRoot = createRoot(container);
  });

  it('⭐훅은 layout 단계에서 쓴다 — 마운트가 끝나면 값이 이미 서 있다 · 언마운트하면 지워진다', async () => {
    const shell = document.createElement('div');
    shell.className = 'dashboard-shell-root';
    document.body.appendChild(shell);
    shell.appendChild(container);
    height = 34;
    HTMLElement.prototype.getBoundingClientRect = function () { return { height: this.getAttribute('data-testid') === 'bands' ? height : 0 } as DOMRect; };
    await act(async () => { reactRoot.render(<Probe />); });
    expect(val(shell)).toBe('34px');
    await act(async () => { reactRoot.unmount(); });
    expect(val(shell)).toBe('');
    reactRoot = createRoot(container);
  });
});

describe('셸 연결(소스 핀) — 값이 실제로 셸에서 쓰이고 CSS가 읽는다', () => {
  const src = (rel: string) => readFileSync(join(__dirname, '..', '..', rel), 'utf8');
  const code = (rel: string) => src(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '').replace(/^\s*\/\/.*$/gm, '');

  it('⭐셸은 띠 셋을 한 칸(ref + data-shell-bands)에 담고 그 칸의 높이를 useShellBandsHeight로 잰다', () => {
    const shell = code('app/dashboard/dashboard-shell.tsx');
    expect(shell).toContain('useShellBandsHeight(bandsRef)');
    expect(shell).toMatch(/<div ref=\{bandsRef\} data-shell-bands>[\s\S]*<ActivationChecklistBanner \/>[\s\S]*<OrgHintBanner \/>[\s\S]*<ReclaimNoticeAlert \/>[\s\S]*?<\/div>\s*<\/div>\s*(?:\{\}\s*)*<ContextualPanelLayout/);
  });

  it('⭐스크롤러 아래에 도움말 단추 여백이 있다(긴 화면 끝이 단추 위로 오게)', () => {
    expect(code('app/dashboard/dashboard-shell.tsx')).toMatch(/<div ref=\{setRef\} className="[^"]*pb-\[var\(--shell-launcher-clear,0px\)\]/);
  });

  it('⭐--shell-chrome-h의 네 가지 값 모두 띠 높이와 단추 여백을 더한다(하나라도 빠지면 그 모양의 앵커가 넘친다)', () => {
    const css = src('app/globals.css');
    const rules = [...css.matchAll(/--shell-chrome-h:\s*([^;]+);/g)].map((m) => m[1]!);
    expect(rules.length).toBe(4);
    for (const r of rules) {
      expect(r, r).toContain('var(--shell-bands-h, 0px)');
      expect(r, r).toContain('var(--shell-launcher-clear, 0px)');
    }
  });

  it('⭐단추 여백 4rem은 `<html data-support-launcher>`일 때만(단추가 그려질 때만 — 단추 컴포넌트가 같은 값으로 켜고 끈다)', () => {
    const css = src('app/globals.css');
    expect(css).toMatch(/:root\[data-support-launcher\] \.dashboard-shell-root\s*\{\s*--shell-launcher-clear:\s*calc\(4rem \+ env\(safe-area-inset-bottom, 0px\)\);/);
    expect(css.match(/--shell-launcher-clear:\s*calc\(4rem/g)?.length).toBe(1);
    expect(src('components/support-widget/support-widget-launcher.tsx')).toContain("SUPPORT_LAUNCHER_ATTR = 'data-support-launcher'");
  });
});
