"""``hermes-dock`` command line."""

from __future__ import annotations

import argparse
import json
import sys
import time

from .llm import make_backend
from .station import Station


def _station(args) -> Station:
    return Station(args.root, backend=make_backend(offline=args.offline or None), autonomy=args.autonomy)


def _print(obj) -> None:
    print(obj if isinstance(obj, str) else json.dumps(obj, indent=2, default=str))


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="hermes-dock", description=__doc__)
    p.add_argument("--root", default=".hermes", help="state directory (default .hermes)")
    p.add_argument("--offline", action="store_true", help="use the deterministic offline backend")
    p.add_argument("--autonomy", choices=["supervised", "autonomous"], help="persist a new autonomy level")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("init", help="create the station and install the three starter decks")
    sub.add_parser("status", help="decks, crews and latest audit scores")
    c = sub.add_parser("cycle", help="run one operating cycle on a deck (or all)")
    c.add_argument("deck", nargs="?")
    c.add_argument("--directive")
    a = sub.add_parser("audit", help="run the station auditors")
    a.add_argument("deck", nargs="?")
    sub.add_parser("review", help="Hermes standing review: audit, act, learn")
    h = sub.add_parser("ask", help="give Hermes a free-form instruction")
    h.add_argument("instruction")
    h.add_argument("--no-web", action="store_true")
    r = sub.add_parser("research", help="have Hermes research a question online and record strategy")
    r.add_argument("question")
    w = sub.add_parser("watch", help="loop: audit every deck, then Hermes review, every N minutes")
    w.add_argument("--minutes", type=float, default=60)
    w.add_argument("--rounds", type=int, default=0, help="stop after N rounds (0 = forever)")
    k = sub.add_parser("canon", help="add an owner reference document (e.g. a story bible) to a deck")
    k.add_argument("deck")
    k.add_argument("file")
    k.add_argument("--name", help="name inside the deck (default: the file's name)")
    k.add_argument("--glob", default="*", help="when FILE is a folder: which files to add (default all)")
    sub.add_parser("approvals", help="list actions waiting on a human")
    d = sub.add_parser("approve", help="approve a pending ticket")
    d.add_argument("ticket")
    d = sub.add_parser("reject", help="reject a pending ticket")
    d.add_argument("ticket")
    sub.add_parser("memory", help="show what Hermes has learned")
    args = p.parse_args(argv)
    st = _station(args)

    if args.cmd == "init":
        _print({"created": st.install_templates(), "decks": st.store.deck_ids(), "autonomy": st.autonomy})
    elif args.cmd == "status":
        health = st.health()
        _print([{"deck": d.id, "name": d.spec["name"], "version": d.spec.get("version"),
                 "manager": d.manager_spec.name, "crew": list(d.worker_specs), "health": health.get(d.id, {})}
                for d in st.decks()])
    elif args.cmd == "cycle":
        for deck_id in [args.deck] if args.deck else st.store.deck_ids():
            r = st.run_cycle(deck_id, args.directive)
            _print({"deck": deck_id, "summary": r.summary, "kpis": r.kpis, "needs": r.needs})
    elif args.cmd == "audit":
        _print(st.audit(args.deck))
    elif args.cmd == "review":
        _print(st.review().text)
    elif args.cmd == "ask":
        _print(st.hermes(args.instruction, web=not args.no_web).text)
    elif args.cmd == "research":
        _print(st.hermes(f"Research this online and record the strategic takeaways with record_learning "
                         f"(kind=strategy): {args.question}").text)
    elif args.cmd == "watch":
        n = 0
        while True:
            n += 1
            print(f"--- round {n} @ {time.strftime('%H:%M:%S')}", file=sys.stderr)
            _print(st.review().text)
            if args.rounds and n >= args.rounds:
                break
            time.sleep(args.minutes * 60)
    elif args.cmd == "canon":
        from pathlib import Path

        path = Path(args.file)
        files = [path] if path.is_file() else sorted(p for p in path.rglob(args.glob) if p.is_file())
        for f in files:
            name = args.name if path.is_file() and args.name else (f.name if path.is_file() else
                                                                  str(f.relative_to(path)))
            raw = f.read_bytes()
            try:
                content: str | bytes = raw.decode("utf-8")
            except UnicodeDecodeError:
                content = raw
            _print(st.add_canon(args.deck, name, content))
    elif args.cmd == "approvals":
        _print(st.pending())
    elif args.cmd in ("approve", "reject"):
        _print(st.decide(args.ticket, args.cmd == "approve"))
    elif args.cmd == "memory":
        _print(st.memory())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
