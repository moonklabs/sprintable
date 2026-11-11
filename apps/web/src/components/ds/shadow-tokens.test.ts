// UI-3(a9d56577) — 어느 부품이 어느 그림자 토큰을 쓰는지(소스 글 단언 — 부품마다 렌더 환경이 달라 한 곳에서 못박는다):
// popup = 떠 있는 작은 상자(토스트 · 달력 팝업) / overlay = 바깥을 가리거나 목록을 연 큰 상자(대화창 · 패널 · 메뉴). 서로 바뀌면 빨개진다.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = (f: string) => readFileSync(join(__dirname, f), 'utf-8');
const SHADOWS = { popup: ['toast-card.tsx', 'date-picker.tsx'], overlay: ['dialog.tsx', 'panel.tsx', 'menu.tsx'] } as const;

describe('ds 그림자 토큰 사용', () => {
  for (const [kind, files] of Object.entries(SHADOWS)) {
    for (const f of files) {
      it(`${f}는 shadow-ds-${kind}만 쓴다`, () => {
        const text = src(f);
        const other = kind === 'popup' ? 'overlay' : 'popup';
        expect(text).toContain(`shadow-ds-${kind}`);
        expect(text).not.toContain(`shadow-ds-${other}`);
        expect(text).not.toMatch(/(^|[\s'"`])shadow-(md|xl|lg|sm)(?![\w-])/);
      });
    }
  }
});
