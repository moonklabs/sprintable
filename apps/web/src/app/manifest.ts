import type { MetadataRoute } from 'next';

// story #2022: PWA manifest 신설 — 이전엔 부재. 아이콘 3종(192/512/maskable)은 유나 규격
// 산출물 그대로 재사용.
// story #2529: 마크 v1(3단 모노 #1274D4)→v2(2단 듀오톤) 갱신 — theme_color를 마크 상단
// 색(인디고, 핸드오프 §6-2) #42549B로. 아이콘 파일은 경로 그대로 in-place 교체(§5).
export default function manifest(): MetadataRoute.Manifest {
  return {
    // story #2745 — layout.tsx SITE_TITLE/SITE_DESCRIPTION과 동일 정본(같은 이유로 동시 갱신).
    name: 'Sprintable — Ship with AI agents',
    short_name: 'Sprintable',
    description: 'The organization OS that closes open loops. Kanban, memos, standups, retros, MCP server — with AI agents as first-class team members.',
    start_url: '/',
    display: 'standalone',
    background_color: '#FFFFFF',
    theme_color: '#42549B',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
