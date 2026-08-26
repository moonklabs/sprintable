// 루트 경로 폴백 — 일부 구형 swcd가 `.well-known/` 전에 이 경로도 훑는다. proxy.ts
// PUBLIC_PREFIX에 이미 '/apple-app-site-association'이 공개로 등록돼 있다(§10.2).
// 본문은 .well-known 쪽과 완전히 동일 — native-app-links.ts 단일 출처를 그대로 재사용.
export { GET } from '../.well-known/apple-app-site-association/route';
