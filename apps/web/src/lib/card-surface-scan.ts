// story #3785 — 「배경 위 테두리만 있는 상자」 판정선 5조건 스캐너. e2e/card-surface-guard.spec.ts
// (page.evaluate로 브라우저 컨텍스트에 이 함수를 직접 주입 — 순수 함수라 클로저 참조 없이
// 그대로 직렬화된다)와 그 단위테스트(card-surface-scan.test.ts, jsdom)가 이 하나를 공유한다.
// 두 갈래가 갈라지면(예: e2e만 고치고 단위테스트가 낡은 사본을 검증) 뮤테이션 방어가
// 무의미해지므로 반드시 이 파일 하나가 SSOT.
//
// 판정선 5조건(유나 定, story #3785 본문) — 모두 만족해야 «배경 위 무표면 상자»로 센다.
//   ① 자기 표면이 없다 — backgroundColor alpha < 0.01(투명)이거나, 불투명이어도 그 색이
//     body 배경색과 같다(bg-background 재도색, PO 지적 2026-09-10 10:40Z). backgroundImage는 none.
//   ② 네 변이 다 있는 상자다 — border-*-width 넷 다 ≥ 1.
//   ③ 모서리가 둥글다 — border-radius > 0(네 모서리 中 하나라도).
//   ④ 컨테이너다 — 폼 컨트롤/버튼/링크(및 그 자손)가 아니고 w ≥ 160·h ≥ 48.
//   ⑤ 바로 페이지 배경 위다 — 가장 가까운 «불투명 배경» 조상의 배경색 == body의 배경색.
export function countSurfacelessBoxes(): number {
  function parseColor(str: string): { r: number; g: number; b: number; a: number } | null {
    // "transparent" 키워드 — 실 브라우저는 rgba(0, 0, 0, 0)으로 정규화하지만(getComputedStyle),
    // 이 키워드 그대로 돌려주는 엔진(jsdom 등)도 있어 명시적으로 걷는다.
    if (str === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
    const m = str.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const parts = m[1].split(',').map((s) => parseFloat(s.trim()));
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  }
  const bodyColor = parseColor(getComputedStyle(document.body).backgroundColor);
  if (!bodyColor) return -1;

  function sameAsBody(c: { r: number; g: number; b: number; a: number }): boolean {
    return c.a >= 0.99 && Math.abs(c.r - bodyColor!.r) <= 1 && Math.abs(c.g - bodyColor!.g) <= 1 && Math.abs(c.b - bodyColor!.b) <= 1;
  }

  function hasNoOwnSurface(el: Element): boolean {
    const cs = getComputedStyle(el);
    if (cs.backgroundImage !== 'none') return false;
    const c = parseColor(cs.backgroundColor);
    if (!c) return false;
    if (c.a < 0.01) return true;
    return sameAsBody(c);
  }

  function hasFullBorder(el: Element): boolean {
    const cs = getComputedStyle(el);
    return (
      parseFloat(cs.borderTopWidth) >= 1 &&
      parseFloat(cs.borderRightWidth) >= 1 &&
      parseFloat(cs.borderBottomWidth) >= 1 &&
      parseFloat(cs.borderLeftWidth) >= 1
    );
  }

  function hasRoundedCorner(el: Element): boolean {
    const cs = getComputedStyle(el);
    return (
      parseFloat(cs.borderTopLeftRadius) > 0 ||
      parseFloat(cs.borderTopRightRadius) > 0 ||
      parseFloat(cs.borderBottomLeftRadius) > 0 ||
      parseFloat(cs.borderBottomRightRadius) > 0
    );
  }

  function isContainer(el: Element): boolean {
    if (el.closest('button, a, input, select, textarea, [role="button"], [role="link"]')) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 160 && r.height >= 48;
  }

  function nearestOpaqueAncestorIsBody(el: Element): boolean {
    let cur = el.parentElement;
    while (cur && cur !== document.documentElement) {
      const c = parseColor(getComputedStyle(cur).backgroundColor);
      if (c && c.a >= 0.99) return sameAsBody(c);
      cur = cur.parentElement;
    }
    return true;
  }

  let count = 0;
  for (const el of Array.from(document.querySelectorAll('*'))) {
    if (!hasNoOwnSurface(el)) continue;
    if (!hasFullBorder(el)) continue;
    if (!hasRoundedCorner(el)) continue;
    if (!isContainer(el)) continue;
    if (!nearestOpaqueAncestorIsBody(el)) continue;
    count += 1;
  }
  return count;
}
