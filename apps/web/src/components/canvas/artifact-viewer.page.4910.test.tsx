// @vitest-environment jsdom
//
// 4910 — 산출물 상세 화면의 «쪽 배치»(`layout="page"`) 구조 시험. 스토리 패널이 쓰는 기본 배치(`embedded`)는 그대로여야 한다(양쪽 다 잰다).
// SSR 마크업(effects 없음)을 DOM으로 풀어 구조 · 층 · 동작 자리를 단정한다 — 위 막대 제목은 화면(`artifact-detail-view`)의 몫이라 여기엔 없다.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import koMessages from '../../../messages/ko.json';
import { ArtifactViewer } from './artifact-viewer';
import { LAYER } from '@/components/ds/layers';
import { MOCK_ARTIFACT, MOCK_VERSIONS, MOCK_MEMBERS } from '@/services/canvas';
import { MOCK_THREADS } from '@/services/canvas-comments';

function render(node: React.ReactElement): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(
    <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>,
  );
  return host;
}

const noop = () => undefined;
const classesOf = (el: Element, layer: string) => layer.split(' ').every((c) => el.classList.contains(c));

describe('ArtifactViewer layout="page" (4910)', () => {
  it('한 쪽 틀: 칸 = LAYER.panel + 컨테이너 쿼리 · 보기 영역 = LAYER.well · 오른쪽 열은 칸 폭 문턱에서만 옆에 선다(좁으면 아래)', () => {
    const h = render(<ArtifactViewer layout="page" artifact={MOCK_ARTIFACT} versions={MOCK_VERSIONS} memberMap={MOCK_MEMBERS} />);
    const panel = h.querySelector('[data-testid="artifact-detail-panel"]')!;
    expect(panel).not.toBeNull();
    expect(classesOf(panel, LAYER.panel)).toBe(true);
    expect(panel.classList.contains('@container')).toBe(true);
    const grid = panel.firstElementChild!;
    expect(grid.className).toContain('grid-cols-1');
    expect(grid.className).toContain('@min-[860px]:grid-cols-[minmax(0,1fr)_340px]');
    const stage = panel.querySelector('[data-stage-region]')!;
    expect(classesOf(stage, LAYER.well)).toBe(true);
    const column = panel.querySelector('[data-testid="artifact-detail-column"]')!;
    expect(column.tagName).toBe('ASIDE');
    expect(column.className).toContain('@min-[860px]:border-l');
    expect(column.className).toContain('border-t'); // 좁을 때(아래로 내려옴)는 위 경계선
    // 오른쪽 열 하나에 계보(레일)가 들어 있다 — 따로 옆 레일(border-l 고정)이 아니다.
    expect(column.textContent).toContain('버전 계보');
    expect(stage.parentElement).toBe(grid);
    expect(column.parentElement).toBe(grid);
  });

  it('머리: 제목 글(h1 · h2)을 다시 세우지 않고 칩(형식 · 정본) + 보는 판 고르개 + ds 단추만 선다', () => {
    const h = render(<ArtifactViewer layout="page" artifact={MOCK_ARTIFACT} versions={MOCK_VERSIONS} memberMap={MOCK_MEMBERS} onCreateThread={async () => true} onProposeCanonical={noop} />);
    expect(h.querySelector('h1')).toBeNull();
    expect(h.textContent).not.toContain(MOCK_ARTIFACT.title);
    const head = h.querySelector('[data-slot="ds-page-head"]')!;
    const chips = [...head.querySelectorAll('[data-slot="ds-chip"]')].map((c) => c.textContent);
    expect(chips).toContain(MOCK_ARTIFACT.format);
    expect(chips).toContain('정본 v3');
    const select = head.querySelector('select')!;
    expect(select.getAttribute('aria-label')).toBe('보는 판');
    expect([...select.options].map((o) => o.textContent)).toEqual([...MOCK_VERSIONS].sort((a, b) => b.version - a.version).map((v) => `v${v.version}`));
    const actions = head.querySelector('[data-slot="ds-page-head-actions"]')!;
    const buttons = [...actions.querySelectorAll('button')];
    expect(buttons.length).toBeGreaterThanOrEqual(3);
    expect(buttons.every((b) => b.getAttribute('data-slot') === 'ds-button')).toBe(true); // 손으로 쓴 button 0
    expect(buttons.map((b) => b.textContent)).toEqual(expect.arrayContaining(['정본으로 제안', '내보내기']));
  });

  it('동작 자리 = 있던 동작 그대로: 크게 보기는 html만 · 편집은 tree + onEnterEdit만 · 정본 제안은 정본이 아닌 판을 볼 때만(대기 중이면 칩)', () => {
    const html = render(<ArtifactViewer layout="page" artifact={{ ...MOCK_ARTIFACT, format: 'html' }} versions={MOCK_VERSIONS} memberMap={MOCK_MEMBERS} />);
    expect(html.textContent).toContain('크게 보기');
    const tree = render(<ArtifactViewer layout="page" artifact={{ ...MOCK_ARTIFACT, format: 'tree' }} versions={MOCK_VERSIONS} memberMap={MOCK_MEMBERS} onEnterEdit={noop} />);
    expect(tree.textContent).not.toContain('크게 보기');
    const editBtn = [...tree.querySelectorAll('button')].find((b) => /편집/.test(b.textContent ?? ''));
    expect(editBtn).toBeDefined();
    const noEdit = render(<ArtifactViewer layout="page" artifact={{ ...MOCK_ARTIFACT, format: 'tree' }} versions={MOCK_VERSIONS} memberMap={MOCK_MEMBERS} />);
    expect([...noEdit.querySelectorAll('button')].some((b) => /편집/.test(b.textContent ?? ''))).toBe(false);
    // 기본으로 보는 판(current)이 정본이면 제안 단추 없음.
    const onAnchor = render(<ArtifactViewer layout="page" artifact={{ ...MOCK_ARTIFACT, anchor_version: MOCK_ARTIFACT.current_version }} versions={MOCK_VERSIONS} memberMap={MOCK_MEMBERS} onProposeCanonical={noop} />);
    expect(onAnchor.textContent).not.toContain('정본으로 제안');
    // 대기 중이면 단추 대신 칩.
    const pending = render(<ArtifactViewer layout="page" artifact={MOCK_ARTIFACT} versions={MOCK_VERSIONS} memberMap={MOCK_MEMBERS} onProposeCanonical={noop} pendingCanonicalizeVersion={MOCK_ARTIFACT.current_version} />);
    expect([...pending.querySelectorAll('button')].some((b) => b.textContent === '정본으로 제안')).toBe(false);
    expect([...pending.querySelectorAll('[data-slot="ds-chip"]')].some((c) => c.textContent === '정본 제안 대기 중')).toBe(true);
  });

  it('코멘트 켜고 끄기: onCreateThread가 있을 때만 aria-pressed 단추(열린 수 포함) · 없으면 단추 0', () => {
    const on = render(<ArtifactViewer layout="page" artifact={MOCK_ARTIFACT} versions={MOCK_VERSIONS} memberMap={MOCK_MEMBERS} threads={MOCK_THREADS} onCreateThread={async () => true} />);
    const toggle = [...on.querySelectorAll('button')].find((b) => b.textContent?.includes('캔버스에 코멘트 남기기'))!;
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    const open = MOCK_THREADS.filter((th) => th.rollup !== 'resolved').length;
    if (open > 0) expect(toggle.textContent).toContain(`· ${open}`);
    const off = render(<ArtifactViewer layout="page" artifact={MOCK_ARTIFACT} versions={MOCK_VERSIONS} memberMap={MOCK_MEMBERS} threads={MOCK_THREADS} />);
    expect([...off.querySelectorAll('button')].some((b) => b.textContent?.includes('캔버스에 코멘트 남기기'))).toBe(false);
  });

  it('코멘트 카드는 오른쪽 열 «코멘트» 구역 안에 선다(예전엔 카드 아래 따로 깔렸다) · 없으면 구역 자체가 없다', () => {
    const h = render(<ArtifactViewer layout="page" artifact={MOCK_ARTIFACT} versions={MOCK_VERSIONS} memberMap={MOCK_MEMBERS} threads={MOCK_THREADS} />);
    const column = h.querySelector('[data-testid="artifact-detail-column"]')!;
    const section = column.querySelector('[data-testid="artifact-detail-threads"]')!;
    expect(section).not.toBeNull();
    expect(section.getAttribute('aria-label')).toBe('코멘트');
    for (const th of MOCK_THREADS) expect(section.textContent).toContain(th.comments[0]!.body);
    const none = render(<ArtifactViewer layout="page" artifact={MOCK_ARTIFACT} versions={MOCK_VERSIONS} memberMap={MOCK_MEMBERS} threads={[]} />);
    expect(none.querySelector('[data-testid="artifact-detail-threads"]')).toBeNull();
  });

  it('계보 열: 판 줄의 «지금 · 정본»은 ds 칩이고 고른 판 줄은 LAYER.rowSelected + aria-current', () => {
    const h = render(<ArtifactViewer layout="page" artifact={MOCK_ARTIFACT} versions={MOCK_VERSIONS} memberMap={MOCK_MEMBERS} />);
    const list = h.querySelector('[data-version-list]')!;
    const current = list.querySelector('[aria-current="true"]')!;
    expect(classesOf(current, LAYER.rowSelected)).toBe(true);
    const tags = [...list.querySelectorAll('[data-slot="ds-chip"]')].map((c) => c.textContent);
    expect(tags).toContain('지금');
    expect(tags).toContain('정본');
  });
});

describe('ArtifactViewer 기본 배치(embedded) — 스토리 패널용은 예전 그대로 (4910 회귀 0)', () => {
  it('옛 카드 · 옆 레일 232 · 스토리 패널 구조 그대로이고 쪽 배치의 표지는 하나도 없다', () => {
    const h = render(<ArtifactViewer artifact={MOCK_ARTIFACT} versions={MOCK_VERSIONS} memberMap={MOCK_MEMBERS} threads={MOCK_THREADS} />);
    expect(h.querySelector('[data-testid="artifact-detail-panel"]')).toBeNull();
    expect(h.querySelector('[data-testid="artifact-detail-column"]')).toBeNull();
    expect(h.querySelector('[data-slot="ds-page-head"]')).toBeNull();
    expect(h.querySelector('[data-stage-region]')!.parentElement!.className).toContain('sm:grid-cols-[minmax(0,1fr)_232px]');
    // 제목은 예전처럼 카드 머리 안(스토리 패널엔 위 막대 제목이 없다).
    expect(h.textContent).toContain(MOCK_ARTIFACT.title);
    expect(h.querySelector('select')?.getAttribute('aria-label')).toBeNull();
  });
});
