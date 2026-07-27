// @vitest-environment jsdom
//
// story #2193 — 문서 트리 자동 묶음 뷰 렌더 검증. computeDocGroups(순수함수)는 이미
// doc-groups.test.ts에서 검증했으니, 여기선 "그룹이 접힌 헤더로 시작하는지(AC1)",
// "펼치면 폴더에 담김/폴더 밖이 나뉘어 보이는지(AC5)", "많은 멤버는 캡+더보기로
// 나뉘는지(AC3)"를 실 렌더로 확인한다.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DocAutoGroups } from './doc-auto-groups';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const LABELS = {
  inFolderLabel: '폴더에 담김',
  looseAtRootLabel: '폴더 밖',
  thisMonthLabel: '이번 달',
  lastMonthLabel: '지난 달',
  olderLabel: '이전',
  unknownDateLabel: '날짜 없음',
  moreLabel: (count: number) => `${count}개 더`,
};

// 월 경계에 걸쳐 테스트가 흔들리지 않도록 고정 — bucketDocsByTime과 동일하게 now를 주입.
const FIXED_NOW = new Date('2026-07-27T00:00:00Z');

function doc(id: string, slug: string, parent_id: string | null = null, created_at?: string) {
  return { id, slug, parent_id, title: `제목-${id}`, created_at };
}

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

describe('DocAutoGroups', () => {
  it('AC1 — 그룹 헤더는 접힌 채로 시작한다(멤버가 처음부터 보이지 않는다)', async () => {
    const docs = [doc('1', 'policy-a'), doc('2', 'policy-b'), doc('3', 'policy-c')];
    await act(async () => { root.render(<DocAutoGroups docs={docs} selectedSlug={null} onSelect={() => {}} {...LABELS} />); });

    expect(container.textContent).toContain('POLICY');
    expect(container.querySelectorAll('nav > div button').length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain('제목-1');
  });

  it('AC5 — 폴더에 담김/폴더 밖이 둘 다 있으면 펼쳤을 때 구분 서브헤더로 나뉜다', async () => {
    const docs = [
      doc('1', 'policy-a', 'folder-x'),
      doc('2', 'policy-b', 'folder-x'),
      doc('3', 'policy-c', null),
    ];
    await act(async () => { root.render(<DocAutoGroups docs={docs} selectedSlug={null} onSelect={() => {}} {...LABELS} />); });

    const header = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('POLICY'))!;
    await act(async () => { header.click(); });

    expect(container.textContent).toContain('폴더에 담김');
    expect(container.textContent).toContain('폴더 밖');
    expect(container.textContent).toContain('제목-1');
    expect(container.textContent).toContain('제목-3');
  });

  it('AC5 음성대조 — 한쪽이 0이면(전량 폴더 밖) 구분 서브헤더 없이 평면으로 나열한다', async () => {
    const docs = [doc('1', 'policy-a'), doc('2', 'policy-b'), doc('3', 'policy-c')];
    await act(async () => { root.render(<DocAutoGroups docs={docs} selectedSlug={null} onSelect={() => {}} {...LABELS} />); });

    const header = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('POLICY'))!;
    await act(async () => { header.click(); });

    expect(container.textContent).not.toContain('폴더에 담김');
    expect(container.textContent).not.toContain('폴더 밖');
    expect(container.textContent).toContain('제목-1');
  });

  it('AC3 — 멤버가 CAP(8)개를 넘으면 "N개 더" 버튼 뒤로 접히고, 누르면 전부 보인다', async () => {
    const docs = Array.from({ length: 10 }, (_, i) => doc(`${i}`, `bigroup-${i}`));
    await act(async () => { root.render(<DocAutoGroups docs={docs} selectedSlug={null} onSelect={() => {}} {...LABELS} />); });

    const header = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('BIGROUP'))!;
    await act(async () => { header.click(); });

    expect(container.textContent).toContain('제목-0');
    expect(container.textContent).not.toContain('제목-9');
    const moreBtn = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '2개 더')!;
    expect(moreBtn).toBeDefined();

    await act(async () => { moreBtn.click(); });
    expect(container.textContent).toContain('제목-9');
  });

  it('클릭 시 onSelect(slug)가 호출된다', async () => {
    const docs = [doc('1', 'policy-a'), doc('2', 'policy-b'), doc('3', 'policy-c')];
    const selected: string[] = [];
    await act(async () => { root.render(<DocAutoGroups docs={docs} selectedSlug={null} onSelect={(slug) => selected.push(slug)} {...LABELS} />); });

    const header = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('POLICY'))!;
    await act(async () => { header.click(); });
    const leaf = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === '제목-1')!;
    await act(async () => { leaf.click(); });

    expect(selected).toEqual(['policy-a']);
  });

  it('접두어가 약해(최소크기 미달) 어떤 그룹도 못 만들면 시간 그릇(created_at 있으면 이번 달 등)으로 떨어진다', async () => {
    const docs = [doc('1', 'onlyone-a', null, '2026-07-01T00:00:00Z'), doc('2', 'onlyone-b', null, '2026-07-02T00:00:00Z')];
    await act(async () => { root.render(<DocAutoGroups docs={docs} selectedSlug={null} onSelect={() => {}} now={FIXED_NOW} {...LABELS} />); });

    expect(container.textContent).toContain('이번 달');
  });

  it('AC2/AC6 — created_at이 없는 문서는 "날짜 없음"으로 명시적으로 분리되고, 값이 있으면 "이번 달"/"지난 달"/"이전"으로 갈린다', async () => {
    const docs = [
      doc('1', 'onlyone-a', null, undefined), // created_at 없음
      doc('2', 'onlyone-b', null, '2026-01-01T00:00:00Z'), // 오래 전
    ];
    await act(async () => { root.render(<DocAutoGroups docs={docs} selectedSlug={null} onSelect={() => {}} now={FIXED_NOW} {...LABELS} />); });

    expect(container.textContent).toContain('날짜 없음');
    expect(container.textContent).toContain('이전');

    const unknownHeader = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('날짜 없음'))!;
    await act(async () => { unknownHeader.click(); });
    expect(container.textContent).toContain('제목-1');
  });
});
