// @vitest-environment jsdom
// story #4277(PO 라이브 반려 · 유나 판정) — 402 목록 보기에서 파일 이름 칸이 0px였다: 행 칸 `26px_1fr_92px_78px_150px_30px` + gap 10 × 5 +
// 좌우 18 × 2 = 고정 462px > 402라 `1fr`이 0으로 줄었다. e2e 가드는 «목록 폭 > 300»만 봐 이름 0px인데도 초록이었다.
// ① 칸 예산: 칸 정의 한 상수(ASSET_ROW_GRID)를 풀어 폰 폭(360 · 390 · 402)에서 이름 칸(1fr)에 남는 폭을 계산한다(레이아웃 엔진 없이 결정적).
// ② 행 모양: lg 미만 둘째 줄 순서([사용처] · 확장자 · 크기 · 시간 · 폴더) · 업로더는 lg 이상 칸에만.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ASSET_ROW_GRID, StorageAssetRow } from './storage-asset-row';

vi.mock('./storage-uploader-avatar', () => ({ StorageUploaderAvatar: () => <span data-testid="uploader-avatar" /> }));

const MIN_NAME_PX = 200; // 이름이 주인공(유나) — 폰 폭에서 이 이상 남아야 한다.

/** `grid-cols-[a_b_c]`(접두 없는 = lg 미만) 와 gap · 좌우 여백(px)을 풀어 고정 폭 합을 구한다. */
function mobileFixedPx(cls: string): { fixed: number; frCount: number } {
  const tokens = cls.split(/\s+/);
  const cols = tokens.find((t) => t.startsWith('grid-cols-['))!.slice('grid-cols-['.length, -1).split('_');
  const gap = Number(tokens.find((t) => t.startsWith('gap-['))!.match(/(\d+)px/)![1]);
  const px = Number(tokens.find((t) => t.startsWith('px-['))!.match(/(\d+)px/)![1]);
  let fixed = 0; let frCount = 0;
  for (const c of cols) {
    if (/fr$/.test(c)) frCount += 1;
    else fixed += Number(c.match(/^(\d+)px$/)![1]);
  }
  return { fixed: fixed + gap * (cols.length - 1) + px * 2, frCount };
}

describe('스토리지 목록 행 — 폰 폭 칸 예산(story #4277)', () => {
  it.each([360, 390, 402])('⭐%ipx — 이름 칸(1fr)에 %s 이상 남는다(예전 여섯 칸은 고정 462px라 0)', (width) => {
    const { fixed, frCount } = mobileFixedPx(ASSET_ROW_GRID);
    expect(frCount).toBe(1);
    expect(width - fixed).toBeGreaterThanOrEqual(MIN_NAME_PX);
  });

  it('lg 이상은 예전 여섯 칸 그대로(데스크톱 행 모양 무변)', () => {
    expect(ASSET_ROW_GRID).toContain('lg:grid-cols-[26px_1fr_92px_78px_150px_30px]');
  });

  it('예산 계산이 실제로 잡는다(양성대조 — 예전 여섯 칸이면 402에서 음수)', () => {
    const { fixed } = mobileFixedPx('grid gap-[10px] px-[18px] grid-cols-[26px_1fr_92px_78px_150px_30px]');
    expect(402 - fixed).toBeLessThan(MIN_NAME_PX);
  });
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container); });
afterEach(async () => { await act(async () => { root.unmount(); }); container.remove(); });

const asset = (links: number) => ({
  id: 'a1', name: '분기 보고서 최종본.pdf', content_type: 'application/pdf', size_bytes: 2048, folder_id: 'f1',
  source_links: Array.from({ length: links }, (_, i) => ({ id: `l${i}` })),
  created_by: { id: 'm1', name: '아주 긴 이름을 가진 시스템 업로더 계정' }, updated_at: '2026-09-25T00:00:00Z', created_at: '2026-09-25T00:00:00Z',
});
async function renderRow(links: number) {
  await act(async () => {
    root.render(
      <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
        {/* @ts-expect-error — 테스트 표본(필요 필드만) */}
        <StorageAssetRow asset={asset(links)} selected={false} folderLabel="회의록" onSelect={() => {}} onDelete={() => {}} onDownload={() => {}} />
      </NextIntlClientProvider>,
    );
  });
  return container.querySelector('[data-testid="storage-row-meta-mobile"]') as HTMLElement;
}

describe('스토리지 목록 행 — lg 미만 두 줄(story #4277 · 유나 판정)', () => {
  it('⭐사용처 있을 때: 둘째 줄 = 사용처 · 확장자 · 크기 · … · 폴더(폴더가 끝) · sr-only «사용처»', async () => {
    const meta = await renderRow(2);
    expect(meta.className).toContain('lg:hidden');
    const text = meta.textContent ?? '';
    expect(text.indexOf(koMessages.storage.colUsage)).toBe(0);
    expect(text.indexOf('2')).toBeLessThan(text.indexOf('PDF'));
    expect(text.trimEnd().endsWith('회의록')).toBe(true);
  });

  it('사용처 없으면 둘째 줄에 안 그림 · 업로더는 lg 이상 칸에만(둘째 줄에 없음)', async () => {
    const meta = await renderRow(0);
    const text = meta.textContent ?? '';
    expect(text).not.toContain(koMessages.storage.colUsage);
    expect(text).not.toContain('아주 긴 이름');
    const uploaderCell = container.querySelector('[data-testid="uploader-avatar"]')!.parentElement!;
    expect(uploaderCell.className).toMatch(/\bhidden\b/);
    expect(uploaderCell.className).toContain('lg:flex');
  });
});

describe('스토리지 목록 행 — 메뉴 버튼(story #4277 · 유나 판정)', () => {
  it('⭐메뉴 이름은 «{name} 작업»(행 이름과 다름) · 호버 되는 기기(pointer-fine)만 숨김 — 그 밖엔 늘 보임', async () => {
    await renderRow(0);
    const trigger = container.querySelector('[aria-label$="작업"]') as HTMLElement;
    expect(trigger?.getAttribute('aria-label')).toBe('분기 보고서 최종본.pdf 작업');
    expect(trigger.className).toContain('opacity-100');
    expect(trigger.className).toContain('pointer-fine:opacity-0');
    expect(trigger.className).not.toMatch(/(^|\s)(lg:)?opacity-0(\s|$)/);
  });
});

