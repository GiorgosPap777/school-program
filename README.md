# Ωρολόγιο Πρόγραμμα — 7ο ΓΕΛ Ηρακλείου Κρήτης

A mobile-first PWA that merges a student's **general section**, **orientation track**
and **elective groups** into one timetable, and highlights the period that is
running right now. Works offline once loaded, installs to the home screen on both
iOS and Android, and picks up new schedule revisions without an app rewrite.

The school publishes its timetable as a 49-page aSc Timetables PDF where a single
student's week is spread across three separate pages. This app does that merge for
them.

---

## Running it

There is no build step. Any static file server works:

```bash
python3 -m http.server 8080
```

Then open <http://localhost:8080>. For a real install prompt and offline support
the page must be served over `https://` or from `localhost` — service workers are
disabled on plain `http://` to any other host.

### Docker

```bash
docker run -d -p 127.0.0.1:8080:80 --name programma giorgospap777/school-program
```

Or `docker compose up -d` with the bundled `docker-compose.yml`. The image is
nginx plus the static app, and already sends the cache headers described below —
your outer proxy only has to avoid overriding them.

The schedule is baked in at build time. To publish a new one without rebuilding,
mount over it:

```bash
docker run -d -p 127.0.0.1:8080:80 \
  -v "$PWD/data/schedule.json:/usr/share/nginx/html/data/schedule.json:ro" \
  giorgospap777/school-program
```

The published image is multi-arch (`linux/amd64` + `linux/arm64`), so it runs on
a normal server or on a Raspberry Pi / ARM VPS without changes. The repository is
private, so the host needs `docker login` before it can pull.

Rebuild after a schedule import with:

```bash
docker build -t giorgospap777/school-program .
```

To publish both architectures (the Dockerfile has no `RUN` steps, so this
cross-builds with no emulation):

```bash
docker buildx create --name multiarch --driver docker-container --use
docker buildx build --platform linux/amd64,linux/arm64 -t giorgospap777/school-program:latest --push .
```

### Deploying behind a reverse proxy

Copy the whole folder to the host and point the proxy at it as static files.
Every path in the app is relative, so it works at the domain root **or** under a
subpath (`https://school.gr/programma/`) with no changes.

Four things the proxy has to get right:

1. **HTTPS.** Service workers only register on `https://` or `localhost`. Without
   it there is no offline mode and no install prompt — the rest still works.
2. **Don't let `sw.js` or `index.html` be cached for long.** A stale service
   worker means students never receive updates. Send `Cache-Control: no-cache`
   for both; the fingerprinted-by-version shell cache handles the rest.
3. **Don't proxy-cache `data/schedule.json`,** or schedule updates will stall
   behind the proxy's TTL rather than reaching students.
4. **Redirect a subpath without its trailing slash.** `/programma` must redirect
   to `/programma/`, otherwise relative paths resolve one level too high.

nginx:

```nginx
location = /programma { return 301 /programma/; }

location /programma/ {
    alias /srv/programma/;
    try_files $uri $uri/ /programma/index.html;

    location ~ ^/programma/(sw\.js|index\.html)$ {
        add_header Cache-Control "no-cache";
    }
    location = /programma/data/schedule.json {
        add_header Cache-Control "no-cache";
    }
}
```

Caddy:

```caddyfile
school.gr {
    redir /programma /programma/ 301
    handle_path /programma/* {
        root * /srv/programma
        header /sw.js Cache-Control "no-cache"
        header /index.html Cache-Control "no-cache"
        header /data/schedule.json Cache-Control "no-cache"
        file_server
    }
}
```

**When you change `index.html`, `app.css`, `app.js` or `sw.js`, bump
`APP_VERSION` in _both_ `app.js` and `sw.js`.** The shell cache is keyed on it,
so without a bump the old files stay cached on every installed phone.
`node tools/test/sw.test.mjs` fails if the two drift apart.

---

## Updating the schedule (4–5× per year)

1. Drop the new PDF into the project folder.
2. Regenerate the data:

   ```bash
   python3 tools/pdf2schedule.py "NewProgramme.pdf" -o data/schedule.json --version 2026-11-02 --valid-from 2026-11-02 --valid-to 2026-11-06
   ```

3. **Read `data/report.txt`.** It lists unknown subjects, unclassified groups,
   merged double periods, teacher initials it resolved, hours it corrected
   against the school's ωράριο, groups with no classroom, and any timetable
   collisions. A clean report means the import is trustworthy; if something is
   listed, add it to `tools/aliases.json` and re-run.
4. Check the invariants still hold:

   ```bash
   python3 tools/test/schedule.test.py
   ```

5. Publish. Either redeploy the folder, or — if you set `REMOTE_SCHEDULE_URL`
   (see below) — just push the new `data/schedule.json` to that location and every
   installed app will offer the update on its next launch.

`--version` defaults to the creation date printed in the PDF footer, so it can
usually be omitted.

### Publishing updates without redeploying

Set one constant at the top of `app.js`:

```js
const REMOTE_SCHEDULE_URL = 'https://raw.githubusercontent.com/<user>/<repo>/main/data/schedule.json';
```

The app then compares that file's `version` / `generatedAt` against what it has
cached, and shows a «Νέο πρόγραμμα» banner when something newer appears. The
student taps to apply it — the timetable never changes underneath them mid-look.
A payload that fails validation is refused and the last good schedule is kept.

---

## Layout

```
index.html                app shell (Greek UI)
app.css                   mobile-first styles, light + dark, safe-area aware
app.js                    picker, merge, live highlighting, update checks
sw.js                     service worker — cache-first shell, network-first data
manifest.webmanifest
data/schedule.json        the only file that changes per revision
data/report.txt           import report, regenerated with the data
icons/                    generated PNG icon set
tools/pdf2schedule.py     PDF → schedule.json
tools/aliases.json        subject / room / group normalisation tables
tools/make_icons.py       regenerates icons/
tools/test/               tests and fixtures
```

Everything is standard library / plain browser APIs. No npm, no pip, no bundler.

---

## Data model

`data/schedule.json` is the contract between the converter and the app:

```jsonc
{
  "schemaVersion": 1,
  "version": "2026-09-14",               // compared for update detection
  "generatedAt": "2026-09-16T11:20:39+00:00",
  "sourceDate": "2026-09-11",            // the date printed in the PDF footer
  "validFrom": "2026-09-14", "validTo": "2026-09-18",
  "days": ["Δευτέρα", "…"],
  "periods": [{ "n": 1, "start": "08:10", "end": "08:55" }],
  "rooms": { "ΕΠ": "Εργαστήριο Πληροφορικής" },
  "subjectShort": { "Μαθηματικά Προσανατολισμού": "Μαθ. Προσ." },
  "groups": {
    "Βθ1": {
      "label": "Βθ1", "grade": "Β", "kind": "track",
      "track": "Θετικών Σπουδών", "hidden": false,
      "room": "Αίθ. 8",                    // home classroom for this group
      "lessons": [
        { "d": 0, "p": 3, "subject": "Φυσική Προσανατολισμού",
          "teacher": "ΓΙΑΝΝΟΥΛΑ ΒΑΛΕΡΓΑΚΗ" }
      ]
    }
  }
}
```

`kind` is one of `section` (Α1, Β3, Γ2 …), `track` (Βθ1, Γοικ2, Γθετικό …),
`kontra` (Γ' electives) or `extra` (second foreign language and similar).
`d` is a 0-based day index; `p` is a 1-based period number. `teacher` and `room`
are omitted rather than written as `null` when there is nothing to say. A lesson's
own `room` means it happens somewhere other than usual; otherwise the student is
in the `room` of the group the lesson came from. `hidden` groups are kept in the
file but never offered in the picker — that flag is the converter's decision and
the app does not second-guess it, which is what keeps an empty-but-real κόντρα
elective on offer while an empty section stays hidden.

The picker is built entirely by grouping over `groups` — no class list is
hardcoded anywhere — so a new section or orientation next term appears on its own.

### How the merge works

A Β' or Γ' section's page deliberately leaves periods free for the orientation
track to fill (Β' leaves period 3; Γ' leaves 2–5). Merging is therefore a union of
the selected groups' lessons. Where two selected groups do claim the same slot, the
app keeps **both** and marks the slot «Σύγκρουση» rather than silently dropping one.

---

## Bandwidth

Sized for a slow home uplink, because that is what this usually ships from.
Measured against the container with gzip on:

| What | Bytes on the wire |
|---|---|
| First install (whole app + schedule) | **39 KB** |
| Returning student, app already installed | **~900 B** (three 304s) |
| Background update check, nothing new | **~300 B** |
| The day a new schedule is published | **~6 KB** |

At 5 Mbit/s up (~537 KB/s usable), 600 students all opening the app on the same
morning costs about **one second** of uplink. A whole school installing it for the
first time simultaneously is ~44 s — and that never happens at once in practice.

Three things keep it there, all of which are easy to undo by accident:

- **`fetch(..., { cache: 'no-cache' })`, never `'no-store'`.** `no-store` skips the
  validator and re-downloads the full schedule on every check; `no-cache` still
  revalidates every time but lets an unchanged file answer `304` with no body.
  That one word is a 20× difference on the hot path.
- **One schedule request per load.** A stored schedule renders straight from
  `localStorage` with no network at all; the background check is what goes out.
- **Background checks are throttled** to once per `CHECK_INTERVAL_MS` (30 min).
  The «Έλεγχος για νέο πρόγραμμα» button ignores the throttle.

Keep `gzip on` in whatever proxy sits in front — `schedule.json` is 76 KB raw and
4.9 KB gzipped, so serving it uncompressed costs 15× more.

## Testing

```bash
node tools/test/sw.test.mjs           # service worker caching strategies
python3 tools/test/schedule.test.py   # data invariants
```

`tools/test/make_fixtures.py` builds the schedule variants used to exercise the
update path by hand (a newer revision, one that drops a track, one that introduces
a collision, and two malformed payloads). Point `REMOTE_SCHEDULE_URL` at
`tools/test/fixtures/<name>.json` and reload.

For live-highlighting, `?now=` pins the clock:

```
http://localhost:8080/?now=2026-09-16T10:20    # Wednesday, mid 3rd period
http://localhost:8080/?now=2026-09-19T12:00    # Saturday
```

---

## Notes and known limits

- **Period 7** (13:25–14:05) exists in the grid but is unused in the current
  revision. The app renders only as far as each day's last real lesson.
- **Double periods are drawn as one merged cell.** When a class has the same
  lesson two hours running, aSc leaves out the rule between the two columns and
  centres the text across both. Read naively that fills one hour and leaves the
  other looking free — and drops the teacher, who is centred into the *other*
  half. The converter reads the missing rules back out of the drawing commands
  and writes the lesson to every hour the cell spans. The import report lists
  every merged cell it found (13 in the current revision, all `ΓΛΩ/ΛΟΓ`).
- **Inside a merged cell the teacher is printed as initials** — `ΕΓ`, not
  `ΕΛΕΝΗ ΓΙΑΜΑΛΑΚΗ`. That is the same shape as a room code, so the two can only
  be told apart by lookup: anything that is not a known room is matched against
  the teachers on that same page, narrowed by subject when two of them share
  initials (both ΜΑΡΙΑ ΤΣΙΩΚΟΥ and ΜΑΡΙΑ ΤΣΑΓΚΑΡΑΚΗ are `ΜΤ`; only one teaches
  Γλώσσα to Γ2). Every resolution is listed in the report; anything unresolved
  is a warning, never a silent guess.
- **Period times come from the school's ωράριο, not the PDF.** aSc prints
  whatever times were typed into it and this school's bell does not follow them —
  they were five minutes out on every hour. `periodTimes.times` in
  `tools/aliases.json` holds the official ΗΜΕΡΗΣΙΟ ΩΡΑΡΙΟ ΛΕΙΤΟΥΡΓΙΑΣ and wins;
  the report names every hour it had to correct. Delete the block to go back to
  trusting the PDF.
- **Classrooms come from the noticeboard,** not the PDF, via `groupRooms` in
  `tools/aliases.json` — one home room per group. A lesson only carries a room of
  its own when it is somewhere else (a lab), and that wins. This matters most for
  Γ΄, who move between their general room and their orientation room during the
  day. A group that can be picked but has no room is flagged by the tests.
- **Rooms the school does not use are dropped.** `ΕΦΕ` is printed on 13 lessons
  in the PDF but that lab is not actually used, so it is stripped at import via
  `hideRooms.labels` in `tools/aliases.json`; the lessons keep their subject and
  teacher. Remove the code from that list to start showing it again. `ΕΠ`
  (Εργαστήριο Πληροφορικής) is the only room the PDF itself supplies today.
- **Groups with no lessons are hidden — except «κόντρα» electives.** The current
  PDF has pages for 15 groups that carry no lessons, including Γ6 and Γ7, which
  are not real classes and were exported by accident. They stay in
  `schedule.json` (so a later revision that fills them just works) but the picker
  never offers them. A κόντρα elective is the exception: it is a real, active
  class that simply may have no hour in a given week, so it is always offered.
  Hide one by name via `excludeGroups.labels` if it genuinely does not exist.
- To suppress a group that *does* have lessons but should not be offered, add its
  label to `excludeGroups.labels` in `tools/aliases.json`.
- The converter reads the table geometry from the ruled lines aSc draws, not from
  fixed coordinates, so it tolerates layout shifts between exports. It will
  **fail loudly** rather than emit a half-parsed timetable.
