const LOCAL_APP_URL = 'http://localhost:3108';

/** story #3905 — 온보딩 슬러그 미리보기 등 클라 측 캡션에 찍을 "이 환경의 실 호스트". Next.js가
 * `process.env.NEXT_PUBLIC_APP_URL`을 빌드 타임에 리터럴로 인라인하므로 그 값에서 프로토콜만
 * 벗겨 쓴다 — 도메인 하드코딩 금지.
 *
 * story #3947(2026-09-16, 페드루 PO 판정) — 위 "cloudbuild.yaml이 환경별로 이미 정확히
 * 분기"라는 옛 주석은 틀렸다: 분기 자체(cloud-build.yml steps.env → `_NEXT_PUBLIC_APP_URL`
 * substitution)는 맞았지만, 그 값이 `apps/web/Dockerfile`의 docker build-arg 목록까지
 * 온 적이 없어(EE_ENABLED #2728·TOSS_CLIENT_KEY #2758과 동형 「분기는 있는데 이 스테이지까지
 * 안 옴」 클래스) 배포 빌드에서 이 값은 **항상** undefined였다 — dev-app이 아래 localhost
 * fallback을 그대로 노출한 근본 원인. 이제 Dockerfile에도 배선했지만(cloudbuild.yaml build-arg
 * 참고), "다음 환경에서 같은 클래스가 재발"을 막으려면 조용한 fallback 자체를 걷어야 한다 —
 * 로컬 `next dev`(NODE_ENV=development, docker-compose가 값을 직접 주입)에서만 fallback을
 * 허용하고, 배포 빌드(NODE_ENV=production — `next build`가 항상 이렇게 설정)에서 env가 없으면
 * 조용히 넘어가지 않고 즉시 던진다(양성대조: build-arg 제거 → `pnpm build` RED).
 */
export function getPublicAppHost(): string {
  const envValue = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (!envValue && process.env.NODE_ENV === 'production') {
    throw new Error(
      'NEXT_PUBLIC_APP_URL이 배포 빌드에 배선되지 않았다(story #3947) — cloudbuild.yaml의 ' +
        'build-frontend 스텝에 --build-arg NEXT_PUBLIC_APP_URL이 있는지, Dockerfile에 ARG/ENV가 ' +
        '있는지 확認하라. 로컬 `next dev`에서만 조용한 localhost fallback이 허용된다.'
    );
  }
  const raw = envValue || LOCAL_APP_URL;
  return raw.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}
