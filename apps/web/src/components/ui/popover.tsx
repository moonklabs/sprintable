"use client"

import { Popover as PopoverPrimitive } from "@base-ui/react/popover"

import { cn } from "@/lib/utils"

// story 4831 (바탕 한 벌 규격 v1 §5) — 손으로 깐 `role="dialog"` 팝오버(자산 고르기 · 보낸 사람 프로필 등)의 자리. 바깥 클릭 · Esc 닫기 · 초점 이동은 base-ui가 맡는다.
// 겉모습은 DropdownMenuContent와 같은 면(bg-popover · elev-overlay · ring)이다. className은 문자열만 받는다(Base UI의 «상태 함수» className은 cn()이 버린다).
function Popover({ ...props }: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverClose({ ...props }: PopoverPrimitive.Close.Props) {
  return <PopoverPrimitive.Close data-slot="popover-close" {...props} />
}

function PopoverContent({
  align = "center",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 6,
  className,
  ...props
}: Omit<PopoverPrimitive.Popup.Props, "className"> & { className?: string } &
  Pick<PopoverPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset">) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Positioner className="isolate z-50 outline-none" align={align} alignOffset={alignOffset} side={side} sideOffset={sideOffset}>
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            "z-50 w-72 max-w-(--available-width) origin-(--transform-origin) rounded-lg bg-popover p-3 text-popover-foreground shadow-[var(--elev-overlay)] ring-1 ring-proof-line-strong outline-none",
            className
          )}
          {...props}
        />
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}

function PopoverTitle({ className, ...props }: Omit<PopoverPrimitive.Title.Props, "className"> & { className?: string }) {
  return <PopoverPrimitive.Title data-slot="popover-title" className={cn("text-sm font-medium", className)} {...props} />
}

function PopoverDescription({ className, ...props }: Omit<PopoverPrimitive.Description.Props, "className"> & { className?: string }) {
  return <PopoverPrimitive.Description data-slot="popover-description" className={cn("text-xs text-muted-foreground", className)} {...props} />
}

export { Popover, PopoverTrigger, PopoverClose, PopoverContent, PopoverTitle, PopoverDescription }
