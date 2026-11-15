// @vitest-environment jsdom
//
// 4910 — 산출물 상세 · 스토리 패널이 같이 쓰는 안쪽 세 부품(코멘트 카드 · 설명 · 가리키는 것들)이 ds 토큰으로 옮겨 갔는지.
// 구조 · 글 · 동작은 그대로(그쪽 옛 시험이 지킨다) — 여기서는 «옛 색 토큰이 하나도 안 남고 ds 부품 · 토큰이 선 것»만 잰다.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { CommentThreadCard } from './comment-thread-card';
import { DescriptionPane } from './description-pane';
import { EntityBacklinksSection } from '@/components/shared/entity-backlinks-section';
import { MOCK_MEMBERS } from '@/services/canvas';
import { MOCK_THREADS } from '@/services/canvas-comments';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 옛 토큰 계열(색 · 글자 크기) — 이 세 부품 안에는 하나도 없어야 한다.
const LEGACY = /(?<![\w-])(?:text-(?:muted-foreground|foreground|info|success)|bg-(?:muted|card|background|info\/\d+|success\/\d+)|border-border|text-micro|text-editorial-meta|text-xs|shadow-\[var\(--elev-card\)\])(?![\w-])/;

// 번호 핀(AnchorPin)도 이제 ds 토큰이라(4910 ③ · 대비는 styles/pin-contrast.4910.test.tsx) 카드 머리의 핀까지 포함해 통째로 검사한다.
const legacyScan = (el: HTMLElement) => el.innerHTML;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

const wrap = (node: React.ReactNode) => (
  <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>
);
const mount = (node: React.ReactNode) => act(async () => { root.render(wrap(node)); });

describe('CommentThreadCard — ds 토큰 (4910)', () => {
  it('열린 카드: 옛 토큰 0 · 상태는 ds Chip(info) · 답글 칸은 ds Input에 이름 · «해결»은 ds Button', async () => {
    const open = MOCK_THREADS.find((t) => t.rollup === 'open')!;
    await mount(<CommentThreadCard thread={open} memberMap={MOCK_MEMBERS} onReply={() => undefined} onResolve={() => undefined} />);
    expect(legacyScan(container)).not.toMatch(LEGACY);
    const chip = container.querySelector('[data-slot="ds-chip"]')!;
    expect(chip.getAttribute('data-tone')).toBe('info');
    expect(chip.textContent).toBe('열림');
    const input = container.querySelector('input')!;
    expect(input.getAttribute('aria-label')).toBe(input.getAttribute('placeholder'));
    const resolve = [...container.querySelectorAll('button')].find((b) => b.textContent === '해결')!;
    expect(resolve.getAttribute('data-slot')).toBe('ds-button');
  });

  it('해결된 카드: 상태 칩은 done 톤 · 가라앉음(opacity)은 그대로 · 답글 칸 · 해결 단추 없음', async () => {
    const resolved = MOCK_THREADS.find((t) => t.rollup === 'resolved')!;
    await mount(<CommentThreadCard thread={resolved} memberMap={MOCK_MEMBERS} onReply={() => undefined} onResolve={() => undefined} />);
    expect(legacyScan(container)).not.toMatch(LEGACY);
    expect(container.querySelector('[data-slot="ds-chip"]')!.getAttribute('data-tone')).toBe('done');
    expect(container.firstElementChild!.classList.contains('opacity-70')).toBe(true);
    expect(container.querySelector('input')).toBeNull();
  });
});

describe('DescriptionPane — ds 토큰 (4910)', () => {
  it('글이 있을 때 · 빈 안내일 때 모두 옛 토큰 0', async () => {
    await mount(<DescriptionPane description="헤더는 primary 배경입니다." elementLabel="헤더" />);
    expect(container.innerHTML).not.toMatch(LEGACY);
    expect(container.textContent).toContain('헤더는 primary 배경입니다.');
    await mount(<DescriptionPane description={null} />);
    expect(container.innerHTML).not.toMatch(LEGACY);
    expect(container.textContent).toContain('핀을 선택하면');
  });
});

describe('EntityBacklinksSection — ds 토큰 (4910)', () => {
  const item = (id: string, still: boolean, title: string) => ({ id, source_type: 'doc', source_id: id, created_by: { id: 'm', name: '안나', type: 'human' }, created_at: '2026-07-28T00:00:00Z', relation: 'none', still_exists: still, doc: { id, title }, message: null });
  async function load(props: { className?: string } = {}, items = [item('r1', true, '살아있는 문서'), item('r2', false, '없어진 문서')]) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: items, meta: { next_cursor: null, has_more: false } }))));
    await act(async () => { root.render(wrap(<EntityBacklinksSection entityType="artifact" entityId="a1" {...props} />)); });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  }

  it('목록: 옛 토큰 0 · 끊어진 항목 표시는 ds Chip · 바깥 선은 ds-line', async () => {
    await load();
    expect(container.innerHTML).not.toMatch(LEGACY);
    expect(container.textContent).toContain('살아있는 문서');
    const gone = [...container.querySelectorAll('[data-slot="ds-chip"]')].map((c) => c.textContent);
    expect(gone).toEqual(['대상이 없어요']);
    const root_ = container.firstElementChild!;
    expect(root_.classList.contains('border-ds-line')).toBe(true);
  });

  it('빈 목록 안내도 옛 토큰 0', async () => {
    await load({}, []);
    expect(container.innerHTML).not.toMatch(LEGACY);
    expect(container.textContent).toContain('가리키는 곳이 없어요');
  });

  it('className으로 바깥 선을 끌 수 있다(오른쪽 열 구분선과 겹치지 않게) — 기본은 선이 있다', async () => {
    await load({ className: 'border-t-0' });
    expect(container.firstElementChild!.className).toContain('border-t-0');
    await load();
    expect(container.firstElementChild!.className).not.toContain('border-t-0');
  });
});
