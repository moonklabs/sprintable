/**
 * story #3368(Phase0·마케팅운영 S4) AC8(UX 검수, 유나) — 글 관리 화면 다섯 상태의 실제
 * 렌더 캡처. doc phase0-post-manager-screen-design §8-2/§8-3(유나 2026-09-03 리뷰).
 *
 * §8-2: "컴포넌트 스냅샷은 합격으로 치지 않는다 — DOM 텍스트 assertion과 브라우저
 * 스크린샷을 함께 남긴다."
 * §8-3: 유나 리뷰 5건 전부 반영 — ①canvas 정규화 대비 측정(oklch 토큰은 rgb 정규식
 * 파서가 null을 내고 그 null을 통과로 치면 "검사 안 된 초록"이 된다) ②다크 경로(rest
 * 스캔은 contrast-guard.spec.ts가 담당, 이 파일은 비텍스트 3:1 dot 판정만) ③테스트
 * 이름=assertion(넓힌 이름엔 그만큼 실제 검증을 세운다) ④S10은 오늘 404(계약 stub)만
 * 재고 진짜 403 보존 검증은 S2·S3 뒤로 명시 분리 ⑤어휘를 시안("서버 응답 보기")에 맞춤.
 * 상태 칩은 opacity를 안 쓴다(components/content/status-chip.tsx) — computed style이
 * opacity를 합성 못 해 대비 측정이 조용히 새는 자리이기 때문.
 *
 * 페드루 PO 지시(2026-09-03) — 오늘(S2 미착지) 돌릴 수 있는 상태(목록·편집 완료·오류
 * UI 골격·대비)는 실제로 실행하고, 나머지(승인 카드·발행 URL·재승인 필요, 그리고 S10의
 * 진짜 403 보존)는 S2(content_sha256·content_version)·S3(공개 projection) 착지 뒤
 * fixture(work item·draft·gate id)만 채우면 되게 자리를 비워 둔다.
 *
 * 계정: **일반 sellerking 세션만**(카디르 QA 관례, PO스크립트 금지 — customer-zero
 * 원칙). owner.json(global-setup.ts)이 아니라 이 파일 전용 sellerking 로그인을 쓴다 —
 * 크리덴셜은 절대 하드코딩하지 않는다(SELLERKING_EMAIL/SELLERKING_PASSWORD, 로컬은
 * .env.playwright에). 둘 다 없으면 전체 스위트를 명시적으로 skip한다(무음 통과 금지).
 *
 * 실행: pnpm exec playwright test e2e/content-post-manager-states.spec.ts
 * 스크린샷: e2e/screenshots/content-*.png (git 추적 — 유나 검수가 그대로 diff 대조)
 */
import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';

const SELLERKING_EMAIL = process.env['SELLERKING_EMAIL'];
const SELLERKING_PASSWORD = process.env['SELLERKING_PASSWORD'];
const HAS_SELLERKING_CREDS = Boolean(SELLERKING_EMAIL && SELLERKING_PASSWORD);

const SCREENSHOT_DIR = path.join(__dirname, 'screenshots');

async function loginAsSellerking(page: Page): Promise<void> {
  const resp = await page.request.post('/api/auth/login', {
    data: { email: SELLERKING_EMAIL, password: SELLERKING_PASSWORD },
    headers: { 'Content-Type': 'application/json' },
  });
  if (!resp.ok()) {
    throw new Error(`sellerking 로그인 실패(${resp.status()}) — SELLERKING_EMAIL/PASSWORD 확인`);
  }
}

// contrast-guard.spec.ts(story #2590/#2607)와 동일 실 토글 헬퍼 재사용(§8-3②, 새 로직
// 발명 0) — 다크 경로는 이 함수 하나로 재현한다.
async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.addInitScript((t) => window.localStorage.setItem('theme', t), theme);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
}

/**
 * §8-3① 유나 처방 그대로 — canvas 정규화(어떤 CSS 색 문자열이든 브라우저 자신에게
 * 풀게 한다, oklch 토큰을 rgb 정규식으로 파싱하려다 null을 통과시키는 함정을 피한다).
 * 파싱 실패·opacity≠1은 조용히 넘기지 않고 던진다(무음 통과 금지).
 */
// §8-3-1(유나 실측, 2026-09-03 라이브에서 잡음) — 최초 판은 배경 한 겹만 읽어 알파
// 배경(예: thead의 bg-muted/50, 알파 0.5)을 그 색 하나로 재면 거짓 FAIL이 났다
// (thead 헤더 6개가 실측 5.10인데 2.44로 나옴). 부모부터 겹쳐 칠해 실제로 «보이는 색»을
// 만든 뒤 재는 것으로 교체 — 구현엔 결함이 없었고 이 헬퍼가 틀렸었다.
async function measureChip(page: Page, chipSel: string): Promise<{ label: number; dot: number }> {
  return page.$eval(chipSel, (chip) => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 1;
    const ctx = cv.getContext('2d', { willReadFrequently: true })!;
    const isOpaque = (c: string) =>
      !/\/\s*[\d.]+\s*\)/.test(c) && !/rgba\([^)]*,\s*(0?\.\d+|0)\s*\)/.test(c);
    // 요소 위로 올라가며 배경을 모은다 — 불투명한 색을 만나면 멈춘다(그 위는 안 보인다).
    const bgStack = (el: Element): string[] => {
      const s: string[] = [];
      let e: Element | null = el;
      while (e) {
        const bg = getComputedStyle(e).backgroundColor;
        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
          s.push(bg);
          if (isOpaque(bg)) break;
        }
        e = e.parentElement;
      }
      return s.reverse(); // 아래(부모)부터
    };
    // 캔버스에 실제로 겹쳐 칠해 "보이는 색"을 얻는다. oklch·color-mix도 브라우저가 푼다.
    const paint = (colors: string[]): [number, number, number] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = getComputedStyle(document.body).backgroundColor || '#ffffff';
      ctx.fillRect(0, 0, 1, 1);
      for (const c of colors) {
        ctx.fillStyle = '#000';
        ctx.fillStyle = c;
        if (ctx.fillStyle === '#000000' && !/^(#000000|rgb\(0,\s*0,\s*0\)|black)$/.test(c.trim())) {
          throw new Error(`색 파싱 실패: ${c}`); // 무음 통과 금지
        }
        ctx.fillRect(0, 0, 1, 1);
      }
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return [r, g, b];
    };
    const lin = (c: number) => {
      c /= 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    const L = ([r, g, b]: [number, number, number]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    const cr = (a: [number, number, number], b: [number, number, number]) => {
      const la = L(a);
      const lb = L(b);
      const hi = Math.max(la, lb);
      const lo = Math.min(la, lb);
      return +((hi + 0.05) / (lo + 0.05)).toFixed(2);
    };
    const dotEl = chip.querySelector('[data-chip-dot]');
    if (!dotEl) throw new Error('dot 요소 없음 — data-chip-dot 필요');
    for (const el of [chip, dotEl as HTMLElement]) {
      const op = getComputedStyle(el).opacity;
      if (op !== '1') throw new Error(`opacity(${op})가 걸려 있다 — computed로는 실색을 못 잰다`);
    }
    const stack = bgStack(chip);
    const bg = paint(stack);
    return {
      label: cr(paint([...stack, getComputedStyle(chip).color]), bg),
      dot: cr(paint([...stack, getComputedStyle(dotEl).backgroundColor]), bg),
    };
  });
}

test.describe('글 관리 화면 — S4 AC8 다섯 상태 캡처(sellerking 전용)', () => {
  test.beforeEach(async ({ page }) => {
    if (!HAS_SELLERKING_CREDS) {
      test.skip(true, 'SELLERKING_EMAIL/SELLERKING_PASSWORD 미설정 — .env.playwright에 채운다(크리덴셜 하드코딩 금지)');
      return;
    }
    await loginAsSellerking(page);
  });

  // ── S1 — 글 목록 ────────────────────────────────────────────────────────
  // §8-3③ — 이름이 약속하는 네 가지(제목·상태·버전·원작성 주체)를 각각 assertion으로
  // 세운다. 원작성 주체는 §4-2에서 "서버에 없는 값"이라 했으나 S1(list) 계약의
  // latest_author_kind는 이미 있다 — dev 배포 뒤엔 이 값도 실측 대상이다.
  test('S1 — 목록: 제목·상태 칩·버전·원작성 주체가 각각 실제로 보인다', async ({ page }) => {
    const response = await page.goto('/content');
    expect(response?.status(), '/content 200').toBe(200);
    await page.waitForLoadState('networkidle');

    const firstRow = page.locator('[data-testid="content-list-row"]').first();
    await expect(firstRow, '초안 행이 최소 1건 보인다').toBeVisible({ timeout: 10_000 });

    // 제목 — 빈 문자열이 아닌 실 텍스트.
    const titleCell = firstRow.locator('td').first();
    await expect(titleCell).not.toHaveText('');

    // 상태 칩 — data-status-chip이 다섯 상태 중 하나(오늘은 게이트 신호가 없어 'draft'만
    // 가능·post-status.ts::ContentPostStatus와 어휘 동일).
    const statusChip = firstRow.locator('[data-status-chip]');
    await expect(statusChip, '상태 칩이 보인다').toBeVisible();
    await expect(statusChip).toHaveAttribute('data-status-chip', /draft|pending|approved|published|reapproval_needed/);

    // 버전 — "v" + 숫자.
    await expect(firstRow, '버전 배지(v숫자)가 보인다').toContainText(/v\d+/);

    // 원작성 주체 — content.authorAgent("에이전트")/authorHuman("휴먼") 둘 중 하나.
    await expect(firstRow, '원작성 주체(에이전트/휴먼)가 보인다').toContainText(/에이전트|휴먼/);

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'content-s1-list.png'), fullPage: true });
  });

  // ── S3/S4 — 편집 완료 ───────────────────────────────────────────────────
  // §8-3③ — 저장 토스트만 보지 않는다. 버전 번호가 실제로 올라가고, 상태 칩이 "초안"
  // (미상신 — 새로 생긴 버전엔 아직 게이트가 없다)으로 보이는지 각각 확인한다.
  test('S3/S4 — 편집 완료: 새 버전 번호와 "초안"(미상신) 상태 칩이 실제로 갱신된다(AC2)', async ({ page }) => {
    await page.goto('/content');
    await page.waitForLoadState('networkidle');

    const firstRowLink = page.locator('[data-testid="content-list-row"] a').first();
    await firstRowLink.click();
    await page.waitForURL(/\/content\/.+/);
    await page.waitForLoadState('networkidle');

    const versionBadgeBefore = await page.getByText(/^v\d+$/).first().textContent();

    const bodyField = page.locator('#post-body');
    await expect(bodyField, '본문 textarea가 보인다').toBeVisible();
    const before = await bodyField.inputValue();
    await bodyField.fill(`${before}\n\n(E2E 검수 타임스탬프 ${new Date().toISOString()})`);

    const saveButton = page.getByRole('button', { name: '저장' });
    await saveButton.click();
    await expect(page.getByRole('status'), '저장 성공 alert').toBeVisible({ timeout: 10_000 });

    // 버전 번호가 실제로 올라갔다(before와 다른 값).
    const versionBadgeAfter = page.getByText(/^v\d+$/).first();
    await expect(versionBadgeAfter, '버전 배지가 갱신된다').not.toHaveText(versionBadgeBefore ?? '');

    // 새 버전엔 게이트가 없다 — 상태 칩이 "초안"(contentStatusDraft, 미상신과 동형)이어야
    // 한다. 지어낸 성공(예: 승인/발행)으로 뜨지 않는지가 이 assertion의 핵심.
    const statusChip = page.locator('[data-status-chip]').first();
    await expect(statusChip, '상태 칩=draft').toHaveAttribute('data-status-chip', 'draft');
    await expect(statusChip, '상태 칩 라벨="초안"').toContainText('초안');

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'content-s3-edit-complete.png'), fullPage: true });
  });

  // ── S10 — 오류 UI 골격 ──────────────────────────────────────────────────
  // §8-3④ — 이름을 "오류 UI 골격이 선다"로 좁힌다. 오늘 재는 것은 404(계약 stub, 라우트
  // 부재)지 AC가 보존하려는 403("external_publish 게이트가 승인되지 않았습니다
  // (gate_id=…, status=…)")이 아니다 — 그 진짜 문구 보존 검증은 아래 별도 test.skip.
  test('S10 — 오류 UI 골격이 선다: 승인 요청 클릭 시 오류 alert+"서버 응답 보기" 접힘이 뜬다(오늘은 404)', async ({ page }) => {
    await page.goto('/content');
    await page.waitForLoadState('networkidle');
    await page.locator('[data-testid="content-list-row"] a').first().click();
    await page.waitForURL(/\/content\/.+/);
    await page.waitForLoadState('networkidle');

    const submitButton = page.getByRole('button', { name: '승인 요청' });
    await submitButton.click();
    const errorAlert = page.getByRole('alert');
    await expect(errorAlert, '오류 alert가 뜬다').toBeVisible({ timeout: 10_000 });

    // §8-3⑤ — 시안 어휘로 정렬("원문 보기" → "서버 응답 보기", ko.json::content.
    // errorRawDetailsToggle).
    const rawToggle = page.getByText('서버 응답 보기');
    await expect(rawToggle, '서버 응답 보기 접힘 토글이 있다(§4-1 — gate_id 등 추적정보 보존)').toBeVisible();
    await rawToggle.click();

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'content-s10-error-shell.png'), fullPage: true });
  });

  test.skip('S10(진짜) — 403 "external_publish 게이트가 승인되지 않았습니다(gate_id=…)" 원문이 접힌 상세에 보존된다', () => {
    // TODO(S2·S3 착지 후): 승인되지 않은 게이트가 달린 draftId로 "발행"을 직접 호출(또는
    // 승인 요청이 실제 게이트를 만든 뒤 미승인 상태에서 발행 시도)해 실 403을 재현한다.
    // 원문에 gate_id·status가 들어있는지, 접힌 <details>가 그것을 그대로 보존하는지
    // 확인한다 — 사람 말로만 바꿔 두면 추적이 끊긴다는 §4-1 규율의 실측.
  });

  // ── 대비 실측(§8-3①②) — canvas 정규화, 두 층 × 두 테마 ───────────────────
  for (const theme of ['light', 'dark'] as const) {
    test(`대비(상태 칩) [${theme}] — dot↔배경 3:1·라벨↔배경 4.5:1(canvas 정규화, oklch 안전)`, async ({ page }) => {
      await page.goto('/content', { waitUntil: 'domcontentloaded' });
      await setTheme(page, theme);
      await page.waitForLoadState('networkidle');

      const chip = page.locator('[data-status-chip]').first();
      if ((await chip.count()) === 0) {
        test.skip(true, '이 org에 초안이 없어 상태 칩이 안 뜬다(빈 상태) — customer-zero 데이터가 있는 세션에서 재실행');
        return;
      }
      await expect(chip).toBeVisible();

      const { dot, label } = await measureChip(page, '[data-status-chip]');
      // 목표값은 doc §6-2-1 실측표 그대로(경계값 — 라이트 draft dot 4.91, 다크 5.74 등
      // 전부 3:1 이상). 판정선만 여기 고정한다 — 목표 수치는 doc이 SSOT.
      expect(dot, `dot↔배경 3:1 [${theme}]`).toBeGreaterThanOrEqual(3.0);
      expect(label, `라벨↔배경 4.5:1 [${theme}]`).toBeGreaterThanOrEqual(4.5);
    });
  }

  // ── S6 — 승인 카드(S2 착지 후 fixture만 채우면 실행) ───────────────────
  test.skip('S6 — 승인 카드: 본문 전문·버전·봉인 해시가 카드에 보인다', () => {
    // TODO(S2 착지 후): 아래 값을 실 fixture로 채우고 이 test.skip을 test로 바꾼다.
    //   1) draftId — content_sha256/content_version이 채워진 실 게이트를 낳은 초안 id
    //   2) 그 초안을 승인 요청까지 진행(§handleSubmitForApproval)해 gate_id 확보
    //   3) page.goto(`/gates/${gateId}`) → getByText('버전')·getByText('봉인 해시') 확인
  });

  // ── S8 — 발행 URL(S2+S3 착지 후 fixture만 채우면 실행) ─────────────────
  test.skip('S8 — 발행 URL: 발행 성공 후 공개 URL·발행 시각이 보인다', () => {
    // TODO(S2·S3 착지 후): 승인된 draftId로 편집 화면을 열고 "발행" 클릭 → getByRole('link',
    // { name: '발행된 글 보기' }) 확인.
  });

  // ── S9 — 재승인 필요(S2 착지 후 fixture만 채우면 실행) ──────────────────
  test.skip('S9 — 재승인 필요: 승인된 해시·현재 해시가 나란히 보이고 발행 버튼이 비활성', () => {
    // TODO(S2 착지 후): 승인까지 갔다가 본문을 다시 수정해 해시가 갈라진 draftId로
    // getByText('이전 승인은 더 이상 유효하지 않습니다')·발행 버튼 disabled 확인.
  });
});
