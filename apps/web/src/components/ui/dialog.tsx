"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"
import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { XIcon } from "lucide-react"

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/50 duration-100 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean
}) {
  // story 3436(묶음 1) — 전역 셸 접근 이름이 한국어 화면에서도 영문 하드코딩이라
  // 스크린리더가 "Close"를 그대로 읽었다. common.close는 이미 toast.tsx·
  // command-palette.tsx의 aria-label로 쓰이는 정본 키(새 키 0).
  const t = useTranslations("common")
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        // story #4210(유나 390 실측) — 닫기(X)가 떠 있으면 첫 줄이 그 자리를 비우도록 표지(아래 className의 data-[close-button]).
        data-close-button={showCloseButton ? "" : undefined}
        // story #2969 §2 PR-4(doc proofline-system-layer-2969) — 크리스프(rounded-xl→
        // rounded-lg)·--elev-overlay 적용·hairline을 proof-line-strong으로 정련(§1.2 "항상
        // elev-overlay+hairline 동반").
        className={cn(
          // story #4210 — grid-cols-[minmax(0,1fr)]: 열 폭이 자식의 최소 내용 폭(예: 9단계 스테퍼 1040px)을 따라 늘어
          // 390에서 다이얼로그를 가로로 넘기고 제목을 화면 밖으로 밀던 것 — 열을 다이얼로그 폭 안에 묶고 넓은 자식은
          // 제 칸에서 스크롤.
          // story #4210 후속(배포 20 라이브 · 1440 X가 «Apply to project» 위에 겹침) — 닫기(X)가 있으면 **첫 줄 전체**(첫 자식:
          // DialogHeader든 제목·머리 액션이 한 줄인 커스텀 행이든)가 X 자리를 비운다. 예전엔 DialogTitle만 비켜서 같은 줄의 버튼·배지·라벨이
          // X 밑에 깔렸다. X는 children 뒤에 그리므로 첫 자식은 늘 이 다이얼로그의 첫 줄이다.
          "group/dialog data-[close-button]:[&>*:first-child]:pr-8 fixed top-1/2 left-1/2 z-50 grid grid-cols-[minmax(0,1fr)] max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto rounded-lg bg-popover p-4 text-sm text-popover-foreground shadow-[var(--elev-overlay)] ring-1 ring-proof-line-strong duration-100 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={
              <Button
                variant="ghost"
                className="absolute top-2 right-2"
                size="icon-sm"
              />
            }
          >
            <XIcon
            />
            <span className="sr-only">{t("close")}</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-lg border-t bg-muted/50 p-4 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>
          Close
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        // story #4210 — 닫기(X, absolute top-2 right-2 · 28px)가 떠 있을 때만 제목 오른쪽을 비워 긴 제목(en)이 X 밑으로
        // 들어가지 않게. 닫기 버튼이 없는 다이얼로그는 제목 폭 그대로.
        "font-heading text-base leading-none font-medium",
        className
      )}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
