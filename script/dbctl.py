#!/usr/bin/env python3
"""opencode-dbctl — centralized management for the opencode data backend.

The opencode binary names its SQLite DB after the build channel
(packages/core/src/database/database.ts path()): channels in
{latest, beta, prod} share `opencode.db`, everything else opens
`opencode-<channel>.db`. Fork builds from branch `main` therefore land in
`opencode-main.db`, source runs in `opencode-local.db`, release builds in
`opencode.db` — a silent data fork per build flavor.

Consolidation policy (2026-09-29):
  * canonical DB  = opencode-main.db (name kept, zero-rename of live data)
  * anti-fork pin = OPENCODE_DB=opencode-main.db in ~/.config/environment.d/
  * orphans       = retired by rename (retired-<date>/), never deleted
  * history merge = INSERT OR IGNORE with a system-table skip list
    (naive ATTACH merge dies: project_directory composite-key collision,
    migration id collision, account_state is a rowid INTEGER PK)

Every read path here opens databases `file:...?mode=ro`. Writes happen only
for backup destinations, explicit --apply, and vacuum (holder-guarded).

Commands:
  status             inventory: canonical / retired / unexpected DBs, holders
  backup [--dir D]   consistent online backup (sqlite backup API) + verify
  integrity          PRAGMA integrity_check + foreign_key_check per DB
  manifest [--dir D] sha256 + size + row counts manifest.json for backups
  retire NAME...     by-rename into retired-<date>/ (holder-checked, reversible)
  prune-tool-output [--apply] [--days N]
                     reference-safe tool-output reaper (default dry-run).
                     The built-in hourly cleanup is reference-unsafe.
  migrate --from DB [--apply]
                     merge a retired/legacy DB into the canonical one
                     (default dry-run; INSERT OR IGNORE; skip list below)
  vacuum [--force]   VACUUM canonical (refuses while any holder exists)
  log-rotate [--apply]
                     copytruncate ~/.local/share/opencode/log/opencode.log
  doctor             policy checks: pin present, version channel, backup age
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import shutil
import sqlite3
import sys
from pathlib import Path

DATA_DIR = Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")) / "opencode"
CANONICAL = "opencode-main.db"
LOG_FILE = DATA_DIR / "log" / "opencode.log"

# Tables holding identity / system state: never merge across DBs.
MIGRATE_SKIP = {
    "account",
    "account_state",
    "control_account",
    "credential",
    "data_migration",
    "migration",
}
# FK-safe insert order for the remaining tables (sqlite_master, 2026-09-29).
MIGRATE_ORDER = [
    "project",
    "project_directory",
    "permission",
    "workspace",
    "session",
    "session_share",
    "session_input",
    "session_message",
    "session_context_epoch",
    "message",
    "part",
    "event_sequence",
    "event",
    "todo",
]
KEY_TABLES = ["session", "message", "part", "event", "todo"]


def ro(path: Path) -> sqlite3.Connection:
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)


def holders(name: str) -> list[int]:
    pids: list[int] = []
    for proc in Path("/proc").iterdir():
        if not proc.name.isdigit():
            continue
        try:
            for fd in (proc / "fd").iterdir():
                try:
                    if os.readlink(fd).endswith(name):
                        pids.append(int(proc.name))
                        break
                except OSError:
                    continue
        except OSError:
            continue
    return sorted(set(pids))


def db_files() -> list[Path]:
    return sorted(DATA_DIR.glob("*.db"))


def counts(path: Path) -> dict[str, int]:
    out: dict[str, int] = {}
    try:
        con = ro(path)
        for t in KEY_TABLES:
            if con.execute("SELECT 1 FROM sqlite_master WHERE name=?", (t,)).fetchone():
                out[t] = con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
        con.close()
    except sqlite3.Error as e:
        out["error"] = str(e)
    return out


def human(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.1f}{unit}" if unit != "B" else f"{n}B"
        n /= 1024
    return f"{n}GB"


def cmd_status(_: argparse.Namespace) -> int:
    print(f"data dir : {DATA_DIR}")
    print(f"pin      : OPENCODE_DB={os.environ.get('OPENCODE_DB', '<unset>')}")
    print(f"canonical: {CANONICAL}")
    for p in db_files():
        h = holders(p.name)
        tag = "CANONICAL" if p.name == CANONICAL else "UNEXPECTED (fork?)"
        print(f"\n{p.name} [{tag}] {human(p.stat().st_size)} holders={h or 'none'}")
        for k, v in counts(p).items():
            print(f"    {k:8s} {v}")
    retired = DATA_DIR.glob("retired-*")
    for r in sorted(retired):
        print(f"\nretired: {r}")
        for f in sorted(r.glob("*")):
            print(f"    {f.name} {human(f.stat().st_size)}")
    return 0


def cmd_backup(args: argparse.Namespace) -> int:
    out_dir = Path(args.dir) if args.dir else DATA_DIR / f"backup-{dt.date.today():%Y%m%d}"
    out_dir.mkdir(parents=True, exist_ok=True)
    for p in db_files():
        dst = out_dir / p.name
        if dst.exists():
            print(f"skip (exists): {dst}")
            continue
        src = ro(p)
        out = sqlite3.connect(dst)
        with out:
            src.backup(out)
        ok = out.execute("PRAGMA integrity_check").fetchone()[0]
        out.close()
        src.close()
        print(f"backup: {dst} {human(dst.stat().st_size)} integrity={ok}")
    return 0


def cmd_integrity(_: argparse.Namespace) -> int:
    rc = 0
    for p in db_files():
        try:
            con = ro(p)
            ok = con.execute("PRAGMA integrity_check").fetchone()[0]
            fk = con.execute("PRAGMA foreign_key_check").fetchall()
            con.close()
            status = "OK" if ok == "ok" and not fk else f"FAIL({ok}, fk={fk[:3]})"
            print(f"{p.name}: {status}")
            rc |= status != "OK"
        except sqlite3.Error as e:
            print(f"{p.name}: ERROR {e}")
            rc = 1
    return rc


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def cmd_manifest(args: argparse.Namespace) -> int:
    if args.dir:
        out_dir = Path(args.dir)
    else:
        dirs = sorted(d for d in DATA_DIR.glob("backup-*") if d.is_dir())
        if not dirs:
            print(f"no backup dir under {DATA_DIR} (run: opencode-dbctl backup)", file=sys.stderr)
            return 1
        out_dir = dirs[-1]
    man = {"created": dt.datetime.now().isoformat(timespec="seconds"), "files": {}}
    for p in sorted(out_dir.glob("*.db")):
        man["files"][p.name] = {
            "size": p.stat().st_size,
            "sha256": sha256(p),
            "counts": counts(p),
        }
        print(f"manifested: {p.name}")
    dest = out_dir / "manifest.json"
    dest.write_text(json.dumps(man, indent=2) + "\n")
    print(f"wrote {dest}")
    return 0


def cmd_retire(args: argparse.Namespace) -> int:
    stamp = dt.date.today().isoformat()
    retire_dir = DATA_DIR / f"retired-{stamp}"
    for name in args.names:
        if name == CANONICAL:
            print(f"refuse: {name} is the canonical DB", file=sys.stderr)
            return 1
        p = DATA_DIR / name
        if not p.exists():
            print(f"missing: {p}", file=sys.stderr)
            return 1
        h = holders(name)
        if h:
            print(f"refuse: {name} held by pids {h}", file=sys.stderr)
            return 1
        if args.dry_run:
            print(f"would retire: {p} -> {retire_dir / name}")
            continue
        retire_dir.mkdir(exist_ok=True)
        for f in (p, Path(str(p) + "-shm"), Path(str(p) + "-wal")):
            if f.exists():
                shutil.move(str(f), str(retire_dir / f.name))
                print(f"retired: {f.name} -> {retire_dir}")
    return 0


def cmd_prune_tool_output(args: argparse.Namespace) -> int:
    ref = ro(DATA_DIR / CANONICAL)
    names = set()
    for table in ("part", "event"):
        try:
            for (data,) in ref.execute(f"SELECT data FROM {table} WHERE data LIKE '%tool_%'"):
                names.update(re.findall(r"tool_[A-Za-z0-9_\-]+", data or ""))
        except sqlite3.Error:
            pass
    ref.close()
    cutoff = dt.datetime.now().timestamp() - args.days * 86400
    removed = kept = 0
    tool_dir = DATA_DIR / "tool-output"
    files = tool_dir.rglob("tool_*") if tool_dir.is_dir() else []
    for f in sorted(files):
        if not f.is_file():
            continue
        if f.stat().st_mtime > cutoff:
            kept += 1
            continue
        if f.name in names:
            print(f"keep (referenced): {f.name}")
            kept += 1
            continue
        if args.apply:
            f.unlink()
            print(f"removed: {f}")
            removed += 1
        else:
            print(f"would remove: {f} ({human(f.stat().st_size)})")
            removed += 1
    print(f"{'removed' if args.apply else 'would remove'}={removed} kept={kept} (days>{args.days}, unreferenced)")
    return 0


def cmd_migrate(args: argparse.Namespace) -> int:
    """Merge a retired/legacy DB into the canonical one.

    Python-side cursor copy: the source is opened mode=ro (SQLite ATTACH
    does not honor URI query params from Python), rows are inserted with
    INSERT OR IGNORE in FK-safe order, system tables are skipped.
    """
    src_path = Path(args.src)
    if not src_path.exists():
        print(f"missing: {src_path}", file=sys.stderr)
        return 1
    if src_path.resolve() == (DATA_DIR / CANONICAL).resolve():
        print("refuse: source is the canonical DB", file=sys.stderr)
        return 1
    src = ro(src_path)
    dst = sqlite3.connect(DATA_DIR / CANONICAL)
    dst.execute("PRAGMA foreign_keys=OFF")
    tables = [
        r[0]
        for r in src.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        )
    ]
    ordered = [t for t in MIGRATE_ORDER if t in tables] + [
        t for t in tables if t not in MIGRATE_ORDER and t not in MIGRATE_SKIP
    ]
    total_new = 0
    for table in ordered:
        if table in MIGRATE_SKIP:
            print(f"skip (system table): {table}")
            continue
        if not dst.execute("SELECT 1 FROM sqlite_master WHERE name=?", (table,)).fetchone():
            print(f"skip (absent in canonical): {table}")
            continue
        cols = [r[1] for r in src.execute(f'PRAGMA table_info("{table}")')]
        collist = ", ".join(f'"{c}"' for c in cols)
        src_n = src.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
        before = dst.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
        if args.apply:
            cur = src.execute(f'SELECT {collist} FROM "{table}"')
            insert = f'INSERT OR IGNORE INTO "{table}" ({collist}) VALUES ({",".join("?" * len(cols))})'
            while True:
                rows = cur.fetchmany(500)
                if not rows:
                    break
                dst.executemany(insert, rows)
        after = dst.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
        new = after - before
        total_new += new
        print(f"{table}: src={src_n} {'+' + str(new) + ' rows' if args.apply else '(dry-run)'}")
    if args.apply:
        dst.commit()
        print(f"migrate applied: {total_new} new rows -> {DATA_DIR / CANONICAL}")
    else:
        print("dry-run only; re-run with --apply to write")
    dst.close()
    src.close()
    return 0


def cmd_vacuum(args: argparse.Namespace) -> int:
    p = DATA_DIR / CANONICAL
    h = holders(p.name)
    if h and not args.force:
        print(f"refuse: {p.name} held by {h}; stop the server first (or --force)", file=sys.stderr)
        return 1
    con = sqlite3.connect(p)
    before = p.stat().st_size
    con.execute("VACUUM")
    con.close()
    print(f"vacuum: {human(before)} -> {human(p.stat().st_size)}")
    return 0


def cmd_log_rotate(args: argparse.Namespace) -> int:
    if not LOG_FILE.exists():
        print(f"missing: {LOG_FILE}")
        return 0
    size = LOG_FILE.stat().st_size
    if not args.apply:
        print(f"would rotate: {LOG_FILE} {human(size)} -> {LOG_FILE}.1")
        return 0
    shutil.copy2(LOG_FILE, Path(str(LOG_FILE) + ".1"))
    with open(LOG_FILE, "w"):
        pass  # copytruncate: fd held by the TUI keeps working (O_APPEND)
    print(f"rotated: {human(size)} -> {LOG_FILE}.1, log truncated")
    return 0


def cmd_doctor(_: argparse.Namespace) -> int:
    issues = 0
    pin = os.environ.get("OPENCODE_DB")
    if pin != CANONICAL:
        print(f"[FAIL] OPENCODE_DB pin: got {pin!r}, want {CANONICAL!r} "
              f"(see ~/.config/environment.d/10-opencode-db.conf; re-login to apply)")
        issues += 1
    else:
        print(f"[PASS] OPENCODE_DB pin = {pin}")
    unexpected = [p.name for p in db_files() if p.name != CANONICAL]
    if unexpected:
        print(f"[WARN] unexpected DB files (fork candidates): {unexpected}")
    else:
        print("[PASS] single DB file (canonical only)")
    canon = DATA_DIR / CANONICAL
    if canon.exists():
        h = holders(canon.name)
        print(f"[{'PASS' if h else 'WARN'}] canonical holders: {h or 'none (server down?)'}")
        con = ro(canon)
        ok = con.execute("PRAGMA integrity_check").fetchone()[0]
        con.close()
        print(f"[{'PASS' if ok == 'ok' else 'FAIL'}] integrity_check = {ok}")
        issues += ok != "ok"
    else:
        print(f"[FAIL] canonical DB missing: {canon}")
        issues += 1
    backups = sorted(DATA_DIR.glob("backup-*/manifest.json"))
    if backups:
        age = dt.date.today() - dt.date.fromisoformat(backups[-1].parent.name.split("backup-")[-1])
        good = age.days <= 7
        print(f"[{'PASS' if good else 'WARN'}] last backup manifest: {backups[-1].parent.name} (age {age.days}d)")
    else:
        print("[WARN] no backup manifests found (run: opencode-dbctl backup && opencode-dbctl manifest)")
    if LOG_FILE.exists():
        sz = LOG_FILE.stat().st_size
        good = sz < 64 * 1024 * 1024
        print(f"[{'PASS' if good else 'WARN'}] opencode.log {human(sz)} (rotate with: opencode-dbctl log-rotate --apply)")
    return 1 if issues else 0


def main() -> int:
    ap = argparse.ArgumentParser(prog="opencode-dbctl", description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("status").set_defaults(fn=cmd_status)
    p = sub.add_parser("backup")
    p.add_argument("--dir")
    p.set_defaults(fn=cmd_backup)
    sub.add_parser("integrity").set_defaults(fn=cmd_integrity)
    p = sub.add_parser("manifest")
    p.add_argument("--dir")
    p.set_defaults(fn=cmd_manifest)
    p = sub.add_parser("retire")
    p.add_argument("names", nargs="+")
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(fn=cmd_retire)
    p = sub.add_parser("prune-tool-output")
    p.add_argument("--apply", action="store_true")
    p.add_argument("--days", type=int, default=14)
    p.set_defaults(fn=cmd_prune_tool_output)
    p = sub.add_parser("migrate")
    p.add_argument("--from", dest="src", required=True)
    p.add_argument("--apply", action="store_true")
    p.set_defaults(fn=cmd_migrate)
    p = sub.add_parser("vacuum")
    p.add_argument("--force", action="store_true")
    p.set_defaults(fn=cmd_vacuum)
    p = sub.add_parser("log-rotate")
    p.add_argument("--apply", action="store_true")
    p.set_defaults(fn=cmd_log_rotate)
    sub.add_parser("doctor").set_defaults(fn=cmd_doctor)
    args = ap.parse_args()
    return args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
