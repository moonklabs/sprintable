// @vitest-environment jsdom
//
// story #3785 — countSurfacelessBoxes()(판정선 5조건)의 단위테스트. e2e/card-surface-guard.
// spec.ts가 실 라우트에서 같은 함수를 페이지 컨텍스트에 주입해 쓴다(import 하나 공유, 이 파일
// 헤더 주석 참고) — 여기서는 jsdom으로 각 조건을 개별 뮤테이션-킬한다(getBoundingClientRect는
// jsdom이 항상 0을 내므로 이 파일에서만 stub한다).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { countSurfacelessBoxes } from './card-surface-scan';

// jsdom은 레이아웃 엔진이 없어 getBoundingClientRect가 항상 0×0 — 폭/높이 조건(④)을 실측처럼
// 테스트하려면 요소별로 직접 stub한다(data-w/data-h 속성으로 원하는 크기를 실어 보낸다).
function stubBoundingRect() {
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (this: Element) {
    const w = parseFloat(this.getAttribute('data-w') ?? '0');
    const h = parseFloat(this.getAttribute('data-h') ?? '0');
    return { width: w, height: h, top: 0, left: 0, right: w, bottom: h, x: 0, y: 0, toJSON() { return this; } } as DOMRect;
  };
  return () => { Element.prototype.getBoundingClientRect = original; };
}

let restoreRect: () => void;

beforeEach(() => {
  restoreRect = stubBoundingRect();
  // body 자체가 페이지 배경(#F4F2EC 상당) — 명시적으로 불투명 색을 지정해 기준을 고정한다.
  document.body.style.backgroundColor = 'rgb(244, 242, 236)';
  document.body.innerHTML = '';
});

afterEach(() => {
  restoreRect();
  document.body.innerHTML = '';
});

/** 조건 ①~④를 전부 만족하는 「배경 위 무표면 상자」 하나를 body 직계 자식으로 만든다.
 * ⚠️jsdom은 `border-radius` 약칭을 `border-top-left-radius` 등 개별 속성의 getComputedStyle
 * 계산값으로 안 풀어낸다(cssstyle 한계 — 실측: 약칭만 주면 개별 속성이 "0"으로 읽힘) — 그래서
 * 개별 속성을 직접 지정한다(실 브라우저에서는 약칭이든 개별이든 같은 계산값을 낸다). */
function makeSurfacelessBox(overrides?: Partial<{ bg: string; borderWidth: string; radius: string; w: string; h: string }>) {
  const el = document.createElement('div');
  el.style.backgroundColor = overrides?.bg ?? 'transparent';
  el.style.borderStyle = 'solid';
  el.style.borderWidth = overrides?.borderWidth ?? '1px';
  const radius = overrides?.radius ?? '8px';
  el.style.borderTopLeftRadius = radius;
  el.style.borderTopRightRadius = radius;
  el.style.borderBottomLeftRadius = radius;
  el.style.borderBottomRightRadius = radius;
  el.setAttribute('data-w', overrides?.w ?? '200');
  el.setAttribute('data-h', overrides?.h ?? '60');
  document.body.appendChild(el);
  return el;
}

/** makeSurfacelessBox와 같은 이유로 개별 radius 속성을 직접 건다 — button/nested 케이스처럼
 * document.body가 아닌 다른 부모에 붙이는 자리에서 쓴다. */
function applyBoxStyle(el: HTMLElement, opts?: Partial<{ bg: string; borderWidth: string; radius: string; w: string; h: string }>) {
  el.style.backgroundColor = opts?.bg ?? 'transparent';
  el.style.borderStyle = 'solid';
  el.style.borderWidth = opts?.borderWidth ?? '1px';
  const radius = opts?.radius ?? '8px';
  el.style.borderTopLeftRadius = radius;
  el.style.borderTopRightRadius = radius;
  el.style.borderBottomLeftRadius = radius;
  el.style.borderBottomRightRadius = radius;
  el.setAttribute('data-w', opts?.w ?? '200');
  el.setAttribute('data-h', opts?.h ?? '60');
}

describe('countSurfacelessBoxes — story #3785 판정선 5조건', () => {
  it('5조건을 전부 만족하는 상자 1개 → 1을 센다(기준선)', () => {
    makeSurfacelessBox();
    expect(countSurfacelessBoxes()).toBe(1);
  });

  it('조건①(투명형) — 자기 표면(불투명 bg)이 있으면 안 센다', () => {
    makeSurfacelessBox({ bg: 'rgb(255, 255, 255)' }); // body와 다른 불투명 색 = 진짜 카드 표면
    expect(countSurfacelessBoxes()).toBe(0);
  });

  it('조건①(재도색형) — body와 같은 불투명 색으로 칠해도 센다(bg-background 재도색 버그)', () => {
    makeSurfacelessBox({ bg: 'rgb(244, 242, 236)' }); // body와 동일 = 재도색
    expect(countSurfacelessBoxes()).toBe(1);
  });

  it('조건② — 네 변 中 하나라도 테두리가 없으면 안 센다(구분선·밑줄류 배제)', () => {
    const el = makeSurfacelessBox();
    el.style.borderBottomWidth = '0px';
    expect(countSurfacelessBoxes()).toBe(0);
  });

  it('조건③ — 모서리가 각지면(radius 0) 안 센다', () => {
    makeSurfacelessBox({ radius: '0px' });
    expect(countSurfacelessBoxes()).toBe(0);
  });

  it('조건④(폭) — 160 미만이면 소품으로 보고 안 센다', () => {
    makeSurfacelessBox({ w: '159' });
    expect(countSurfacelessBoxes()).toBe(0);
  });

  it('조건④(높이) — 48 미만이면 소품으로 보고 안 센다', () => {
    makeSurfacelessBox({ h: '47' });
    expect(countSurfacelessBoxes()).toBe(0);
  });

  it('조건④(경계값) — 정확히 160×48이면 센다(하한 포함)', () => {
    makeSurfacelessBox({ w: '160', h: '48' });
    expect(countSurfacelessBoxes()).toBe(1);
  });

  it('조건④(폼 컨트롤 배제) — button 자신은 5조건을 만족해도 안 센다', () => {
    const btn = document.createElement('button');
    applyBoxStyle(btn);
    document.body.appendChild(btn);
    expect(countSurfacelessBoxes()).toBe(0);
  });

  it('조건④(폼 컨트롤 자손 배제) — button 안의 자손 상자도 안 센다', () => {
    const btn = document.createElement('button');
    const inner = document.createElement('div');
    applyBoxStyle(inner);
    btn.appendChild(inner);
    document.body.appendChild(btn);
    expect(countSurfacelessBoxes()).toBe(0);
  });

  it('조건⑤ — 이미 카드(불투명·body와 다른 색) 안에 중첩되면 안 센다(2층 자동 승계)', () => {
    const card = document.createElement('div');
    card.style.backgroundColor = 'rgb(255, 255, 255)'; // body와 다른 불투명 색 = 카드 표면
    document.body.appendChild(card);
    const row = document.createElement('div');
    applyBoxStyle(row);
    card.appendChild(row);
    expect(countSurfacelessBoxes()).toBe(0);
  });

  it('조건⑤ — 카드 안에 중첩됐더라도 카드 자체가 재도색(bg-background)이면 여전히 센다', () => {
    const fakeCard = document.createElement('div');
    applyBoxStyle(fakeCard, { bg: 'rgb(244, 242, 236)' }); // body와 동일 = 재도색(카드 아님)
    document.body.appendChild(fakeCard);
    const row = document.createElement('div');
    applyBoxStyle(row);
    fakeCard.appendChild(row);
    // fakeCard 자신도 조건 ①~④를 만족하므로 1, row는 조상(fakeCard)이 body와 같은 색이라
    // 조건⑤가 여전히 참 — 둘 다 잡혀 2.
    expect(countSurfacelessBoxes()).toBe(2);
  });

  it('여러 상자가 섞이면 조건을 만족하는 것만 정확히 센다', () => {
    makeSurfacelessBox(); // 카운트
    makeSurfacelessBox({ bg: 'rgb(255, 255, 255)' }); // 진짜 카드 — 제외
    makeSurfacelessBox({ radius: '0px' }); // 각진 상자 — 제외
    makeSurfacelessBox(); // 카운트
    expect(countSurfacelessBoxes()).toBe(2);
  });
});
