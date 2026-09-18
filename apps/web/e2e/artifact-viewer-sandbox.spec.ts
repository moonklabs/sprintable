/**
 * story #3377(결함·customer-zero) — 시각 산출물 뷰어 html_blob iframe이 `sandbox=""`라
 * 스크립트가 전부 차단돼 인터랙티브 프로토타입이 정지 화면으로 보이던 결함.
 *
 * 이 파일은 앱(로그인·백엔드) 전체를 왕복하지 않고 브라우저 sandbox 계약 자체를
 * `page.setContent()`로 직접 재현해 검증한다 — AC가 실제로 묻는 건 "이 iframe 속성
 * 조합이 브라우저에서 어떻게 동작하는가"이지 우리 React 배선이 아니다(그 배선은
 * artifact-stage.test.tsx/artifact-expand-dialog.test.tsx가 jsdom으로 덮는다). 크리덴셜
 * 불요·백엔드 불요 — 항상 실행된다(default-off 아님).
 *
 * 실행: pnpm exec playwright test e2e/artifact-viewer-sandbox.spec.ts
 */
import { expect, test } from '@playwright/test';

// ArtifactStage(artifact-stage.tsx)가 실제로 렌더하는 형태 그대로 재현 — sandbox 값과
// pointer-events 클래스만 시나리오별로 바꾼다(props htmlInteractive와 1:1 대응).
function harnessHtml(opts: { sandbox: string; pointerEventsAuto: boolean }): string {
  const iframeClass = opts.pointerEventsAuto ? '' : 'pointer-events-none';
  return `<!doctype html><html><body>
    <div id="stage" style="width:400px;height:300px;position:relative">
      <iframe id="target" title="artifact" sandbox="${opts.sandbox}" class="${iframeClass}"
        style="width:400px;height:300px;border:0;${opts.pointerEventsAuto ? '' : 'pointer-events:none;'}"
        srcdoc="&lt;!doctype html&gt;&lt;body style='margin:0'&gt;
          &lt;a id='link' href='#next' onclick=&quot;document.body.dataset.clicked='1'&quot;
             style='display:block;width:400px;height:300px;'&gt;다음 화면&lt;/a&gt;
          &lt;script&gt;
            window.__ran = true;
            try { window.parent.document; window.__parentAccess = 'ok'; }
            catch (e) { window.__parentAccess = 'blocked:' + e.name; }
          &lt;/script&gt;
        &lt;/body&gt;"
      ></iframe>
    </div>
  </body></html>`;
}

test.describe('artifact viewer iframe sandbox (story #3377)', () => {
  test('allow-scripts runs the artifact\'s JS but blocks parent DOM access (no allow-same-origin)', async ({ page }) => {
    await page.setContent(harnessHtml({ sandbox: 'allow-scripts', pointerEventsAuto: true }));
    const frame = page.frameLocator('#target');
    await expect(frame.locator('#link')).toBeVisible();

    const frameHandle = await page.$('#target');
    const contentFrame = await frameHandle!.contentFrame();
    const ran = await contentFrame!.evaluate(() => (window as unknown as { __ran?: boolean }).__ran);
    expect(ran).toBe(true); // 결함 재현 — 예전 sandbox=""였으면 스크립트가 전혀 안 돌아 이게 undefined였다

    const parentAccess = await contentFrame!.evaluate(() => (window as unknown as { __parentAccess?: string }).__parentAccess);
    expect(parentAccess).toMatch(/^blocked:/); // 뮤테이션 대상 — allow-same-origin을 더하면 'ok'가 되어 RED
  });

  test('interactive(pointer-events:auto) lets a real click reach the iframe and change its DOM (hash 라우팅 전제)', async ({ page }) => {
    await page.setContent(harnessHtml({ sandbox: 'allow-scripts', pointerEventsAuto: true }));
    const frameHandle = await page.$('#target');
    // test 3(비상호작용)과 동일한 실좌표 클릭 방식이라야 pointer-events 차이만 대조된다.
    // 클릭이 실제로 앵커 href(#next)를 발화시켜 iframe 자신의 URL 프래그먼트가 바뀌는지로
    // 판별한다(hash 라우팅 전제 그 자체) — onclick의 JS부수효과는 같은 클릭이 hash 네비를
    // 동반해 실행 컨텍스트가 갈리므로(정상 동작) 그 값을 읽으려 들지 않는다.
    const bounds = (await frameHandle!.boundingBox())!;
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await expect.poll(() => frameHandle!.contentFrame().then((f) => f?.url())).toMatch(/#next$/);
  });

  test('non-interactive(pointer-events:none) — a click at the iframe\'s coordinates never reaches its DOM (캔버스 pan 설계 보존, 회귀 0)', async ({ page }) => {
    await page.setContent(harnessHtml({ sandbox: 'allow-scripts', pointerEventsAuto: false }));
    const box = (await page.$('#target'))!;
    const bounds = (await box.boundingBox())!;
    // pointer-events:none이면 이 좌표 클릭은 iframe 아래(부모 div)로 그대로 통과한다 —
    // 실제 브라우저 히트테스트 계약을 검증(className 문자열 존재 확인이 아니라 진짜 클릭).
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    const frameHandle = await page.$('#target');
    const contentFrame = await frameHandle!.contentFrame();
    const clicked = await contentFrame!.evaluate(() => document.body.dataset['clicked']);
    expect(clicked).toBeUndefined();
  });
});
