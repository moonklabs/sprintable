// story #3715(2026-09-09, 페드루 PO 決) — E-GLANCE 2D hero(glance-hero.tsx) 은퇴 스윕.
// `HeroStory`·`heroProofState`·`splitParticipants`는 유일 소비처였던 glance-hero.tsx(+
// derive-hero-envelope.ts의 호출체인)가 삭제되며 소비처 0이 됐다. `HeroMember`만 실
// 소비처가 있어 남긴다(load-glance-data.ts의 memberMap).
export interface HeroMember {
  name: string;
  type: string;
}
