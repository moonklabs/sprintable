import type { MetadataRoute } from 'next';

// story #2022: PWA manifest 신설 — 이전엔 부재. 아이콘 3종(192/512/maskable)은 유나 규격
// 산출물(브랜드 마크 셰브론 3단 정본) 그대로 재사용. theme_color는 --brand(oklch(0.56 0.17 254))의
// sRGB 변환값과 실측 일치하는 #1274D4(icon.svg와 동일 소스) — 별도 토큰 없이 여기 1곳만 하드코딩.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Sprintable — The PM tool where agents are teammates',
    short_name: 'Sprintable',
    description: 'AI-powered sprint management. Kanban, memos, standups, retros, MCP server — with AI agents as first-class team members.',
    start_url: '/',
    display: 'standalone',
    background_color: '#FFFFFF',
    theme_color: '#1274D4',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
