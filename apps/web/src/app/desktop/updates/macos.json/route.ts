// §10.2류 공개 경로 — 데스크톱 컴패니언이 인증 쿠키 없이 업데이트를 확인하는 자리
// (proxy.ts PUBLIC_PREFIX '/desktop/updates/'). 본문은 desktop-updates.ts 단일 출처
// (mobile 레포 CI가 만든 GCS 매니페스트를 그대로 중계, 이 파일은 손으로 안 지음).
import { NextResponse } from 'next/server';
import { DesktopManifestUnavailableError, fetchDesktopUpdateManifest } from '@/lib/desktop-updates';

export async function GET() {
  try {
    const body = await fetchDesktopUpdateManifest();
    return new NextResponse(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    if (err instanceof DesktopManifestUnavailableError) {
      console.error('desktop_updates.manifest_unavailable', err);
      return NextResponse.json({ error: 'manifest_unavailable' }, { status: 502 });
    }
    throw err;
  }
}
