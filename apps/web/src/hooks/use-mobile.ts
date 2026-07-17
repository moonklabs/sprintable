import * as React from "react"

// P2-S1(mobile-p2-p1a-story-breakdown SSOT): 1024=데스크톱 IA 경계로 수렴(Tailwind lg와 정합).
// GNB(components/ui/sidebar.tsx)도 동일 경계로 md:→lg: 전환 완료 — 이 값과 항상 같이 움직인다.
const MOBILE_BREAKPOINT = 1024

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
