"""python -m sprintable_connectors — SPRINTABLE_RUNTIME 선택형 진입점.

auto-detect 안 함(2026-08-03 조사 결론 — 같은 머신에 여러 CLI가 공존해도 사용자가 이미
어느 host.py를 실행할지로 명시 선택하던 것과 동형, 자동감지는 과설계).

Stage 1(2026-08-03) — 5종 전부 등록 완료: codex·cursor·gemini·grok·pi. 각자 모듈의 `main()`
코루틴만 등록 — 프로토콜 로직은 계열별로 그대로 둔다(4계열 반증 결론, 원본과 byte-identical
diff 확認 완료).
"""
from __future__ import annotations

import asyncio
import os
import sys

_RUNTIMES: dict[str, str] = {
    "codex": "sprintable_connectors.codex",
    "cursor": "sprintable_connectors.cursor",
    "gemini": "sprintable_connectors.gemini",
    "grok": "sprintable_connectors.grok",
    "pi": "sprintable_connectors.pi",
}


def _resolve_main(runtime: str):
    import importlib

    module_path = _RUNTIMES[runtime]
    module = importlib.import_module(module_path)
    return module.main


def main() -> None:
    runtime = (os.getenv("SPRINTABLE_RUNTIME") or "").strip().lower()
    if not runtime:
        print(
            "Error: SPRINTABLE_RUNTIME environment variable required.\n"
            f"  Available: {', '.join(sorted(_RUNTIMES))}\n"
            "  Example: export SPRINTABLE_RUNTIME=codex",
            file=sys.stderr,
        )
        sys.exit(1)
    if runtime not in _RUNTIMES:
        print(
            f"Error: unknown SPRINTABLE_RUNTIME={runtime!r}.\n"
            f"  Available: {', '.join(sorted(_RUNTIMES))}",
            file=sys.stderr,
        )
        sys.exit(1)

    runtime_main = _resolve_main(runtime)
    try:
        asyncio.run(runtime_main())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
