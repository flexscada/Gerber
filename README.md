# Gerber:// Inventory & Production Control

Electronics component inventory, BOM/PCB reference, production, purchase planning,
and sales tracker — built for small board-building shops.

This is a small Node.js + Express app: a static frontend (plain HTML/CSS/JS, no build
step) backed by a minimal JSON-file database and a local file store for uploads.

## Pricing

This software costs $100 usd and you have access to it for life, it is done on a 100% trust basis, you're welcome to try it out but if you decide to use it we ask that you send us $100 using the sponsor link on this page.

## Requirements

- Node.js 16+ (no other system dependencies)

## Setup

```bash
npm install
npm start
```

Then open **http://localhost:3000** in a browser.

The server listens on port `3000` by default — set the `PORT` environment variable to
change it, e.g. `PORT=8080 npm start`.

## How data is stored

- **`data/config.json`** — the whole database (components, products, BOMs, sales,
  journal, purchase planning config, etc.) as one JSON document. It's created
  automatically the first time the app runs (seeded with a small demo dataset) and
  overwritten on every save.
- **`data/media/`** — every uploaded file (component images, PCB photos, datasheets,
  spec sheets, ...) lives here as a plain file on disk, served at `/media/<filename>`.
  Components and products reference these files by filename instead of embedding them
  as base64, which keeps `config.json` small and lets one file be reused in multiple
  places (see the **Media** page in the app to see what's uploaded and where it's used).

Neither of these is committed to git (see `.gitignore`) — back up the `data/` folder
directly if you want a full backup, or use the **Export JSON Backup** button in the app
sidebar for a snapshot of just the database (not the uploaded files).

The frontend auto-saves to the server ~700ms after each change (debounced so rapid
edits collapse into one request); the sidebar footer shows the current save status.

## Project layout

```
server.js              Express app: serves the frontend + the API below
package.json
data/
  config.json           the database (git-ignored, created on first run)
  media/                 uploaded files (git-ignored)
public/
  index.html             thin HTML shell
  css/style.css           all styling
  js/app.js               all application logic
  js/vendor/chart.umd.min.js   bundled Chart.js (no external CDN dependency)
```

## API

| Method | Path                     | Description                                   |
|--------|--------------------------|------------------------------------------------|
| GET    | `/api/config`            | Returns the database JSON (404 if none saved yet) |
| PUT    | `/api/config`            | Saves the database JSON; see **Multiple users** below |
| GET    | `/api/version`           | Returns `{version}` — a cheap, in-memory counter for polling |
| GET    | `/api/media`             | Lists uploaded files: `[{name, size, modified}]` |
| POST   | `/api/media/upload`      | Multipart upload, field name `file`; returns `{filename, size}` |
| DELETE | `/api/media/:filename`   | Deletes a file from the media store            |
| GET    | `/media/:filename`       | Serves an uploaded file directly                |

There's no authentication layer — if you're exposing this beyond your own machine/LAN,
put it behind a reverse proxy with auth (nginx + basic auth, a VPN, etc.), since anyone
who can reach the server can read and overwrite the entire database.

## Multiple users at once

This isn't built as a real-time collaborative editor, but it's safe to have a few people
using it at the same time:

- The server keeps a version number that increments on every save (persisted in
  `config.json`'s own `meta.version`, so it survives a restart).
- Every open tab polls `GET /api/version` once a second. If it's moved since the last
  time that tab loaded, it pulls the fresh copy and applies it automatically — with a
  toast: *"The database was updated by another user — changes automatically applied!"*
  This is skipped for a moment if you have unsaved local edits, a modal open, or a field
  focused, so an incoming update can't yank a form out from under you mid-edit; it just
  applies on the next poll once you're done.
- Saves include the version the tab last saw. If someone else saved in between, the
  write is **rejected** (not merged, not silently overwritten) and that tab pulls in the
  newer copy instead, with a toast telling you your last change wasn't applied so you
  know to redo it.

There's no field-level merging — if two people edit the *same* thing at the *same*
moment, one of them will need to redo their change. What this does guarantee is that
you'll always know when that's happened, instead of a change quietly vanishing.

## Notes on migrating from the old single-file version

If you have a database exported from the old browser-only single-HTML-file version of
this app (with images embedded as base64), importing it via **Import JSON Backup** will
automatically upload those embedded images into the Media library and re-link them —
nothing is lost, they just move from being embedded in the JSON to being real files.
