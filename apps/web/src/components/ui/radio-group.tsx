"use client"

import { Radio as RadioPrimitive } from "@base-ui/react/radio"
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group"

import { cn } from "@/lib/utils"

// story 4831 (바탕 한 벌 규격 v1 §5) — 날것 <input type="radio">의 자리. 묶음(RadioGroup)이 화살표 키 이동과 한 번에 하나 선택을 맡는다.
// Base UI는 className에 «상태를 받는 함수»도 허용하지만 cn()은 함수를 조용히 버린다 — 이 부품은 문자열만 받는다.
function RadioGroup({ className, ...props }: Omit<RadioGroupPrimitive.Props, "className"> & { className?: string }) {
  return <RadioGroupPrimitive data-slot="radio-group" className={cn("flex flex-col gap-2", className)} {...props} />
}

// 키보드는 날것 radio와 같아야 한다: 초점 있는 항목에서 스페이스를 누르면 그 항목이 골라진다.
// Base UI 1.3.0은 스페이스 keydown에서 preventDefault를 먼저 하고 뿌리의 onClick을 부르는데, 그 onClick이 «defaultPrevented면 무시»라 스페이스가 아무것도 못 고른다.
// 그래서 스페이스를 부품이 직접 받아 진짜 클릭을 한 번 일으킨다(시험: form-controls.behavior.4831 «스페이스»).
function RadioGroupItem({ className, onKeyDown, ...props }: Omit<RadioPrimitive.Root.Props, "className"> & { className?: string }) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-group-item"
      onKeyDown={(event) => {
        onKeyDown?.(event)
        if (event.key === " " && !event.defaultPrevented) {
          event.preventDefault()
          event.preventBaseUIHandler()
          event.currentTarget.click()
        }
      }}
      className={cn(
        "relative inline-flex size-4 shrink-0 items-center justify-center rounded-full border border-input bg-transparent transition-colors outline-none after:absolute after:-inset-2 focus-visible:border-proof-citron focus-visible:ring-3 focus-visible:ring-proof-citron data-disabled:cursor-not-allowed data-disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-checked:border-primary dark:bg-input/30",
        className
      )}
      {...props}
    >
      <RadioPrimitive.Indicator data-slot="radio-group-indicator" className="size-2 rounded-full bg-primary" />
    </RadioPrimitive.Root>
  )
}

export { RadioGroup, RadioGroupItem }
