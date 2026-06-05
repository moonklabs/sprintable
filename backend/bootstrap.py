"""DB bootstrap entrypoint: always `alembic upgrade head`.

On an EMPTY database, alembic/env.py provisions from the squashed baseline snapshot (dev's
0096 end-state schema + global system seed) and stamps revision 0096. On an existing database
it runs the normal incremental chain (a no-op for a DB already at head). There is no longer a
create_all shortcut — it built from the drifted models and produced a schema that diverged from
the migrated one (the prod onboarding 500). See alembic/baseline/ and alembic/env.py.
"""
import subprocess
import sys


def main() -> None:
    print("[bootstrap] Running alembic upgrade head")
    subprocess.run(["alembic", "upgrade", "head"], check=True)


if __name__ == "__main__":
    main()
    sys.exit(0)
