/**
 * story #4333 — 스캐너 테스트의 «일의 양»을 벽시계가 아니라 **결정적 양**으로 잰다.
 *
 * 예전(#3902 관례): 실 트리 전수 스캔 테스트마다 «실측 최댓값×3»으로 5초보다 낮은 시한을 걸어 성능 회귀를 잡으려 했다 — 전체 판 병렬
 * 부하에선 같은 코드가 시한을 넘겨 까닭 없이 RED였다(판정이 부하에 따라 달라지는 테스트). 이제 시한은 기본(행 가드)이고, 성능 회귀는
 * «한 번의 스캔이 파일을 몇 번 읽었나»로 단언한다: 스캔이 같은 파일을 두 번 읽으면(일이 두 배) RED — 부하와 무관.
 */
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';

export interface FsWork<T> {
  result: T;
  /** 읽기 호출 수(readFileSync). */
  reads: number;
  /** 서로 다른 파일 수. */
  files: number;
  /** 가장 많이 읽힌 파일과 그 횟수. */
  maxPerFile: { file: string; count: number };
}

/**
 * `fn`이 도는 동안의 파일 읽기를 센다(동기 스캐너용 — fs 객체 · ESM 이름 가져오기 둘 다). 끝나면 원래 함수로 되돌린다.
 * `ignore`: 트리 크기와 무관하게 **정해진 횟수만** 읽는 설정 파일(예: 추출기 둘이 각자 한 번씩 읽는 cloudbuild.yaml) — 호출 자리에
 * 이유와 함께만 쓴다. 훑는 소스 파일은 넣지 않는다(그게 이 단언의 대상이다).
 */
export function measureFsReads<T>(fn: () => T, { ignore = [] }: { ignore?: string[] } = {}): FsWork<T> {
  const counts = new Map<string, number>();
  const target = fs as unknown as { readFileSync: typeof fs.readFileSync };
  const original = target.readFileSync;
  target.readFileSync = function counted(this: unknown, file: fs.PathOrFileDescriptor, ...rest: unknown[]) {
    if (typeof file === 'string' || file instanceof URL || Buffer.isBuffer(file)) {
      const key = path.resolve(String(file instanceof URL ? file.pathname : file));
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return (original as (...a: unknown[]) => unknown).apply(this, [file, ...rest]);
  } as typeof fs.readFileSync;
  syncBuiltinESMExports();
  let result: T;
  try {
    result = fn();
  } finally {
    target.readFileSync = original;
    syncBuiltinESMExports();
  }
  const ignored = new Set(ignore.map((p) => path.resolve(p)));
  let maxPerFile = { file: '', count: 0 };
  let reads = 0;
  for (const [file, count] of counts) {
    reads += count;
    if (!ignored.has(file) && count > maxPerFile.count) maxPerFile = { file, count };
  }
  return { result, reads, files: counts.size, maxPerFile };
}
