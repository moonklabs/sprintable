// @vitest-environment jsdom
// UI-3(a9d56577) AC3 — 부품 견본 화면 회귀가드: 한 쪽에 모든 ds 부품이 밝음 · 어둠 두 틀로 그려진다 · 토큰이 이름과 함께 보인다 · 부품이 새로 생기면 견본에도 있어야 한다.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../../messages/ko.json';
import { ShowcaseFrame } from './ds-showcase';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(async () => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul"><ShowcaseFrame today="2026-11-11" /></NextIntlClientProvider>);
  });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});
const frame = (theme: 'light' | 'dark') => container.querySelector(`[data-theme-frame="${theme}"]`) as HTMLElement;

describe('ds 견본 화면 (AC3)', () => {
  it('⭐밝음 · 어둠 두 틀이 나란히 — 어둠 틀만 .dark 감싸개이고 둘 다 같은 견본을 그린다', () => {
    expect(frame('light')).not.toBeNull();
    expect(frame('dark')).not.toBeNull();
    expect(frame('dark').classList.contains('dark')).toBe(true);
    expect(frame('light').classList.contains('dark')).toBe(false);
    const parts = (t: HTMLElement) => Array.from(t.querySelectorAll('[data-slot]')).map((e) => e.getAttribute('data-slot'));
    expect(parts(frame('dark'))).toEqual(parts(frame('light')));
  });

  it('⭐토큰: 색 27종 · 글자 8단 가운데 7 · 모서리 4 · 밀도 6 · 그림자 2 이름이 코드의 이름 그대로 보인다', () => {
    const text = frame('light').textContent ?? '';
    for (const c of ['surface-sunk', 'action-text', 'needs-hand-bar', 'on-needs-hand', 'failed-soft', 'info-soft', 'scrim']) expect(text, c).toContain(c);
    for (const d of ['control-sm 28', 'compact 32', 'control 36', 'touch 44', 'control-xl 48', 'row 56']) expect(text, d).toContain(d);
    for (const r of ['tag 2', 'control 4', 'panel 8', 'pill 12']) expect(text, r).toContain(r);
    for (const s of ['popup', 'overlay']) expect(text, s).toContain(s);
    expect(text).toContain('fast 100ms');
    expect(text).toContain('enter 300ms');
  });

  it('⭐모든 ds 부품이 견본에 있다 — ds 폴더에 부품 파일이 새로 생겼는데 견본에 안 넣으면 빨개진다', () => {
    const dir = join(__dirname, '..');
    const sources = readdirSync(dir).filter((f) => f.endsWith('.tsx') && !f.endsWith('.test.tsx'));
    const showcase = readdirSync(__dirname).filter((f) => f.startsWith('showcase-') && f.endsWith('.tsx')).map((f) => readFileSync(join(__dirname, f), 'utf-8')).join('\n');
    // 견본에 «안 넣는» 파일(부품이 아니거나 내부용)은 이유와 함께 명시한다.
    const NOT_A_PART = new Map<string, string>([
      ['icon.tsx', '아이콘 — IconButton · Banner 등 안에서 늘 보인다'],
      ['icon-paths.ts', '아이콘 경로 표'],
    ]);
    // 임포트만 남기고 사용을 지워도 통과하지 않도록: 파일이 내보내는 부품(대문자 이름) 중 하나라도 견본에서 실제로 «그려져야» 한다(`<이름`).
    const drawn = (file: string) => {
      const src = readFileSync(join(dir, file), 'utf-8');
      const names = [...src.matchAll(/export (?:function|const) ([A-Z]\w*)/g)].map((m) => m[1]!);
      return names.some((n) => new RegExp(`<${n}[\\s/>]`).test(showcase));
    };
    const missing = sources.filter((f) => !NOT_A_PART.has(f) && !drawn(f)).map((f) => f.replace(/\.tsx$/, ''));
    expect(missing).toEqual([]);
  });

  it('⭐이름이 필수인 부품에는 이름이 있다 — 진행 막대 · 단계 · 시간 줄 · 달력 · 탭 줄(접근 가능한 이름 없는 막대/목록 0)', () => {
    for (const el of Array.from(container.querySelectorAll('[role="progressbar"]'))) {
      expect((el.getAttribute('aria-label') ?? '').length, 'progressbar').toBeGreaterThan(0);
    }
    for (const sel of ['[data-slot="ds-stepper"]', '[data-slot="ds-timeline"]', 'nav[aria-label]']) {
      for (const el of Array.from(container.querySelectorAll(sel))) {
        expect(el.getAttribute('aria-label') ?? el.getAttribute('aria-labelledby'), sel).toBeTruthy();
      }
    }
    for (const g of Array.from(container.querySelectorAll('[role="grid"]'))) expect(g.getAttribute('aria-label')).toBeTruthy();
  });

  it('상태 견본: 단추 비활성 · 불러오는 중 · 입력 오류 · 내 손이 필요 · 모름 값이 둘 다 틀에 있다', () => {
    for (const t of ['light', 'dark'] as const) {
      const f = frame(t);
      expect(f.querySelector('button[disabled]'), `${t} disabled`).not.toBeNull();
      expect(f.querySelector('[aria-busy="true"]'), `${t} busy`).not.toBeNull();
      expect(f.querySelector('[aria-invalid="true"]'), `${t} invalid`).not.toBeNull();
      expect(f.querySelector('[data-needs-hand="true"], [data-tone="needs-hand"]'), `${t} needs-hand`).not.toBeNull();
      expect(f.querySelector('[data-unavailable="true"]'), `${t} unavailable`).not.toBeNull();
    }
  });
});
