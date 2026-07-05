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

/* ============================= VERSIONING =============================
   To support multiple people using this at once without silently clobbering each
   other's edits: every save bumps an in-memory version counter (persisted into
   config.json's own meta so it survives a server restart). Clients poll GET
   /api/version (cheap — no disk read) roughly every second and pull a fresh copy
   when it moves. Saves also carry the version the client last saw; if that's
   stale (someone else saved in between), the write is rejected instead of
   overwriting the newer data, and the client is hands back the current copy. */
let currentVersion = 0;
if (fs.existsSync(CONFIG_PATH)) {
  try {
    const existing = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    currentVersion = (existing.meta && existing.meta.version) || 1;
  } catch (err) {
    console.warn('Could not read existing config.json version on startup:', err.message);
  }
}

app.use(express.json({ limit: '20mb' })); // config.json body (no more base64 images in it, so this is generous headroom)
app.use(express.static(path.join(__dirname, 'public')));
app.use('/media', express.static(MEDIA_DIR, { maxAge: '1d' }));

/* ============================= CONFIG API =============================
   The whole app database (parts, boards, sales, journal, etc.) is a single JSON
   document, same shape as the old browser-only export file — just persisted here
   instead of only living in memory. */
app.get('/api/config', (req, res) => {
  if (!fs.existsSync(CONFIG_PATH)) {
    return res.status(404).json({ error: 'No config.json yet' });
  }
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    res.type('application/json').send(raw);
  } catch (err) {
    res.status(500).json({ error: 'Could not read config.json: ' + err.message });
  }
});

// Lightweight endpoint for the frontend to poll frequently — just the in-memory
// number, no disk access, so polling every second is essentially free.
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
    if (!fs.existsSync(CONFIG_PATH)) {
      return res.status(409).json({ error: 'version_conflict', currentVersion, currentConfig: null });
    }
    try {
      const latest = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      return res.status(409).json({ error: 'version_conflict', currentVersion, currentConfig: latest });
    } catch (err) {
      return res.status(409).json({ error: 'version_conflict', currentVersion, currentConfig: null });
    }
  }

  try {
    currentVersion += 1;
    const body = req.body || {};
    body.meta = body.meta || {};
    body.meta.version = currentVersion;

    const tmpPath = CONFIG_PATH + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(body, null, 2));
    fs.renameSync(tmpPath, CONFIG_PATH); // atomic-ish swap so a crash mid-write can't corrupt the real file
    res.json({ ok: true, version: currentVersion });
  } catch (err) {
    currentVersion -= 1; // the write failed, don't advance the version for nothing
    res.status(500).json({ error: 'Could not save config.json: ' + err.message });
  }
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
