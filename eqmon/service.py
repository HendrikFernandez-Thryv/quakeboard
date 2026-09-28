"""Search logic: turn a free-text query into a list of events."""

from . import api, regions


class SearchResult(object):
    def __init__(self, query, quakes, label, note="", bbox_count=0):
        self.query = query
        self.quakes = quakes
        self.label = label          # resolved region name, or the raw text
        self.note = note            # how the query was interpreted
        self.bbox_count = bbox_count


def _dedupe(quakes):
    seen, out = set(), []
    for q in quakes:
        if q.id in seen:
            continue
        seen.add(q.id)
        out.append(q)
    out.sort(key=lambda q: q.epoch, reverse=True)
    return out


def search(query, min_mag=2.5, days=30, limit=500, strict=False):
    """Search by country/region name, or by free text against the place field.

    A name that resolves in the gazetteer is queried geographically, which
    catches offshore events the USGS labels by sea or trench rather than by
    country. Anything else falls back to a text match on the place string.
    """
    query = (query or "").strip()
    if not query:
        raise ValueError("empty search")

    hit = regions.resolve(query)
    if hit:
        key, boxes, how = hit
        label = regions.display_name(key)
        per_box = max(20, int(limit / max(1, len(boxes))))
        found = []
        for box in boxes:
            found.extend(api.search(min_mag=min_mag, days=days, bbox=box,
                                    limit=per_box))
        found = _dedupe(found)
        if how == "exact":
            note = "region match"
        elif how == "partial":
            note = 'closest match to "%s"' % query
        else:
            note = 'best guess for "%s"' % query
        if strict:
            needle = regions.normalize(query)
            kept = [q for q in found
                    if needle in regions.normalize(q.place)]
            note = note + ", name-filtered"
            found = kept
        return SearchResult(query, found[:limit], label, note, len(boxes))

    # Not a known place name: pull the window globally and match the text.
    needle = regions.normalize(query)
    everything = api.search(min_mag=min_mag, days=days, limit=20000)
    matched = [q for q in everything if needle in regions.normalize(q.place)]
    note = "text match on place name"
    return SearchResult(query, _dedupe(matched)[:limit], query, note, 0)
