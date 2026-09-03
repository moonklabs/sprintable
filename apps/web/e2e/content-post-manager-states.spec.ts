/**
 * story #3368(Phase0·마케팅운영 S4) AC8(UX 검수, 유나) — 글 관리 화면 다섯 상태의 실제
 * 렌더 캡처. doc phase0-post-manager-screen-design §8-2: "컴포넌트 스냅샷은 합격으로
 * 치지 않는다 — DOM 텍스트 assertion과 브라우저 스크린샷을 함께 남긴다."
 *
 * 페드루 PO 지시(2026-09-03) — 오늘(S2 미착지) 돌릴 수 있는 세 상태(목록·편집 완료·서버
 * 오류)는 실제로 실행하고, 나머지 두 상태(승인 카드·재승인 필요, 원래 AC8의 승인카드·
 * 재승인 다섯 목록 그대로)는 S2(neutral_facts.content_sha256·content_version)가
 * 실제로 값을 채운 뒤 fixture(work item·draft·gate id)만 채워 넣으면 바로 돌게 자리를
 * 비워 둔다(test.skip — 이 파일 자체는 완결, 값만 없다). AC8 원 목록의 "발행 URL"(S8)도
 * 같은 이유로 S2·S3(공개 projection) 둘 다 필요해 여기 포함.
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

test.describe('글 관리 화면 — S4 AC8 다섯 상태 캡처(sellerking 전용)', () => {
  test.beforeEach(async ({ page }) => {
    if (!HAS_SELLERKING_CREDS) {
      test.skip(true, 'SELLERKING_EMAIL/SELLERKING_PASSWORD 미설정 — .env.playwright에 채운다(크리덴셜 하드코딩 금지)');
      return;
    }
    await loginAsSellerking(page);
  });

  // ── S1 — 글 목록 ────────────────────────────────────────────────────────
  test('S1 — 목록: 초안 목록에 제목·상태·버전·원작성 주체가 보인다', async ({ page }) => {
    test.skip(!HAS_SELLERKING_CREDS, '위 beforeEach와 동일 사유');
    const response = await page.goto('/content');
    expect(response?.status(), '/content 200').toBe(200);
    await page.waitForLoadState('networkidle');

    // AC1 — DOM 텍스트 assertion(§8-2, 스냅샷만으론 합격 아님). 담롱군의 2호 콘텐츠가
    // 이미 초안으로 있어야 이 화면이 빈 상태가 아니다(customer-zero 종료 판정 §4-1
    // 흐름의 결과물을 그대로 재사용 — 새 fixture 발명 0).
    const firstRow = page.locator('[data-testid="content-list-row"]').first();
    await expect(firstRow, '초안 행이 최소 1건 보인다').toBeVisible({ timeout: 10_000 });

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'content-s1-list.png'), fullPage: true });
  });

  // ── S3/S4 — 편집 완료 ───────────────────────────────────────────────────
  test('S3/S4 — 편집 완료: 본문 수정·저장 후 새 버전·"미상신" 상태가 보인다(AC2)', async ({ page }) => {
    test.skip(!HAS_SELLERKING_CREDS, '위 beforeEach와 동일 사유');
    await page.goto('/content');
    await page.waitForLoadState('networkidle');

    const firstRowLink = page.locator('[data-testid="content-list-row"] a').first();
    await firstRowLink.click();
    await page.waitForURL(/\/content\/.+/);
    await page.waitForLoadState('networkidle');

    const bodyField = page.locator('#post-body');
    await expect(bodyField, '본문 textarea가 보인다').toBeVisible();
    const before = await bodyField.inputValue();
    await bodyField.fill(`${before}\n\n(E2E 검수 타임스탬프 ${new Date().toISOString()})`);

    const saveButton = page.getByRole('button', { name: '저장' });
    await saveButton.click();
    // 저장 성공 alert(§handleSave) — 새 버전 반영까지 기다린다.
    await expect(page.getByRole('status')).toBeVisible({ timeout: 10_000 });

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'content-s3-edit-complete.png'), fullPage: true });
  });

  // ── S10 — 오류(서버 원문 보존) ──────────────────────────────────────────
  test('S10 — 오류: 승인 요청 클릭 시(S2 미착지) 서버 오류가 사람 말+원문 접힘으로 렌더된다', async ({ page }) => {
    test.skip(!HAS_SELLERKING_CREDS, '위 beforeEach와 동일 사유');
    await page.goto('/content');
    await page.waitForLoadState('networkidle');
    await page.locator('[data-testid="content-list-row"] a').first().click();
    await page.waitForURL(/\/content\/.+/);
    await page.waitForLoadState('networkidle');

    // 오늘 시점(S2 미착지) — 이 클릭은 실제 dev 백엔드가 404를 낸다(계약 stub, 지어낸
    // 라우트 아님). §4-1 규율(사람 말 위·원문 접힘)이 실제로 지켜지는지 라이브로 확인.
    const submitButton = page.getByRole('button', { name: '승인 요청' });
    await submitButton.click();
    const errorAlert = page.getByRole('alert');
    await expect(errorAlert, '오류 alert가 뜬다').toBeVisible({ timeout: 10_000 });

    const rawToggle = page.getByText('원문 보기');
    await expect(rawToggle, '원문 접힘 토글이 있다(§4-1 — gate_id 등 추적정보 보존)').toBeVisible();
    await rawToggle.click();

    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'content-s10-error.png'), fullPage: true });
  });

  // ── S6 — 승인 카드(S2 착지 후 fixture만 채우면 실행) ───────────────────
  test('S6 — 승인 카드: 본문 전문·버전·봉인 해시가 카드에 보인다', async ({ page }) => {
    // TODO(S2 착지 후): 아래 세 값을 실 fixture로 채우고 이 test.skip 줄만 지운다.
    //   1) draftId — content_sha256/content_version이 채워진 실 게이트를 낳은 초안 id
    //   2) 그 초안을 승인 요청까지 진행(§handleSubmitForApproval)해 gate_id 확보
    //   3) 아래 gateId 변수에 그 값을 대입
    test.skip(true, 'S2(neutral_facts.content_sha256·content_version) 착지 대기 — fixture 자리만 비워 둠');
    const gateId = ''; // TODO: 실 gate id
    await page.goto(`/gates/${gateId}`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByText('버전').first()).toBeVisible();
    await expect(page.getByText('봉인 해시').first()).toBeVisible();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'content-s6-approval-card.png'), fullPage: true });
  });

  // ── S8 — 발행 URL(S2+S3 착지 후 fixture만 채우면 실행) ─────────────────
  test('S8 — 발행 URL: 발행 성공 후 공개 URL·발행 시각이 보인다', async ({ page }) => {
    // TODO(S2·S3 착지 후): 승인된 draftId로 편집 화면을 열고 "발행" 클릭 → 공개 URL 캡처.
    test.skip(true, 'S2(승인 파이프)·S3(공개 projection·url 필드) 둘 다 착지 대기');
    const draftId = ''; // TODO: 승인 완료된 실 draft id
    await page.goto(`/content/${draftId}`);
    await page.waitForLoadState('networkidle');
    const publishButton = page.getByRole('button', { name: '발행' });
    await publishButton.click();
    await expect(page.getByRole('link', { name: '발행된 글 보기' })).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'content-s8-published.png'), fullPage: true });
  });

  // ── S9 — 재승인 필요(S2 착지 후 fixture만 채우면 실행) ──────────────────
  test('S9 — 재승인 필요: 승인된 해시·현재 해시가 나란히 보이고 발행 버튼이 비활성', async ({ page }) => {
    // TODO(S2 착지 후): 승인까지 갔다가 본문을 다시 수정해 해시가 갈라진 draftId를 만든다.
    test.skip(true, 'S2(봉인 해시) 착지 대기 — fixture 자리만 비워 둠');
    const draftId = ''; // TODO: 승인 후 재수정된 실 draft id
    await page.goto(`/content/${draftId}`);
    await page.waitForLoadState('networkidle');
    await expect(page.getByText('이전 승인은 더 이상 유효하지 않습니다')).toBeVisible();
    const publishButton = page.getByRole('button', { name: '발행' });
    await expect(publishButton).toBeDisabled();
    await page.screenshot({ path: path.join(SCREENSHOT_DIR, 'content-s9-reapproval-needed.png'), fullPage: true });
  });
});
