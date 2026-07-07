const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

// Make sure the data directories exist before anything tries to read/write them.
fs.mkdirSync(MEDIA_DIR, { recursive: true });

/* ============================= VERSIONING & IN-MEMORY CONFIG =============================
   To support multiple people using this at once without silently clobbering each other's
   edits: every save bumps a version counter, and the whole config document is kept in
   memory as the live source of truth while the server runs — reads and writes just touch
   that in-memory copy so a burst of saves (or a bunch of clients polling) doesn't hammer
   disk I/O. It's written to config.json periodically (every 5 minutes) and on a graceful
   shutdown (Ctrl+C / SIGTERM), plus the version is embedded in the document so it survives
   a restart. Clients poll GET /api/version (cheap — just returns the in-memory number) and
   pull a fresh copy when it moves. Saves also carry the version the client last saw; if
   that's stale (someone else saved in between), the write is rejected instead of
   overwriting the newer data, and the client is handed the current copy back. */
let currentVersion = 0;
let configCache = null;   // the live, in-memory database — null until the first save ever happens
let configDirty = false;  // true if configCache has changes not yet written to config.json
const FLUSH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

if (fs.existsSync(CONFIG_PATH)) {
  try {
    configCache = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    currentVersion = (configCache.meta && configCache.meta.version) || 1;
  } catch (err) {
    console.warn('Could not read existing config.json on startup:', err.message);
  }
}

function flushConfigToDisk() {
  if (!configDirty || !configCache) return;
  try {
    const tmpPath = CONFIG_PATH + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(configCache, null, 2));
    fs.renameSync(tmpPath, CONFIG_PATH);
    configDirty = false;
    console.log(`[${new Date().toISOString()}] config.json flushed to disk (version ${currentVersion})`);
  } catch (err) {
    console.error('Failed to flush config.json to disk:', err.message);
  }
}
setInterval(flushConfigToDisk, FLUSH_INTERVAL_MS);

function shutdown() {
  console.log('Shutting down — flushing config to disk...');
  flushConfigToDisk();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

app.use(express.json({ limit: '20mb' })); // config.json body (no more base64 images in it, so this is generous headroom)
app.use(express.static(path.join(__dirname, 'public')));
app.use('/media', express.static(MEDIA_DIR, { maxAge: '1d' }));

/* ============================= CONFIG API =============================
   The whole app database (parts, boards, sales, journal, etc.) is a single JSON
   document, same shape as the old browser-only export file — just persisted here
   instead of only living in browser memory (well — it does still live in memory! just
   also on disk, per the flush strategy above). */
app.get('/api/config', (req, res) => {
  if (!configCache) {
    return res.status(404).json({ error: 'No config.json yet' });
  }
  res.json(configCache);
});

// Lightweight endpoint for the frontend to poll frequently — just the in-memory
// number, no disk access, so polling every 200ms is essentially free.
app.get('/api/version', (req, res) => {
  res.json({ version: currentVersion });
});

app.put('/api/config', (req, res) => {
  const clientVersionHeader = req.get('X-Client-Version');
  const clientVersion = clientVersionHeader !== undefined ? Number(clientVersionHeader) : null;

  // Optimistic concurrency check: if the client tells us what version it started
  // from and someone else has saved since, reject rather than overwrite — the
  // client is expected to pull the fresh copy (the response includes it) instead
  // of blindly retrying with stale data.
  if (clientVersion !== null && clientVersion !== currentVersion) {
    return res.status(409).json({ error: 'version_conflict', currentVersion, currentConfig: configCache });
  }

  currentVersion += 1;
  const body = req.body || {};
  body.meta = body.meta || {};
  body.meta.version = currentVersion;
  configCache = body;
  configDirty = true;
  res.json({ ok: true, version: currentVersion });
});

/* ============================= MEDIA API =============================
   Uploaded files (component/PCB images, datasheets, spec sheets, ...) are stored as
   plain files on disk under data/media and referenced by filename from config.json,
   instead of being embedded as base64 — keeps the database small and lets one file
   be reused by multiple parts/products. */
function sanitizeFilename(name) {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._-]+/g, '_');
  return base || 'file';
}
function uniqueFilename(desired) {
  let final = desired;
  let i = 1;
  const ext = path.extname(desired);
  const stem = path.basename(desired, ext);
  while (fs.existsSync(path.join(MEDIA_DIR, final))) {
    final = `${stem}_${i}${ext}`;
    i++;
  }
  return final;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, MEDIA_DIR),
  filename: (req, file, cb) => {
    const safe = sanitizeFilename(file.originalname);
    cb(null, uniqueFilename(safe));
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 } // 50MB/file is plenty for images/datasheets
});

app.post('/api/media/upload', (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    res.json({ filename: req.file.filename, size: req.file.size });
  });
});

app.get('/api/media', (req, res) => {
  try {
    const files = fs.readdirSync(MEDIA_DIR)
      .filter(f => !f.startsWith('.'))
      .map(f => {
        const stat = fs.statSync(path.join(MEDIA_DIR, f));
        return { name: f, size: stat.size, modified: stat.mtime };
      });
    res.json(files);
  } catch (err) {
    res.status(500).json({ error: 'Could not list media: ' + err.message });
  }
});

app.delete('/api/media/:filename', (req, res) => {
  const safe = path.basename(req.params.filename); // strip any path traversal attempt
  const target = path.join(MEDIA_DIR, safe);
  if (!target.startsWith(MEDIA_DIR)) return res.status(400).json({ error: 'Invalid filename' });
  try {
    if (fs.existsSync(target)) fs.unlinkSync(target);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Could not delete file: ' + err.message });
  }
});

// Replaces an existing file's content while keeping the same filename, so anything
// already referencing it (a part's image, a product's attachment, etc.) picks up the
// new content automatically without needing to be re-linked.
const replaceUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, MEDIA_DIR),
    filename: (req, file, cb) => cb(null, path.basename(req.params.filename))
  }),
  limits: { fileSize: 50 * 1024 * 1024 }
});
app.put('/api/media/:filename', (req, res) => {
  const safe = path.basename(req.params.filename);
  const target = path.join(MEDIA_DIR, safe);
  if (!target.startsWith(MEDIA_DIR)) return res.status(400).json({ error: 'Invalid filename' });
  replaceUpload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    res.json({ filename: req.file.filename, size: req.file.size });
  });
});

app.listen(PORT, () => {
  console.log(`Gerber inventory tracker running at http://localhost:${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
});
