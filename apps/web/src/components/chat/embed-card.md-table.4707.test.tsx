// @vitest-environment jsdom
//
// story 4707 (선생님 폰 지적 · Yuna AC0) — 챗에서 연 문서의 표. 둘째 렌더러(MdBody)에 표 처리기가 0이라 칸이 서로 붙고 넓은 표가 문서 전체를
// 옆으로 밀었다. 표는 전체 보기와 «정의 하나»(docs/doc-table.tsx): 규칙 상수 + 가로 스크롤 상자 + 폰(<640) 4열 이상 = 행마다 카드.
// 되돌리면(`table` 처리기를 빼면) 아래 시험이 빨개진다 — 그 표는 선생님이 못 읽은 걷기 표 문서의 실제 줄(표 셋)이다.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import { MdBody } from './embed-card';
import { CARD_BELOW_MAX_PX, COLUMN_MIN_PX, DOC_TABLE_RULES, DocTable, PHONE_CARD_MIN_COLUMNS, cardBelowPx, cardsAtBoxWidth, readDocTable } from '@/components/docs/doc-table';
import koMessages from '../../../messages/ko.json';

// 걷기 표 문서(doc 2e593422)의 실제 표 셋 — 5열(§1 걷기 표 · 긴 한글 칸 · 코드 · 링크 칸) · 3열(§0) · 6열(§6)
const WALK_5 = `| # | ① 선생님 손 | ② 닫는 AC 칸 | ③ 우리가 볼 것 (선생님께 묻지 않음) | ④ 선생님께 물을 한 줄 |
|---|---|---|---|---|
| 4 | 웹(ux1 로그인) 설정 › «데스크톱 앱 받기» [다운로드] → 받은 dmg 열기 → 앱을 «응용 프로그램»에 끌기 → 앱 더블클릭 | 4672 AC3(더블클릭으로 열림) · 4668 AC5(표면 전환 웹 → 앱 1) | 카드에 «처음 열면 macOS가 막아요» 안내 0(공증 판) · 제품 이름 · 버전 · 빌드 = 0-1 sha | «앱을 처음 열 때 뜬 창이 ‹인터넷에서 받은 앱 · 열기› 확인 하나였나요?» |
| 5 | 앱 첫 창 → 앱 안 «계정 추가» → ux1 로그인 → 셋업 [시작] | 4668 AC4 · 4670 AC1 실사용 | 셋업 행(\`GET /api/desktop/setups/{id}\` · kind · confirmed) · \`GET /api/organizations/{id}/remote-control\` → \`enabled: true\` |  |`;
const WALK_3 = `| # | 할 일 | 누가 |
|---|---|---|
| 0-1 | **판 = 8f653af1e** (PO 11:52Z) | PO · 유나 |`;
const WALK_7 = `| a | b | c | d | e | f | g |
|---|---|---|---|---|---|---|
| 1 | 2 | 3 | 4 | 5 | 6 | 7 |`;
const WALK_6 = `| 스토리 | AC1 | AC2 | AC3 | AC4 | AC5 |
|---|---|---|---|---|---|
| 4668 | ✅ 시험 | ✅ 시험 | ✅ 시험 + 유나 | 🚶5 | 🚶4~5 |`;

function wrap(node: React.ReactNode) {
  return <NextIntlClientProvider locale="ko" messages={koMessages} timeZone="Asia/Seoul">{node}</NextIntlClientProvider>;
}
function render(content: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = renderToStaticMarkup(wrap(<MdBody content={content} />));
  return host;
}
const cards = (host: HTMLElement) => [...host.querySelectorAll('[data-doc-table-card]')] as HTMLElement[];

describe('챗 문서 미리보기의 표 — story 4707', () => {
  it('5열 표: 표는 가로 스크롤 상자 안에 · 카드는 표를 감싼 «칸의 폭» 기준(컨테이너 쿼리) — 칸 < 열 수 × 160px(5열 = 800)이면 카드 · 그 이상이면 표 (되돌리면 상자도 카드도 없다)', () => {
    const host = render(WALK_5);
    const table = host.querySelector('table')!;
    expect(table).not.toBeNull();
    const shell = table.parentElement!;
    expect(shell.className).toContain('overflow-x-auto'); // 표만 스크롤 — 문서 전체가 아니라
    expect(shell.className).toContain('rounded-xl');
    // story 4707 다시 열림(선생님 지적): 화면 폭(sm:)이 아니라 표를 감싼 칸의 폭 — 넓은 화면의 좁은 옆 문서 칸(480~720px)도 카드
    const box = host.querySelector('[data-doc-table-box]') as HTMLElement;
    expect(box.className).toContain('@container');
    expect(box.getAttribute('data-card-below')).toBe('800'); // 5열 = 5 × 160
    expect(shell.parentElement!.className).toContain('hidden @min-[800px]:block'); // 칸이 좁으면 표를 숨기고 카드를 보인다
    const list = host.querySelector('[data-doc-table-cards]')!;
    expect(list.className).toContain('@min-[800px]:hidden');
    expect(`${box.innerHTML}`).not.toMatch(/\bsm:(hidden|block)\b/); // 화면 폭 기준은 남지 않았다
    expect(cards(host)).toHaveLength(2); // 본문 행 둘 = 카드 둘
  });

  // PO 5118 판정: 열 하나 최소 160px — 칸 폭 < 열 수 × 160이면 카드(4열 640 · 5열 800 · 6열 960 · 7열 이상 1120 상한 — 유나 판정)
  it('열 수에 비례한 전환 폭: 4열 640 · 5열 800 · 6열 960 · 7열 이상 1120(상한) — 클래스 리터럴과 순수 함수가 같다', () => {
    expect(COLUMN_MIN_PX).toBe(160);
    expect(CARD_BELOW_MAX_PX).toBe(1120);
    expect([4, 5, 6, 7, 12].map(cardBelowPx)).toEqual([640, 800, 960, 1120, 1120]);
    for (const [md, below] of [[WALK_5, 800], [WALK_6, 960], [WALK_7, 1120], ['| a | b | c | d |\n|---|---|---|---|\n| 1 | 2 | 3 | 4 |', 640]] as const) {
      const host = render(md);
      expect(host.querySelector('[data-doc-table-box]')!.getAttribute('data-card-below')).toBe(String(below));
      expect(host.querySelector('[data-doc-table-cards]')!.className).toContain(`@min-[${below}px]:hidden`); // 클래스 문자열이 상수와 같다
      expect(host.querySelector('[data-doc-table-box] > div')!.className).toContain(`hidden @min-[${below}px]:block`);
    }
  });

  // codex 질문(까디르): 가장 가까운 컨테이너가 이 상자인가 · 쿼리를 모르는 웹뷰에서 둘 다 보이거나 둘 다 안 보이지 않는가
  it('카드 목록과 표 상자는 모두 표 상자(@container)의 직계 자식 — 위쪽 다른 컨테이너가 아니라 이 상자의 폭을 본다', () => {
    const host = render(WALK_5);
    const box = host.querySelector('[data-doc-table-box]') as HTMLElement;
    expect(box.className).toBe('@container');
    expect(host.querySelector('[data-doc-table-cards]')!.parentElement).toBe(box);
    expect(host.querySelector('table')!.parentElement!.parentElement!.parentElement).toBe(box); // table > 스크롤 상자 > 전환 div > 표 상자
  });

  it('컨테이너 쿼리를 모르는 웹뷰: 표는 기본이 hidden · 카드는 기본이 보임 — @min 규칙을 못 읽으면 카드만 남는다(둘 다 보이거나 둘 다 안 보이는 일 없음)', () => {
    const host = render(WALK_5);
    const tableBox = host.querySelector('table')!.parentElement!.parentElement as HTMLElement;
    const base = (c: string) => c.split(/\s+/).filter((t) => !t.includes(':'));
    expect(base(tableBox.className)).toContain('hidden'); // @min 없이는 표를 숨김
    expect(base(host.querySelector('[data-doc-table-cards]')!.className)).not.toContain('hidden'); // @min 없이는 카드를 보임
  });

  // 선생님이 매일 보는 크기: 넓은 창 옆 문서 칸 720 → 안쪽 672. 5열 표가 열당 134px로 눌리면 안 된다
  it('[PO 5118] 720 칸(안쪽 672): 5열 표 = 카드 · 4열 표 = 표 — 576 · 650 · 390 칸은 모두 카드 · 넓은 칸은 표', () => {
    expect(cardsAtBoxWidth(5, 672)).toBe(true); // 5열 · 720 칸 = 카드
    expect(cardsAtBoxWidth(4, 672)).toBe(false); // 4열 · 720 칸 = 표 (672 ≥ 640)
    expect(cardsAtBoxWidth(6, 672)).toBe(true);
    for (const box of [358, 528, 602]) for (const cols of [4, 5, 6]) expect(cardsAtBoxWidth(cols, box)).toBe(true); // 폰 390 · 칸 576 · 칸 650
    expect(cardsAtBoxWidth(5, 800)).toBe(false); // 정확히 열 수 × 160이면 표
    expect(cardsAtBoxWidth(6, 960)).toBe(false);
    expect(cardsAtBoxWidth(9, 1100)).toBe(true); // 상한 1120 — 7열 이상은 1120 미만이면 카드
    expect(cardsAtBoxWidth(9, 1120)).toBe(false); // 전체 폭 1440 창의 안쪽 1,390은 표
    expect(cardsAtBoxWidth(3, 300)).toBe(false); // 3열은 카드 대상이 아니다
  });

  it('카드 한 장 = «머리: 값» 줄들 — 칸 내용(코드 · 강조)이 그대로 · 빈 칸은 줄이 없다', () => {
    const host = render(WALK_5);
    const [first, second] = cards(host);
    const lines = [...first!.querySelectorAll('p')].map((p) => p.textContent);
    expect(lines[0]).toBe('#: 4');
    expect(lines[1]).toContain('① 선생님 손: 웹(ux1 로그인)');
    expect(lines).toHaveLength(5); // 칸 5 = 줄 5
    expect(second!.querySelectorAll('p')).toHaveLength(4); // 마지막 칸이 빈 줄 → 줄 없음
    expect(second!.querySelector('code')).not.toBeNull(); // 인라인 코드가 카드에서도 코드
    expect([...second!.querySelectorAll('p')].map((p) => p.textContent).join('')).not.toContain('④ 선생님께 물을 한 줄');
  });

  it('긴 한글 칸이 줄을 바꾼다 — 카드 줄은 overflow-wrap:anywhere · 인라인 코드 · 링크도', () => {
    const host = render(`${WALK_5}\n\n문장 \`GET /api/aaaaaaaaaaaaaaaaaaaa/{id}\` 과 [링크](https://example.com/aaaaaaaaaaaaaaaaaaaaaaaa)`);
    expect(host.querySelector('[data-doc-table-card] p')!.className).toContain('[overflow-wrap:anywhere]');
    const bodyCode = [...host.querySelectorAll('code')].pop()!;
    expect(bodyCode.className).toContain('[overflow-wrap:anywhere]');
    expect(host.querySelector('a[href^="https://example.com"]')!.className).toContain('[overflow-wrap:anywhere]');
  });

  it('3열 표는 카드가 아니라 표 그대로(가로 스크롤 상자) · 폰에서 낱말 단위 줄바꿈 · 칸 최소 폭 규칙은 없다(짧은 칸이 긴 칸을 누르지 않게)', () => {
    const host = render(WALK_3);
    expect(host.querySelector('[data-doc-table-cards]')).toBeNull();
    const shell = host.querySelector('table')!.parentElement!;
    expect(shell.className).toContain('overflow-x-auto');
    expect(shell.className).toContain('max-sm:[&_th]:[word-break:keep-all]');
    expect(shell.className).not.toContain('min-w-28'); // Chrome 390px 측정: 3열 표 648px → 1303px 로 길어졌던 규칙
    expect(PHONE_CARD_MIN_COLUMNS).toBe(4);
  });

  it('경계: 정확히 4열 = 카드 · 3열 = 표(위) — 4열 이상부터', () => {
    const host = render('| a | b | c | d |\n|---|---|---|---|\n| 1 | 2 | 3 | 4 |');
    expect(cards(host)).toHaveLength(1);
    expect(host.querySelector('[data-doc-table-box]')!.getAttribute('data-card-below')).toBe('640');
  });

  it('6열 표도 카드 — 열 수 기준은 머리 열 수', () => {
    const host = render(WALK_6);
    expect(cards(host)).toHaveLength(1);
    expect(cards(host)[0]!.querySelectorAll('p')).toHaveLength(6);
  });

  it('표 규칙은 전체 보기와 같은 상수 · 표 글은 본문과 같은 14px(text-sm) · 본문 상자는 min-w-0', () => {
    const host = render(WALK_5);
    const wrapper = host.firstElementChild as HTMLElement;
    for (const piece of DOC_TABLE_RULES.split(' ')) expect(wrapper.className).toContain(piece);
    expect(wrapper.className).toContain('[&_th]:text-sm');
    expect(wrapper.className).toContain('[&_td]:text-sm');
    expect(wrapper.className).toContain('min-w-0');
    expect(DOC_TABLE_RULES).toContain('[&_th]:border');
    expect(DOC_TABLE_RULES).toContain('[&_td]:px-3');
  });

  it('구분선(---)은 처리기가 있다', () => {
    const host = render('위\n\n---\n\n아래');
    expect(host.querySelector('hr')!.className).toContain('border-border');
  });

  it('전체 보기용 DocTable(phoneCards 끔)은 열이 많아도 카드를 안 만든다 — 챗만 카드', () => {
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(
      <DocTable>
        <thead><tr><th>a</th><th>b</th><th>c</th><th>d</th><th>e</th></tr></thead>
        <tbody><tr><td>1</td><td>2</td><td>3</td><td>4</td><td>5</td></tr></tbody>
      </DocTable>,
    );
    expect(host.querySelector('[data-doc-table-cards]')).toBeNull();
    expect(host.querySelector('table')!.parentElement!.className).toContain('overflow-x-auto');
  });

  it('readDocTable: 머리가 없으면 null · 머리와 행의 칸을 읽는다', () => {
    expect(readDocTable(<tbody><tr><td>1</td></tr></tbody>)).toBeNull();
    const read = readDocTable([<thead key="h"><tr><th>x</th><th>y</th></tr></thead>, <tbody key="b"><tr><td>1</td><td>2</td></tr></tbody>]);
    expect(read!.headers).toEqual(['x', 'y']);
    expect(read!.rows).toEqual([['1', '2']]);
  });
});
