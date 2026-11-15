// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ListRow } from './list-row';
import { DataText } from './data-text';

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
});
const row = () => container.querySelector('[data-slot="ds-list-row"]') as HTMLElement;

describe('ds ListRow', () => {
  it('⭐앞 자리 칸은 기본 shrink-0이고 leadingClassName을 받는다 — 화면이 고정 폭을 주면 줄마다 제목이 같은 x에서 시작(4911)', async () => {
    await act(async () => {
      root.render(<ListRow leading={<i data-testid="lead" />} leadingClassName="sm:w-[7.5rem]" title="제목" />);
    });
    const cell = row().querySelector('[data-slot="ds-list-row-leading"]') as HTMLElement;
    expect(cell.className).toContain('shrink-0');
    expect(cell.className).toContain('sm:w-[7.5rem]');
    expect(cell.querySelector('[data-testid="lead"]')).not.toBeNull();
    await act(async () => { root.render(<ListRow leading={<i data-testid="lead" />} title="제목" />); });
    expect((row().querySelector('[data-slot="ds-list-row-leading"]') as HTMLElement).className).toBe('shrink-0');   // no prop → exactly as before
  });

  it('앞 자리 · 제목 · 고정폭 둘째 줄 · 오른쪽 행동', async () => {
    await act(async () => {
      root.render(<ListRow leading={<i data-testid="lead" />} title="결제 수단 두 개 추가 승인" subtitle="개발 에이전트 · 12분 전" trailing={<button type="button">허용</button>} />);
    });
    expect(row().querySelector('[data-testid="lead"]')).not.toBeNull();
    expect(row().textContent).toContain('결제 수단 두 개 추가 승인');
    expect(row().querySelector('[data-slot="ds-list-row-subtitle"]')!.textContent).toBe('개발 에이전트 · 12분 전');
    expect(row().querySelector('button')!.textContent).toBe('허용');
  });

  it('⭐4928 둘째 줄은 본문 글꼴이 기본 — 한국어 낱말 사이가 고정폭 칸으로 벌어지지 않는다 · 데이터 조각만 DataText로 고정폭', async () => {
    await act(async () => { root.render(<ListRow title="줄" subtitle={<>구성원 · 모델 <DataText>claude-haiku-5-5</DataText></>} />); });
    const sub = row().querySelector('[data-slot="ds-list-row-subtitle"]') as HTMLElement;
    expect(sub.className).toContain('font-sans');
    expect(sub.className).not.toContain('font-mono');
    const data = sub.querySelector('[data-slot="ds-data-text"]') as HTMLElement;
    expect(data.className).toContain('font-mono');
    expect(data.className).toContain('tabular-nums');
    expect(data.textContent).toBe('claude-haiku-5-5');
  });

  it('⭐손 필요 줄은 왼쪽 4px 막대 + data-needs-hand', async () => {
    await act(async () => { root.render(<ListRow title="줄" needsHand needsHandLabel="내 손이 필요" />); });
    expect(row().getAttribute('data-needs-hand')).toBe('true');
    expect(row().className).toContain('before:bg-ds-needs-hand-bar');
    await act(async () => { root.render(<ListRow title="줄" />); });
    expect(row().getAttribute('data-needs-hand')).toBeNull();
    expect(row().className).not.toContain('before:bg-ds-needs-hand-bar');
  });

  it('선택은 aria-current + 눌린 면', async () => {
    await act(async () => { root.render(<ListRow title="줄" selected />); });
    expect(row().getAttribute('aria-current')).toBe('true');
    expect(row().className).toContain('bg-ds-surface-high');
  });

  it('⭐asChild면 링크 요소가 줄이 된다(href 유지 · 같은 모양)', async () => {
    await act(async () => { root.render(<ListRow asChild needsHand needsHandLabel="내 손이 필요"><a href="https://example.com/story/1">줄 전체가 링크</a></ListRow>); });
    const a = container.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://example.com/story/1');
    expect(a.className).toContain('min-h-ds-row');
    expect(a.getAttribute('data-needs-hand')).toBe('true');
  });

  it('⭐손 필요 줄은 읽히는 이름도 가진다(일반 줄 · asChild 둘 다) · 일반 줄은 없다', async () => {
    await act(async () => { root.render(<ListRow title="줄" needsHand needsHandLabel="내 손이 필요" />); });
    expect(row().querySelector('.sr-only')?.textContent).toBe('내 손이 필요');
    await act(async () => { root.render(<ListRow asChild needsHand needsHandLabel="내 손이 필요"><a href="https://example.com/s/1">제목</a></ListRow>); });
    const a = container.querySelector('a')!;
    expect(a.querySelector('.sr-only')?.textContent).toBe('내 손이 필요');
    expect(a.textContent).toContain('제목');
    await act(async () => { root.render(<ListRow title="줄" />); });
    expect(row().querySelector('.sr-only')).toBeNull();
  });

  it('타입: asChild는 요소 자식이 필수 · 아니면 title이 필수', () => {
    // @ts-expect-error asChild에 자식 요소 없음
    const a = <ListRow asChild />;
    // @ts-expect-error asChild에 글 자식
    const b = <ListRow asChild>글</ListRow>;
    // @ts-expect-error 일반 줄에 title 없음
    const c = <ListRow />;
    expect([a, b, c]).toHaveLength(3);
  });

  it('⭐asChild에 Fragment · 글을 주면 그리지 않는다(모양 · 의미를 새게 하지 않는다)', async () => {
    const frag = (<><a href="https://example.com/s/1">제목</a></>) as never;
    await act(async () => { root.render(<ListRow asChild needsHand needsHandLabel="내 손이 필요">{frag}</ListRow>); });
    expect(container.querySelector('a')).toBeNull();
    const text = '글' as never;
    await act(async () => { root.render(<ListRow asChild>{text}</ListRow>); });
    expect(container.querySelector('[data-slot="ds-list-row"]')).toBeNull();
  });

  it('⭐density=compact: 높이 36 · 폰 누름 44 이상 · 기본은 56', async () => {
    await act(async () => { root.render(<ListRow title="줄" />); });
    expect(row().className).toContain('min-h-ds-row');
    expect(row().getAttribute('data-density')).toBe('default');
    expect(row().className).not.toContain('min-h-ds-control');
    await act(async () => { root.render(<ListRow title="줄" density="compact" />); });
    expect(row().className).toContain('min-h-ds-control');
    expect(row().className).toContain('touch:min-h-ds-touch');
    expect(row().className).not.toContain('min-h-ds-row');
    expect(row().getAttribute('data-density')).toBe('compact');
  });

  it('compact도 asChild · 손 필요 · 선택과 함께 쓰인다', async () => {
    await act(async () => { root.render(<ListRow asChild density="compact" selected><a href="https://example.com/x">줄</a></ListRow>); });
    const a = container.querySelector('a')!;
    expect(a.className).toContain('min-h-ds-control');
    expect(a.getAttribute('aria-current')).toBe('true');
  });

  // 4913 C판(codex) — 오른쪽 행동 묶음(상태 칩 + 단추 + «⋯»)이 폰 좁은 폭에서 패널 가장자리에 «잘리지» 않고 둘째 줄로 내려온다.
  it('⭐행은 줄바꿈을 허용하고, 오른쪽 묶음은 오른쪽 끝에 붙은 채 줄바꿈 · 제목 칸은 최소 폭 기준(basis)을 가진다', async () => {
    await act(async () => { root.render(<ListRow title="줄" trailing={<><span>칩</span><button type="button">연결 관리</button></>} />); });
    expect(row().className).toContain('flex-wrap');
    const trailing = row().querySelector('button')!.parentElement as HTMLElement;
    expect(trailing.className).toContain('flex-wrap');
    expect(trailing.className).toContain('ml-auto');
    expect(trailing.className).toContain('justify-end');
    expect(trailing.className).toContain('max-w-full');
    expect((row().querySelector('.truncate') as HTMLElement).parentElement!.className).toContain('basis-24');
  });
});
