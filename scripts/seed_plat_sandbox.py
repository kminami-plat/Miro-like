"""Copy the production plat-todo task list into the sandbox key, so the grid can be tried safely.

  .venv/bin/python scripts/seed_plat_sandbox.py            # plat-todo-tasks -> plat-todo-tasks-sandbox
  .venv/bin/python scripts/seed_plat_sandbox.py --to my-key

Reads PLAT_KV_URL / PLAT_KV_TOKEN from the environment or .env (via the server package).
Only ever writes the target key, and refuses to write the production key.
"""
import argparse
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from server import plat_tasks as plat  # noqa: E402  (importing `server` loads .env)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--from", dest="src", default=plat.PRODUCTION_KEY)
    ap.add_argument("--to", dest="dst", default=plat.SANDBOX_KEY)
    args = ap.parse_args()
    if args.dst == plat.PRODUCTION_KEY:
        sys.exit("本番キーには書き込めません（このスクリプトはサンドボックス用です）")
    cfg = plat.settings()
    kv = plat.KvClient(cfg["kv_url"], cfg["token"])
    value = kv.get(args.src)
    if not isinstance(value, dict) or not isinstance(value.get("tasks"), list):
        sys.exit(f"{args.src} の内容が想定と異なるため中止しました")
    kv.put(args.dst, value)
    print(f"{args.src} → {args.dst}: タスク {len(value['tasks'])} 件、候補 {len(value.get('suggestions') or [])} 件をコピーしました")


if __name__ == "__main__":
    main()
