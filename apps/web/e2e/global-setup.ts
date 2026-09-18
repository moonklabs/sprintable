import { chromium } from '@playwright/test';
import fs from 'fs';
import path from 'path';

async function globalSetup() {
  const baseURL = process.env['PLAYWRIGHT_BASE_URL'] ?? 'http://localhost:3108';
  const authDir = path.join(__dirname, '../playwright/.auth');
  fs.mkdirSync(authDir, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL });

  // Call login API directly — cookies are set in the browser context
  const resp = await context.request.post('/api/auth/login', {
    data: { email: 'owner@sprintable.dev', password: 'password123' },
    headers: {
      'Content-Type': 'application/json',
      Origin: baseURL,
    },
  });

  if (!resp.ok()) {
    const body = await resp.text();
    throw new Error(`Login failed (${resp.status()}): ${body}`);
  }

  // story #3389(CI 플래키, 2026-09-03) — Next dev는 라우트를 요청 시점에 처음
  // 컴파일한다(on-demand compile). playwright의 webServer.url 체크는 "포트가 응답하는가"
  // 만 확인할 뿐 /inbox 라우트 자체가 컴파일됐는지는 모른다 — 그래서 아래 로그인 확인용
  // goto가 이 프로세스에서 /inbox의 «첫 요청»이 되면 컴파일 시간이 기본 30초 goto
  // 예산을 넘길 수 있다. 실측(PR #3736·#3740·#3746 CI 3회 재현, run 33741248327·
  // 33750372064·job 100668189880): 매번 대비 위반 0건인데 정확히 이 줄에서 51~53초
  // 만에 TimeoutError — 러너 경합이면 실패 시각이 들쭉날쭉해야 하는데 세 번 다 같은
  // 좁은 구간에 몰린 것이 콜드 컴파일 신호와 일치한다(자원 경합·느린 API라면 이렇게
  // 좁게 몰리지 않는다). 처방(AC2): goto 타임아웃 값을 올리는 지름길 대신, 판정 대상이
  // 아닌 별도 웜업 요청으로 컴파일 비용을 먼저 치른다 — 아래 진짜 goto는 이미 컴파일된
  // (warm) 라우트를 받으므로 기본 30초 예산 그대로 둔다(이 웜업 자체가 "처방이 통했다"는
  // 증거다: 웜업 없이 되돌리면 이 결함이 재현돼야 한다).
  await context.request.get('/inbox', { timeout: 90_000 }).catch(() => {
    // 웜업의 목적은 컴파일 트리거뿐 — 응답 상태/성패는 판정하지 않는다(아래 진짜 goto가
    // 판정한다). 웜업 자체가 실패해도(예: 아직 서버가 완전히 안정화되지 않음) 무시하고
    // 진짜 goto로 넘어간다 — 웜업 실패가 이 함수 전체를 죽이면 안 된다.
  });

  // Navigate to /inbox once to confirm the session works server-side
  const page = await context.newPage();
  try {
    await page.goto('/inbox');
    await page.waitForURL(/\/inbox/, { timeout: 15000 });
  } catch (err) {
    // story #3389(AC3) — 이 실패는 대비(color-contrast) 판정과 무관하다. axe 위반
    // 리포트와 다른 문장으로 내야 PO가 로그를 열자마자 "플래키/기동 실패"와 "실 대비
    // 위반"을 가른다(이전엔 둘 다 그냥 "Contrast guard 빨강"으로만 보였다).
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`⚠ 페이지 도달 실패(타임아웃) — not a contrast verdict(대비 판정 아님, story #3389). 원인: ${detail}`);
  }

  await context.storageState({ path: path.join(authDir, 'owner.json') });
  await browser.close();
}

export default globalSetup;
