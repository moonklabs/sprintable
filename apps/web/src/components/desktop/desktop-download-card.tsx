'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Banner } from '@/components/ds/banner';
import { Button } from '@/components/ds/button';
import { Card } from '@/components/ds/card';
import { DESKTOP_DOWNLOAD_BUCKET_HEADER, ourDownloadUrl } from '@/lib/desktop-downloads';
import { usePhoneBridge } from '@/components/providers/phone-bridge-context';
import { desktopApp, subscribeDesktopApp, type SprintableDesktop } from '@/lib/desktop-app';
import { DesktopThisComputerCard } from '@/components/desktop/desktop-this-computer-card';

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
  /** story 4655 (PO 14405): the first-open guide follows this flag — only an un-notarized build is blocked by macOS. Absent = treated as not notarized. */
  notarized?: boolean;
}

/**
 * story #4547 (Yuna `4547-phone-download-card.md` · spec b0713c54 «4524 곁» · AC1): the macOS download is for a Mac — the device
 * decides, never the window's width (a narrow Mac window keeps [다운로드]). Not a Mac: inside the phone app's shell, or a browser
 * whose user agent is not a Mac's (iPhone · Android · a tablet · another OS). iPadOS reports itself as «Macintosh» and stays on the
 * Mac side (nothing is blocked there).
 */
export function notAMac(userAgent: string, inPhoneApp: boolean): boolean {
  return inPhoneApp || !/Macintosh/.test(userAgent);
}

/** [SID:4998 · 4999] the manifest of the Windows installer (publish-win-setup.mjs) or the Linux AppImage: the card reads the url (our bucket only), the version and — for Windows — `signed` (the first-open guide is shown only when the manifest says `signed: false`) */
interface DesktopOtherManifest {
  product?: string;
  version: string;
  build?: string;
  url: string;
  signed?: boolean;
}

/** [SID:4998] a Windows computer's browser (never inside the phone app): the person who can use the Windows download — the Windows manifest is asked for only here (a Mac · a phone · Linux never ask for it) */
export function isWindowsBrowser(userAgent: string, inPhoneApp: boolean): boolean {
  return !inPhoneApp && /Windows NT/.test(userAgent);
}

/** [SID:4999] what a fresh Ubuntu 24.04 needs before the AppImage starts: FUSE 2 («AppImages require FUSE») and the sound library («libasound.so.2: cannot open shared object file») — a shell command, not UI text, so it is not in the message files */
export const LINUX_PREREQUISITES_COMMAND = 'sudo apt install libfuse2t64 libasound2t64';

/** [SID:4999] a Linux desktop's browser (never inside the phone app · never Android — its user agent carries «Linux» too · never an Arm Linux: the AppImage is the 64-bit x86 one; a ChromeOS agent says «CrOS», not «Linux», so it is no Linux here): the person who can use the Linux download */
export function isLinuxBrowser(userAgent: string, inPhoneApp: boolean): boolean {
  return !inPhoneApp && /Linux/.test(userAgent) && !/Android|aarch64|arm/i.test(userAgent);
}

type OtherPlatform = 'windows' | 'linux';
/** the platform whose download this browser gets instead of the Mac's, or null (a Mac · a phone · anything else) */
export function otherPlatformOf(userAgent: string, inPhoneApp: boolean): OtherPlatform | null {
  return isWindowsBrowser(userAgent, inPhoneApp) ? 'windows' : isLinuxBrowser(userAgent, inPhoneApp) ? 'linux' : null;
}

/** story 4668: `hideTitle` — the onboarding's «데스크톱 앱 받기» screen has the title as its h1, so the card's own «데스크톱 앱» line
 * is not drawn there (Yuna A-2); every other place keeps it. */
/** story 4680 (Yuna 5065): `ctaVariant` — under another hero (the recruiter's [이 컴퓨터에서 시작]) the card's [다운로드] is outline,
 * so one screen has one primary; every other place keeps the default. */
/** story 4715: `ctaLabel` — the onboarding's first screen says what the button gets («Mac 앱 받기»); every other place keeps [다운로드].
 * `onCta` — told when the download is pressed (the onboarding counts the app way there; the download itself is the link's). */
/** story 4970: what every place that draws this card passes */
interface DownloadCardProps { hideTitle?: boolean; ctaVariant?: 'default' | 'outline'; ctaLabel?: string; onCta?: () => void }

/**
 * story 4970 (선생님 11-16: 맥 앱 안에서 «데스크톱 앱» 메뉴가 앱 내려받기를 권함): the app is already here, so inside it this slot does not offer a download — it says which
 * computer this is and which build runs (`DesktopThisComputerCard`, the same card frame). «Inside the app» is the one mark the app gives the page — `desktopApp()`
 * (`window.sprintableDesktop.inApp`, 4679) — never a user-agent guess. In a browser (and in the phone app) it is undefined and the card below is exactly what it was.
 * The browser card is not even mounted inside the app, so it does not ask for the download manifest either.
 */
export function DesktopDownloadCard(props: DownloadCardProps = {}) {
  const bridge = useSyncExternalStore<SprintableDesktop | undefined>(subscribeDesktopApp, desktopApp, () => undefined);
  if (bridge) return <DesktopThisComputerCard hideTitle={props.hideTitle} bridge={bridge} />;
  return <BrowserDownloadCard {...props} />;
}

function BrowserDownloadCard({ hideTitle = false, ctaVariant = 'default', ctaLabel, onCta }: DownloadCardProps = {}) {
  const t = useTranslations('desktop');
  const [manifest, setManifest] = useState<DesktopDownloadManifest | null>(null);
  const [loading, setLoading] = useState(true);
  // story #4547/#4661: the device is read after mount, and a claim that comes later reaches this card (subscribed)
  const { inPhoneApp } = usePhoneBridge();
  const elsewhere = typeof navigator !== 'undefined' && notAMac(navigator.userAgent, inPhoneApp);
  const otherPlatform = typeof navigator === 'undefined' ? null : otherPlatformOf(navigator.userAgent, inPhoneApp);
  const [other, setOther] = useState<DesktopOtherManifest | null>(null);
  const [otherLoading, setOtherLoading] = useState(otherPlatform !== null);

  useEffect(() => {
    // story 4970 (codex): while the page hydrates, the server snapshot (no bridge) mounts this card for one render even inside the app — the app's bridge is already on the page then (the preload runs
    // first), so a card that is about to be replaced by «this computer» asks for no download manifest
    if (desktopApp()) return;
    let alive = true;
    fetch('/desktop/downloads/macos.json')
      .then(async (r) => (r.ok ? { json: (await r.json()) as DesktopDownloadManifest, bucket: r.headers.get(DESKTOP_DOWNLOAD_BUCKET_HEADER) } : null))
      .catch(() => null)
      .then((got: { json: DesktopDownloadManifest; bucket: string | null } | null) => {
        if (!alive) return;
        const json = got?.json ?? null;
        // [SID:4619 · Kadir 5004 후속 ①] a link only into our bucket — any other url is «지금은 받을 수 없어요», as no manifest.
        // story 4696: «our bucket» is the one the server says (its own setting) — none said, nothing is ours
        const url = ourDownloadUrl(json?.url, got?.bucket);
        setManifest(json?.version && url ? { ...json, url } : null);
        setLoading(false);
      });
    return () => { alive = false; };
  }, []);

  // [SID:4998 · 4999] a Windows or a Linux browser also asks for its own platform's manifest (the same checks: a link only into our bucket · a version) — a failure is «none», the card then says what it said before.
  // Its own effect, kept by `otherPlatform`: when the phone bridge claims after the mount (a late claim), the page is no desktop browser any more — nothing is asked, and what was asked is dropped.
  useEffect(() => {
    if (desktopApp() || otherPlatform === null) return; // (nothing is asked; what is shown is derived from `otherPlatform` below — no state is set here)
    let alive = true;
    fetch(`/desktop/downloads/${otherPlatform}.json`)
      .then(async (r) => (r.ok ? { json: (await r.json()) as DesktopOtherManifest, bucket: r.headers.get(DESKTOP_DOWNLOAD_BUCKET_HEADER) } : null))
      .catch(() => null)
      .then((got: { json: DesktopOtherManifest; bucket: string | null } | null) => {
        if (!alive) return;
        const json = got?.json ?? null;
        const url = ourDownloadUrl(json?.url, got?.bucket);
        setOther(json?.version && url ? { ...json, url } : null);
        setOtherLoading(false);
      });
    return () => { alive = false; };
  }, [otherPlatform]);

  if (loading || (otherPlatform !== null && otherLoading)) {
    return (
      <Card className="flex items-center gap-2 p-4" data-testid="desktop-download-card">
        <Loader2 className="size-ds-icon-sm animate-spin text-ds-ink-3" />
        <span className="text-ds-small text-ds-ink-3">{t('loading')}</span>
      </Card>
    );
  }

  // 매니페스트를 아직 못 읽으면(민 라우트 미착지·일시 오류 등) 있지도 않은
  // 버전·다운로드 링크는 지어내지 않되, 카드 틀은 남겨 「지금은 받을 수
  // 없습니다」로 정직하게 말한다(페드루 PO 정정 — 완전 침묵은 막다른 길).
  // [SID:4998 · 4999] a Windows or Linux computer with its platform's download to give: that download (the app for the computer the person is on) — and, for Windows, under it the first-open guide while the installer is not signed
  if (otherPlatform !== null && other) {
    const p = otherPlatform;
    return (
      <Card className="space-y-2 p-4" data-testid="desktop-download-card">
        {hideTitle ? null : <p className="text-ds-card-title font-semibold text-ds-ink">{t('title')}</p>}
        <p className="text-ds-small text-ds-ink-3" data-testid={`desktop-download-${p}-target`}>{t(p === 'windows' ? 'windowsTarget' : 'linuxTarget')}</p>
        <p className="text-ds-small text-ds-ink-3">
          {other.product ? <span data-testid="desktop-download-product">{other.product}{' · '}</span> : null}
          <span data-testid="desktop-download-version">{t('versionLabel', { version: other.version })}</span>
          {other.build ? <span data-testid="desktop-download-build-sha">{' · '}{t('buildLabel', { sha: other.build })}</span> : null}
        </p>
        <Button asChild variant={ctaVariant === 'outline' ? 'secondary' : 'primary'} data-testid={`desktop-download-${p}-button`}>
          <a href={other.url} download onClick={onCta} onAuxClick={(e) => { if (e.button === 1) onCta?.(); }}>{t(p === 'windows' ? 'windowsDownloadCta' : 'linuxDownloadCta')}</a>
        </Button>
        {p === 'linux' ? (
          <div className="space-y-1" data-testid="desktop-download-linux-install-notice">
            <p className="break-keep text-ds-small text-ds-ink-3">{t('linuxInstallNotice')}</p>
            <code className="block select-all rounded bg-ds-surface-sunk px-2 py-1 text-ds-small text-ds-ink" data-testid="desktop-download-linux-install-command">{LINUX_PREREQUISITES_COMMAND}</code>
          </div>
        ) : null}
        {p === 'windows' && other.signed === false ? (
          <p className="break-keep text-ds-small text-ds-ink-3" data-testid="desktop-download-windows-unsigned-notice">{t('windowsUnsignedNotice')}</p>
        ) : null}
      </Card>
    );
  }

  if (!manifest) {
    return (
      <Card className="space-y-2 p-4" data-testid="desktop-download-card">
        {hideTitle ? null : <p className="text-ds-card-title font-semibold text-ds-ink">{t('title')}</p>}
        <p className="text-ds-small text-ds-ink-3" data-testid="desktop-download-unavailable">
          {t('unavailable')}
        </p>
      </Card>
    );
  }

  const buildSha = manifest.build || null;
  const downloadUrl = manifest.url;

  return (
    <Card className="space-y-2 p-4" data-testid="desktop-download-card">
      {hideTitle ? null : <p className="text-ds-card-title font-semibold text-ds-ink">{t('title')}</p>}
      <p className="text-ds-small text-ds-ink-3" data-testid="desktop-download-target">
        {t('targetLabel')}
      </p>
      <p className="text-ds-small text-ds-ink-3">
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
      {/* story #4547: not a Mac — nothing to do here: no warning, no button, one line where they were (no link either: no way to
          open the Mac's screen from here). The unavailable state above keeps its own line (a Mac could not get it either) */}
      {elsewhere ? (
        <p className="break-keep text-ds-small text-ds-ink-3" data-testid="desktop-download-open-on-mac">{t('openOnMac')}</p>
      ) : (
      <>
      {/* [SID:4619] 유나 정본 — 제목 = 지금 할 일 · 손순서 두 줄(번호가 뜻) · macOS 12 덧줄 · 까닭(공증 전) */}
      {/* story 4655 (PO 14405): the guide is for an un-notarized build only; a notarized one opens without it (the button stays) */}
      {manifest.notarized === true ? null : (
      <Banner tone="note" className="items-start">
        <p className="break-keep font-semibold text-ds-ink" data-testid="desktop-download-gatekeeper-title">{t('gatekeeperTitle')}</p>
        {/* an <ol> and <p>s in a div (not inside a <p>) — the warning's body, at the same 12 px as the card's other lines */}
        <div className="mt-1 space-y-1 text-ds-small leading-relaxed break-keep [overflow-wrap:anywhere]">
          <ol className="list-decimal space-y-1 pl-4" data-testid="desktop-download-install-steps">
            <li>{t('installStepDrag')}</li>
            {/* the settings panel's name in one piece (it split over two lines at 390; one piece is easier to find in Settings) */}
            {/* <nw> = «no wrap»: two letters, so the ko value holds no English word (verify:no-ascii-token-in-ko-value) */}
            <li>{t.rich('installStepOpen', { nw: (chunks) => <span className="whitespace-nowrap" data-testid="desktop-download-settings-panel">{chunks}</span> })}</li>
          </ol>
          <p data-testid="desktop-download-old-mac">{t('installOldMac')}</p>
          <p data-testid="desktop-download-notarization-notice">
            {t('notarizationNotice')}
          </p>
        </div>
      </Banner>
      )}
      <Button asChild variant={ctaVariant === 'outline' ? 'secondary' : 'primary'} data-testid="desktop-download-button">
        {/* story 4891: a middle-click (open in a new tab) starts the download too — it is an auxclick, not a click, so the press is counted on both (the first screen says «after the download…» from the press) */}
        <a href={downloadUrl} download onClick={onCta} onAuxClick={(e) => { if (e.button === 1) onCta?.(); }}>{ctaLabel ?? t('downloadCta')}</a>
      </Button>
      </>
      )}
    </Card>
  );
}
