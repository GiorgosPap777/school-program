#!/usr/bin/env python3
"""Build the schedule fixtures used to exercise the app's update path.

    python3 tools/test/make_fixtures.py

Writes into tools/test/fixtures/ (deliberately outside data/, so the deployed
app never serves them). To use one, point REMOTE_SCHEDULE_URL in app.js at it
while a local server is running, then reload the page.
"""

import copy
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
OUT = os.path.join(HERE, "fixtures")


def write(name, payload, raw=False):
    path = os.path.join(OUT, name)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(payload if raw else json.dumps(payload, ensure_ascii=False))
    print("  %-20s %7d bytes" % (name, os.path.getsize(path)))


def main():
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(ROOT, "data", "schedule.json"), encoding="utf-8") as fh:
        base = json.load(fh)

    # 1. A legitimately newer revision with one visibly changed lesson.
    newer = copy.deepcopy(base)
    newer.update(version="2026-10-05", generatedAt="2026-10-01T09:00:00+00:00",
                 validFrom="2026-10-05", validTo="2026-10-09")
    for lesson in newer["groups"]["Γ1"]["lessons"]:
        if lesson["d"] == 2 and lesson["p"] == 1:
            lesson["subject"] = "ΔΟΚΙΜΗ ΝΕΟΥ ΠΡΟΓΡΑΜΜΑΤΟΣ"
    write("newer.json", newer)

    # 2. A revision that drops a track, to exercise selection pruning.
    dropped = copy.deepcopy(newer)
    dropped.update(version="2026-10-12", generatedAt="2026-10-10T09:00:00+00:00")
    del dropped["groups"]["Γθετικό"]
    write("dropped-track.json", dropped)

    # 3. A revision where a section and a track collide, to exercise the
    #    conflict UI. The real data has none, so one has to be manufactured.
    clashing = copy.deepcopy(newer)
    clashing.update(version="2026-10-19", generatedAt="2026-10-17T09:00:00+00:00")
    clashing["groups"]["Γ1"]["lessons"].append({
        "d": 2, "p": 3, "subject": "ΜΑΘΗΜΑ ΠΟΥ ΣΥΓΚΡΟΥΕΤΑΙ",
        "teacher": "ΔΟΚΙΜΑΣΤΙΚΟΣ ΚΑΘΗΓΗΤΗΣ", "room": None,
    })
    write("conflict.json", clashing)

    # 4 & 5. Payloads the app must refuse instead of adopting.
    write("bad-schema.json", {"schemaVersion": 99, "groups": {}})
    write("truncated.json", json.dumps(newer, ensure_ascii=False)[:5000], raw=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
