// @vitest-environment jsdom
//
// [SID:4345] 문서 주소 칩의 «주소 바꾸기»(연필)는 `opacity-0 … focus-visible:opacity-100 group-hover:opacity-100`이었다 —
// 키보드 초점에선 보였지만 터치(호버 없음)에선 늘 투명했다. 이제 HOVER_REVEAL(호버 없는 기기에선 늘)이다.
// jsdom은 CSS를 안 입혀서 보임 여부는 클래스 모양으로 핀한다.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { HOVER_REVEAL } from '@/lib/hover-reveal';
import { DocUrlChip } from './doc-url-chip';

function editButton() {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(
    <DocUrlChip slug="release-notes" onEdit={() => {}} labels={{ editUrl: '주소 바꾸기', slugNudge: '제목으로 주소 만들기' }} />,
  );
  return { wrapper: host.firstElementChild as HTMLElement, button: host.querySelector<HTMLButtonElement>('button[aria-label="주소 바꾸기"]')! };
}

describe('DocUrlChip «주소 바꾸기» — 호버 전용 아님([SID:4345])', () => {
  it('HOVER_REVEAL 모양 · 맨 opacity-0 없음 · 초점 링은 그대로 · 부모에 group', () => {
    const { wrapper, button } = editButton();
    const tokens = button.className.split(/\s+/);
    for (const t of HOVER_REVEAL.split(' ')) expect(tokens, t).toContain(t);
    expect(tokens).not.toContain('opacity-0');
    expect(tokens).toContain('focus-visible:ring-1');
    expect(wrapper.className.split(/\s+/)).toContain('group');
  });
});
