// story #2393 — checkReservedFirstSegmentsSync()가 실제 저장소 구조를 스캔해 어긋남 0건을
// 내는지 확認한다. main()은 import.meta.url 가드로 감싸져 있어 이 파일을 import해도 CLI 실행
// (process.exit 포함)은 돌지 않는다 — checkReservedFirstSegmentsSync()만 안전하게 호출한다.
import { describe, expect, it } from 'vitest';
import { checkReservedFirstSegmentsSync, METADATA_FILE_ROUTES } from './verify-reserved-first-segments-sync';

describe('checkReservedFirstSegmentsSync — story #2393 AC3', () => {
  it('실제 저장소 기준 어긋남 0건이다(2026-08-01 AC1 실측으로 찾은 6곳을 이미 반영)', () => {
    const result = checkReservedFirstSegmentsSync();
    expect(result.missing).toEqual([]);
  });

  it('sanity floor — 스캔이 실제로 디렉터리를 훑었다(빈 배열을 0건으로 오독하지 않는다)', () => {
    const result = checkReservedFirstSegmentsSync();
    expect(result.liveDirs.length).toBeGreaterThan(20);
    expect(result.liveMetadataRoutes.length).toBeGreaterThan(0);
    expect(result.derivedLegacyNames.length).toBeGreaterThan(0);
  });

  it('gates·more가 라이브 디렉터리 목록에 실제로 잡힌다(2026-08-01 발견한 드리프트의 근거)', () => {
    const result = checkReservedFirstSegmentsSync();
    expect(result.liveDirs).toContain('gates');
    expect(result.liveDirs).toContain('more');
  });

  it('manifest.webmanifest가 메타데이터 라우트로 잡힌다(manifest.ts가 소스, 서빙 경로는 다른 이름)', () => {
    const result = checkReservedFirstSegmentsSync();
    expect(result.liveMetadataRoutes).toContain('manifest.webmanifest');
    expect(METADATA_FILE_ROUTES['manifest.ts']).toBe('manifest.webmanifest');
  });

  it('flow·goals가 파생 축(레거시 리소스명)에 들어 있다(레거시 리소스 표에서 직접 파생 확認)', () => {
    const result = checkReservedFirstSegmentsSync();
    expect(result.derivedLegacyNames).toContain('flow');
    expect(result.derivedLegacyNames).toContain('goals');
  });
});
