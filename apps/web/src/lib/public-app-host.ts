const LOCAL_APP_URL = 'http://localhost:3108';

/** story #3905 — 온보딩 슬러그 미리보기 등 클라 측 캡션에 찍을 "이 환경의 실 호스트". Next.js가
 * `process.env.NEXT_PUBLIC_APP_URL`을 빌드 타임에 리터럴로 인라인하므로(cloudbuild.yaml이
 * 환경별로 이미 정확히 분기: dev=dev-app.sprintable.ai·prod=app.sprintable.ai, 로컬은
 * docker-compose가 주입) 그 값에서 프로토콜만 벗겨 쓴다 — 도메인 하드코딩 금지. */
export function getPublicAppHost(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL?.trim() || LOCAL_APP_URL;
  return raw.replace(/^https?:\/\//i, '').replace(/\/$/, '');
}
