# quakeboard

A terminal earthquake monitor. An auto-updating board of the latest detected
events sits at the top of the screen; below it you can search past earthquakes
by country or region, pull up the aftershock sequence around any event, see
whether a region's recent activity is unusual, and plot it all on a world map.

Data comes from the [USGS earthquake feeds](https://earthquake.usgs.gov/earthquakes/feed/).
No API key, no account, no third-party packages — Python 3.6+ and its standard
library are all you need.

## Quick start

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

## Keys

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
tools/build_mapdata.py  regenerates the land mask from Natural Earth data
test_quakeboard.py      tests
```

## Tests

```bash
python3 test_quakeboard.py          # 59 offline tests
python3 test_quakeboard.py --net    # also hits the live USGS service
```

## Credits

Earthquake data from the [U.S. Geological Survey](https://earthquake.usgs.gov/).
Coastlines from [Natural Earth](https://www.naturalearthdata.com/) 1:110m land
(public domain), via `world-atlas`, baked into `eqmon/mapdata.py` at build time.
