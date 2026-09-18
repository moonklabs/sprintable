/**
 * story #3785 — 카드 표면 재발 가드(주). 판정선 5조건을 만족하는 «배경 위 무표면 상자»를
 * 라우트마다 세어 0임을 단언한다(contrast-guard.spec.ts와 동형 — 실 렌더 픽셀이 authority).
 *
 * 판정선 5조건(유나 定, story #3785 본문) — 다음을 모두 만족하는 요소를 «배경 위 무표면
 * 상자»로 센다.
 *   ① 자기 표면이 없다 — backgroundColor alpha < 0.01(투명)이거나, 불투명이어도 그 색이
 *     body 배경색과 같다(bg-background 재도색). backgroundImage는 none.
 *   ② 네 변이 다 있는 상자다 — border-*-width 넷 다 ≥ 1(구분선·밑줄 배제).
 *   ③ 모서리가 둥글다 — border-radius > 0(네 모서리 中 하나라도).
 *   ④ 컨테이너다 — 폼 컨트롤/버튼/링크(및 그 자손)가 아니고 w ≥ 160·h ≥ 48.
 *   ⑤ 바로 페이지 배경 위다 — 가장 가까운 «불투명 배경» 조상의 배경색 == body의 배경색.
 *     ⑤번이 카드 안·다이얼로그 안(= --card/--popover 위)을 자동으로 걷어낸다 — 그래서
 *     rewards의 행(리더보드·원장 항목)처럼 구역 카드 안에 중첩된 border-only 요소는
 *     구역 카드가 표면을 지는 순간 자동으로 「2층」이 되어 이 스캔에서 빠진다(별도 수정 불요).
 *
 * 양성대조(필수, 라우트마다 3건) — 이 자가 실제로 무는지 매 라우트에서 확認한다.
 *   (a) 표면 있는 합성 카드(bg: var(--card)) 주입 → 카운트 불변(거짓양성 0).
 *   (b) 표면을 걷은(투명) 합성 카드 주입 → 카운트 정확히 +1(투명형을 잡는가).
 *   (c) bg-background로 재도색한 합성 카드 주입 → 카운트 정확히 +1(재도색형을 잡는가 —
 *       PO 지적 2026-09-10 10:40Z: 「투명」만 재면 이 형이 통째로 빠진다).
 * 세 조건을 모두 통과하지 못한 라우트의 실측치는 쓰지 않는다(expect가 그 자리에서 실패).
 *
 * ⚠️ 이 스펙이 «못 잡는 것»:
 *   ①아래 ROUTES 목록 밖 화면(정적 정규식 보조 가드가 상한을 잰다 — verify-no-card-surface-
 *     less-box.ts) ②org 데이터가 있어야만 렌더되는 자리(CI e2e owner는 빈 org) ③160×48
 *     미만의 소품(색 견본 칩 등 — 조건 ④가 의도적으로 배제) ④SSR 최초 프레임 이후 클라이언트
 *     에서 조건부로 나타나는 상자(로딩 완료 대기는 waitForLoadState뿐, 개별 상태 전이는 미추적).
 */
import { test, expect, type Page } from '@playwright/test';
import { countSurfacelessBoxes } from '../src/lib/card-surface-scan';

test.use({ storageState: './playwright/.auth/owner.json' });

// story #3785(유나 라이브 실측 · PO 재검) — 이 스토리가 실제로 손댄 라우트만 건다. 정적
// 상한(107/67파일)은 스윕 «후보»이지 이 가드의 목록이 아니다 — 범위를 넓히려면 자로 라우트를
// 더 재는 것이 길이다(본문 ④절).
const ROUTES: Array<{ path: string; label: string }> = [
  { path: '/organization/channels', label: 'channels(목록 컨테이너 3자리)' },
  { path: '/organization/content-rules', label: 'content-rules(목록 컨테이너 1자리)' },
  { path: '/organization/trust', label: 'trust(목록 컨테이너 2자리 — admin/self 배타분기)' },
  { path: '/rewards', label: 'rewards(구역 카드 3자리 — 재도색형)' },
  { path: '/standup', label: 'standup(구역 카드 1자리 — 재도색형)' },
  { path: '/docs/design-tokens', label: 'design-tokens(표본 컨테이너 1자리·8상자)' },
];

/** 합성 카드를 document.body 직계 자식으로 주입한다(조건 ⑤가 항상 성립하도록 — nearest
 * opaque ancestor가 정확히 body가 되게). id로 반환해 호출부가 지운다. */
async function injectSyntheticBox(page: Page, background: string): Promise<string> {
  return page.evaluate((bg) => {
    const el = document.createElement('div');
    const id = `card-surface-guard-probe-${Math.random().toString(36).slice(2)}`;
    el.id = id;
    el.style.position = 'fixed';
    el.style.left = '-9999px'; // 뷰포트 밖 — 실 UI를 가리지 않는다(getBoundingClientRect는 여전히 값을 낸다).
    el.style.top = '0px';
    el.style.width = '200px';
    el.style.height = '60px';
    el.style.borderRadius = '8px';
    el.style.border = '1px solid rgba(0,0,0,0.2)';
    el.style.background = bg;
    document.body.appendChild(el);
    return id;
  }, background);
}

async function removeSyntheticBox(page: Page, id: string): Promise<void> {
  await page.evaluate((elId) => { document.getElementById(elId)?.remove(); }, id);
}

for (const { path: routePath, label } of ROUTES) {
  test(`배경 위 무표면 상자 = 0 — ${label}`, async ({ page }) => {
    await page.goto(routePath, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200); // SSE 앱 — networkidle 대신 짧은 정착 대기(#dev-pixel 교훈, contrast-guard와 동형).

    // 「안 그려진 0」 배제 — 렌더가 안 된 페이지의 0은 「깨끗함」이 아니다.
    const nodeCount = await page.evaluate(() => document.querySelectorAll('*').length);
    const textLength = await page.evaluate(() => document.body.innerText.length);
    expect(nodeCount, `${routePath} — 페이지가 사실상 안 그려짐(node ${nodeCount}) — 라우트/인증/시드를 먼저 확認할 것`).toBeGreaterThan(50);
    expect(textLength, `${routePath} — 페이지 텍스트가 사실상 없음(len ${textLength}) — 렌더 실패 의심`).toBeGreaterThan(10);

    const baseline = await page.evaluate(countSurfacelessBoxes);

    // 양성대조 (a) 표면 있는 카드 — 카운트 불변.
    const surfacedId = await injectSyntheticBox(page, 'var(--card)');
    const afterSurfaced = await page.evaluate(countSurfacelessBoxes);
    await removeSyntheticBox(page, surfacedId);
    expect(afterSurfaced, `${routePath} — 양성대조(a) 실패: 표면 있는 합성 카드가 거짓양성을 냈다(${baseline}→${afterSurfaced})`).toBe(baseline);

    // 양성대조 (b) 투명 카드 — 정확히 +1.
    const transparentId = await injectSyntheticBox(page, 'transparent');
    const afterTransparent = await page.evaluate(countSurfacelessBoxes);
    await removeSyntheticBox(page, transparentId);
    expect(afterTransparent, `${routePath} — 양성대조(b) 실패: 투명 합성 카드를 못 잡음(자가 고장·이 라우트 실측 불신)(${baseline}→${afterTransparent})`).toBe(baseline + 1);

    // 양성대조 (c) bg-background 재도색 카드 — 정확히 +1(PO 지적 10:40Z 클래스).
    const repaintedId = await injectSyntheticBox(page, 'var(--background)');
    const afterRepainted = await page.evaluate(countSurfacelessBoxes);
    await removeSyntheticBox(page, repaintedId);
    expect(afterRepainted, `${routePath} — 양성대조(c) 실패: bg-background 재도색 합성 카드를 못 잡음(${baseline}→${afterRepainted})`).toBe(baseline + 1);

    // 양성대조 셋을 통과한 라우트의 실측치만 판정에 쓴다.
    expect(baseline, `${routePath} — 배경 위 무표면 상자 ${baseline}건 발견(Card/SectionCard로 치환할 것)`).toBe(0);
  });
}
