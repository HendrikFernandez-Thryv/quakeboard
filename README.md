# quakeboard

A terminal earthquake monitor. An auto-updating board of the latest detected
events sits at the top of the screen, and below it you can search past
earthquakes by country or region.

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

Start with a search already run:

```bash
./quakeboard japan
```

## Keys

| Key | Action |
| --- | --- |
| `/` | search by country or region (`japan`, `chile`, `aegean`, `ring of fire`) |
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
- Misspellings are matched loosely and the results pane says it guessed:
  `chili` → `best guess for "chili"` over Chile.
- A name that isn't in the gazetteer falls back to a text match against the
  place field, so landmarks and towns (`ridgecrest`, `kermadec`) still work.
- Regions can be broader than a country: `mediterranean`, `himalayas`,
  `east african rift`, `ring of fire`, `world`.

`./quakeboard --list-regions` prints every name it knows.

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

output
  --plain              print once as plain text and exit
  -n, --limit N        cap the rows printed in --plain mode
  --list-regions       list known country and region names
```

`--plain` prints a single snapshot instead of taking over the screen, which is
what you want for a cron job or a pipe. It also kicks in automatically when
output is not a terminal:

```bash
./quakeboard --plain -M 5 -n 10              # the ten most recent M5+ events
./quakeboard --plain -m 4 -d 7 chile | mail -s "Chile M4+ this week" me@example.com
```

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
quakeboard            entry point
eqmon/api.py          USGS feed and FDSN query client
eqmon/service.py      search: region resolution, then geographic query
eqmon/regions.py      gazetteer of country and region bounding boxes
eqmon/model.py        event model and formatting
eqmon/ui.py           curses interface
eqmon/plain.py        plain-text output
eqmon/cli.py          argument parsing
test_quakeboard.py    tests
```

## Tests

```bash
python3 test_quakeboard.py          # offline
python3 test_quakeboard.py --net    # also hits the live USGS service
```
