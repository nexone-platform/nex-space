# The five typefaces

Every one of them draws Thai and Latin in a single design. That is the rule for
being on this list: a face with only Latin would leave the browser to fetch
something else for the Thai, and a screen that is two thirds Thai would be set
in two typefaces that never met.

| id | family | licence |
|---|---|---|
| `sarabun` | Sarabun — the web edition of TH Sarabun | OFL 1.1 |
| `noto` | Noto Sans Thai | OFL 1.1 |
| `plex` | IBM Plex Sans Thai | OFL 1.1 |
| `prompt` | Prompt | OFL 1.1 |
| `kanit` | Kanit | OFL 1.1 |

Forty files: each family cut into Thai and Latin, four weights each
(400/500/600/700). About 770 KB on disk and almost none of it over the wire —
a browser fetches only the family it is drawing with, and only the script it
needs, so a Thai screen in Sarabun costs two files of ten kilobytes.

## Why these are here rather than a link to Google

A tool people use at work should not tell a third party each time somebody opens
it. Self-hosting also removes a DNS lookup and a TLS handshake to another origin
from the critical path, which costs more than the ten kilobytes it was saving.

## How a face is chosen

`src/typeface.ts` owns the choice and writes `data-face` on `<html>`; the
`@font-face` rules and one `--sans` per face live in the `<style>` of
`index.html`, `admin.html` and `editor.html`. Nothing else in the app names a
font — every rule says `var(--sans)`.

The size works the same way: `--ui` is the scale, the interface having been
drawn at 13px, and every size in those stylesheets is `calc(Npx * var(--ui))`.
Both are stamped on `<html>` by the small script in `<head>` before the first
paint, because a module import lands after it and the text would visibly jump.

## Replacing or adding a weight

`/assets/` is served with a year of `immutable`, so **never overwrite a file in
place** — a browser that has the old bytes would keep them until 2027. The
version is in the filename (`-v17`) for exactly this: a new cut gets a new name,
the `@font-face` block points at it, and the old file can go once nobody is
still holding a cached page that names it.

## The one place that does not use this

Mail. No webfont loads in Gmail or Outlook, so `apps/api/src/mailer.ts` asks for
`TH Sarabun New` first — the desktop font, which is on most Thai office machines
— and only then for an installed Sarabun.
