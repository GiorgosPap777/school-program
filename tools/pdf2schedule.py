#!/usr/bin/env python3
"""Convert an aSc Timetables PDF export into the app's schedule.json.

Pure standard library — no pip install required.

    python3 tools/pdf2schedule.py "Programma.pdf" -o data/schedule.json \
        --version 2026-09-14 --valid-from 2026-09-14 --valid-to 2026-09-18

Writes schedule.json plus a human-readable report next to it. Read the report
after every run: it lists anything the converter did not recognise, which is
where a silently-wrong timetable would otherwise come from.
"""

import argparse
import json
import os
import re
import sys
import zlib
from collections import defaultdict
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
SCHEMA_VERSION = 1

# aSc writes some class labels with Latin lookalike letters (B5 vs Β5), which
# makes two spellings of the same group. Fold Latin onto Greek everywhere.
LATIN_TO_GREEK = str.maketrans("ABEZHIKMNOPTXY", "ΑΒΕΖΗΙΚΜΝΟΡΤΧΥ")

DAY_NAMES = ["Δευτέρα", "Τρίτη", "Τετάρτη", "Πέμπτη", "Παρασκευή"]
N_DAYS = 5
N_PERIODS = 7

SUBJECT_MIN_SIZE = 20.0          # anything this big is subject text
ROOM_RE = re.compile(r"^[Α-ΩΆΈΉΊΌΎΏ]{2,3}$")   # room codes look like ΕΠ / ΕΦΕ
GRADE_SUFFIX_RE = re.compile(r"\s*[ΑΒΓ]$")     # trailing grade letter on subjects


class ConversionError(Exception):
    pass


# --------------------------------------------------------------------------
# Minimal PDF reader: objects, streams, page tree, ToUnicode CMaps
# --------------------------------------------------------------------------

class Pdf:
    def __init__(self, data: bytes):
        self.data = data
        self.objects = {}
        for m in re.finditer(rb"(\d+)\s+(\d+)\s+obj\b", data):
            end = data.find(b"endobj", m.end())
            if end != -1:
                self.objects[int(m.group(1))] = data[m.end():end]

    def body(self, num: int) -> bytes:
        if num not in self.objects:
            raise ConversionError("PDF object %d not found" % num)
        return self.objects[num]

    def stream(self, num: int) -> bytes:
        body = self.body(num)
        start = body.find(b"stream")
        if start == -1:
            raise ConversionError("object %d has no stream" % num)
        header = body[:start]
        pos = start + len("stream")
        while body[pos:pos + 1] in (b"\r", b"\n"):
            pos += 1
        raw = body[pos:body.rfind(b"endstream")]
        if b"FlateDecode" in header:
            try:
                return zlib.decompress(raw)
            except zlib.error:
                return zlib.decompressobj().decompress(raw)
        return raw

    def find_root_pages(self) -> int:
        """Locate the /Pages object via /Catalog rather than assuming a number."""
        for num, body in self.objects.items():
            if b"/Type /Catalog" in body or b"/Type/Catalog" in body:
                m = re.search(rb"/Pages\s+(\d+)\s+0\s+R", body)
                if m:
                    return int(m.group(1))
        for num, body in self.objects.items():
            if b"/Type /Pages" in body or b"/Type/Pages" in body:
                return num
        raise ConversionError("could not locate the PDF page tree")

    def page_objects(self) -> list:
        """Return page object numbers in document order, following /Kids."""
        order = []
        seen = set()

        def walk(num):
            if num in seen:
                return
            seen.add(num)
            body = self.body(num).decode("latin-1")
            if "/Type /Page" in body and "/Type /Pages" not in body:
                order.append(num)
                return
            kids = re.search(r"/Kids\s*\[(.*?)\]", body, re.S)
            if not kids:
                return
            for ref in re.findall(r"(\d+)\s+0\s+R", kids.group(1)):
                walk(int(ref))

        walk(self.find_root_pages())
        return order


def parse_cmap(text: str) -> dict:
    """Build CID -> unicode from a ToUnicode CMap stream."""
    cmap = {}
    for block in re.finditer(r"beginbfchar(.*?)endbfchar", text, re.S):
        for m in re.finditer(r"<([0-9A-Fa-f]{4})>\s*<([0-9A-Fa-f]+)>", block.group(1)):
            dst = m.group(2)
            cmap[int(m.group(1), 16)] = "".join(
                chr(int(dst[i:i + 4], 16)) for i in range(0, len(dst), 4)
            )
    for block in re.finditer(r"beginbfrange(.*?)endbfrange", text, re.S):
        for m in re.finditer(
            r"<([0-9A-Fa-f]{4})>\s*<([0-9A-Fa-f]{4})>\s*<([0-9A-Fa-f]{4})>", block.group(1)
        ):
            lo, hi, dst = (int(m.group(i), 16) for i in (1, 2, 3))
            for i in range(lo, hi + 1):
                cmap[i] = chr(dst + i - lo)
    return cmap


def page_fonts(pdf: Pdf, page_num: int) -> dict:
    """Map font resource name (e.g. 'F1') -> its ToUnicode cmap dict."""
    body = pdf.body(page_num).decode("latin-1")
    res_match = re.search(r"/Resources\s+(\d+)\s+0\s+R", body)
    res = pdf.body(int(res_match.group(1))).decode("latin-1") if res_match else body

    fonts = {}
    font_block = re.search(r"/Font\s*<<(.*?)>>", res, re.S)
    if not font_block:
        return fonts
    for name, ref in re.findall(r"/(\w+)\s+(\d+)\s+0\s+R", font_block.group(1)):
        font_body = pdf.body(int(ref)).decode("latin-1")
        tu = re.search(r"/ToUnicode\s+(\d+)\s+0\s+R", font_body)
        if tu:
            fonts[name] = parse_cmap(pdf.stream(int(tu.group(1))).decode("latin-1"))
    return fonts


# The text operators aSc emits: a Tf sets the font/size, a Tm sets the matrix,
# then a TJ array of hex strings carries the glyph IDs.
TEXT_RE = re.compile(
    r"/(\w+)\s+([\d.]+)\s+Tf\s+.*?"
    r"([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+Tm\s+"
    r"\[(.*?)\]\s*TJ",
    re.S,
)


def extract_items(pdf: Pdf, page_num: int):
    """Return ([{x, y, size, text}], raw content stream) for one page."""
    body = pdf.body(page_num).decode("latin-1")
    contents = re.search(r"/Contents\s*\[?\s*(\d+)\s+0\s+R", body)
    if not contents:
        return [], ""
    content = pdf.stream(int(contents.group(1))).decode("latin-1")
    fonts = page_fonts(pdf, page_num)

    items = []
    for m in TEXT_RE.finditer(content):
        font, size = m.group(1), float(m.group(2))
        a, b = float(m.group(3)), float(m.group(4))
        x, y = float(m.group(7)), float(m.group(8))
        # Rotated runs (the day labels down the left edge) use a different
        # matrix and land far off-canvas; the grid text is all axis-aligned.
        if abs(a - 1.0) > 0.01 or abs(b) > 0.01:
            continue
        cmap = fonts.get(font, {})
        text = "".join(
            cmap.get(int(h[i:i + 4], 16), "�")
            for h in re.findall(r"<([0-9A-Fa-f]+)>", m.group(9))
            for i in range(0, len(h), 4)
        )
        if text.strip():
            items.append({"x": x, "y": y, "size": size, "text": text})
    return items, content


# --------------------------------------------------------------------------
# Grid geometry — read from the ruled lines aSc draws, never hardcoded
# --------------------------------------------------------------------------

TIME_RE = re.compile(r"^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$")

# A ruled grid line: "x1 y1 m / x2 y2 l / S".
LINE_RE = re.compile(
    r"([-\d.]+)\s+([-\d.]+)\s+m\s*\n([-\d.]+)\s+([-\d.]+)\s+l\s*\nS"
)


def grid_lines(content: str):
    """Return (horizontal ys, vertical xs) of the ruled table, both sorted.

    The table borders are the only stroked lines on an aSc page, so the cell
    boundaries come straight out of the drawing commands. That beats guessing
    from text positions, which breaks on pages where most cells are empty.
    """
    horiz, vert = set(), set()
    for x1, y1, x2, y2 in LINE_RE.findall(content):
        x1, y1, x2, y2 = float(x1), float(y1), float(x2), float(y2)
        if abs(y1 - y2) < 0.5 and abs(x1 - x2) > 1:
            horiz.add(round(y1, 2))
        elif abs(x1 - x2) < 0.5 and abs(y1 - y2) > 1:
            vert.add(round(x1, 2))
    return sorted(horiz), sorted(vert)


def cell_bounds(content: str):
    """Return ([day row (lo, hi)], [period column (lo, hi)], header y band).

    Layout: the first horizontal pair is the header band holding the period
    numbers and times; the remaining pairs are the day rows. The first vertical
    pair is the narrow day-name column; the rest are the period columns.
    """
    horiz, vert = grid_lines(content)
    if len(horiz) < 3 or len(vert) < 3:
        raise ConversionError(
            "could not find the ruled grid (%d horizontal, %d vertical lines)"
            % (len(horiz), len(vert))
        )
    header = (horiz[0], horiz[1])
    rows = list(zip(horiz[1:-1], horiz[2:]))
    cols = list(zip(vert[1:-1], vert[2:]))
    return rows, cols, header


def read_periods(items: list, cols: list, header: tuple) -> list:
    """Read the period start/end times out of the header band."""
    periods = [None] * len(cols)
    for it in items:
        m = TIME_RE.match(it["text"])
        if not m or not (header[0] <= it["y"] <= header[1]):
            continue
        idx = bucket(it["x"], cols)
        if idx is None:
            continue
        periods[idx] = {
            "n": idx + 1,
            "start": "%02d:%02d" % (int(m.group(1)), int(m.group(2))),
            "end": "%02d:%02d" % (int(m.group(3)), int(m.group(4))),
        }
    return periods


def bucket(value: float, bounds: list):
    for i, (lo, hi) in enumerate(bounds):
        if lo <= value < hi:
            return i
    return None


# --------------------------------------------------------------------------
# Normalisation
# --------------------------------------------------------------------------

def collapse(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def normalise_label(label: str) -> str:
    return collapse(label).translate(LATIN_TO_GREEK)


class Normaliser:
    def __init__(self, aliases: dict, report):
        self.subjects = {collapse(k): v for k, v in aliases["subjects"].items()
                         if not k.startswith("_")}
        self.short = {k: v for k, v in aliases["subjectShort"].items()
                      if not k.startswith("_")}
        self.rooms = {k: v for k, v in aliases["rooms"].items() if not k.startswith("_")}
        self.hidden_rooms = set(aliases.get("hideRooms", {}).get("labels", []))
        self.teachers = {collapse(k): v for k, v in aliases["teachers"].items()
                         if not k.startswith("_")}
        self.rules = aliases["groupRules"]["rules"]
        self.overrides = {k: v for k, v in aliases["groupOverrides"].items()
                          if not k.startswith("_")}
        self.excluded = set(aliases.get("excludeGroups", {}).get("labels", []))
        self.report = report

    def subject(self, raw: str) -> str:
        text = collapse(raw)
        if text in self.subjects:
            return self.subjects[text]
        # Strip the grade letter aSc appends ("Άλγεβρα Α" -> "Άλγεβρα"), which
        # is redundant once the student has picked their class.
        stripped = collapse(GRADE_SUFFIX_RE.sub("", text))
        if stripped in self.subjects:
            return self.subjects[stripped]
        if stripped:
            self.report.unknown_subjects.add(stripped)
        return stripped or text

    def teacher(self, raw: str):
        text = collapse(raw)
        if not text:
            return None
        return self.teachers.get(text, text)

    def room(self, code: str):
        if not code:
            return None
        if code in self.hidden_rooms:
            # A room the school does not really use: drop it rather than show a
            # place nobody goes. Counted in the report so the choice stays visible.
            self.report.dropped_rooms[code] = self.report.dropped_rooms.get(code, 0) + 1
            return None
        if code not in self.rooms:
            self.report.unknown_rooms.add(code)
        return code

    def classify(self, label: str) -> dict:
        if label in self.overrides:
            return dict(self.overrides[label])
        for rule in self.rules:
            m = re.match(rule["re"], label)
            if not m:
                continue
            info = {k: v for k, v in rule.items() if k not in ("re", "parent")}
            if "parent" in rule:
                info["parent"] = m.group(rule["parent"])
                info.setdefault("grade", info["parent"][0])
            return info
        self.report.unclassified_groups.add(label)
        return {"grade": label[0] if label else "?", "kind": "extra"}


class Report:
    def __init__(self):
        self.unknown_subjects = set()
        self.unknown_rooms = set()
        self.unclassified_groups = set()
        self.warnings = []
        self.collisions = []
        self.empty = []
        self.excluded = []
        self.dropped_rooms = {}

    def ok(self) -> bool:
        return not (self.unknown_subjects or self.unclassified_groups or self.warnings)

    def render(self, groups: dict) -> str:
        lines = ["Αναφορά μετατροπής PDF -> schedule.json", "=" * 46, ""]
        lines.append("Ομάδες: %d συνολικά, %d με μαθήματα"
                     % (len(groups), sum(1 for g in groups.values() if g["lessons"])))
        by_kind = defaultdict(list)
        for name, g in sorted(groups.items()):
            by_kind[g["kind"]].append("%s(%d)" % (name, len(g["lessons"])))
        for kind in ("section", "track", "kontra", "extra"):
            if by_kind[kind]:
                lines.append("  %-8s %s" % (kind + ":", ", ".join(by_kind[kind])))

        def section(title, values):
            lines.append("")
            if values:
                lines.append("%s (%d):" % (title, len(values)))
                lines.extend("  - %s" % v for v in sorted(values))
            else:
                lines.append("%s: κανένα ✓" % title)

        section("ΑΓΝΩΣΤΑ ΜΑΘΗΜΑΤΑ (πρόσθεσέ τα στο tools/aliases.json)",
                self.unknown_subjects)
        section("ΑΓΝΩΣΤΟΙ ΚΩΔΙΚΟΙ ΑΙΘΟΥΣΑΣ", self.unknown_rooms)
        section("ΑΙΘΟΥΣΕΣ ΠΟΥ ΑΓΝΟΗΘΗΚΑΝ (hideRooms)",
                ["%s — σε %d μαθήματα" % (k, v)
                 for k, v in sorted(self.dropped_rooms.items())])
        section("ΑΤΑΞΙΝΟΜΗΤΕΣ ΟΜΑΔΕΣ", self.unclassified_groups)
        section("ΚΡΥΜΜΕΝΕΣ — ΧΩΡΙΣ ΜΑΘΗΜΑΤΑ (δεν εμφανίζονται στην εφαρμογή)",
                self.empty)
        section("ΚΡΥΜΜΕΝΕΣ — ΑΠΟΚΛΕΙΣΜΕΝΕΣ ΧΕΙΡΟΚΙΝΗΤΑ (excludeGroups)",
                self.excluded)
        section("ΠΡΟΕΙΔΟΠΟΙΗΣΕΙΣ", self.warnings)
        section("ΣΥΓΚΡΟΥΣΕΙΣ ΩΡΩΝ (γενικό x κατεύθυνση)", self.collisions)
        lines.append("")
        return "\n".join(lines)


# --------------------------------------------------------------------------
# Page -> group
# --------------------------------------------------------------------------

def parse_page(items: list, content: str, norm: Normaliser, report: Report):
    """Return (label, lessons, periods) for one timetable page."""
    rows, cols, header = cell_bounds(content)
    if len(rows) != N_DAYS:
        report.warnings.append("σελίδα με %d ημέρες αντί για %d" % (len(rows), N_DAYS))
    periods = read_periods(items, cols, header)
    if any(p is None for p in periods):
        raise ConversionError("period header row is incomplete")

    # The class label is the large text above the grid. The day names down the
    # left edge are drawn far larger still, so cap the size as well as the floor.
    label_items = sorted(
        (it for it in items if 40 < it["size"] < 100 and it["y"] < header[1]),
        key=lambda it: it["x"],
    )
    label = normalise_label(" ".join(it["text"] for it in label_items))
    if not label:
        return None, None, None

    cells = defaultdict(lambda: {"subject": [], "teacher": [], "room": []})
    for it in items:
        r, c = bucket(it["y"], rows), bucket(it["x"], cols)
        if r is None or c is None:
            continue
        if it["size"] >= SUBJECT_MIN_SIZE:
            kind = "subject"
        elif ROOM_RE.match(it["text"].strip()):
            # Long teacher names auto-shrink into the room-code size band, so
            # the shape of the text decides, not the font size alone.
            kind = "room"
        else:
            kind = "teacher"
        cells[(r, c)][kind].append(it)

    lessons = []
    for (r, c), parts in sorted(cells.items()):
        def joined(key, sep=""):
            ordered = sorted(parts[key], key=lambda it: (round(it["y"] / 6), it["x"]))
            return sep.join(it["text"] for it in ordered)

        subject_raw = joined("subject")
        if not subject_raw.strip():
            continue
        lessons.append({
            "d": r,
            "p": c + 1,
            "subject": norm.subject(subject_raw),
            "teacher": norm.teacher(joined("teacher", " ")),
            "room": norm.room(joined("room", " ").strip()),
        })
    return label, lessons, periods


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def build(pdf_path: str, args) -> tuple:
    with open(pdf_path, "rb") as fh:
        pdf = Pdf(fh.read())

    with open(os.path.join(HERE, "aliases.json"), encoding="utf-8") as fh:
        aliases = json.load(fh)

    report = Report()
    norm = Normaliser(aliases, report)

    groups = {}
    periods = None
    footer_date = None

    for page_num in pdf.page_objects():
        items, content = extract_items(pdf, page_num)
        if not items:
            continue
        if footer_date is None:
            for it in items:
                m = re.search(r"Δημιουργία Προγράμματος:\s*(\d{1,2})/(\d{1,2})/(\d{4})",
                              it["text"])
                if m:
                    footer_date = "%s-%02d-%02d" % (m.group(3), int(m.group(2)),
                                                    int(m.group(1)))
                    break
        label, lessons, page_periods = parse_page(items, content, norm, report)
        if label is None:
            continue
        if periods is None:
            periods = page_periods
        elif page_periods != periods:
            report.warnings.append("η σελίδα «%s» έχει διαφορετικές ώρες" % label)
        if label in groups:
            report.warnings.append("διπλή σελίδα για την ομάδα «%s»" % label)
            groups[label]["lessons"].extend(lessons)
            continue
        info = norm.classify(label)
        # A page with no lessons is a group nobody attends; the app never offers
        # one. Keep it in the file so a later revision that fills it just works.
        excluded = label in norm.excluded
        if excluded:
            report.excluded.append(label)
        elif not lessons:
            report.empty.append(label)
        groups[label] = {
            "label": label,
            "grade": info.get("grade"),
            "kind": info.get("kind", "extra"),
            "track": info.get("track"),
            "name": info.get("name"),
            "parent": info.get("parent"),
            "hidden": excluded or not lessons,
            "lessons": lessons,
        }

    if not groups:
        raise ConversionError("no timetable pages recognised — is this an aSc export?")
    if periods is None:
        raise ConversionError("could not read the period header row")

    # Surface any slot where a section and a track both teach the student at
    # once. Zero is expected; anything else means the merge would hide a lesson.
    live = [g for g in groups.values() if not g["hidden"]]
    sections = [g for g in live if g["kind"] == "section"]
    overlays = [g for g in live if g["kind"] in ("track", "kontra")]
    for sec in sections:
        taken = {(l["d"], l["p"]): l["subject"] for l in sec["lessons"]}
        for ov in overlays:
            if ov["grade"] != sec["grade"]:
                continue
            for lesson in ov["lessons"]:
                key = (lesson["d"], lesson["p"])
                if key in taken:
                    report.collisions.append(
                        "%s + %s — %s ώρα %d: %s / %s"
                        % (sec["label"], ov["label"], DAY_NAMES[key[0]], key[1],
                           taken[key], lesson["subject"]))

    short = {k: v for k, v in aliases["subjectShort"].items() if not k.startswith("_")}
    used_subjects = {l["subject"] for g in groups.values() for l in g["lessons"]}
    rooms = {k: v for k, v in aliases["rooms"].items() if not k.startswith("_")}
    used_rooms = {l["room"] for g in groups.values() for l in g["lessons"] if l["room"]}

    schedule = {
        "schemaVersion": SCHEMA_VERSION,
        "version": args.version or footer_date or datetime.now().strftime("%Y-%m-%d"),
        "generatedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "sourceDate": footer_date,
        "validFrom": args.valid_from,
        "validTo": args.valid_to,
        "school": args.school,
        "sourceFile": os.path.basename(pdf_path),
        "days": DAY_NAMES,
        "periods": periods,
        "rooms": {k: v for k, v in rooms.items() if k in used_rooms},
        "subjectShort": {k: v for k, v in short.items() if k in used_subjects},
        "groups": dict(sorted(groups.items())),
    }
    return schedule, report


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pdf", help="the aSc Timetables PDF export")
    ap.add_argument("-o", "--output", default="data/schedule.json")
    ap.add_argument("--version", help="version stamp (default: the PDF's own date)")
    ap.add_argument("--valid-from", help="first day this schedule applies, YYYY-MM-DD")
    ap.add_argument("--valid-to", help="last day this schedule applies, YYYY-MM-DD")
    ap.add_argument("--school", default="7ο ΓΕΝΙΚΟ ΛΥΚΕΙΟ ΗΡΑΚΛΕΙΟΥ ΚΡΗΤΗΣ")
    ap.add_argument("--report", help="where to write the report "
                                     "(default: alongside the output)")
    args = ap.parse_args(argv)

    try:
        schedule, report = build(args.pdf, args)
    except ConversionError as exc:
        print("σφάλμα: %s" % exc, file=sys.stderr)
        return 2

    out_dir = os.path.dirname(os.path.abspath(args.output))
    os.makedirs(out_dir, exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as fh:
        json.dump(schedule, fh, ensure_ascii=False, indent=1)
        fh.write("\n")

    report_path = args.report or os.path.join(out_dir, "report.txt")
    text = report.render(schedule["groups"])
    with open(report_path, "w", encoding="utf-8") as fh:
        fh.write(text)

    print(text)
    print("Γράφτηκε: %s (έκδοση %s)" % (args.output, schedule["version"]))
    print("Αναφορά:  %s" % report_path)
    if not report.ok():
        print("\n⚠  Η αναφορά έχει ευρήματα — έλεγξέ τα πριν το ανεβάσεις.",
              file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
