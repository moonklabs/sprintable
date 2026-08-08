// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DocSyncBanner } from './doc-sync-banner';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const labels = {
  title: '제목',
  pull: '새로 불러오기',
  overwrite: '덮어쓰기',
  keepEditing: '계속 편집',
  discardWarning: '경고',
  overwriteConfirm: '확인',
};

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

// story #2513 — 카디르 QA 발견: alert.tsx 글자가 text-foreground로 통일된 후, 색을
// 명시하지 않은 아이콘(RotateCw, info 분기)은 부모의 currentColor를 상속해 variant
// 색(info)을 잃는다.
describe('DocSyncBanner — 아이콘 색 유지 (story #2513 회귀가드)', () => {
  it('status=remote-changed(info) — RotateCw 아이콘이 text-info를 갖는다', async () => {
    await act(async () => {
      root.render(
        <DocSyncBanner
          status="remote-changed"
          isDirty={false}
          onPull={() => {}}
          onOverwrite={() => {}}
          onDismiss={() => {}}
          labels={labels}
        />,
      );
    });
    const icon = container.querySelector('svg');
    expect(icon?.getAttribute('class')).toContain('text-info');
  });

  it('status=conflict(warning) — AlertTriangle 아이콘은 이미 text-foreground라 별도 색 지정 불필요(무영향 확認)', async () => {
    await act(async () => {
      root.render(
        <DocSyncBanner
          status="conflict"
          isDirty={true}
          onPull={() => {}}
          onOverwrite={() => {}}
          onDismiss={() => {}}
          labels={labels}
        />,
      );
    });
    const alertEl = container.querySelector('[role="alert"]');
    expect(alertEl?.className).toContain('text-foreground');
  });
});
