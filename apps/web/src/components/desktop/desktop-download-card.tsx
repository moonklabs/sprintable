'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

/**
 * story #3807 AC3(페드루 PO 確定 2026-09-11) — dev-app 다운로드 자리(최소 1곳).
 * 데이터 원천은 민 AC2 `/desktop/updates/macos.json`(공개·비로그인 200, tauri
 * updater 표준 매니페스트 계약 — 카드 AC2 원문 그대로: version·pub_date·
 * platforms.darwin-aarch64.{url,signature}). 이 카드 착수 시점(2026-09-11)
 * 민 PR 0건 — 아직 이 라우트가 없어 지금은 fetch가 실패(404/미등록)하는 게
 * 정상이고, 이 컴포넌트는 그 실패를 조용히 흡수해(지어내지 않는다) 카드
 * 자체를 안 그린다. 라우트가 실제로 착지하면 그대로 작동한다(새 코드 0).
 *
 * 「빌드 sha」 표시(카드 AC3 원문) — 매니페스트 스키마엔 별도 sha 필드가
 * 없다(AC2가 못박은 4필드만). semver build-metadata 관례(`{semver}+{sha}`)로
 * CI가 짤 가능성에 대비해 `version`의 `+` 뒤를 sha로 뽑는다 — 그 형식이
 * 아니면(예: 순수 "0.3.1") 빌드 sha 줄은 그냥 안 그린다(지어내지 않는다).
 * ⚠️미확認 — 민 AC2 실 착지 뒤 실제 버전 문자열 형식으로 재확認 필요.
 */

interface MacosUpdateManifest {
  version: string;
  pub_date: string;
  platforms: {
    'darwin-aarch64': { url: string; signature: string };
  };
}

function parseBuildSha(version: string): string | null {
  const idx = version.indexOf('+');
  if (idx < 0 || idx === version.length - 1) return null;
  return version.slice(idx + 1);
}

export function DesktopDownloadCard() {
  const t = useTranslations('desktop');
  const [manifest, setManifest] = useState<MacosUpdateManifest | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch('/desktop/updates/macos.json')
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
      .then((json: MacosUpdateManifest | null) => {
        if (!alive) return;
        setManifest(json?.version && json.platforms?.['darwin-aarch64']?.url ? json : null);
        setLoading(false);
      });
    return () => { alive = false; };
  }, []);

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-border bg-card p-4" data-testid="desktop-download-card">
        <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
        <span className="text-xs text-muted-foreground">{t('loading')}</span>
      </div>
    );
  }

  // 매니페스트를 아직 못 읽으면(민 라우트 미착지·일시 오류 등) 카드 자체를 안
  // 그린다 — 있지도 않은 버전·다운로드 링크를 지어내지 않는다.
  if (!manifest) return null;

  const buildSha = parseBuildSha(manifest.version);
  const downloadUrl = manifest.platforms['darwin-aarch64'].url;

  return (
    <div className="space-y-2 rounded-xl border border-border bg-card p-4" data-testid="desktop-download-card">
      <p className="text-sm font-medium text-foreground">{t('title')}</p>
      <p className="text-xs text-muted-foreground">
        <span data-testid="desktop-download-version">{t('versionLabel', { version: manifest.version })}</span>
        {buildSha ? (
          <span data-testid="desktop-download-build-sha">{' · '}{t('buildLabel', { sha: buildSha })}</span>
        ) : null}
      </p>
      <p className="text-xs text-muted-foreground" data-testid="desktop-download-notarization-notice">
        {t('notarizationNotice')}
      </p>
      <Button asChild size="sm" data-testid="desktop-download-button">
        <a href={downloadUrl} download>{t('downloadCta')}</a>
      </Button>
    </div>
  );
}
