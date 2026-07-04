"""DB bootstrap entrypoint: always `alembic upgrade heads`.

On an EMPTY database, alembic/env.py provisions from the squashed baseline snapshot (dev's
0096 end-state schema + global system seed) and stamps revision 0096. On an existing database
it runs the normal incremental chain (a no-op for a DB already at heads). There is no longer a
create_all shortcut — it built from the drifted models and produced a schema that diverged from
the migrated one (the prod onboarding 500). See alembic/baseline/ and alembic/env.py.

story bda4beac: ee_pricing(0146/0147) branched off the core chain (0145->0148->0149+) as its
own head, so a checkout that has those files (local dev, EE builds) is dual-head. `heads`
(plural) is safe for both that case and a single-head checkout (main/prod, which never has
0146/0147 at all).
"""
import subprocess
import sys


def main() -> None:
    print("[bootstrap] Running alembic upgrade heads")
    subprocess.run(["alembic", "upgrade", "heads"], check=True)


if __name__ == "__main__":
    main()
    sys.exit(0)
