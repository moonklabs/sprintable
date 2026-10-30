"use client"

import { Radio as RadioPrimitive } from "@base-ui/react/radio"
import { RadioGroup as RadioGroupPrimitive } from "@base-ui/react/radio-group"

import { cn } from "@/lib/utils"

// story 4831 (바탕 한 벌 규격 v1 §5) — 날것 <input type="radio">의 자리. 묶음(RadioGroup)이 화살표 키 이동과 한 번에 하나 선택을 맡는다.
// Base UI는 className에 «상태를 받는 함수»도 허용하지만 cn()은 함수를 조용히 버린다 — 이 부품은 문자열만 받는다.
function RadioGroup({ className, ...props }: Omit<RadioGroupPrimitive.Props, "className"> & { className?: string }) {
  return <RadioGroupPrimitive data-slot="radio-group" className={cn("flex flex-col gap-2", className)} {...props} />
}

function RadioGroupItem({ className, ...props }: Omit<RadioPrimitive.Root.Props, "className"> & { className?: string }) {
  return (
    <RadioPrimitive.Root
      data-slot="radio-group-item"
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
