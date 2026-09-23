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

# Every page carries a banner saying when the timetable starts, and sometimes
# when it stops: «ΩΡΟΛΟΓΙΟ ΠΡΟΓΡΑΜΜΑ ΑΠΟ 21-9-26», «... ΑΠΟ 14-9-26εως 18-9-26».
# Reading it here means the dates cannot be forgotten on the command line.
VALIDITY_RE = re.compile(r"ΑΠΟ\s*(\d{1,2})-(\d{1,2})-(\d{2,4})"
                         r"(?:\s*εως\s*(\d{1,2})-(\d{1,2})-(\d{2,4}))?")


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


# How close a stroked line has to be to a computed boundary to count as it.
LINE_TOL = 0.6


def column_spans(content: str, rows: list, cols: list) -> list:
    """Return spans[row][col] = (first_col, last_col) of the cell covering it.

    aSc draws a double period as one wide cell: the vertical rule between the
    two period columns is simply not stroked for that day. The lesson text is
    then centred across the pair and lands in whichever column it happens to
    start in, leaving the other looking like a free period. Reading the missing
    rules back out is what lets both periods be filled in.
    """
    segs = []
    for x1, y1, x2, y2 in LINE_RE.findall(content):
        x1, y1, x2, y2 = float(x1), float(y1), float(x2), float(y2)
        if abs(x1 - x2) < 0.5 and abs(y1 - y2) > 1:
            segs.append((x1, min(y1, y2), max(y1, y2)))

    spans = []
    for lo, hi in rows:
        breaks = [0]
        for j in range(len(cols) - 1):
            bx = cols[j][1]
            drawn = any(abs(x - bx) < LINE_TOL and y0 <= lo + LINE_TOL and y1 >= hi - LINE_TOL
                        for x, y0, y1 in segs)
            if drawn:
                breaks.append(j + 1)
        breaks.append(len(cols))
        row = [None] * len(cols)
        for start, stop in zip(breaks, breaks[1:]):
            for c in range(start, stop):
                row[c] = (start, stop - 1)
        spans.append(row)
    return spans


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


def iso_date(day: str, month: str, year: str) -> str:
    """'21', '9', '26' -> '2026-09-21'. aSc writes the year two digits wide."""
    y = int(year)
    return "%04d-%02d-%02d" % (y + 2000 if y < 100 else y, int(month), int(day))


def normalise_label(label: str) -> str:
    """Fold a class label onto a single spelling.

    Whoever types the timetable into aSc is not consistent about spaces, and it
    changes between exports: the same κόντρα group was «Γιστορια 3» in one
    revision and «Γ ιστορια 3» in the next. A space never carries meaning in a
    class label here, so drop them all and the two spellings become one group
    instead of two half-empty ones.
    """
    return re.sub(r"\s+", "", label).translate(LATIN_TO_GREEK)


GREEK_WORD_RE = re.compile(r"[Α-ΩΆΈΉΊΌΎΏ][Α-ΩΆΈΉΊΌΎΏα-ωάέήίόύώΐΰϊϋ]*")


def initials_of(name: str) -> set:
    """The 2- and 3-letter initial codes a teacher's name could be written as.

    In a merged cell aSc prints the teacher as initials instead of the full
    name — 'ΕΓ' for ΕΛΕΝΗ ΓΙΑΜΑΛΑΚΗ. They are the same shape as a room code,
    so they can only be told apart by looking them up.
    """
    words = GREEK_WORD_RE.findall(name)
    codes = set()
    if len(words) >= 2:
        codes.add(words[0][0] + words[1][0])
    if len(words) >= 3:
        codes.add(words[0][0] + words[1][0] + words[2][0])
    return codes


def resolve_initials(code: str, subject: str, lessons: list):
    """Match an initials code against the teachers on the same page.

    Narrowest pool first: a teacher who already teaches this exact subject to
    this class. Two teachers on one page can share initials (ΜΑΡΙΑ ΤΣΙΩΚΟΥ and
    ΜΑΡΙΑ ΤΣΑΓΚΑΡΑΚΗ are both 'ΜΤ'); which of them teaches Γλώσσα to Γ2 is not.
    """
    same_subject = {l["teacher"] for l in lessons
                    if l["teacher"] and l["subject"] == subject}
    page = {l["teacher"] for l in lessons if l["teacher"]}
    for pool in (same_subject, page):
        hits = sorted(t for t in pool if code in initials_of(t))
        if len(hits) == 1:
            return hits[0]
    return None


class Normaliser:
    def __init__(self, aliases: dict, report):
        self.subjects = {collapse(k): v for k, v in aliases["subjects"].items()
                         if not k.startswith("_")}
        self.short = {k: v for k, v in aliases["subjectShort"].items()
                      if not k.startswith("_")}
        self.rooms = {k: v for k, v in aliases["rooms"].items() if not k.startswith("_")}
        self.hidden_rooms = set(aliases.get("hideRooms", {}).get("labels", []))
        self.roomless = set(aliases.get("roomlessSubjects", {}).get("subjects", []))
        self.teachers = {collapse(k): v for k, v in aliases["teachers"].items()
                         if not k.startswith("_")}
        self.rules = aliases["groupRules"]["rules"]
        self.overrides = {k: v for k, v in aliases["groupOverrides"].items()
                          if not k.startswith("_")}
        self.excluded = set(aliases.get("excludeGroups", {}).get("labels", []))
        self.group_rooms = {k: v for k, v in aliases.get("groupRooms", {}).items()
                            if not k.startswith("_")}
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

    def is_room(self, code: str) -> bool:
        return code in self.rooms or code in self.hidden_rooms

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
        self.merged = []
        self.resolved_initials = set()
        self.empty_kontra = []
        self.roomless_groups = set()
        self.roomless_subjects = []
        self.retimed = []
        self.parallel = []
        self.coteach = []
        self.kontra_open = []
        self.validity = None

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
        section("ΜΑΘΗΜΑΤΑ ΧΩΡΙΣ ΑΙΘΟΥΣΑ — ΕΚΤΟΣ ΤΑΞΗΣ (roomlessSubjects)",
                self.roomless_subjects)
        section("ΑΙΘΟΥΣΕΣ ΠΟΥ ΑΓΝΟΗΘΗΚΑΝ (hideRooms)",
                ["%s — σε %d μαθήματα" % (k, v)
                 for k, v in sorted(self.dropped_rooms.items())])
        section("ΩΡΕΣ ΠΟΥ ΔΙΟΡΘΩΘΗΚΑΝ ΑΠΟ ΤΟ ΩΡΑΡΙΟ ΤΟΥ ΣΧΟΛΕΙΟΥ", self.retimed)
        section("ΕΝΩΜΕΝΑ ΚΕΛΙΑ — ΔΙΩΡΑ (γράφτηκαν και στις δύο ώρες)", self.merged)
        section("ΧΩΡΙΣΤΕΣ ΟΜΑΔΕΣ — ΑΝΤΙΚΑΘΙΣΤΟΥΝ ΤΗΝ ΩΡΑ ΤΟΥ ΤΜΗΜΑΤΟΣ",
                self.parallel)
        section("ΤΜΗΜΑΤΑ ΕΝΤΑΞΗΣ — ΔΕΥΤΕΡΟΣ ΚΑΘΗΓΗΤΗΣ ΣΤΗΝ ΙΔΙΑ ΩΡΑ",
                self.coteach)
        section("ΚΑΤΕΥΘΥΝΣΕΙΣ ΧΩΡΙΣ ΟΡΙΣΜΕΝΟ ΚΟΝΤΡΑ (τους προσφέρονται όλα)",
                self.kontra_open)
        section("ΑΡΧΙΚΑ ΚΑΘΗΓΗΤΩΝ ΠΟΥ ΑΝΑΓΝΩΡΙΣΤΗΚΑΝ", self.resolved_initials)
        section("ΑΤΑΞΙΝΟΜΗΤΕΣ ΟΜΑΔΕΣ", self.unclassified_groups)
        section("ΟΜΑΔΕΣ ΧΩΡΙΣ ΔΙΚΗ ΤΟΥΣ ΑΙΘΟΥΣΑ (πρόσθεσέ τες στο groupRooms όταν τη μάθεις)",
                self.roomless_groups)
        section("ΚΟΝΤΡΑ ΧΩΡΙΣ ΩΡΑ ΑΥΤΗ ΤΗΝ ΕΒΔΟΜΑΔΑ (εμφανίζονται κανονικά)",
                self.empty_kontra)
        section("ΚΡΥΜΜΕΝΕΣ — ΧΩΡΙΣ ΜΑΘΗΜΑΤΑ (δεν εμφανίζονται στην εφαρμογή)",
                self.empty)
        section("ΚΡΥΜΜΕΝΕΣ — ΑΠΟΚΛΕΙΣΜΕΝΕΣ ΧΕΙΡΟΚΙΝΗΤΑ (excludeGroups)",
                self.excluded)
        section("ΠΡΟΕΙΔΟΠΟΙΗΣΕΙΣ", self.warnings)
        section("ΣΥΓΚΡΟΥΣΕΙΣ ΩΡΩΝ (γενικό x κατεύθυνση)", self.collisions)
        lines.append("")
        lines.append("ΙΣΧΥΣ (από το banner του PDF): %s"
                     % (self.validity or "δεν βρέθηκε"))
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

    # A merged cell has no rule down its middle, so both of its period columns
    # belong to one lesson. Collect every item under the span's leftmost column.
    spans = column_spans(content, rows, cols)

    cells = defaultdict(lambda: {"subject": [], "teacher": [], "code": []})
    for it in items:
        r, c = bucket(it["y"], rows), bucket(it["x"], cols)
        if r is None or c is None:
            continue
        if it["size"] >= SUBJECT_MIN_SIZE:
            kind = "subject"
        elif ROOM_RE.match(it["text"].strip()):
            # Long teacher names auto-shrink into the short-code size band, so
            # the shape of the text decides, not the font size alone. Whether a
            # short code is a room or a teacher's initials is settled below.
            kind = "code"
        else:
            kind = "teacher"
        cells[(r, spans[r][c][0])][kind].append(it)

    # First pass: one record per cell, with full teacher names but short codes
    # left as written. Resolving those needs the whole page's teacher list.
    cooked = []
    for (r, c), parts in sorted(cells.items()):
        def joined(key, sep=""):
            ordered = sorted(parts[key], key=lambda it: (round(it["y"] / 6), it["x"]))
            return sep.join(it["text"] for it in ordered)

        subject_raw = joined("subject")
        if not subject_raw.strip():
            continue
        cooked.append({
            "d": r,
            "span": spans[r][c],
            "subject": norm.subject(subject_raw),
            "teacher": norm.teacher(joined("teacher", " ")),
            "code": joined("code", " ").strip(),
        })

    lessons = []
    for cell in cooked:
        room = None
        if cell["code"] and not cell["teacher"] and not norm.is_room(cell["code"]):
            who = resolve_initials(cell["code"], cell["subject"], cooked)
            if who:
                cell["teacher"] = who
                report.resolved_initials.add("%s = %s" % (cell["code"], who))
            else:
                report.warnings.append(
                    "«%s» %s ώρα %d: ο κωδικός «%s» δεν είναι ούτε αίθουσα "
                    "ούτε αρχικά καθηγητή" % (label, DAY_NAMES[cell["d"]],
                                              cell["span"][0] + 1, cell["code"]))
                room = norm.room(cell["code"])
        elif cell["code"]:
            room = norm.room(cell["code"])
        if room and cell["subject"] in norm.roomless:
            # Γυμναστική is in the προαύλιο. A room printed on such a cell is a
            # place the class is not, so it never reaches the file — but it is
            # worth a look, since it may mean the lesson has moved indoors.
            report.warnings.append(
                "«%s» %s ώρα %d: το %s δείχνει αίθουσα «%s» — δεν γράφτηκε "
                "(roomlessSubjects)" % (label, DAY_NAMES[cell["d"]],
                                        cell["span"][0] + 1, cell["subject"], room))
            room = None

        first, last = cell["span"]
        if last > first:
            report.merged.append("%s %s ώρες %d-%d: %s"
                                 % (label, DAY_NAMES[cell["d"]], first + 1, last + 1,
                                    cell["subject"]))
        # One lesson per period the cell spans, so a double period fills both
        # slots instead of leaving the second looking free.
        for c in range(first, last + 1):
            # Omit empty fields rather than writing nulls: it keeps the file
            # small and quick to parse on an old phone. The app already treats
            # a missing teacher or room the same as a null one.
            lesson = {"d": cell["d"], "p": c + 1, "subject": cell["subject"]}
            if cell["teacher"]:
                lesson["teacher"] = cell["teacher"]
            if room:
                lesson["room"] = room
            lessons.append(lesson)
    lessons.sort(key=lambda l: (l["d"], l["p"]))
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
    valid_from = valid_to = None

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
        if valid_from is None:
            for it in items:
                m = VALIDITY_RE.search(it["text"])
                if m:
                    valid_from = iso_date(m.group(1), m.group(2), m.group(3))
                    if m.group(4):
                        valid_to = iso_date(m.group(4), m.group(5), m.group(6))
                    report.validity = collapse(it["text"])
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
        kind = info.get("kind", "extra")
        # A page with no lessons is normally a group nobody attends. «Κόντρα»
        # electives are the exception: they are real classes that simply may
        # not meet in a given week, so they stay on offer. Hide one by name in
        # aliases.json -> excludeGroups if it genuinely does not exist.
        hidden = excluded or (not lessons and kind != "kontra")
        if excluded:
            report.excluded.append(label)
        elif hidden:
            report.empty.append(label)
        elif not lessons:
            report.empty_kontra.append(label)
        group = {
            "label": label,
            "grade": info.get("grade"),
            "kind": kind,
            "hidden": hidden,
            "lessons": lessons,
        }
        for key in ("track", "name", "shortName", "parent", "parallel", "coteach"):
            if info.get(key):
                group[key] = info[key]
        room = norm.group_rooms.get(label)
        if room:
            group["room"] = room
        elif not hidden:
            # A τμήμα ένταξης needs no room of its own: nobody moves, so the app
            # reads the class's. A split group does move, and until the school
            # says where, its hours show no room at all — worth saying which
            # kind this is, because only one of them leaves a blank on screen.
            report.roomless_groups.add(
                "%s — %s" % (label, "παίρνει την αίθουσα του %s" % info["parent"]
                             if info.get("coteach") else
                             "οι ώρες της εμφανίζονται χωρίς αίθουσα"))
        groups[label] = group

    if not groups:
        raise ConversionError("no timetable pages recognised — is this an aSc export?")
    if periods is None:
        raise ConversionError("could not read the period header row")

    # The times in the aSc header are the ones whoever built the timetable typed
    # in, and this school's bell does not follow them. The official ωράριο wins,
    # but any disagreement is reported so nobody has to notice it by being late.
    official = aliases.get("periodTimes", {}).get("times")
    if official:
        if len(official) != len(periods):
            report.warnings.append(
                "το periodTimes έχει %d ώρες, το PDF %d — αγνοήθηκε"
                % (len(official), len(periods)))
        else:
            for i, (start, end) in enumerate(official):
                was = periods[i]
                if (was["start"], was["end"]) != (start, end):
                    report.retimed.append(
                        "%dη ώρα: PDF %s-%s -> ωράριο σχολείου %s-%s"
                        % (i + 1, was["start"], was["end"], start, end))
                periods[i] = {"n": i + 1, "start": start, "end": end}

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

    # A «parallel» group splits the class for one subject: its students spend
    # that hour with a different teacher. The app keeps the split group's lesson
    # and drops the section's, so every swap is listed here — a careless rule in
    # aliases.json would otherwise quietly delete real lessons.
    #
    # A «coteach» group does not split anything: the τμήμα ένταξης teacher walks
    # into the same room for that hour, so the app only adds their name to the
    # class's own lesson. An hour where the class has nothing scheduled is
    # therefore nothing the app can show, and is listed here to be noticed.
    by_label = {g["label"]: g for g in groups.values()}
    for g in live:
        if not (g.get("parallel") or g.get("coteach")):
            continue
        parent = by_label.get(g.get("parent") or "")
        if parent is None:
            report.warnings.append(
                "η ομάδα «%s» δείχνει σε τμήμα που λείπει" % g["label"])
            continue
        taken = {(l["d"], l["p"]): l for l in parent["lessons"]}
        for lesson in g["lessons"]:
            was = taken.get((lesson["d"], lesson["p"]))
            if g.get("coteach"):
                report.coteach.append(
                    "%s %s ώρα %d: %s %s"
                    % (g["label"], DAY_NAMES[lesson["d"]], lesson["p"],
                       lesson["teacher"] or "χωρίς καθηγητή",
                       "μαζί με %s (%s)" % (was["teacher"] or "—", was["subject"])
                       if was else
                       "— μόνος του, το %s δεν έχει μάθημα αυτή την ώρα"
                       % parent["label"]))
            else:
                report.parallel.append(
                    "%s %s ώρα %d: %s αντί για %s"
                    % (g["label"], DAY_NAMES[lesson["d"]], lesson["p"],
                       lesson["subject"],
                       was["subject"] if was else "κενό — πρόσθετη ώρα"))

    # Which «κόντρα» goes with which orientation. Checked against the groups
    # that actually came out of this PDF: a typo here would quietly leave a
    # whole orientation with nothing to pick, which looks like missing data
    # rather than a wrong table.
    kontra_by_track = {k: v for k, v in aliases.get("kontraByTrack", {}).items()
                       if not k.startswith("_")}
    track_names = {g.get("track") for g in live if g["kind"] == "track"}
    kontra_names = {g.get("track") for g in live if g["kind"] == "kontra"}
    for track, wants in sorted(kontra_by_track.items()):
        if track not in track_names:
            report.warnings.append(
                "το kontraByTrack δείχνει κατεύθυνση «%s» που δεν υπάρχει" % track)
        elif wants not in kontra_names:
            report.warnings.append(
                "η κατεύθυνση «%s» ζητά κόντρα «%s», που δεν έχει καμία ομάδα"
                % (track, wants))
    for track in sorted(n for n in track_names if n and n not in kontra_by_track):
        report.kontra_open.append(track)

    short = {k: v for k, v in aliases["subjectShort"].items() if not k.startswith("_")}
    used_subjects = {l["subject"] for g in groups.values() for l in g["lessons"]}

    # Subjects with nowhere to name. The app needs the list too: dropping the
    # room here is not enough, because it would otherwise fall back to the
    # class's home room and send the student indoors.
    roomless = [s for s in aliases.get("roomlessSubjects", {}).get("subjects", [])
                if not s.startswith("_")]
    for name in roomless:
        if name not in used_subjects:
            report.warnings.append(
                "το roomlessSubjects έχει μάθημα «%s» που δεν διδάσκεται πουθενά"
                % name)
    report.roomless_subjects = [s for s in roomless if s in used_subjects]
    rooms = {k: v for k, v in aliases["rooms"].items() if not k.startswith("_")}
    used_rooms = {l["room"] for g in groups.values() for l in g["lessons"] if l.get("room")}

    schedule = {
        "schemaVersion": SCHEMA_VERSION,
        "version": args.version or footer_date or datetime.now().strftime("%Y-%m-%d"),
        "generatedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "sourceDate": footer_date,
        "validFrom": args.valid_from or valid_from,
        "validTo": args.valid_to or valid_to,
        "school": args.school,
        "sourceFile": os.path.basename(pdf_path),
        "days": DAY_NAMES,
        "periods": periods,
        "rooms": {k: v for k, v in rooms.items() if k in used_rooms},
        "subjectShort": {k: v for k, v in short.items() if k in used_subjects},
        "kontraByTrack": kontra_by_track,
        "roomlessSubjects": report.roomless_subjects,
        "groups": dict(sorted(groups.items())),
    }
    return schedule, report


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pdf", help="the aSc Timetables PDF export")
    ap.add_argument("-o", "--output", default="data/schedule.json")
    ap.add_argument("--version", help="version stamp (default: the PDF's own date)")
    ap.add_argument("--valid-from", help="override the «ΑΠΟ …» banner in the PDF")
    ap.add_argument("--valid-to", help="override the «… εως …» banner in the PDF")
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
