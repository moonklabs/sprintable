"use client"

import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox"
import { CheckIcon } from "lucide-react"

import { cn } from "@/lib/utils"

// story 4831 (바탕 한 벌 규격 v1 §5) — 날것 <input type="checkbox">의 자리. 켜진 상태는 primary 면 + 체크, 초점은 Input과 같은 시트론 링.
// Base UI는 className에 «상태를 받는 함수»도 허용하지만 cn()은 함수를 조용히 버린다 — 이 부품은 문자열만 받는다.
// 키보드는 날것 checkbox와 같아야 한다: 스페이스로만 켜고 끈다. Base UI는 span 뿌리라 엔터도 «누름»으로 처리해 켜 버리므로 엔터는 부품 쪽에서 건너뛴다
// (날것 checkbox에서 엔터는 켜지 않는다 — 시험: form-controls.behavior.4831 «엔터로는 켜지지 않는다»).
function Checkbox({ className, onKeyDown, ...props }: Omit<CheckboxPrimitive.Root.Props, "className"> & { className?: string }) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      onKeyDown={(event) => {
        onKeyDown?.(event)
        if (event.key === "Enter") event.preventBaseUIHandler()
      }}
      className={cn(
        "peer relative inline-flex size-4 shrink-0 items-center justify-center rounded-sm border border-input bg-transparent transition-colors outline-none after:absolute after:-inset-2 focus-visible:border-proof-citron focus-visible:ring-3 focus-visible:ring-proof-citron data-disabled:cursor-not-allowed data-disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground data-indeterminate:border-primary data-indeterminate:bg-primary data-indeterminate:text-primary-foreground dark:bg-input/30",
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator data-slot="checkbox-indicator" className="flex items-center justify-center text-current">
        <CheckIcon className="size-3" aria-hidden="true" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
