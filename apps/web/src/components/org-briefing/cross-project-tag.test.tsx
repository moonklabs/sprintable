// @vitest-environment jsdom
//
// story #3870 — CrossProjectTag를 attention-cluster-board.tsx(은퇴 잔재 삭제)에서
// 자기 파일로 옮기며, 그 파일의 vitest 스위트에 딸려 있던 간접 커버리지가 함께 사라지지
// 않게 직접 테스트를 둔다.
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CrossProjectTag } from './cross-project-tag';

let container: HTMLDivElement;
let root: Root;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(ui: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(ui));
}

describe('CrossProjectTag', () => {
  it('label이 null이면 아무것도 렌더하지 않는다', () => {
    render(<CrossProjectTag label={null} />);
    expect(container.textContent).toBe('');
  });

  it('label이 있으면 배지에 그 값을 그대로 보인다', () => {
    render(<CrossProjectTag label="다른-프로젝트" />);
    expect(container.textContent).toContain('다른-프로젝트');
  });
});
