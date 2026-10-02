# quakeboard

A live earthquake monitor, as a terminal app and as an animated single-page web
app. An auto-updating board of the latest detected events sits at the top;
below it you can search past earthquakes by country or region, pull up the
aftershock sequence around any event, see whether a region's recent activity
is unusual, and plot it all on a world map.

- **Terminal:** `./quakeboard` — Python standard library only. See [Quick start](#quick-start-terminal).
- **Web:** `web/index.html` — one self-contained file, live at
  **<https://hendrikfernandez-thryv.github.io/quakeboard/>**. See [Web app](#web-app).

Data comes from the [USGS earthquake feeds](https://earthquake.usgs.gov/earthquakes/feed/).
No API key, no account, no third-party packages — Python 3.6+ and its standard
library are all you need.

## Quick start (terminal)

```bash
./quakeboard
```

That opens the full-screen monitor with the board showing **M4.0 and above from
the last 24 hours**, refreshing every 60 seconds. Press `/` to search, `?` for
the key list, `q` to quit.

```bash
./quakeboard japan                      # start with a search already run
./quakeboard --home 32.78,-96.80 --home-name Dallas   # remember where you are
./quakeboard --near --radius 500        # what has happened near you
./quakeboard --watch --watch-mag 6      # notify me, don't take over my screen
```

## Web app

`web/index.html` is the same monitor as a single page: one self-contained file
with no server, no install and no dependencies. It is live at
<https://hendrikfernandez-thryv.github.io/quakeboard/>, or you can run it
yourself: open it in a browser, or serve the folder:

```bash
open web/index.html                   # macOS; or just double-click it
python3 -m http.server -d web 8000    # then visit http://localhost:8000
```

**What you get**

- **A live, animated board.** Events arrive from the USGS on a countdown ring
  (15 s to 5 min), new ones slide in flagged `NEW`, and everything that changes
  does so without the list jumping: rows are reused by event id and the ones
  pushed down glide to their new place.
- **A dotted 3-D globe** you can drag and scroll, with a live day/night
  terminator, atmosphere glow, and shockwave rings that ripple across the
  surface when an event lands. Or switch to a flat Mercator map that pans,
  zooms and frames whatever you searched.
- **A seismograph strip** that scrolls continuously and fires a P-wave then a
  longer S-wave for each real event, sized by magnitude and tinted by tier. It
  is an illustration driven by live data, not a recording, and says so.
- **A timelapse replay** of the current window: events appear in order with
  their shockwaves while the seismograph plays along, with a scrubber.
- **Search** by country or region (179 of them, with aliases, partial names
  and misspellings — `japn` finds Japan and says it guessed), type-ahead
  suggestions, and a text fallback for place names outside the gazetteer.
- **Near me**, using a circle rather than a box, from coordinates you type or
  the browser's location if you click for it. It never leaves your browser.
- **Aftershock sequences** with a magnitude-over-time scatter, per-day counts,
  the decay verdict and the Båth's-law size gap; and **"how unusual is this?"**
  against the past year. The charts all have a table view.
- **Alerts** for new events above a magnitude you choose: an in-page toast, an
  optional synthesised rumble, and optional desktop notifications while the tab
  is open.
- **Saved searches** on keys `1`–`9`, CSV export, shareable URLs
  (`#q=japan&m=5&d=90`), light and dark themes, a reduced-motion mode that
  turns the movement off, and a full keyboard map (press `?`).

It works offline-ish: recent responses are kept in the browser, so if the
network drops the board keeps showing the last data, labelled `CACHED`.

**How it differs from the terminal app.** The gazetteer, the aftershock radius
and verdict wording, and the activity comparison are the same code ported to
JavaScript, and 88 region queries plus every analysis string are checked against
the Python by tests. Two deliberate differences: a known name inside a longer
query must be a whole word of three or more letters and the most specific one
wins (so `andrew` is no longer the Dominican Republic and `all of japan` is not
"worldwide"), and the live board below M4.5 queries the FDSN service for just
what is shown instead of downloading the whole feed and filtering it.

**Privacy.** The only network requests are to `earthquake.usgs.gov`. There is no
analytics, no third-party script or font, and no server. Settings, saved
searches and a few cached responses live in your browser's `localStorage`.

**Publishing.** The live site is served by GitHub Pages, which is free for
public repositories. Every push to `main` that touches `web/` runs
`.github/workflows/pages.yml`, which publishes `web/index.html` only if it is
exactly what `tools/build_web.py` builds from `web/src` and the Node tests pass.
So after changing anything in `web/src`, rebuild and commit `web/index.html`
too, or the deploy will stop at that check. You can also start it by hand from
the repository's Actions tab.

**Working on it.** The page is assembled from `web/src/` by a small script:

```bash
python3 tools/build_web.py            # write web/index.html
python3 tools/build_web.py --check    # fail if index.html is out of date
node --test web/test/*.test.js        # 95 tests, no network needed
python3 tools/build_webdata.py        # regenerate the gazetteer and coastlines
python3 tools/gen_web_fixtures.py     # regenerate what the tests compare against
```

## Terminal keys

| Key | Action |
| --- | --- |
| `/` | search by country or region (`japan`, `chile`, `aegean`, `ring of fire`) |
| `n` / `N` | search near your home location / set that location |
| `a` | aftershocks and foreshocks around the selected event |
| `x` | how the current region compares with its last 12 months |
| `g` | toggle the world map |
| `1`–`9` / `0` | open a saved search / manage saved searches |
| `B` | save the current search |
| `r` | refresh the board now, and re-run the last search |
| `m` / `M` | minimum magnitude for the board / for searches |
| `t` | cycle the board window: last hour, 24 hours, 7 days, 30 days |
| `d` | days of history to search |
| `i` | auto-refresh interval |
| `s` | strict mode — also require the place name to contain your query |
| `c` | clear the search pane |
| `TAB` | move focus between the board and the results |
| `↑` `↓` `j` `k` `PgUp` `PgDn` `Home` `End` | move the selection |
| `ENTER` | full detail for the selected event |
| `o` | open the selected event's USGS page in a browser |
| `e` | export the focused pane to a CSV file |
| `b` | toggle the beep for new big events |
| `?` `h` | help |
| `q` | quit |

New events that appeared in the last refresh are marked with a `*` and shown in
bold. Magnitude drives the row colour: yellow for M4s, magenta for M5s, red for
M6s, and reversed red for M7 and above.

## Searching

Names resolve through a built-in gazetteer of 179 countries and seismic
regions, so a search runs **geographically** rather than as a string match.
That matters because the USGS labels many events by sea, ridge or trench rather
than by country — a search for `japan` finds `Izu Islands, Japan region`, and
`tonga` finds events the feed calls `South Pacific Ocean`.

- Aliases and demonyms work: `usa`, `uk`, `nz`, `türkiye`, `persia`, `burma`.
- Partial names work: `jap`, `aege`, `philip`.
- Misspellings are matched loosely and the results pane says so:
  `chili` → `best guess for "chili"` over Chile.
- A name that isn't in the gazetteer falls back to a text match against the
  place field, so landmarks and towns (`ridgecrest`, `kermadec`) still work.
- Regions can be broader than a country: `mediterranean`, `himalayas`,
  `east african rift`, `ring of fire`, `world`.

`./quakeboard --list-regions` prints every name it knows.

### Near me

Set a home location once and it is remembered:

```bash
./quakeboard --home 32.78,-96.80 --home-name Dallas
```

Then `n` searches a **circle** around it rather than a bounding box, which is
the right shape for "within 300 km of here". Distances and compass bearings
from home appear in the event detail, in CSV exports and in plain-text output,
and home is marked `+` on the map.

## Aftershocks

Select any event and press `a`. It searches a radius scaled to the mainshock —
from the Wells & Coppersmith rupture-length relation, floored at 25 km — and
reports what came before and after:

```
Searched         43 km around the epicentre
Window           2026-09-25 03:12:07 to now, M3.6 and above
Foreshocks       0
Aftershocks      30
  largest        M5.5, 2h later
  size gap       1.1  (Bath's law expects about 1.2)
Rate             22 in the first 24h, 6 in the last 24h
Shape            ▇▂▃▁▁▁▁  (per day since the mainshock)

The rate is decaying as you would expect, from 22 on day one to 6 in the
last 24 hours.
```

The size gap is worth knowing about: Båth's law says the largest aftershock is
typically about 1.2 magnitude units below the mainshock. A much smaller gap —
or a negative one — means the event you picked may not be the biggest of its
sequence, and quakeboard says so.

## Is this unusual?

Press `x` (or pass `--context` in plain mode) to compare a region's last 30
days against its trailing 12 months. It uses the FDSN *count* endpoint, so it
is a handful of tiny requests rather than downloading any events:

```
Japan - events at M4.0 and above
Last 30 days           50
Last 365 days          1,372
Expected in 30 days    113
Ratio                  0.44x the 12-month rate
```

## The map

`g` draws a braille world map — each character cell is a 2×4 pixel grid, so a
100×24 pane is a 200×96 canvas. Events are plotted as coloured markers by
magnitude, the selected event is highlighted, and the view zooms to the
searched region when there is one. Land comes from a 5.7 kB mask baked into the
package from Natural Earth data, so the map works offline.

## Watch mode

```bash
./quakeboard --watch --watch-mag 6
./quakeboard --watch --watch-mag 4.5 --watch-region japan --watch-region chile
./quakeboard --watch --watch-mag 3 --near --radius 300
```

Polls without taking over the screen and raises a desktop notification for each
new event — macOS Notification Centre via `osascript`, `notify-send` on Linux,
and a terminal bell as a fallback. Events already reported are remembered on
disk, so restarting does not re-announce the backlog, and the first run
establishes a baseline instead of firing off a burst.

## Saved searches

Press `B` to save the current search along with its magnitude floor and time
window, then `1`–`9` to jump back to it. `0` lists them and deletes with `d`
followed by a digit. They live in `~/.config/quakeboard/config.json`, alongside
your home location and board defaults — which are also remembered, so the
magnitude floor and time window you last used come back next time.

## Command line

```
./quakeboard [query] [options]

live board
  -M, --min-mag X      board magnitude floor (default 4.0)
  -p, --period WINDOW  hour | day | week | month (default day)
  -i, --interval SEC   auto-refresh seconds, minimum 15 (default 60)
  --board-rows N       rows of board to show alongside results (default 8)
  --bell               beep when a new event lands at or above --bell-mag
  --bell-mag X         magnitude that triggers the beep (default 6.0)

search
  -m, --search-min-mag X   magnitude floor for searches (default 2.5)
  -d, --days N             days of history to search (default 30)
  --strict                 also require the place name to contain the query
  --near                   search around your home location

location
  --home LAT,LON       set your home location and save it
  --home-name NAME     a label for it
  --radius KM          radius for --near (default 300)

watch mode
  --watch              poll and raise desktop notifications; no full-screen UI
  --watch-mag X        notify at or above this magnitude (default 6.0)
  --watch-region NAME  only notify for this region; repeatable

output
  --plain              print once as plain text and exit
  --map                show the world map (in --plain mode, print it)
  --context            in --plain mode, also report the 12-month comparison
  -n, --limit N        cap the rows printed in --plain mode
  --list-regions       list known country and region names
  --clear-cache        delete cached responses
```

`--plain` prints a single snapshot instead of taking over the screen, which is
what you want for a cron job or a pipe. It also kicks in automatically when
output is not a terminal:

```bash
./quakeboard --plain -M 5 -n 10              # the ten most recent M5+ events
./quakeboard --plain -m 4 -d 7 chile | mail -s "Chile M4+ this week" me@example.com
```

## Caching

Responses are cached under `~/.cache/quakeboard` and revalidated with `ETag`,
so a repeat request costs a 304 and no body, and an identical search within 30
seconds does not hit the network at all. If the network is unreachable,
quakeboard serves the last good copy and labels it `cached` rather than showing
you nothing.

Searches are capped at 500 results, and when there are more, the count endpoint
tells you honestly: `showing 500 of 1,240`. Text searches — for names outside
the gazetteer — have to be filtered locally, so the magnitude floor is raised
automatically rather than quietly pulling down tens of thousands of events, and
the pane says when that happened.

## Notes on the data

- Magnitudes are whatever the USGS reports for the event (`mww`, `mb`, `ml` and
  others), not strictly Richter values — the original Richter scale saturates
  for large earthquakes and is no longer used for them.
- Depth is in kilometres. `NOTES` carries a tsunami flag (`TSU`), the PAGER
  alert colour, the count of felt reports, and `rev` once a seismologist has
  reviewed the automatic solution.
- Events appear within a couple of minutes of detection and get revised
  afterwards, so magnitudes shift slightly as the board refreshes.
- **A `TSU` flag here is not an official warning.** For tsunami advisories use
  [tsunami.gov](https://www.tsunami.gov/) or your national agency.

## Layout

```
quakeboard              entry point
eqmon/api.py            USGS feed, FDSN query and count client
eqmon/cache.py          on-disk HTTP cache with ETag revalidation
eqmon/service.py        search, aftershock sequences, activity baselines
eqmon/regions.py        gazetteer of country and region bounding boxes
eqmon/geo.py            distance and bearing helpers
eqmon/map.py            braille world map renderer
eqmon/mapdata.py        baked land mask (generated; see tools/)
eqmon/config.py         settings, home location, saved searches
eqmon/model.py          event model and formatting
eqmon/ui.py             curses interface
eqmon/plain.py          plain-text output
eqmon/watch.py          notification daemon
eqmon/cli.py            argument parsing
tools/build_mapdata.py  regenerates the terminal app's land mask
test_quakeboard.py      tests for the terminal app

web/index.html          the web app: one file, built from web/src (committed)
web/src/core.js         geo maths, gazetteer matching, USGS client, analysis (no DOM)
web/src/land.js         coastlines: decode, unwrap at the antimeridian, rasterise
web/src/fx-*.js         animation: seismograph, globe and flat map, charts
web/src/app-*.js        the interface: list, detail, dialogs, orchestration
web/src/css/            design tokens and styles, dark and light
web/src/template.html   page skeleton and icon sprite
web/test/               Node tests, incl. parity with the Python via fixtures
tools/build_web.py      assembles web/index.html
tools/build_webdata.py  generates web/src/gazetteer.js and landdata.js
tools/gen_web_fixtures.py  writes web/test/fixtures.json from the Python app
```

## Tests

```bash
python3 test_quakeboard.py            # 63 offline tests for the terminal app
python3 test_quakeboard.py --net      # also hits the live USGS service
node --test web/test/*.test.js        # 95 tests for the web app
```

## Credits

Earthquake data from the [U.S. Geological Survey](https://earthquake.usgs.gov/).
Coastlines from [Natural Earth](https://www.naturalearthdata.com/) 1:110m land
(public domain), via `world-atlas`, baked into `eqmon/mapdata.py` and `web/src/landdata.js`
at build time.
