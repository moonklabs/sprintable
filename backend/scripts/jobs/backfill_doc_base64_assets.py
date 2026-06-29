"""E-STORAGE-SSOT S4 Phase2 (009fd681): doc 본문 base64 첨부 → GCS 자산 이관 + 본문 rewrite (멱등 배치).

배경: S4 前 doc 첨부는 base64 가 `Doc.content` 에 인라인 저장(행 bloat·재사용/캡 미연동). 이 job 이
legacy base64 노드를 GCS 업로드 + asset registry 등록 + 본문을 `data-asset-id` ref 로 치환한다(핸드오프
§1 LOCK 포맷). 렌더러가 ref→`sign?asset_id` 로 해소하므로 변환 즉시 정상 렌더(legacy 호환 규칙).

멱등(변환된 노드는 재스캔 대상 아님·2회차 0)·chunked·resumable·**dry-run 기본**·부분실패 graceful.
register 는 additive(reconcile=False·같은 doc 기존 FE-업로드 link clobber 금지). size 는 head_object
authoritative.

env: DATABASE_URL (백엔드 동일·cloud-sql-proxy/in-VPC)·STORAGE_PROVIDER/버킷 설정. apply 시 GCS 쓰기.
실행:
  cd backend && DATABASE_URL=... python -m scripts.jobs.backfill_doc_base64_assets            # dry-run
  cd backend && DATABASE_URL=... python -m scripts.jobs.backfill_doc_base64_assets --apply     # 실제 이관
옵션: --org <uuid> 특정 org만 · --chunk N keyset 청크 크기(기본 100).

⚠️ run 전 미르코 FE 렌더러(data-asset-id 분기) 머지 + 이미지 노드 markup byte-exact(§1) 대조 필수.
dev 먼저·prod 는 선생님 승인 시(PO 게이트).
"""
from __future__ import annotations

import argparse
import asyncio
import os
import sys
import uuid

from app.core.database import async_session_factory
from app.services.doc_asset_backfill import backfill_docs


async def main() -> int:
    if not os.environ.get("DATABASE_URL"):
        print("DATABASE_URL 미설정", file=sys.stderr)
        return 2

    parser = argparse.ArgumentParser(
        description="doc 본문 base64 첨부 → GCS 자산 이관 + ref rewrite (멱등·dry-run 기본)"
    )
    parser.add_argument("--apply", action="store_true", help="실제 이관/쓰기 (미지정 시 dry-run)")
    parser.add_argument("--org", type=str, default=None, help="특정 org_id 만 (기본 전체)")
    parser.add_argument("--chunk", type=int, default=100, help="keyset 청크 크기 (기본 100)")
    args = parser.parse_args()

    org_id = uuid.UUID(args.org) if args.org else None
    mode = "APPLY" if args.apply else "DRY-RUN"
    print(f"[{mode}] doc base64 backfill 시작 org={args.org or 'ALL'} chunk={args.chunk}", file=sys.stderr)

    async with async_session_factory() as session:
        totals = await backfill_docs(session, apply=args.apply, org_id=org_id, chunk=args.chunk)

    print(
        f"[{mode}] 완료 — docs_scanned={totals['docs_scanned']} docs_converted={totals['docs_converted']} "
        f"nodes_found={totals['found']} converted={totals['converted']} failed={totals['failed']} "
        f"skipped_modified={totals['skipped_modified']}"
    )
    if not args.apply:
        print("(dry-run — 쓰기 없음. --apply 로 실제 이관)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
