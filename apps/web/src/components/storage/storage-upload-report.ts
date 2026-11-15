import type { Asset } from '@/lib/storage/types';

/**
 * 4910 — 올리기 한 번(파일 하나)을 «올리고 → 목록에 넣고 → 알린다». 단추로 고른 여러 파일 · 창에 끌어 놓은 여러 파일이 파일마다 이 길로 차례로 돈다.
 * 한 파일의 실패는 그 파일만 알리고(알림에 그 파일 이름) 다음 파일은 계속 올린다 — 어느 것이 안 올라갔는지 이름으로 안다.
 * 성공 알림 body = 파일 이름이므로 실패 알림도 같은 자리에 이름을 둔다.
 */
export interface UploadReporter {
  success: (file: File) => void;
  failure: (file: File) => void;
}

export async function uploadFileAndReport(
  file: File,
  run: (file: File) => Promise<Asset>,
  onUploaded: (asset: Asset) => void,
  report: UploadReporter,
): Promise<void> {
  try {
    const asset = await run(file);
    onUploaded(asset);
    report.success(file);
  } catch {
    report.failure(file);
  }
}
