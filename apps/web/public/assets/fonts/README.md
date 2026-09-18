# Sarabun

The web edition of TH Sarabun, drawn by Suppakit Chalermlarp and published by
Cadson Demak under the **SIL Open Font License 1.1** — the same licence Google
Fonts serves it under, which permits redistribution with a product.

Eight files: Thai and Latin cut apart, four weights each (400/500/600/700), so a
screen with no Thai on it never downloads the Thai one. About 85 KB in total, and
a page typically fetches two of the eight.

## Why these are here rather than a link to Google

A tool people use at work should not tell a third party each time somebody opens
it. Self-hosting also removes a DNS lookup and a TLS handshake to another origin
from the critical path, which costs more than the ten kilobytes it was saving.

## Replacing or adding a weight

`/assets/` is served with a year of `immutable`, so **never overwrite a file in
place** — a browser that has the old bytes would keep them until 2027. The
version is in the filename (`-v17`) for exactly this: a new cut gets a new name,
the `@font-face` block in the page points at it, and the old file can go once
nobody is still holding a cached page that names it.

The `@font-face` rules and the `--sans` token live in the `<style>` of
`index.html`, `admin.html` and `editor.html`. The two probe stylesheets carry
their own copy so they can be opened on their own.

## The one place that does not use this

Mail. No webfont loads in Gmail or Outlook, so `apps/api/src/mailer.ts` asks for
`TH Sarabun New` first — the desktop font, which is on most Thai office machines
— and only then for an installed Sarabun.
