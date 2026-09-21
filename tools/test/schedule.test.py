#!/usr/bin/env python3
"""Invariant checks on data/schedule.json.

Run this after every PDF import. It catches the failure mode that matters most:
a converter change or a new PDF layout that silently produces a wrong or
lopsided timetable rather than an obvious error.

    python3 tools/test/schedule.test.py [path/to/schedule.json]
"""

import itertools
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DEFAULT = os.path.join(ROOT, "data", "schedule.json")
TIME_RE = re.compile(r"^\d{2}:\d{2}$")

results = []


def check(name):
    def wrap(fn):
        try:
            fn()
            results.append((True, name))
        except AssertionError as exc:
            results.append((False, "%s — %s" % (name, exc)))
        return fn
    return wrap


def main(path):
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)

    groups = data["groups"]
    kinds = lambda k: {n: g for n, g in groups.items() if g["kind"] == k}
    sections, tracks = kinds("section"), kinds("track")
    kontra = kinds("kontra")

    @check("schema envelope is complete")
    def _():
        for key in ("schemaVersion", "version", "generatedAt", "days", "periods", "groups"):
            assert key in data, "missing %s" % key
        assert data["schemaVersion"] == 1, "unexpected schemaVersion"
        assert len(data["days"]) == 5, "expected 5 school days"

    @check("every period has a sane, ordered time range")
    def _():
        prev_end = -1
        for p in data["periods"]:
            assert TIME_RE.match(p["start"]) and TIME_RE.match(p["end"]), \
                "bad time on period %s" % p["n"]
            to_min = lambda t: int(t[:2]) * 60 + int(t[3:])
            start, end = to_min(p["start"]), to_min(p["end"])
            assert start < end, "period %s ends before it starts" % p["n"]
            assert start >= prev_end, "period %s overlaps the previous one" % p["n"]
            prev_end = end

    @check("every lesson lands inside the grid")
    def _():
        for name, g in groups.items():
            for l in g["lessons"]:
                assert 0 <= l["d"] < len(data["days"]), "%s: bad day %s" % (name, l["d"])
                assert 1 <= l["p"] <= len(data["periods"]), "%s: bad period %s" % (name, l["p"])
                assert l["subject"], "%s: empty subject" % name

    @check("no group double-books itself")
    def _():
        for name, g in groups.items():
            seen = {}
            for l in g["lessons"]:
                key = (l["d"], l["p"])
                assert key not in seen, \
                    "%s teaches two lessons at %s/%s" % (name, l["d"], l["p"])
                seen[key] = l

    @check("every section + track + elective combination merges without collision")
    def _():
        clashes = []
        for sec_name, sec in sections.items():
            if sec["hidden"]:
                continue
            taken = {(l["d"], l["p"]): l["subject"] for l in sec["lessons"]}
            overlays = {n: g for n, g in {**tracks, **kontra}.items()
                        if g["grade"] == sec["grade"] and not g["hidden"]}
            for ov_name, ov in overlays.items():
                for l in ov["lessons"]:
                    key = (l["d"], l["p"])
                    if key in taken:
                        clashes.append("%s+%s at day %s period %s (%s vs %s)"
                                       % (sec_name, ov_name, key[0], key[1],
                                          taken[key], l["subject"]))
        assert not clashes, "%d collision(s): %s" % (len(clashes), "; ".join(clashes[:4]))

    @check("merged week is a plausible size for every student")
    def _():
        for sec_name, sec in sections.items():
            # Hidden sections are never offered, so their hours do not matter.
            if sec["hidden"]:
                continue
            peers = [g for g in tracks.values()
                     if g["grade"] == sec["grade"] and not g["hidden"]] or [None]
            for track in peers:
                slots = {(l["d"], l["p"]) for l in sec["lessons"]}
                if track:
                    slots |= {(l["d"], l["p"]) for l in track["lessons"]}
                label = "%s+%s" % (sec_name, track["label"] if track else "—")
                assert 20 <= len(slots) <= 35, \
                    "%s has %d hours a week, which is out of range" % (label, len(slots))

    @check("empty groups are hidden, except the «κόντρα» electives")
    def _():
        for name, g in groups.items():
            if g["lessons"] or g["kind"] == "kontra":
                continue
            assert g["hidden"], \
                "%s has no lessons but is still offered in the picker" % name
        offered = sorted(n for n, g in sections.items() if not g["hidden"])
        assert offered, "no sections left for students to pick"
        hidden = sorted(n for n, g in sections.items() if g["hidden"])
        if hidden:
            print("    note: sections hidden as non-existent: %s" % ", ".join(hidden))

    @check("period times match the school's official ωράριο")
    def _():
        # aSc prints its own times in the PDF header and this school's bell does
        # not follow them, so the converter overrides them from aliases.json.
        # If that override silently stops applying, every countdown in the app
        # is five minutes wrong — which is exactly how a student is late.
        with open(os.path.join(ROOT, "tools", "aliases.json"), encoding="utf-8") as fh:
            official = json.load(fh).get("periodTimes", {}).get("times")
        assert official, "aliases.json no longer carries the school's ωράριο"
        got = [[p["start"], p["end"]] for p in data["periods"]]
        assert got == [list(t) for t in official], \
            "periods are %s but the ωράριο says %s" % (got, official)

    @check("a double period fills both of its hours")
    def _():
        # aSc draws a double period as one merged cell. Reading it as a single
        # hour leaves the second one looking free, so assert that the pattern
        # the source actually contains survives the import.
        doubles = 0
        for name, g in groups.items():
            by_slot = {(l["d"], l["p"]): l for l in g["lessons"]}
            for (d, p), l in by_slot.items():
                nxt = by_slot.get((d, p + 1))
                if nxt and nxt["subject"] == l["subject"] \
                        and nxt.get("teacher") == l.get("teacher"):
                    doubles += 1
        assert doubles >= 13, \
            "only %d consecutive same-subject pairs — merged cells look dropped" % doubles

    @check("every class that actually meets says which room it is in")
    def _():
        # The school's noticeboard gives a home classroom to every section and
        # every orientation group, so those must have one the moment they have
        # an hour. A «κόντρα» elective with no hour this week has nowhere to be
        # yet; and a group split off a class (Γαλλικά, a τμήμα ένταξης) has no
        # room of its own because it sits in the class's — the app resolves it
        # through `parent`, so what must hold for those is that the parent has
        # one. A lesson with no room at all is the bug this guards against.
        homed = ("section", "track")
        missing = sorted(n for n, g in groups.items()
                         if not g["hidden"] and g["lessons"]
                         and g["kind"] in homed and not g.get("room"))
        assert not missing, "no room for %s — add them to aliases.json groupRooms" \
            % ", ".join(missing)
        for name, g in groups.items():
            if g["hidden"] or g.get("room") or not g.get("parent"):
                continue
            assert groups[g["parent"]].get("room"), \
                "%s has no room and neither does %s, the class it sits in" \
                % (name, g["parent"])
        blank = sorted(n for n, g in groups.items()
                       if not g["hidden"] and not g.get("room") and not g.get("parent"))
        if blank:
            print("    note: no room on the noticeboard yet for %s" % ", ".join(blank))

    @check("a group tied to a class names the class it is tied to")
    def _():
        # Both kinds lean on `parent`. A «parallel» group takes the place of its
        # class's lesson; a «coteach» group adds a second teacher to it and is
        # never offered in the picker. Either way, a wrong or missing parent
        # makes the app delete the wrong lesson or quietly stop merging, and
        # neither shows up as an error — so pin the link down here.
        for name, g in groups.items():
            if not (g.get("parallel") or g.get("coteach")):
                continue
            assert not (g.get("parallel") and g.get("coteach")), \
                "%s cannot both replace its class's hour and sit in on it" % name
            parent = g.get("parent")
            assert parent, "%s is tied to a class but names none" % name
            assert parent in groups, "%s is tied to %s, which has no page" \
                % (name, parent)
            assert groups[parent]["grade"] == g["grade"], \
                "%s is %s΄ but is tied to %s΄ %s" \
                % (name, g["grade"], groups[parent]["grade"], parent)
        live = sorted(n for n, g in groups.items()
                      if g.get("parallel") and g["lessons"])
        if live:
            print("    note: groups that replace their class's hour: %s"
                  % ", ".join(live))

    @check("a τμήμα ένταξης is named and roomed through its class")
    def _():
        # The app merges a coteach group's teacher into the class's own lesson,
        # and where the class has no lesson at all the hour still runs — with
        # the ενισχυτική teacher alone. Either way the name needs a label the
        # student can read, or a second name appears with nothing to explain it.
        alone = []
        for name, g in groups.items():
            if not g.get("coteach"):
                continue
            assert not g.get("room"), \
                "%s has a room of its own, but it sits in the class's room" % name
            assert g.get("name"), "%s joins a lesson under no name" % name
            held = {(l["d"], l["p"]) for l in groups[g["parent"]]["lessons"]}
            alone += ["%s %s.%d" % (name, data["days"][l["d"]], l["p"])
                      for l in g["lessons"] if (l["d"], l["p"]) not in held]
        if alone:
            print("    note: hours that run with the ενισχυτική teacher alone: %s"
                  % ", ".join(alone))

    @check("every orientation has exactly one «κόντρα» subject to pick from")
    def _():
        # The school pairs the two: Ανθρωπιστικών sit Μαθηματικά, everyone else
        # Ιστορία, and the picker shows only the matching groups. A track left
        # out of the map is offered everything — tolerable — but a map that
        # points at a subject with no groups leaves a whole orientation with an
        # empty list, and a κόντρα subject no track asks for is a group nobody
        # can reach. Neither looks like a broken table from the app; they look
        # like missing data.
        pairs = data.get("kontraByTrack", {})
        offered = {g["track"] for g in kontra.values() if not g["hidden"]}
        if not offered:
            return
        for track, wants in pairs.items():
            assert wants in offered, \
                "«%s» sit «%s», which has no group on offer" % (track, wants)
        picked = {v for k, v in pairs.items()
                  if any(g["track"] == k and g["grade"] == "Γ" for g in tracks.values())}
        assert offered <= picked, \
            "no orientation sits %s — nobody can reach those groups" \
            % ", ".join(sorted(offered - picked))
        loose = sorted(g["track"] for g in tracks.values()
                       if g["grade"] == "Γ" and not g["hidden"] and g["track"] not in pairs)
        if loose:
            print("    note: orientations offered every κόντρα group: %s"
                  % ", ".join(sorted(set(loose))))

    @check("every group is classified and grade-tagged")
    def _():
        for name, g in groups.items():
            assert g["kind"] in ("section", "track", "kontra", "extra"), \
                "%s has kind %r" % (name, g["kind"])
            assert g["grade"] in ("Α", "Β", "Γ"), "%s has grade %r" % (name, g["grade"])

    @check("subject names are normalised, not raw PDF text")
    def _():
        bad = set()
        for g in groups.values():
            for l in g["lessons"]:
                s = l["subject"]
                # Leftovers of the PDF's line-wrapping and its typo.
                if re.search(r"[α-ωά-ώ][ΑΒΓΔ-Ω]", s) or "Μαιθ" in s or s.endswith((" Α", " Β", " Γ")):
                    bad.add(s)
        assert not bad, "un-normalised: %s" % ", ".join(sorted(bad))

    @check("rooms referenced by lessons are all described")
    def _():
        used = {l["room"] for g in groups.values() for l in g["lessons"] if l.get("room")}
        missing = used - set(data.get("rooms", {}))
        assert not missing, "no description for %s" % ", ".join(sorted(missing))

    @check("the tracks a student can pick actually cover the section's gaps")
    def _():
        # A Β'/Γ' section leaves periods free for its orientation track. If a
        # track stopped filling them, students would see a half-empty week.
        for grade in ("Β", "Γ"):
            secs = [g for g in sections.values()
                    if g["grade"] == grade and not g["hidden"]]
            trs = [g for g in tracks.values()
                   if g["grade"] == grade and not g["hidden"]]
            if not secs or not trs:
                continue
            for track in trs:
                assert len(track["lessons"]) >= 3, \
                    "track %s only has %d lessons" % (track["label"], len(track["lessons"]))

    failed = 0
    for ok, name in results:
        if not ok:
            failed += 1
        print("  %s %s" % ("✓" if ok else "✗", name))
    print("\n%d/%d passed" % (len(results) - failed, len(results)))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else DEFAULT))
