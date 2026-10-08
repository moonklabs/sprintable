'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ourDownloadUrl } from '@/lib/desktop-downloads';

/**
 * story #3807 AC3(페드루 PO 確定 2026-09-11) — dev-app 다운로드 자리(최소 1곳).
 * 데이터 원천은 민 AC2 `/desktop/updates/macos.json`(공개·비로그인 200, tauri
 * updater 표준 매니페스트 계약 — 카드 AC2 원문 그대로: version·pub_date·
 * platforms.darwin-aarch64.{url,signature}). 이 카드 착수 시점(2026-09-11)
 * 민 PR 0건 — 아직 이 라우트가 없어 지금은 fetch가 실패(404/미등록)하는 게
 * 정상. 라우트가 실제로 착지하면 그대로 작동한다(새 코드 0).
 *
 * 페드루 PO 정정(2026-09-11 16:02Z 캡처 실측) — 처음엔 fetch 실패 시 카드
 * 자체를 안 그렸는데, 그러면 페이지가 «아무것도 없음»으로 보여 사용자에겐
 * 막다른 길이었다(지어내지 않는다 = 있지도 않은 버전·링크를 안 만든다는
 * 뜻이지 «아무 말도 안 한다»는 뜻이 아니다). 지금은 카드 틀은 그대로 두고
 * 「지금은 받을 수 없습니다」 한 줄로 정직하게 말한다.
 *
 * 「빌드 sha」 표시(카드 AC3 원문) — 매니페스트 스키마엔 별도 sha 필드가
 * 없다(AC2가 못박은 4필드만). semver build-metadata 관례(`{semver}+{sha}`)로
 * CI가 짤 가능성에 대비해 `version`의 `+` 뒤를 sha로 뽑는다 — 그 형식이
 * 아니면(예: 순수 "0.3.1") 빌드 sha 줄은 그냥 안 그린다(지어내지 않는다).
 * ⚠️미확認 — 민 AC2 실 착지 뒤 실제 버전 문자열 형식으로 재확認 필요.
 *
 * 페드루 PO 정정 2(2026-09-11 16:13Z 캡처 실측) — 받는 사람이 알아야 할 두
 * 사실이 빠졌다: ① 대상 플랫폼(현재 매니페스트가 darwin-aarch64뿐 — 다른
 * 아키텍처를 받을 수 있다고 지어내지 않는다) ② 공증 前 Gatekeeper가 처음
 * 실행을 막는다는 사실과 그 우회(우클릭→열기) — 민이 spctl로 실측 확認.
 *
 * [SID:4619](2026-10-08 · 선생님 «실행할 수 없음») — 이 카드가 옛 Tauri 업데이터 매니페스트
 * (`/desktop/updates/macos.json` → 0.1.2 · ad-hoc)의 url을 받는 단추로 쓰고 있었다. 이제 지금 앱
 * «Sprintable Dev Setup»(Electron DMG · Developer ID · 공증 전)의 매니페스트
 * `/desktop/downloads/macos.json`(mobile `publish-dev-setup.mjs`가 올린 것 · version · build ·
 * url · sha256)을 읽는다. 옛 매니페스트는 이미 깔린 옛 앱의 업데이트용이라 그대로 둔다.
 * 첫 열기 안내는 유나 정본(`~/.sprintable-shared/yuna/4619-download-card-copy.md`): 웹은 macOS 판을
 * 모르니 13 이상 모두에서 되는 «설정 → 그래도 열기» 길 하나 + macOS 12 덧줄 · 끌어 놓기 한 줄.
 */

/** publish-dev-setup.mjs가 쓰는 매니페스트 중 이 카드가 읽는 칸 */
interface DesktopDownloadManifest {
  product: string;
  version: string;
  build: string;
  url: string;
}

export function DesktopDownloadCard() {
  const t = useTranslations('desktop');
  const [manifest, setManifest] = useState<DesktopDownloadManifest | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch('/desktop/downloads/macos.json')
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((json: DesktopDownloadManifest | null) => {
        if (!alive) return;
        // [SID:4619 · Kadir 5004 후속 ①] a link only into our bucket — any other url is «지금은 받을 수 없어요», as no manifest
        const url = ourDownloadUrl(json?.url);
        setManifest(json?.version && url ? { ...json, url } : null);
        setLoading(false);
      });
    return () => { alive = false; };
  }, []);

  if (loading) {
    return (
      <Card className="flex items-center gap-2 p-4" data-testid="desktop-download-card">
        <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        <span className="text-xs text-muted-foreground">{t('loading')}</span>
      </Card>
    );
  }

  // 매니페스트를 아직 못 읽으면(민 라우트 미착지·일시 오류 등) 있지도 않은
  // 버전·다운로드 링크는 지어내지 않되, 카드 틀은 남겨 「지금은 받을 수
  // 없습니다」로 정직하게 말한다(페드루 PO 정정 — 완전 침묵은 막다른 길).
  if (!manifest) {
    return (
      <Card className="space-y-2 p-4" data-testid="desktop-download-card">
        <p className="text-sm font-medium text-foreground">{t('title')}</p>
        <p className="text-xs text-muted-foreground" data-testid="desktop-download-unavailable">
          {t('unavailable')}
        </p>
      </Card>
    );
  }

  const buildSha = manifest.build || null;
  const downloadUrl = manifest.url;

  return (
    <Card className="space-y-2 p-4" data-testid="desktop-download-card">
      <p className="text-sm font-medium text-foreground">{t('title')}</p>
      <p className="text-xs text-muted-foreground" data-testid="desktop-download-target">
        {t('targetLabel')}
      </p>
      <p className="text-xs text-muted-foreground">
        {/* [SID:4619] Yuna 04:0xZ: the app's own name first — macOS names it so when it blocks (its «… was blocked to protect
            your Mac» names «Sprintable Dev Setup»), and the card and System Settings must use the same word. From the manifest; none → the line as before */}
        {manifest.product ? <span data-testid="desktop-download-product">{manifest.product}{' · '}</span> : null}
        <span data-testid="desktop-download-version">{t('versionLabel', { version: manifest.version })}</span>
        {buildSha ? (
          <span data-testid="desktop-download-build-sha">{' · '}{t('buildLabel', { sha: buildSha })}</span>
        ) : null}
      </p>
      {/* [SID:3810] 슬라이스13② — 두 경고를 한 위계로: 「지금 해야 할 일」(우클릭→열기)을
          AlertTitle로 먼저 보이고, 「왜」(공증 전 내부용)는 AlertDescription으로 덧붙인다.
          이전엔 둘 다 위 메타 정보(버전·대상 플랫폼)와 같은 text-xs text-muted-foreground라
          경고라는 게 눈에 안 띄었다(유나 지적). */}
      {/* [SID:4619] 유나 정본 — 제목 = 지금 할 일 · 손순서 두 줄(번호가 뜻) · macOS 12 덧줄 · 까닭(공증 전) */}
      <Alert variant="warning">
        <AlertTriangle className="h-4 w-4" />
        <AlertTitle className="break-keep" data-testid="desktop-download-gatekeeper-title">{t('gatekeeperTitle')}</AlertTitle>
        {/* AlertDescription is a <p> — an <ol> and <p>s inside it are invalid nesting (Yuna 5004): a div with its classes */}
        <div className="col-start-2 space-y-1 text-xs leading-relaxed break-keep [overflow-wrap:anywhere]">
          <ol className="list-decimal space-y-1 pl-4" data-testid="desktop-download-install-steps">
            <li>{t('installStepDrag')}</li>
            {/* the settings panel's name in one piece (it split over two lines at 390; one piece is easier to find in Settings) */}
            {/* <nw> = «no wrap»: two letters, so the ko value holds no English word (verify:no-ascii-token-in-ko-value) */}
            <li>{t.rich('installStepOpen', { nw: (chunks) => <span className="whitespace-nowrap" data-testid="desktop-download-settings-panel">{chunks}</span> })}</li>
          </ol>
          {/* text-xs only — muted on the warning tint is below AA (verify:no-muted-on-tint · story #3839) */}
          <p className="text-xs" data-testid="desktop-download-old-mac">{t('installOldMac')}</p>
          <p className="text-xs" data-testid="desktop-download-notarization-notice">
            {t('notarizationNotice')}
          </p>
        </div>
      </Alert>
      <Button asChild size="sm" data-testid="desktop-download-button">
        <a href={downloadUrl} download>{t('downloadCta')}</a>
      </Button>
    </Card>
  );
}
