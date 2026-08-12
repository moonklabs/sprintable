// @vitest-environment jsdom
//
// story #2541 — 클러스터 카드가 top-N(3)만 기본 노출하고 "전체보기"로 나머지를 펼치는지,
// 데이터 없는 유형은 카드 자체를 안 그리는지(없는 데이터에 화면 안 깎기) 왕복 검증한다.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { AttentionClusterBoard } from './attention-cluster-board';
import type { FalsifiedClusterItem, StalledClusterItem } from './derive-attention-clusters';

let container: HTMLDivElement;
let root: Root;

function wrap(node: React.ReactNode) {
  return (
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">
      {node}
    </NextIntlClientProvider>
  );
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
});

function stalledItem(i: number): StalledClusterItem {
  return { id: `s${i}`, title: `스토리 ${i}`, days: 10 - i, href: `/board?story=s${i}` };
}

describe('AttentionClusterBoard', () => {
  it('둘 다 비어 있으면 아무것도 렌더하지 않는다', async () => {
    await act(async () => { root.render(wrap(<AttentionClusterBoard falsified={[]} stalled={[]} />)); });
    expect(container.innerHTML).toBe('');
  });

  it('데이터 있는 유형만 카드로 그린다(가설 반증 0건이면 그 카드 자체가 없다)', async () => {
    await act(async () => {
      root.render(wrap(<AttentionClusterBoard falsified={[]} stalled={[stalledItem(0)]} />));
    });
    expect(container.textContent).toContain(koMessages.orgBriefing.clusterStalledTitle);
    expect(container.textContent).not.toContain(koMessages.orgBriefing.clusterFalsifiedTitle);
  });

  it('story #2541 AC1 — 20건이 top-3만 기본 노출되고 "전체보기"로 나머지가 펼쳐진다', async () => {
    const items = Array.from({ length: 20 }, (_, i) => stalledItem(i));
    await act(async () => {
      root.render(wrap(<AttentionClusterBoard falsified={[]} stalled={items} />));
    });

    let rows = container.querySelectorAll('a');
    expect(rows).toHaveLength(3);
    expect(container.textContent).toContain('17');

    const toggle = Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes('전체보기'));
    expect(toggle).toBeTruthy();
    await act(async () => { toggle!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });

    rows = container.querySelectorAll('a');
    expect(rows).toHaveLength(20);
  });

  it('가설 반증 카드는 목표→최종 실측과 대체 가설 유무를 보인다', async () => {
    const item: FalsifiedClusterItem = {
      id: 'h1', title: '온보딩 연결 완료율이 오르면 채택이 는다',
      target: 70, actual: 41, hasOutcome: true, supersededId: 'h2', href: '/flow?hypothesis=h1',
    };
    await act(async () => {
      root.render(wrap(<AttentionClusterBoard falsified={[item]} stalled={[]} />));
    });
    expect(container.textContent).toContain('70');
    expect(container.textContent).toContain('41');
    expect(container.textContent).toContain(koMessages.orgBriefing.clusterBegetLinked);
  });

  it('대체 가설이 없으면 미연결 정직 문구를 보인다(대체 가설 제목을 지어내지 않는다)', async () => {
    const item: FalsifiedClusterItem = {
      id: 'h1', title: 'X', target: null, actual: null, hasOutcome: false, supersededId: null, href: '/flow?hypothesis=h1',
    };
    await act(async () => {
      root.render(wrap(<AttentionClusterBoard falsified={[item]} stalled={[]} />));
    });
    expect(container.textContent).toContain(koMessages.orgBriefing.clusterBegetUnlinked);
    expect(container.textContent).toContain(koMessages.orgBriefing.clusterFalsifiedResultUnknown);
  });
});
