import * as React from "react"

// P2-S1(mobile-p2-p1a-story-breakdown SSOT): 1024=데스크톱 IA 경계로 수렴(Tailwind lg와 정합).
// GNB(components/ui/sidebar.tsx)도 동일 경계로 md:→lg: 전환 완료 — 이 값과 항상 같이 움직인다.
export const MOBILE_BREAKPOINT = 1024

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }
    mql.addEventListener("change", onChange)
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return !!isMobile
}

// story #2683(모바일 IA S3, doc mobile-ia-full-completion-2678 §2.6①) — 폰(<768)은 /more
// 허브(S2)가 전 목적지 도달을 이미 커버해 Sheet GNB 문이 필요 없다(PO 승인 권고). 태블릿
// (768~1023)은 화면 여력이 있어 Sheet GNB를 존치한다 — 그런데 그 문(SidebarTrigger)이 지금껏
// settings 페이지 안에만 있었다(§1.4 실측: 전 앱 유일 진입점). 그 문을 지우면서(AC1) 태블릿만
// 「폰과 똑같이 문이 없어지는」 회귀를 막으려면 폰/태블릿을 가르는 별도 판정이 필요하다.
// ⚠️CLAUDE.md 프로젝트 규율 — `md:`(768) Tailwind 브레이크포인트 신규 사용 금지(GNB SSOT는
// lg뿐). 그래서 CSS 클래스가 아니라 이 훅처럼 JS 판정으로 768 문턱을 다룬다(useIsMobile()과
// 같은 패턴 — 훅은 이미 브레이크포인트를 다루는 정당한 통로다).
export const TABLET_BREAKPOINT = 768

export function useIsTablet() {
  const [isTablet, setIsTablet] = React.useState<boolean | undefined>(undefined)

  React.useEffect(() => {
    const mql = window.matchMedia(
      `(min-width: ${TABLET_BREAKPOINT}px) and (max-width: ${MOBILE_BREAKPOINT - 1}px)`,
    )
    const onChange = () => {
      const width = window.innerWidth
      setIsTablet(width >= TABLET_BREAKPOINT && width < MOBILE_BREAKPOINT)
    }
    mql.addEventListener("change", onChange)
    onChange()
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return !!isTablet
}
