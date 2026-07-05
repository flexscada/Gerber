/* ============================= DATA LAYER ============================= */
const LOW_STOCK_RATIO = 0.25; // below this fraction of target => red

function uid(prefix){ return (prefix||'id')+'_'+Math.random().toString(36).slice(2,9)+Date.now().toString(36).slice(-4); }
function nowISO(){ return new Date().toISOString(); }
/* Shared time-range filtering for historical line charts (part field history, product
   stock over time). Filters by cutoff date rather than needing a charting zoom plugin. */
const HIST_RANGES = [
  {key:'all', label:'All Time'},
  {key:'5y', label:'Last 5 Years'},
  {key:'1y', label:'Last Year'},
  {key:'1m', label:'Last Month'}
];
function rangeCutoffDate(rangeKey){
  if(rangeKey==='all') return null;
  const cutoff = new Date();
  if(rangeKey==='5y') cutoff.setFullYear(cutoff.getFullYear()-5);
  else if(rangeKey==='1y') cutoff.setFullYear(cutoff.getFullYear()-1);
  else if(rangeKey==='1m') cutoff.setMonth(cutoff.getMonth()-1);
  return cutoff;
}
function filterByRange(items, rangeKey, dateFn){
  const cutoff = rangeCutoffDate(rangeKey);
  if(!cutoff) return items;
  return items.filter(it=> new Date(dateFn(it)) >= cutoff);
}
function rangeButtonsHtml(prefix, activeRange){
  return `<div class="tabs" style="margin-bottom:8px;">` + HIST_RANGES.map(r=>`<button class="tab-btn ${r.key===activeRange?'active':''}" onclick="${prefix}SetRange('${r.key}')">${r.label}</button>`).join('') + `</div>`;
}
/* <input type="date"> only gives "YYYY-MM-DD" with no time component, so building a Date
   straight from that string (then .toISOString()) silently drops to midnight UTC — losing
   the actual hour/minute the entry was logged at. This combines the chosen calendar day
   with the current local time instead, so same-day entries (the common case) keep full
   precision and backdated entries still get a sensible time-of-day rather than 00:00. */
function dateInputToISO(dateStr){
  if(!dateStr) return nowISO();
  const now = new Date();
  const [y,m,d] = dateStr.split('-').map(Number);
  if(!y || !m || !d) return nowISO();
  return new Date(y, m-1, d, now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds()).toISOString();
}
function fmtDate(iso){ if(!iso) return '—'; const d=new Date(iso); return d.toLocaleDateString(undefined,{year:'numeric',month:'short',day:'2-digit'})+' '+d.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'}); }
function fmtMoney(n){ n=Number(n||0); return '$'+n.toFixed(4).replace(/0+$/,'').replace(/\.$/,'.00'); }
function fmtMoney2(n){ return '$'+Number(n||0).toFixed(2); }

let DB = null;

/* Chart.js requires explicit .destroy() on the old instance before a canvas is reused/
   replaced, or the old instance stays registered internally (still tracked by its
   animation loop and global instance registry) even though its canvas is long gone.
   Since this app rebuilds its DOM (and canvases) on every render, every chart must be
   created through this helper so the previous instance is always cleaned up first. */
let chartRegistry = {};
function makeChart(key, el, config){
  if(chartRegistry[key]){
    try{ chartRegistry[key].destroy(); }catch(err){}
    delete chartRegistry[key];
  }
  const instance = new Chart(el, config);
  chartRegistry[key] = instance;
  return instance;
}
let hasUnsavedChanges = false;

function blankDB(){
  return {
    meta:{ createdAt: nowISO(), lastModified: nowISO(), name:'Untitled Inventory DB' },
    parts: [],
    boards: [],
    sales: [],
    journal: [],   // global journal: {id,date,text,author}
    banners: [],   // sticky banners: {id,date,text,color}
    purchasePlanning: { boardQtys:{}, stockMode:'inventory' } // {boardId: qty}; stockMode: 'inventory' | 'inventory_onorder'
  };
}

function seedDemo(){
  const db = blankDB();
  db.meta.name = 'Demo Production DB';
  function mkPart(cat, place, primaryAlias, alias2, qty, target, price, supplier, autosub, displayName, productLink){
    const p = {
      id: uid('part'), name: displayName || '', productLink: productLink || '', category:cat, placement:place, autoSubtractEnabled: autosub,
      targetQty: target, notes:'', currentQty: qty, onOrder: 0, currentPrice: price, currentSupplier: supplier,
      imageFile: null, files: [],
      aliases:[{id:uid('al'), value:primaryAlias, comment:'primary'}],
      history:{ qty:[{id:uid('h'),date:nowISO(),value:qty,delta:qty,comment:'Initial stock load'}],
                price:[{id:uid('h'),date:nowISO(),value:price,comment:'Initial price'}],
                supplier:[{id:uid('h'),date:nowISO(),value:supplier,comment:'Initial supplier'}],
                notes:[], comments:[], onOrder:[] }
    };
    if(alias2) p.aliases.push({id:uid('al'), value:alias2, comment:'alt part number'});
    return p;
  }
  db.parts.push(mkPart('Resistor','Machine Placed','RC0603FR-0710KL','10K-0603',4200,2000,0.0021,'Yageo',true,'10K Resistor 0603','https://www.digikey.com/en/products/detail/yageo/RC0603FR-0710KL/727118'));
  db.parts.push(mkPart('Capacitor','Machine Placed','GRM188R71H104KA93D','0.1UF-0603',6100,3000,0.0035,'Murata',true,'0.1uF Ceramic Cap 0603','https://www.digikey.com/en/products/detail/murata-electronics/GRM188R71H104KA93D/490967'));
  db.parts.push(mkPart('IC','Machine Placed','ATMEGA328P-AU',null,180,150,2.85,'Microchip Direct',true));
  db.parts.push(mkPart('Connector','Hand Placed','TE-1-1123723-2',null,60,100,0.42,'TE Connectivity',true));
  db.parts.push(mkPart('Inductor','Machine Placed','XAL4020-102MEB',null,900,500,0.31,'Coilcraft',true));
  const dPart = db.parts[3]; dPart.currentQty = 60; // force low stock demo
  dPart.onOrder = 200; dPart.history.onOrder.push({id:uid('h'),date:nowISO(),value:200,delta:200,comment:'PO #4471 placed with TE Connectivity'});

  const board = {
    id: uid('board'), name:'MainCtrl-RevB', description:'Primary controller board',
    boardQty: 42, stockTarget: 50, files: [],
    image:{ file:null, scale:1, offsetX:0, offsetY:0, rotation:0 }, markerSize: 12, partsScale: 1, view:{scale:1, offsetX:0, offsetY:0},
    partsList:[
      {id:uid('bp'), partNumber:'10K-0603', x:186,y:121.5,angle:0,comment:'R1', matchedPartId: db.parts[0].id, qtyPerBoard:4},
      {id:uid('bp'), partNumber:'0.1UF-0603', x:225,y:121.5,angle:90,comment:'C1', matchedPartId: db.parts[1].id, qtyPerBoard:6},
      {id:uid('bp'), partNumber:'ATMEGA328P-AU', x:300,y:300,angle:0,comment:'U1', matchedPartId: db.parts[2].id, qtyPerBoard:1},
      {id:uid('bp'), partNumber:'TE-1-1123723-2', x:30,y:30,angle:0,comment:'J1', matchedPartId: db.parts[3].id, qtyPerBoard:1},
    ],
    productionLog:[{id:uid('pl'), date:nowISO(), qty:42, comment:'Initial pilot run'}],
    journal:[{id:uid('bj'), date:nowISO(), type:'production', text:'Pilot run of 42 products completed', qtyDelta:42}]
  };
  db.boards.push(board);
  db.sales.push({id:uid('sale'), date:nowISO(), customer:'Acme Robotics', comment:'Initial order', notes:'Serial numbers: MC-B-1001, MC-B-1002, MC-B-1003, MC-B-1004, MC-B-1005', location:'Austin, TX', items:[{id:uid('si'), boardId:board.id, qty:5, price:34.5}]});
  db.journal.push({id:uid('gj'), date:nowISO(), text:'Database initialized with demo data.'});
  db.banners.push({id:uid('bn'), date:nowISO(), text:'Welcome — this is demo data. Import your own JSON or edit freely.', color:'copper'});
  return db;
}

/* ============================= SERVER PERSISTENCE =============================
   The database now lives server-side as data/config.json, served through a small
   Express API instead of only living in browser memory. On load we fetch it; if it
   doesn't exist yet (first run), we seed demo data and push it to the server. Every
   change still marks hasUnsavedChanges and updates the footer immediately, but the
   actual save to the server is debounced so rapid edits collapse into one request.

   Multi-user safety: the server tracks a version number that increments on every
   save. We poll /api/version once a second; if it's moved past what we last saw,
   another session made a change, so we pull the fresh copy and apply it — unless
   we're in the middle of something local (unsaved edits, a save in flight, a modal
   open, or a field focused), in which case we just wait for the next poll rather
   than yanking data out from under an active edit. Saves also carry the version we
   last saw; if the server's moved on since, the save is rejected instead of
   silently overwriting someone else's newer change, and we pull their copy instead. */
let localVersion = 0;
let saveTimer = null;
let saveInFlight = false;
let saveQueued = false;
let pollTimer = null;

function shouldDeferIncomingUpdate(){
  if(hasUnsavedChanges || saveInFlight || saveQueued) return true;
  const modalOpen = document.getElementById('modalOverlay').classList.contains('active');
  if(modalOpen) return true;
  const active = document.activeElement;
  if(active && ['INPUT','TEXTAREA','SELECT'].includes(active.tagName)) return true;
  return false;
}

function scheduleSave(){
  document.getElementById('footStatus').textContent = 'saving…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveConfigToServer, 700);
}

async function saveConfigToServer(){
  if(saveInFlight){ saveQueued = true; return; }
  saveInFlight = true;
  try{
    const res = await fetch('/api/config', {
      method:'PUT',
      headers:{'Content-Type':'application/json', 'X-Client-Version': String(localVersion)},
      body: JSON.stringify(DB)
    });
    if(res.status===409){
      // Someone else saved first — our change was NOT applied. Pull their version in
      // and clearly tell the user their edit needs to be redone, rather than silently
      // losing it or silently overwriting theirs.
      const conflict = await res.json().catch(()=>null);
      if(conflict && conflict.currentConfig){
        DB = conflict.currentConfig;
        DB.banners = DB.banners || [];
        DB.journal = DB.journal || [];
        DB.purchasePlanning = DB.purchasePlanning || { boardQtys:{}, stockMode:'inventory' };
        localVersion = (DB.meta && DB.meta.version) || conflict.currentVersion || localVersion;
        renderAll();
      }
      hasUnsavedChanges = false;
      document.getElementById('footStatus').textContent = 'conflict — refreshed';
      toast('Someone else saved changes first — your last change wasn\'t applied. Please check and redo it if needed.');
      return;
    }
    if(!res.ok) throw new Error('save failed: ' + res.status);
    const result = await res.json();
    localVersion = result.version || localVersion;
    hasUnsavedChanges = false;
    document.getElementById('footStatus').textContent = 'saved ' + new Date().toLocaleTimeString();
  }catch(err){
    document.getElementById('footStatus').textContent = 'save failed — retrying…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveConfigToServer, 3000);
  }finally{
    saveInFlight = false;
    if(saveQueued){ saveQueued = false; scheduleSave(); }
  }
}

async function loadFromServer(){
  try{
    const res = await fetch('/api/config');
    if(res.status===404){
      DB = seedDemo();
      renderAll();
      await saveConfigToServer();
      toast('New database created on server');
      return;
    }
    if(!res.ok) throw new Error('load failed: ' + res.status);
    DB = await res.json();
    DB.banners = DB.banners || [];
    DB.journal = DB.journal || [];
    DB.purchasePlanning = DB.purchasePlanning || { boardQtys:{}, stockMode:'inventory' };
    localVersion = (DB.meta && DB.meta.version) || 0;
    hasUnsavedChanges = false;
    document.getElementById('footStatus').textContent = 'loaded from server';
    renderAll();
  }catch(err){
    document.getElementById('footStatus').textContent = 'offline — using local demo data';
    DB = seedDemo();
    renderAll();
    toast('Could not reach server, working offline on demo data');
  }
  startVersionPolling();
}

function startVersionPolling(){
  clearInterval(pollTimer);
  pollTimer = setInterval(async ()=>{
    try{
      const res = await fetch('/api/version');
      if(!res.ok) return;
      const { version } = await res.json();
      if(version>localVersion && !shouldDeferIncomingUpdate()){
        const configRes = await fetch('/api/config');
        if(!configRes.ok) return;
        DB = await configRes.json();
        DB.banners = DB.banners || [];
        DB.journal = DB.journal || [];
        DB.purchasePlanning = DB.purchasePlanning || { boardQtys:{}, stockMode:'inventory' };
        localVersion = (DB.meta && DB.meta.version) || version;
        hasUnsavedChanges = false;
        renderAll();
        toast('The database was updated by another user — changes automatically applied!');
      }
    }catch(err){ /* transient network hiccup — just try again next tick */ }
  }, 1000);
}

loadFromServer();
loadMediaFiles();

function touch(){
  DB.meta.lastModified = nowISO();
  hasUnsavedChanges = true;
  document.getElementById('footStatus').textContent = 'unsaved changes…';
  scheduleSave();
}

/* ============================= MEDIA LIBRARY =============================
   Files (images, datasheets, spec sheets, etc.) now live on the server's disk under
   data/media, referenced by filename from parts/boards instead of being embedded as
   base64 — keeps the JSON small and lets the same file be reused in multiple places. */
let mediaFiles = [];
async function loadMediaFiles(){
  try{
    const res = await fetch('/api/media');
    if(!res.ok) throw new Error('failed to load media list');
    mediaFiles = await res.json();
  }catch(err){
    mediaFiles = [];
  }
  return mediaFiles;
}
function isImageFile(name){ return /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(name||''); }
function mediaUrl(name){ return '/media/' + encodeURIComponent(name); }
function fmtFileSize(bytes){
  if(bytes===undefined || bytes===null) return '';
  if(bytes<1024) return bytes+' B';
  if(bytes<1024*1024) return (bytes/1024).toFixed(1)+' KB';
  return (bytes/1024/1024).toFixed(1)+' MB';
}
async function uploadFileToMedia(file){
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch('/api/media/upload', {method:'POST', body:formData});
  if(!res.ok){ const e = await res.json().catch(()=>({error:'Upload failed'})); throw new Error(e.error||'Upload failed'); }
  const data = await res.json();
  await loadMediaFiles();
  return data.filename;
}
async function deleteMediaFile(filename){
  const res = await fetch('/api/media/' + encodeURIComponent(filename), {method:'DELETE'});
  if(!res.ok) throw new Error('Delete failed');
  await loadMediaFiles();
}
async function replaceMediaFile(filename, file){
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch('/api/media/' + encodeURIComponent(filename), {method:'PUT', body:formData});
  if(!res.ok){ const e = await res.json().catch(()=>({error:'Replace failed'})); throw new Error(e.error||'Replace failed'); }
  await loadMediaFiles();
}
function mediaFilterList(containerId, v){
  const s = v.toLowerCase();
  document.querySelectorAll(`#${containerId} .media-pick-row`).forEach(el=>{ el.style.display = el.dataset.s.includes(s) ? 'flex' : 'none'; });
}
/* Builds the "search existing files" list markup shared by every file picker modal. */
function mediaPickerListHtml(listId, onSelectFnName, excludeNames){
  const exclude = new Set(excludeNames||[]);
  const files = mediaFiles.filter(f=>!exclude.has(f.name));
  return `
    <div id="${listId}" style="max-height:180px;overflow-y:auto;margin-top:6px;border:1px solid var(--border);border-radius:6px;">
      ${files.map(f=>`<div class="ac-item media-pick-row" style="display:flex;justify-content:space-between;align-items:center;" data-s="${escapeHtml(f.name.toLowerCase())}" onclick="${onSelectFnName}('${jsAttrEscape(f.name)}')"><span>${isImageFile(f.name)?'🖼️':'📄'} ${escapeHtml(f.name)}</span><span class="sub">${fmtFileSize(f.size)}</span></div>`).join('') || `<div class="empty" style="padding:14px;">No media files yet — upload one above</div>`}
    </div>
  `;
}

/* ============================= UTIL ============================= */
function toast(msg){
  const w = document.getElementById('toastWrap');
  const t = document.createElement('div'); t.className='toast'; t.textContent = msg;
  w.appendChild(t); setTimeout(()=>{ t.style.opacity='0'; t.style.transition='opacity .3s'; setTimeout(()=>t.remove(),300); }, 2600);
}
function findPart(id){ return DB.parts.find(p=>p.id===id); }
function findBoard(id){ return DB.boards.find(b=>b.id===id); }
function partPrimaryName(p){ return (p.name && p.name.trim()) ? p.name.trim() : (p.aliases[0] ? p.aliases[0].value : '(no alias)'); }
function allAliasStrings(p){ return p.aliases.map(a=>a.value); }
function allSupplierNames(){ return Array.from(new Set(DB.parts.map(p=>p.currentSupplier).filter(Boolean))).sort(); }

function normalize(s){ return (s||'').toUpperCase().replace(/[\s\-_]/g,''); }
function fuzzyMatchParts(query){
  const q = normalize(query);
  if(!q) return [];
  const out = [];
  DB.parts.forEach(p=>{
    const candidates = p.aliases.map(a=>({value:a.value, comment:a.comment}));
    if(p.name && p.name.trim()) candidates.unshift({value:p.name, comment:'display name'});
    candidates.forEach(a=>{
      const av = normalize(a.value);
      if(!av) return;
      if(av.includes(q) || q.includes(av)){
        out.push({part:p, alias:a, score: Math.abs(av.length-q.length)});
      }
    });
  });
  out.sort((a,b)=>a.score-b.score);
  // dedupe by part id keep best
  const seen = new Set(); const res=[];
  out.forEach(o=>{ if(!seen.has(o.part.id)){ seen.add(o.part.id); res.push(o);} });
  return res;
}

function partLowState(p){
  if(p.targetQty<=0) return 'ok';
  const ratio = p.currentQty / p.targetQty;
  if(ratio <= LOW_STOCK_RATIO) return 'bad';
  if(ratio < 1) return 'warn';
  return 'ok';
}

/* Board-contextual low-stock check: a part is "low" for a given board if the number of
   boards buildable from that part's stock alone is below the board's Stock Target —
   independent of the part's own general target quantity used elsewhere in the app. */
function boardPartBuildable(part, qtyPerBoard){
  return qtyPerBoard>0 ? Math.floor(part.currentQty/qtyPerBoard) : Infinity;
}
function boardPartLowState(board, part, qtyPerBoard){
  const target = board.stockTarget||25;
  const buildable = boardPartBuildable(part, qtyPerBoard);
  if(!Number.isFinite(buildable)) return 'ok';
  if(buildable <= 0) return 'bad';
  if(buildable < target) return 'warn';
  return 'ok';
}

function boardsUsingPart(partId){
  const res = [];
  DB.boards.forEach(b=>{
    let qty=0;
    b.partsList.forEach(bp=>{ if(bp.matchedPartId===partId) qty += Number(bp.qtyPerBoard||1); });
    if(qty>0) res.push({board:b, qty});
  });
  return res;
}

function boardPartRows(board){
  // aggregate part usage per matched part
  const map = new Map();
  board.partsList.forEach(bp=>{
    if(!bp.matchedPartId) return;
    map.set(bp.matchedPartId, (map.get(bp.matchedPartId)||0) + Number(bp.qtyPerBoard||1));
  });
  return Array.from(map.entries()).map(([partId,qty])=>({part:findPart(partId), qty})).filter(r=>r.part);
}

function maxBuildable(board){
  const rows = boardPartRows(board);
  if(rows.length===0) return 0;
  let min = Infinity;
  rows.forEach(r=>{ min = Math.min(min, Math.floor(r.part.currentQty / r.qty)); });
  return min===Infinity?0:min;
}

/* ============================= NAV / PAGES ============================= */
const PAGES = [
  {id:'dashboard', tag:'OV', label:'Overview'},
  {id:'parts', tag:'PT', label:'Components'},
  {id:'quickupdate', tag:'QU', label:'Quick Update'},
  {id:'boards', tag:'PR', label:'Products'},
  {id:'purchasing', tag:'PP', label:'Purchase Planning'},
  {id:'sales', tag:'SL', label:'Sales'},
  {id:'journal', tag:'JN', label:'Journal'},
  {id:'media', tag:'MD', label:'Media'},
];
let currentPage = 'dashboard';
let currentPartId = null;
let currentBoardId = null;

function renderSidebar(){
  const pins = document.getElementById('pinRow');
  pins.innerHTML = Array.from({length:14}).map((_,i)=>`<div class="pin ${i%3===0?'active':''}"></div>`).join('');
  const nav = document.getElementById('navList');
  nav.innerHTML = PAGES.map(p=>`
    <div class="nav-item ${p.id===currentPage?'active':''}" onclick="goPage('${p.id}')">
      <div class="nav-tag">${p.tag}</div><div>${p.label}</div>
    </div>`).join('');
}
function goPage(id, opts){
  currentPage = id;
  if(opts && opts.partId!==undefined) currentPartId = opts.partId;
  if(opts && opts.boardId!==undefined) currentBoardId = opts.boardId;
  renderAll();
  window.scrollTo(0,0);
  if(id==='media') loadMediaFiles().then(renderAll);
}
window.goPage = goPage;

function renderAll(){
  renderSidebar();
  const pages = document.getElementById('pages');
  let html = '';
  if(currentPage==='dashboard') html = renderDashboard();
  else if(currentPage==='parts') html = currentPartId ? renderPartDetail(currentPartId) : renderPartsList();
  else if(currentPage==='quickupdate') html = renderQuickUpdate();
  else if(currentPage==='boards') html = currentBoardId ? renderBoardDetail(currentBoardId) : renderBoardsList();
  else if(currentPage==='purchasing') html = renderPurchasePlanning();
  else if(currentPage==='sales') html = renderSales();
  else if(currentPage==='journal') html = renderJournalPage();
  else if(currentPage==='media') html = renderMediaPage();
  pages.innerHTML = `<div class="page active">${html}</div>`;
  afterRenderHooks();
}
let afterRenderHooks = ()=>{};

/* ============================= STICKY BANNERS ============================= */
function renderBanners(){
  if(!DB.banners.length) return '';
  return `<div class="sticky-banner-bar">` + DB.banners.map(b=>`
    <div class="banner">
      <div><span class="txt">📌 ${escapeHtml(b.text)}</span></div>
      <div style="display:flex;align-items:center;gap:10px;">
        <span class="meta">${fmtDate(b.date)}</span>
        <span class="small-x" onclick="removeBanner('${b.id}')" style="float:none;">❌</span>
      </div>
    </div>`).join('') + `</div>`;
}
function removeBanner(id){ DB.banners = DB.banners.filter(b=>b.id!==id); touch(); renderAll(); }
function addBannerPrompt(){
  openModal(`
    <div class="modal-title">New Sticky Banner</div>
    <div class="field"><label>Message</label><textarea id="bnText" rows="3" placeholder="e.g. Line down for maintenance until Friday"></textarea></div>
    <button class="btn btn-primary" onclick="submitBanner()">Add Banner</button>
  `);
}
function submitBanner(){
  const t = document.getElementById('bnText').value.trim();
  if(!t) return;
  DB.banners.unshift({id:uid('bn'), date:nowISO(), text:t, color:'copper'});
  touch(); closeModal(); renderAll(); toast('Banner added');
}

function escapeHtml(s){ return (s||'').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
/* For embedding arbitrary text (e.g. a part number) as a single-quoted JS string literal
   inside an onclick="..." attribute: escape backslashes/quotes for JS first, then escapeHtml
   the result so the HTML attribute itself stays valid — order matters, see usage below. */
function jsAttrEscape(s){ return escapeHtml((s||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'")); }

/* ============================= MODAL ============================= */
function openModal(html){
  const body = document.getElementById('modalBody');
  body.style.width = ''; // reset in case a previous modal (e.g. the image viewer) widened it
  body.innerHTML = `<span class="modal-close" onclick="closeModal()">❌</span>${html}`;
  document.getElementById('modalOverlay').classList.add('active');
}
function closeModal(){ document.getElementById('modalOverlay').classList.remove('active'); }
function openImageViewer(url, title){
  openModal(`
    <div class="modal-title">${escapeHtml(title||'Image')}</div>
    <div style="display:flex;justify-content:center;">
      <img src="${url}" style="max-width:100%;max-height:70vh;object-fit:contain;border-radius:8px;">
    </div>
  `);
  document.getElementById('modalBody').style.width = 'min(90vw, 900px)';
}
/* Clicking outside the modal no longer closes it — only the ❌ button or an explicit
   Cancel/action button does, to avoid accidentally discarding in-progress edits. */

/* Native window.confirm() is blocked/auto-dismissed in this sandboxed environment, so use an in-app modal instead. */
let _pendingConfirmCallback = null;
function confirmAction(message, onConfirm){
  _pendingConfirmCallback = onConfirm;
  openModal(`
    <div class="modal-title">Confirm</div>
    <div style="font-size:13px;color:var(--text-dim);margin-bottom:20px;">${escapeHtml(message)}</div>
    <div style="display:flex;gap:8px;justify-content:flex-end;">
      <button class="btn" onclick="_pendingConfirmCallback=null;closeModal();">Cancel</button>
      <button class="btn btn-danger" onclick="runPendingConfirm()">Delete</button>
    </div>
  `);
}
function runPendingConfirm(){
  const cb = _pendingConfirmCallback;
  _pendingConfirmCallback = null;
  closeModal();
  if(cb) cb();
}

/* ============================= DASHBOARD ============================= */
function renderDashboard(){
  const totalParts = DB.parts.length;
  const lowParts = DB.parts.filter(p=>partLowState(p)!=='ok');
  const badParts = DB.parts.filter(p=>partLowState(p)==='bad');
  const totalValue = DB.parts.reduce((s,p)=>s+p.currentQty*p.currentPrice,0);
  const totalBoards = DB.boards.length;

  return `
    ${renderBanners()}
    <div class="page-header">
      <div>
        <div class="page-title"><span class="dot"></span> Overview</div>
        <div class="page-desc">Live snapshot across all components and products.</div>
      </div>
      <button class="btn" onclick="addBannerPrompt()">+ Sticky Banner</button>
    </div>

    <div class="grid grid-4" style="margin-bottom:18px;">
      <div class="stat"><div class="stat-label">Total Parts Tracked</div><div class="stat-val">${totalParts}</div></div>
      <div class="stat"><div class="stat-label">Below Target</div><div class="stat-val warn">${lowParts.length}</div></div>
      <div class="stat"><div class="stat-label">Critical (&lt;25% target)</div><div class="stat-val bad">${badParts.length}</div></div>
      <div class="stat"><div class="stat-label">Inventory Value</div><div class="stat-val good">${fmtMoney2(totalValue)}</div></div>
    </div>

    <div class="card">
      <div class="card-title">Stock Coverage Ratio (on hand ÷ target)</div>
      <div class="page-desc" style="margin-bottom:10px;">Sorted lowest coverage first. Below 1.0× means stock is under the part's target quantity.</div>
      <div style="max-height:600px;overflow-y:auto;border:1px solid var(--border-soft);border-radius:6px;">
        <div style="position:relative;height:${Math.max(240, DB.parts.length*22)}px;">
          <canvas id="dashChart"></canvas>
        </div>
      </div>
    </div>

    <div class="grid grid-2">
      <div class="card">
        <div class="card-title">Attention Needed <span class="badge red">${badParts.length} critical</span></div>
        ${lowParts.length===0 ? `<div class="empty">All parts at or above target ✅</div>` :
          `<div class="table-wrap"><table><thead><tr><th>Part</th><th>Qty</th><th>Target</th><th></th></tr></thead><tbody>
          ${lowParts.slice(0,8).map(p=>`
            <tr class="clickable" onclick="goPage('parts',{partId:'${p.id}'})">
              <td>${escapeHtml(partPrimaryName(p))}</td>
              <td>${p.currentQty}</td>
              <td>${p.targetQty}</td>
              <td>${partLowState(p)==='bad'?'<span class="badge red">critical</span>':'<span class="badge amber">low</span>'}</td>
            </tr>`).join('')}
          </tbody></table></div>`}
      </div>
      <div class="card">
        <div class="card-title">Products Summary</div>
        <div class="table-wrap"><table><thead><tr><th>Product</th><th>On Hand</th><th>Buildable Now</th><th>Parts</th></tr></thead><tbody>
        ${DB.boards.map(b=>`
          <tr class="clickable" onclick="goPage('boards',{boardId:'${b.id}'})">
            <td>${escapeHtml(b.name)}</td><td>${b.boardQty}</td><td>${maxBuildable(b)}</td><td>${boardPartRows(b).length}</td>
          </tr>`).join('') || `<tr><td colspan="4" class="empty">No products yet</td></tr>`}
        </tbody></table></div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Recent Journal Activity</div>
      ${renderJournalFeed(10)}
    </div>
  `;
}
function afterDashboard(){
  const el = document.getElementById('dashChart');
  if(!el) return;
  const withRatio = DB.parts.map(p=>({
    part:p,
    ratio: p.targetQty>0 ? (p.currentQty/p.targetQty) : Infinity
  })).sort((a,b)=> a.ratio - b.ratio); // lowest coverage first (top of chart)

  const colors = withRatio.map(x=> x.ratio<=LOW_STOCK_RATIO ? '#ef5b5b' : x.ratio<1 ? '#e8b23d' : '#34d399');

  makeChart('dashChart', el, {
    type:'bar',
    data:{ labels: withRatio.map(x=>partPrimaryName(x.part)),
      datasets:[{ label:'Coverage vs Target', data: withRatio.map(x=>Number.isFinite(x.ratio)?Number(x.ratio.toFixed(3)):null), backgroundColor:colors, borderRadius:3 }]},
    options:{
      indexAxis:'y', responsive:true, maintainAspectRatio:false,
      plugins:{
        legend:{display:false},
        tooltip:{ callbacks:{
          label:(ctx)=>{
            const x = withRatio[ctx.dataIndex];
            if(!Number.isFinite(x.ratio)) return `On hand ${x.part.currentQty} / no target set`;
            return `On hand ${x.part.currentQty} / target ${x.part.targetQty} (${(x.ratio*100).toFixed(0)}%)`;
          }
        }}
      },
      scales:{
        x:{ ticks:{ color:'#8fa79b', callback:(v)=> v+'×' }, grid:{color:'#1a2926'}, title:{display:true,text:'Stock ÷ Target',color:'#8fa79b'} },
        y:{ ticks:{ color:'#8fa79b', autoSkip:false, font:{size:10.5} }, grid:{display:false} }
      }
    }
  });
}

/* combine journal from global + boards for feed */
let journalHideProductionReductions = true; // hides the noisy per-part auto-subtract entries caused by logging production runs
let journalHideComponentQtyChanges = false; // hides all other (non-production) component quantity change log entries
let journalHideComponentOnOrder = false; // hides component on-order change log entries
function combinedJournal(){
  let items = DB.journal.map(j=>({date:j.date, text:j.text, scope: j.type==='comment' ? 'comment' : 'General', entityType:null, entityId:null, entityName:null}));
  DB.boards.forEach(b=>{
    b.journal.forEach(j=>items.push({date:j.date, text:j.text, scope:j.type||'board', entityType:'board', entityId:b.id, entityName:b.name}));
  });
  DB.parts.forEach(p=>{
    (p.history.qty||[]).forEach(h=>items.push({date:h.date, text:`qty → ${h.value} (${h.comment||'update'})`, scope: h.source==='production' ? 'part-qty-production' : 'part-qty', entityType:'part', entityId:p.id, entityName:partPrimaryName(p)}));
    (p.history.comments||[]).forEach(h=>items.push({date:h.date, text:h.value, scope:'comment', entityType:'part', entityId:p.id, entityName:partPrimaryName(p)}));
    (p.history.onOrder||[]).forEach(h=>items.push({date:h.date, text:`on order → ${h.value} (${h.comment||'update'})`, scope:'part-onorder', entityType:'part', entityId:p.id, entityName:partPrimaryName(p)}));
  });
  if(journalHideProductionReductions) items = items.filter(it=>it.scope!=='part-qty-production');
  if(journalHideComponentQtyChanges) items = items.filter(it=>it.scope!=='part-qty');
  if(journalHideComponentOnOrder) items = items.filter(it=>it.scope!=='part-onorder');
  items.sort((a,b)=> new Date(b.date)-new Date(a.date));
  return items;
}
let journalRenderCache = [];
function renderJournalFeed(limit){
  const all = combinedJournal();
  journalRenderCache = all;
  const items = all.slice(0, limit||50);
  if(!items.length) return `<div class="empty">No activity yet</div>`;
  return items.map((it,idx)=>{
    const isComment = it.scope==='comment';
    return `<div class="hist-row journal-row ${isComment?'journal-comment':''}" onclick="openJournalEntryModal(${idx})">
      <span>${isComment?'<span class="badge green" style="margin-right:6px;">📌 NOTE</span>':''}${it.entityName?`<span class="badge blue" style="margin-right:6px;">${escapeHtml(it.entityName)}</span>`:''}${escapeHtml(it.text)}</span>
      <span class="d">${fmtDate(it.date)}</span>
    </div>`;
  }).join('');
}
function openJournalEntryModal(idx){
  const it = journalRenderCache[idx];
  if(!it) return;
  const isComment = it.scope==='comment';
  const entityPage = it.entityType==='board' ? 'boards' : 'parts';
  const entityParam = it.entityType==='board' ? 'boardId' : 'partId';
  const entityLabel = it.entityType==='board' ? 'Product' : 'Component';
  openModal(`
    <div class="modal-title">${isComment?'📌 Comment':'Journal Entry'}</div>
    <div class="kv"><span>Date</span><b>${fmtDate(it.date)}</b></div>
    <div class="kv"><span>Type</span><b>${isComment?'User Comment':escapeHtml(it.scope)}</b></div>
    ${it.entityName ? `<div class="kv"><span>${entityLabel}</span><b><a href="#" onclick="closeModal();goPage('${entityPage}',{${entityParam}:'${it.entityId}'});return false;" style="color:var(--trace);font-weight:700;">${escapeHtml(it.entityName)} →</a></b></div>` : ''}
    <div style="margin-top:14px;padding:12px;background:var(--panel-2);border:1px solid var(--border);border-radius:8px;font-size:12.5px;color:var(--text);white-space:pre-wrap;line-height:1.5;">${escapeHtml(it.text)}</div>
  `);
}

/* ============================= PARTS LIST ============================= */
let partsFilter = { category:'', placement:'', lowOnly:false, search:'' };
function partsSearchLive(v){
  partsFilter.search = v;
  const s = v.trim().toLowerCase();
  document.querySelectorAll('.parts-row').forEach(el=>{
    el.style.display = (!s || el.dataset.s.includes(s)) ? '' : 'none';
  });
}
let partsSortState = { key:null, dir:1 };
function partsSortBy(key){
  if(partsSortState.key===key){ partsSortState.dir *= -1; } else { partsSortState.key = key; partsSortState.dir = 1; }
  renderAll();
}
function partsSortValue(p, key){
  switch(key){
    case 'name': return partPrimaryName(p).toLowerCase();
    case 'category': return (p.category||'').toLowerCase();
    case 'placement': return (p.placement||'').toLowerCase();
    case 'qty': return p.currentQty;
    case 'target': return p.targetQty;
    case 'stocklevel': return p.targetQty>0 ? (p.currentQty/p.targetQty) : Infinity;
    case 'status': { const st=partLowState(p); return st==='bad'?0:st==='warn'?1:2; }
    case 'price': return p.currentPrice;
    case 'supplier': return (p.currentSupplier||'').toLowerCase();
    case 'autosub': return p.autoSubtractEnabled?1:0;
    case 'onorder': return p.onOrder||0;
    case 'usedby': return boardsUsingPart(p.id).length;
    default: return '';
  }
}
function partsSortTh(label, key){
  const active = partsSortState.key===key;
  const arrow = active ? (partsSortState.dir===1?' ↑':' ↓') : '';
  return `<th style="cursor:pointer;user-select:none;" onclick="partsSortBy('${key}')" title="Sort by ${label}">${label}${arrow}</th>`;
}

function renderPartsList(){
  const cats = Array.from(new Set(DB.parts.map(p=>p.category).filter(Boolean)));
  let rows = DB.parts.filter(p=>{
    if(partsFilter.category && p.category!==partsFilter.category) return false;
    if(partsFilter.placement && p.placement!==partsFilter.placement) return false;
    if(partsFilter.lowOnly && partLowState(p)==='ok') return false;
    if(partsFilter.search){
      const s = partsFilter.search.toLowerCase();
      const hit = allAliasStrings(p).some(a=>a.toLowerCase().includes(s)) || (p.notes||'').toLowerCase().includes(s) || (p.name||'').toLowerCase().includes(s) || (p.currentSupplier||'').toLowerCase().includes(s);
      if(!hit) return false;
    }
    return true;
  });

  if(partsSortState.key){
    rows = rows.slice().sort((a,b)=>{
      const va = partsSortValue(a, partsSortState.key);
      const vb = partsSortValue(b, partsSortState.key);
      if(va<vb) return -1*partsSortState.dir;
      if(va>vb) return 1*partsSortState.dir;
      return 0;
    });
  }

  return `
    ${renderBanners()}
    <div class="page-header">
      <div>
        <div class="page-title"><span class="dot"></span> Components</div>
        <div class="page-desc">${DB.parts.length} parts tracked · manage aliases, pricing, suppliers and history.</div>
      </div>
      <button class="btn btn-primary" onclick="openPartForm()">+ Add Part</button>
    </div>

    <div class="card">
      <div class="grid grid-4" style="align-items:end;">
        <div class="field" style="margin-bottom:0;"><label>Search</label><input type="text" value="${escapeHtml(partsFilter.search)}" oninput="partsSearchLive(this.value)" placeholder="name, alias, supplier, notes..."></div>
        <div class="field" style="margin-bottom:0;"><label>Category</label>
          <select onchange="partsFilter.category=this.value;renderAll()">
            <option value="">All</option>
            ${cats.map(c=>`<option value="${c}" ${partsFilter.category===c?'selected':''}>${c}</option>`).join('')}
          </select>
        </div>
        <div class="field" style="margin-bottom:0;"><label>Placement</label>
          <select onchange="partsFilter.placement=this.value;renderAll()">
            <option value="">All</option>
            <option ${partsFilter.placement==='Machine Placed'?'selected':''}>Machine Placed</option>
            <option ${partsFilter.placement==='Hand Placed'?'selected':''}>Hand Placed</option>
          </select>
        </div>
        <div class="field" style="margin-bottom:0;">
          <label><input type="checkbox" style="width:auto;" ${partsFilter.lowOnly?'checked':''} onchange="partsFilter.lowOnly=this.checked;renderAll()"> Low stock only</label>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="table-wrap"><table>
        <thead><tr>${partsSortTh('Part','name')}${partsSortTh('Category','category')}${partsSortTh('Placement','placement')}${partsSortTh('Used By','usedby')}${partsSortTh('Qty','qty')}${partsSortTh('On Order','onorder')}${partsSortTh('Target','target')}${partsSortTh('Stock Level %','stocklevel')}${partsSortTh('Status','status')}${partsSortTh('Price','price')}${partsSortTh('Supplier','supplier')}${partsSortTh('Auto-Sub','autosub')}<th></th></tr></thead>
        <tbody id="partsTbody">
        ${rows.map(p=>{
          const st = partLowState(p);
          const usedByCount = boardsUsingPart(p.id).length;
          const searchText = [...allAliasStrings(p), p.notes||'', p.name||'', p.currentSupplier||''].join(' ').toLowerCase();
          return `<tr class="clickable parts-row" data-s="${escapeHtml(searchText)}" onclick="goPage('parts',{partId:'${p.id}'})">
            <td><span class="${p.imageFile?'part-thumb-wrap':''}"><b>${escapeHtml(partPrimaryName(p))}</b>${p.imageFile?`<span class="thumb-preview"><img src="${mediaUrl(p.imageFile)}" style="cursor:pointer;" onclick="event.stopPropagation();openImageViewer('${mediaUrl(p.imageFile)}','${jsAttrEscape(partPrimaryName(p))}')" title="Click to enlarge"></span>`:''}</span>${p.productLink?` <a href="${escapeHtml(p.productLink)}" target="_blank" rel="noopener" onclick="event.stopPropagation()" style="color:var(--trace);text-decoration:none;" title="Open product link">🔗</a>`:''}${p.aliases.length>1?`<div style="color:var(--text-faint);font-size:10.5px;">+${p.aliases.length-1} alias(es)</div>`:''}</td>
            <td>${escapeHtml(p.category||'—')}</td>
            <td>${escapeHtml(p.placement||'—')}</td>
            <td>${usedByCount>0?`<span style="text-decoration:underline dotted;cursor:pointer;" onclick="event.stopPropagation();openUsedByModal('${p.id}')">${usedByCount} product${usedByCount===1?'':'s'}</span>`:'—'}</td>
            <td>${p.currentQty} <span class="small-x" style="float:none;color:var(--text-faint);" title="Adjust stock" onclick="event.stopPropagation();openStockAdjustForm('${p.id}')">📝</span></td>
            <td>${p.onOrder>0?p.onOrder:'—'} <span class="small-x" style="float:none;color:var(--text-faint);" title="Edit on order" onclick="event.stopPropagation();openOnOrderForm('${p.id}')">📝</span></td>
            <td>${p.targetQty}</td>
            <td>${p.targetQty>0 ? (p.currentQty/p.targetQty*100).toFixed(0)+'%' : '—'}</td>
            <td>${st==='ok'?'<span class="badge green">OK</span>':st==='warn'?'<span class="badge amber">Low</span>':'<span class="badge red">Critical</span>'}</td>
            <td>${fmtMoney(p.currentPrice)}</td>
            <td>${escapeHtml(p.currentSupplier||'—')}</td>
            <td>${p.autoSubtractEnabled?'<span class="badge green">Yes</span>':'<span class="badge">No</span>'}</td>
            <td><span class="small-x" style="float:none;color:var(--text-faint);" title="Edit part" onclick="event.stopPropagation();openPartEditForm('${p.id}')">📝</span> <span class="small-x" onclick="event.stopPropagation();deletePart('${p.id}')" style="float:none;">❌</span></td>
          </tr>`;
        }).join('') || `<tr><td colspan="13" class="empty"><div class="big">No parts match</div>Try clearing filters or add a new part.</td></tr>`}
        </tbody>
      </table></div>
    </div>
  `;
}
function openUsedByModal(partId){
  const p = findPart(partId);
  if(!p) return;
  const usage = boardsUsingPart(partId);
  openModal(`
    <div class="modal-title">Used By — ${escapeHtml(partPrimaryName(p))}</div>
    ${usage.length===0 ? `<div class="empty">Not used on any product yet</div>` :
    `<div class="table-wrap"><table><thead><tr><th>Product</th><th>Qty / Unit</th><th>On Hand</th><th>Total Committed</th></tr></thead><tbody>
      ${usage.map(u=>`<tr class="clickable" onclick="closeModal();goPage('boards',{boardId:'${u.board.id}'})">
        <td>${escapeHtml(u.board.name)}</td><td>${u.qty}</td><td>${u.board.boardQty}</td><td>${u.qty*u.board.boardQty}</td>
      </tr>`).join('')}
    </tbody></table></div>`}
  `);
}
function deletePart(id){
  confirmAction('Delete this part? This cannot be undone.', ()=>{
    DB.parts = DB.parts.filter(p=>p.id!==id);
    DB.boards.forEach(b=> b.partsList.forEach(bp=>{ if(bp.matchedPartId===id) bp.matchedPartId=null; }));
    touch(); renderAll(); toast('Part deleted');
  });
}
function removePartImage(partId){
  const p = findPart(partId);
  if(!p) return;
  p.imageFile = null;
  touch(); renderAll(); toast('Image removed from part (file stays in Media)');
}
/* Generic media-picker context: several different "pick or upload a file" actions across
   the app (part image, product image, part attachment, product attachment) all reuse the
   same modal + list markup, routed through this one context object and handler so the
   onclick generated by mediaPickerListHtml only ever needs to pass the filename. */
let mediaPickerContext = null;
function onMediaPicked(filename){
  if(!mediaPickerContext) return;
  const ctx = mediaPickerContext;
  mediaPickerContext = null;
  if(ctx.type==='partImage') setPartImage(ctx.id, filename);
  else if(ctx.type==='boardImage') setBoardImage(ctx.id, filename);
  else if(ctx.type==='partFile') addFileToPart(ctx.id, filename);
  else if(ctx.type==='boardFile') addFileToBoard(ctx.id, filename);
}
function openPartImagePicker(partId){
  mediaPickerContext = {type:'partImage', id:partId};
  openModal(`
    <div class="modal-title">Set Component Image</div>
    <div class="field"><label>Upload New Image</label><input type="file" id="genericMediaUpload" accept="image/*"></div>
    <button class="btn btn-sm btn-primary" onclick="submitGenericMediaUpload()">Upload &amp; Use</button>
    <label style="margin-top:16px;">Or Pick An Existing Media File</label>
    <input type="text" autocomplete="off" placeholder="Search media files..." oninput="mediaFilterList('genericMediaPickList', this.value)">
    ${mediaPickerListHtml('genericMediaPickList', 'onMediaPicked')}
  `);
}
async function submitGenericMediaUpload(){
  const input = document.getElementById('genericMediaUpload');
  const file = input.files[0];
  if(!file){ toast('Choose a file first'); return; }
  try{
    const filename = await uploadFileToMedia(file);
    onMediaPicked(filename);
  }catch(err){
    toast('Upload failed: ' + err.message);
  }
}
function setPartImage(partId, filename){
  const p = findPart(partId);
  if(!p) return;
  p.imageFile = filename;
  touch(); closeModal(); renderAll(); toast('Component image set');
}

let pendingMatchContext = null;
function openPartForm(prefillAlias, matchContext){
  pendingMatchContext = matchContext || null;
  openModal(`
    <div class="modal-title">Add New Part${matchContext?' &amp; Match':''}</div>
    <div class="field"><label>Display Name (optional — falls back to primary alias below if blank)</label><input type="text" id="npName" placeholder="e.g. 10K Resistor 0603"></div>
    <div class="field"><label>Primary Part Number / Alias(es)</label><input type="text" id="npAlias" value="${escapeHtml(prefillAlias||'')}" placeholder="e.g. RC0603FR-0710KL, RC0603JR-0710KL">
      <div class="page-desc" style="margin-top:4px;">Separate multiple with commas to add them all at once — the first becomes primary, the rest are added with no comment.</div>
    </div>
    <div class="field"><label>Product Link (URL)</label><input type="text" id="npLink" placeholder="https://... supplier / datasheet page"></div>
    <div class="grid grid-2">
      <div class="field"><label>Category</label><input type="text" id="npCat" placeholder="Resistor, Capacitor, IC..." list="catList">
        <datalist id="catList">${Array.from(new Set(DB.parts.map(p=>p.category))).map(c=>`<option value="${c}">`).join('')}</datalist>
      </div>
      <div class="field"><label>Placement</label>
        <select id="npPlacement"><option>Machine Placed</option><option>Hand Placed</option></select>
      </div>
      <div class="field"><label>Initial Qty</label><input type="number" id="npQty" value="0"></div>
      <div class="field"><label>Target Qty</label><input type="number" id="npTarget" value="0"></div>
      <div class="field"><label>Price (per unit)</label><input type="number" step="0.0001" id="npPrice" value="0"></div>
      <div class="field"><label>Supplier</label><input type="text" id="npSupplier" list="supplierList" placeholder="Start typing or pick a previous supplier">
        <datalist id="supplierList">${allSupplierNames().map(s=>`<option value="${escapeHtml(s)}">`).join('')}</datalist>
      </div>
    </div>
    <div class="field"><label>Notes</label><textarea id="npNotes" rows="2"></textarea></div>
    <div class="field"><label><input type="checkbox" id="npAuto" style="width:auto;" checked> Auto-subtract inventory on product production</label></div>
    <button class="btn btn-primary" onclick="submitNewPart()">${matchContext?'Create &amp; Match':'Create Part'}</button>
  `);
}
function submitNewPart(){
  const aliasInput = document.getElementById('npAlias').value.trim();
  if(!aliasInput){ toast('Alias / part number required'); return; }
  const aliasValues = aliasInput.split(',').map(a=>a.trim()).filter(Boolean);
  if(aliasValues.length===0){ toast('Alias / part number required'); return; }
  const aliases = aliasValues.map((v,i)=>({id:uid('al'), value:v, comment: i===0?'primary':''}));
  const p = {
    id: uid('part'),
    name: document.getElementById('npName').value.trim(),
    productLink: document.getElementById('npLink').value.trim(),
    category: document.getElementById('npCat').value.trim(),
    placement: document.getElementById('npPlacement').value,
    autoSubtractEnabled: document.getElementById('npAuto').checked,
    targetQty: Number(document.getElementById('npTarget').value)||0,
    notes: document.getElementById('npNotes').value.trim(),
    currentQty: Number(document.getElementById('npQty').value)||0,
    onOrder: 0,
    currentPrice: Number(document.getElementById('npPrice').value)||0,
    currentSupplier: document.getElementById('npSupplier').value.trim(),
    imageFile: null, files: [],
    aliases: aliases,
    history:{ qty:[{id:uid('h'),date:nowISO(),value:Number(document.getElementById('npQty').value)||0,delta:Number(document.getElementById('npQty').value)||0,comment:'Part created'}],
              price:[{id:uid('h'),date:nowISO(),value:Number(document.getElementById('npPrice').value)||0,comment:'Initial price'}],
              supplier:[{id:uid('h'),date:nowISO(),value:document.getElementById('npSupplier').value.trim(),comment:'Initial supplier'}],
              notes:[], comments:[], onOrder:[] }
  };
  DB.parts.push(p);
  touch();
  if(pendingMatchContext){
    const ctx = pendingMatchContext; pendingMatchContext = null;
    submitMatch(ctx.boardId, ctx.rowId, p.id);
  } else {
    closeModal(); goPage('parts',{partId:p.id}); toast('Part created');
  }
}

/* ============================= PART DETAIL ============================= */
let partHistTab = 'all';
let partHistRange = 'all';
function partHistSetRange(r){ partHistRange = r; renderAll(); }
function renderPartDetail(id){
  const p = findPart(id);
  if(!p){ currentPartId=null; return renderPartsList(); }
  const st = partLowState(p);
  const usage = boardsUsingPart(id);

  return `
    <div class="page-header">
      <div>
        <div class="page-title"><span class="dot"></span> ${escapeHtml(partPrimaryName(p))}</div>
        <div class="page-desc">${escapeHtml(p.category||'Uncategorized')} · ${escapeHtml(p.placement||'—')} ${st!=='ok'?(st==='bad'?'<span class="badge red">Critical</span>':'<span class="badge amber">Low</span>'):'<span class="badge green">OK</span>'}</div>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn" onclick="goPage('parts',{partId:null})">← All Parts</button>
        <button class="btn btn-primary" onclick="openStockAdjustForm('${p.id}')">Adjust Stock</button>
      </div>
    </div>

    <div class="grid grid-5">
      <div class="stat compact"><div class="stat-label">On Hand</div><div class="stat-val ${st}">${p.currentQty}</div></div>
      <div class="stat compact"><div class="stat-label">Target</div><div class="stat-val">${p.targetQty}</div></div>
      <div class="stat compact"><div class="stat-label">Unit Price</div><div class="stat-val">${fmtMoney(p.currentPrice)}</div></div>
      <div class="stat compact"><div class="stat-label">Extended Value</div><div class="stat-val good">${fmtMoney2(p.currentQty*p.currentPrice)}</div></div>
      <div class="stat compact"><div class="stat-label">On Order</div><div class="stat-val">${p.onOrder||0} <span class="small-x" style="float:none;color:var(--text-faint);font-size:11px;" title="Edit on order" onclick="openOnOrderForm('${p.id}')">📝</span></div></div>
    </div>
    <div class="card" style="margin-top:4px;">
      <div class="bar-track"><div class="bar-fill ${st==='ok'?'':st}" style="width:${Math.min(100,(p.currentQty/Math.max(p.targetQty,1))*100)}%"></div></div>
    </div>

    <div class="card">
      <div class="card-title">Component Image</div>
      <div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap;">
        ${p.imageFile ? `<img src="${mediaUrl(p.imageFile)}" style="width:120px;height:120px;object-fit:contain;background:var(--panel-3);border:1px solid var(--border);border-radius:8px;padding:6px;cursor:pointer;" onclick="openImageViewer('${mediaUrl(p.imageFile)}','${jsAttrEscape(partPrimaryName(p))}')" title="Click to enlarge">` : `<div style="width:120px;height:120px;display:flex;align-items:center;justify-content:center;background:var(--panel-3);border:1px dashed var(--border);border-radius:8px;color:var(--text-faint);font-size:11px;text-align:center;padding:6px;">No image</div>`}
        <div style="display:flex;flex-direction:column;gap:8px;">
          <button class="btn btn-sm" onclick="openPartImagePicker('${p.id}')">${p.imageFile?'Replace Image':'Set Image'}</button>
          ${p.imageFile?`<button class="btn btn-sm btn-danger" onclick="removePartImage('${p.id}')">Remove Image</button>`:''}
          ${p.imageFile?`<span style="font-size:10.5px;color:var(--text-faint);font-family:var(--mono);">${escapeHtml(p.imageFile)}</span>`:''}
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Files <span class="badge" style="cursor:pointer;" onclick="openPartFileAttachPicker('${p.id}')">+ Attach</span></div>
      <div class="page-desc" style="margin-bottom:10px;">Datasheets, manufacturer order specs, or any other reference file for this component.</div>
      ${renderFilesListHtml(p.files, 'part', p.id)}
    </div>

    <div class="grid grid-2">
      <div class="card">
        <div class="card-title">Details <span class="badge" style="cursor:pointer;" onclick="openPartEditForm('${p.id}')">Edit</span></div>
        <div class="kv"><span>Part ID</span><b style="font-family:var(--mono);font-size:10.5px;">${p.id}</b></div>
        <div class="kv"><span>Category</span><b>${escapeHtml(p.category||'—')}</b></div>
        <div class="kv"><span>Placement</span><b>${escapeHtml(p.placement||'—')}</b></div>
        <div class="kv"><span>Supplier</span><b>${escapeHtml(p.currentSupplier||'—')}</b></div>
        <div class="kv"><span>Auto-subtract on production</span><b>${p.autoSubtractEnabled?'Enabled':'Disabled'}</b></div>
        <div class="kv"><span>Target Qty</span><b>${p.targetQty}</b></div>
        <div class="kv"><span>Product Link</span><b>${p.productLink ? `<a href="${escapeHtml(p.productLink)}" target="_blank" rel="noopener" style="color:var(--trace);">Open ↗</a>` : '—'}</b></div>
        <div style="margin-top:10px;"><label>Notes</label><div style="font-size:12.5px;color:var(--text-dim);white-space:pre-wrap;">${escapeHtml(p.notes||'No notes.')}</div></div>
      </div>

      <div class="card">
        <div class="card-title">Aliases / Part Numbers <span class="badge" style="cursor:pointer;" onclick="openAliasForm('${p.id}')">+ Add</span></div>
        <div class="table-wrap"><table><thead><tr><th>Value</th><th>Comment</th><th></th></tr></thead><tbody>
        ${p.aliases.map(a=>`<tr>
          <td style="font-family:var(--mono);">${escapeHtml(a.value)}</td>
          <td>${escapeHtml(a.comment||'—')}</td>
          <td><span class="small-x" onclick="removeAlias('${p.id}','${a.id}')" style="float:none;">❌</span></td>
        </tr>`).join('')}
        </tbody></table></div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Field History</div>
      <div class="tabs">
        ${['all','qty','price','supplier','notes','comments','onOrder'].map(t=>`<button class="tab-btn ${partHistTab===t?'active':''}" onclick="partHistTab='${t}';renderAll()">${t==='onOrder'?'ON ORDER':t.toUpperCase()}</button>`).join('')}
      </div>
      ${(partHistTab==='all'||partHistTab==='comments') ? `
        <div style="max-height:340px;overflow-y:auto;">
        ${(partHistTab==='all' ? allFieldHistory(p) : (p.history.comments||[]).slice().reverse().map(h=>({field:'comments',...h}))).map(h=>`
          <div class="hist-row"><span>${partHistTab==='all'?`<span class="badge blue" style="margin-right:6px;">${h.field.toUpperCase()}</span>`:''}<span class="v">${escapeHtml(String(h.value))}${h.delta!==undefined?` (${h.delta>0?'+':''}${h.delta})`:''}</span>${h.comment?` — ${escapeHtml(h.comment)}`:''}</span><span style="display:flex;align-items:center;gap:8px;"><span class="d">${fmtDate(h.date)}</span><span class="small-x" onclick="deletePartHistoryEntry('${p.id}','${h.field}','${h.id}')" style="float:none;">❌</span></span></div>
        `).join('') || `<div class="empty">No history yet</div>`}
        </div>
      ` : `
      <div class="grid grid-2">
        <div>
          ${rangeButtonsHtml('partHist', partHistRange)}
          <canvas id="partHistChart" height="200"></canvas>
        </div>
        <div style="max-height:260px;overflow-y:auto;">
        ${(p.history[partHistTab]||[]).slice().reverse().map(h=>`
          <div class="hist-row"><span class="v">${escapeHtml(String(h.value))}${h.delta!==undefined?` (${h.delta>0?'+':''}${h.delta})`:''}${h.comment?` — ${escapeHtml(h.comment)}`:''}</span><span style="display:flex;align-items:center;gap:8px;"><span class="d">${fmtDate(h.date)}</span><span class="small-x" onclick="deletePartHistoryEntry('${p.id}','${partHistTab}','${h.id}')" style="float:none;">❌</span></span></div>
        `).join('') || `<div class="empty">No history for this field yet</div>`}
        </div>
      </div>
      `}
    </div>

    <div class="card">
      <div class="card-title">Used In Products</div>
      ${usage.length===0 ? `<div class="empty">Not used on any product yet</div>` :
      `<div class="table-wrap"><table><thead><tr><th>Product</th><th>Qty / Product</th><th>Products On Hand</th><th>Total Committed</th></tr></thead><tbody>
        ${usage.map(u=>`<tr class="clickable" onclick="goPage('boards',{boardId:'${u.board.id}'})">
          <td>${escapeHtml(u.board.name)}</td><td>${u.qty}</td><td>${u.board.boardQty}</td><td>${u.qty*u.board.boardQty}</td>
        </tr>`).join('')}
      </tbody></table></div>`}
    </div>
  `;
}
function allFieldHistory(p){
  const fields = ['qty','price','supplier','notes','comments','onOrder'];
  let items = [];
  fields.forEach(f=>{ (p.history[f]||[]).forEach(h=>items.push({field:f, ...h})); });
  items.sort((a,b)=> new Date(b.date) - new Date(a.date));
  return items;
}
function deletePartHistoryEntry(partId, field, entryId){
  const p = findPart(partId);
  if(!p || !p.history[field]) return;
  confirmAction('Delete this history entry? This only removes the log entry — it does not change the part\'s current value.', ()=>{
    p.history[field] = p.history[field].filter(h=>h.id!==entryId);
    touch(); renderAll(); toast('History entry deleted');
  });
}
afterRenderHooks = function(){
  if(currentPage==='dashboard') afterDashboard();
  if(currentPage==='parts' && currentPartId) afterPartDetail();
  if(currentPage==='boards' && currentBoardId) afterBoardDetail();
  if(currentPage==='purchasing') afterPurchasePlanning();
  if(currentPage==='sales' && salesPageTab==='graph') afterSalesGraph();
};
function afterPurchasePlanning(){
  const withRatio = ppComputeAggregate();
  if(withRatio.length>0) renderCoverageChart('ppChart', withRatio);
  const buildableList = ppComputeBuildable();
  if(buildableList.length>0) renderBuildableChart('ppBuildableChart', buildableList);
}
function renderBuildableChart(canvasId, buildableList){
  const el = document.getElementById(canvasId);
  if(!el) return;
  const colors = buildableList.map(x=>{
    if(x.planned<=0) return '#5b9bef';
    if(x.buildable < x.planned) return '#ef5b5b';
    if(x.buildable < x.planned*1.5) return '#e8b23d';
    return '#34d399';
  });
  const chartInstance = makeChart(canvasId, el, { type:'bar',
    data:{ labels: buildableList.map(x=>x.board.name),
      datasets:[{ label:'Buildable', data: buildableList.map(x=>x.buildable), backgroundColor:colors, borderRadius:3 }]},
    options:{
      indexAxis:'y', responsive:true, maintainAspectRatio:false,
      plugins:{
        legend:{display:false},
        tooltip:{ callbacks:{ label:(ctx)=>{
          const x = buildableList[ctx.dataIndex];
          const lines = [`Can build ${x.buildable} from stock on hand.`];
          if(x.planned>0) lines.push(`Plan calls for ${x.planned}.`);
          lines.push('Click to open this product →');
          return lines;
        }}}
      },
      scales:{
        x:{ ticks:{color:'#8fa79b'}, grid:{color:'#1a2926'}, title:{display:true,text:'Products Buildable From Stock',color:'#8fa79b'} },
        y:{ ticks:{color:'#34d399', autoSkip:false, font:{size:10.5}}, grid:{display:false} }
      }
    }
  });
  el.onclick = (e)=>{
    try{
      const pos = Chart.helpers.getRelativePosition(e, chartInstance);
      const area = chartInstance.chartArea;
      if(pos.x < area.left && pos.y >= area.top && pos.y <= area.bottom){
        const idx = Math.round(chartInstance.scales.y.getValueForPixel(pos.y));
        const x = buildableList[idx];
        if(x) goPage('boards',{boardId:x.board.id});
        return;
      }
      const elements = chartInstance.getElementsAtEventForMode(e, 'nearest', {intersect:true}, false);
      if(elements.length){
        const x = buildableList[elements[0].index];
        goPage('boards',{boardId:x.board.id});
      }
    }catch(err){}
  };
  el.onmousemove = (e)=>{
    try{
      const pos = Chart.helpers.getRelativePosition(e, chartInstance);
      const area = chartInstance.chartArea;
      const overLabel = pos.x < area.left && pos.y >= area.top && pos.y <= area.bottom;
      const elements = chartInstance.getElementsAtEventForMode(e, 'nearest', {intersect:true}, false);
      el.style.cursor = (overLabel || elements.length) ? 'pointer' : 'default';
    }catch(err){}
  };
}
function afterPartDetail(){
  const p = findPart(currentPartId);
  if(!p) return;
  const el = document.getElementById('partHistChart');
  if(!el) return;
  const h = filterByRange(p.history[partHistTab]||[], partHistRange, x=>x.date);
  makeChart('partHistChart', el, { type:'line',
    data:{ labels: h.map(x=>new Date(x.date).toLocaleDateString()),
      datasets:[{label:partHistTab, data:h.map(x=>typeof x.value==='number'?x.value:0), borderColor:'#34d399', backgroundColor:'rgba(52,211,153,.15)', tension:.2, fill:true}]},
    options:{ plugins:{legend:{display:false}}, scales:{ x:{ticks:{color:'#8fa79b'},grid:{color:'#1a2926'}}, y:{ticks:{color:'#8fa79b'},grid:{color:'#1a2926'}} } }
  });
}

function openPartEditForm(id){
  const p = findPart(id);
  openModal(`
    <div class="modal-title">Edit ${escapeHtml(partPrimaryName(p))}</div>
    <div class="field"><label>Display Name (blank = use primary alias)</label><input type="text" id="epName" value="${escapeHtml(p.name||'')}" placeholder="${escapeHtml(p.aliases[0]?p.aliases[0].value:'')}"></div>
    <div class="field"><label>Product Link (URL)</label><input type="text" id="epLink" value="${escapeHtml(p.productLink||'')}" placeholder="https://... supplier / datasheet page"></div>
    <div class="grid grid-2">
      <div class="field"><label>Category</label><input type="text" id="epCat" value="${escapeHtml(p.category||'')}"></div>
      <div class="field"><label>Placement</label><select id="epPlacement"><option ${p.placement==='Machine Placed'?'selected':''}>Machine Placed</option><option ${p.placement==='Hand Placed'?'selected':''}>Hand Placed</option></select></div>
      <div class="field"><label>Target Qty</label><input type="number" id="epTarget" value="${p.targetQty}"></div>
      <div class="field"><label><input type="checkbox" id="epAuto" style="width:auto;" ${p.autoSubtractEnabled?'checked':''}> Auto-subtract inventory</label></div>
    </div>
    <div class="field"><label>Notes</label><textarea id="epNotes" rows="3">${escapeHtml(p.notes||'')}</textarea></div>
    <div class="grid grid-2">
      <div class="field"><label>New Price</label><input type="number" step="0.0001" id="epPrice" value="${p.currentPrice}"></div>
      <div class="field"><label>New Supplier</label><input type="text" id="epSupplier" value="${escapeHtml(p.currentSupplier||'')}" list="supplierListEdit">
        <datalist id="supplierListEdit">${allSupplierNames().map(s=>`<option value="${escapeHtml(s)}">`).join('')}</datalist>
      </div>
    </div>
    <div class="field"><label>Change comment (applies to price/supplier/notes history)</label><input type="text" id="epComment" placeholder="e.g. supplier switched due to lead time"></div>
    <button class="btn btn-primary" onclick="submitPartEdit('${p.id}')">Save Changes</button>
  `);
}
function submitPartEdit(id){
  const p = findPart(id);
  const comment = document.getElementById('epComment').value.trim() || 'Field updated';
  const oldDisplay = partPrimaryName(p);
  const newName = document.getElementById('epName').value.trim();
  if(newName !== (p.name||'')){
    p.name = newName;
    DB.journal.push({id:uid('gj'), date:nowISO(), text:`Part [${id}] renamed: "${oldDisplay}" → "${partPrimaryName(p)}"`});
  }
  p.category = document.getElementById('epCat').value.trim();
  p.placement = document.getElementById('epPlacement').value;
  p.productLink = document.getElementById('epLink').value.trim();
  p.autoSubtractEnabled = document.getElementById('epAuto').checked;
  const newTarget = Number(document.getElementById('epTarget').value)||0;
  p.targetQty = newTarget;
  const newNotes = document.getElementById('epNotes').value.trim();
  if(newNotes !== p.notes){ p.history.notes.push({id:uid('h'),date:nowISO(),value:newNotes,comment}); }
  p.notes = newNotes;
  const newPrice = Number(document.getElementById('epPrice').value)||0;
  if(newPrice !== p.currentPrice){ p.history.price.push({id:uid('h'),date:nowISO(),value:newPrice,comment}); p.currentPrice = newPrice; }
  const newSupplier = document.getElementById('epSupplier').value.trim();
  if(newSupplier !== p.currentSupplier){ p.history.supplier.push({id:uid('h'),date:nowISO(),value:newSupplier,comment}); p.currentSupplier = newSupplier; }
  touch(); closeModal(); renderAll(); toast('Part updated');
}

function openAliasForm(partId){
  openModal(`
    <div class="modal-title">Add Alias / Part Number</div>
    <div class="field"><label>Part Number / Alias</label><input type="text" id="alVal" placeholder="e.g. new replacement P/N"></div>
    <div class="field"><label>Comment</label><input type="text" id="alComment" placeholder="e.g. discontinued, new replacement, 2nd source..."></div>
    <button class="btn btn-primary" onclick="submitAlias('${partId}')">Add</button>
  `);
}
function submitAlias(partId){
  const v = document.getElementById('alVal').value.trim();
  if(!v) return;
  const p = findPart(partId);
  p.aliases.push({id:uid('al'), value:v, comment:document.getElementById('alComment').value.trim()});
  touch(); closeModal(); renderAll(); toast('Alias added');
}
function removeAlias(partId, aliasId){
  const p = findPart(partId);
  if(p.aliases.length<=1){ toast('Part must keep at least one alias'); return; }
  p.aliases = p.aliases.filter(a=>a.id!==aliasId);
  touch(); renderAll();
}

function openOnOrderForm(partId){
  const p = findPart(partId);
  if(!p) return;
  openModal(`
    <div class="modal-title">On Order — ${escapeHtml(partPrimaryName(p))}</div>
    <div class="kv"><span>Current On Order</span><b>${p.onOrder||0}</b></div>
    <div class="kv"><span>Current Stock</span><b>${p.currentQty}</b></div>
    <div class="field"><label>New On Order Quantity</label><input type="number" id="ooQty" value="${p.onOrder||0}" min="0"></div>
    <div class="field"><label>Comment</label><input type="text" id="ooComment" placeholder="e.g. PO number, supplier, reason for change"></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      <button class="btn btn-primary" onclick="submitOnOrderEdit('${p.id}')">Save</button>
      ${p.onOrder>0?`<button class="btn" onclick="receiveOnOrderInFull('${p.id}')">Receive In Full (+${p.onOrder} to stock)</button>`:''}
      ${p.onOrder>0?`<button class="btn btn-danger" onclick="cancelOnOrderQty('${p.id}')">Cancel Pending Purchase</button>`:''}
    </div>
  `);
}
function submitOnOrderEdit(partId){
  const p = findPart(partId);
  if(!p) return;
  const newQty = Math.max(0, Number(document.getElementById('ooQty').value)||0);
  const comment = document.getElementById('ooComment').value.trim();
  const delta = newQty - (p.onOrder||0);
  if(delta===0){ closeModal(); return; }
  if(!p.history.onOrder) p.history.onOrder = [];
  p.history.onOrder.push({id:uid('h'), date:nowISO(), value:newQty, delta, comment: comment || 'On order quantity updated'});
  p.onOrder = newQty;
  touch(); closeModal(); renderAll(); toast('On order updated');
}
function receiveOnOrderInFull(partId){
  const p = findPart(partId);
  if(!p || !(p.onOrder>0)) return;
  const qty = p.onOrder;
  confirmAction(`Receive all ${qty} pending for ${partPrimaryName(p)}? This adds ${qty} to stock and completes the pending purchase.`, ()=>{
    // applyStockOp's "add" already reduces on-order by the amount received, so receiving
    // the full pending qty here brings on-order down to exactly 0 in one step.
    applyStockOp(p, 'add', qty, 'Received in full against pending purchase');
    closeModal(); renderAll(); toast('Purchase received in full');
  });
}
function cancelOnOrderQty(partId){
  const p = findPart(partId);
  if(!p) return;
  confirmAction(`Cancel the pending purchase of ${p.onOrder} for ${partPrimaryName(p)}?`, ()=>{
    if(!p.history.onOrder) p.history.onOrder = [];
    p.history.onOrder.push({id:uid('h'), date:nowISO(), value:0, delta:-(p.onOrder||0), comment:'Pending purchase cancelled'});
    p.onOrder = 0;
    touch(); closeModal(); renderAll(); toast('Pending purchase cancelled');
  });
}
const STOCK_OPS = [
  {key:'add', label:'Add', desc:'Add received stock to current inventory. Also reduces On Order by the same amount if there is a pending purchase.'},
  {key:'remove', label:'Remove', desc:'Subtract stock from current inventory — used, scrapped, lost, etc.'},
  {key:'set', label:'Set', desc:'Directly set current inventory to an exact quantity, e.g. after a physical count.'},
  {key:'onorder', label:'On Order', desc:'Record a pending purchase — adds to On Order without touching current stock.'},
  {key:'comment', label:'Note', desc:"Log a comment to this part's journal without changing any quantity."}
];
function buildOpButtonsHtml(prefix, activeOp){
  return `<div class="op-btn-row" id="${prefix}OpRow">` + STOCK_OPS.map(o=>`
    <button type="button" class="op-btn ${o.key===activeOp?'active':''}" data-op="${o.key}" onclick="${prefix}SetOp('${o.key}')">
      ${o.label}
      <span class="op-tip">${escapeHtml(o.desc)}</span>
    </button>`).join('') + `</div>`;
}
let lastStockOp = 'add'; // remembers the most recently used operation across both dialogs, for this session
let saCurrentOp = 'add';
function openStockAdjustForm(partId){
  const p = findPart(partId);
  saCurrentOp = lastStockOp;
  openModal(`
    <div class="modal-title">Adjust Stock — ${escapeHtml(partPrimaryName(p))}</div>
    <div class="field"><label>Operation</label>
      ${buildOpButtonsHtml('sa', saCurrentOp)}
    </div>
    <div class="field" id="saQtyField" style="${saCurrentOp==='comment'?'display:none;':''}"><label>Quantity</label><input type="number" id="saQty" value="1"></div>
    <div class="page-desc" id="saOnOrderHint" style="${saCurrentOp==='onorder'?'':'display:none;'}margin-top:-6px;margin-bottom:12px;">Current on order: ${p.onOrder||0}. Receiving stock via "Add" automatically reduces this.</div>
    <div class="field"><label>Comment</label><input type="text" id="saComment" placeholder="reason / note"></div>
    <button class="btn btn-primary" onclick="submitStockAdjust('${partId}')">Apply</button>
  `);
}
function saSetOp(op){
  saCurrentOp = op; lastStockOp = op;
  document.querySelectorAll('#saOpRow .op-btn').forEach(b=>b.classList.toggle('active', b.dataset.op===op));
  document.getElementById('saQtyField').style.display = op==='comment' ? 'none':'block';
  document.getElementById('saOnOrderHint').style.display = op==='onorder' ? 'block':'none';
}
function submitStockAdjust(partId){
  const p = findPart(partId);
  const comment = document.getElementById('saComment').value.trim();
  applyStockOp(p, saCurrentOp, Number(document.getElementById('saQty').value)||0, comment);
  closeModal(); renderAll(); toast('Stock updated');
}
function applyStockOp(p, op, qty, comment, source){
  let delta = 0; let newVal = p.currentQty;
  if(op==='add'){ delta = qty; newVal = p.currentQty + qty; }
  else if(op==='remove'){ delta = -qty; newVal = p.currentQty - qty; }
  else if(op==='set'){ delta = qty - p.currentQty; newVal = qty; }
  else if(op==='comment'){
    if(!p.history.comments) p.history.comments = [];
    p.history.comments.push({id:uid('h'), date:nowISO(), value: comment || '(no comment text)'});
    touch(); return;
  }
  else if(op==='onorder'){
    if(!p.history.onOrder) p.history.onOrder = [];
    const newOnOrder = (p.onOrder||0) + qty;
    p.history.onOrder.push({id:uid('h'), date:nowISO(), value:newOnOrder, delta:qty, comment: comment || 'Purchase order placed'});
    p.onOrder = newOnOrder;
    touch(); return;
  }
  p.currentQty = newVal;
  p.history.qty.push({id:uid('h'), date:nowISO(), value:newVal, delta, comment: comment || (op==='set'?'Stock set':op==='add'?'Stock added':'Stock removed'), source});
  // Receiving stock ("Add Stock") reduces the pending on-order quantity by the same amount,
  // since that's presumably the order arriving. Clamped at 0 so it never goes negative.
  if(op==='add' && p.onOrder>0){
    if(!p.history.onOrder) p.history.onOrder = [];
    const reduceBy = Math.min(qty, p.onOrder);
    const newOnOrder = p.onOrder - reduceBy;
    p.history.onOrder.push({id:uid('h'), date:nowISO(), value:newOnOrder, delta:-reduceBy, comment:`Received ${reduceBy} against pending order`});
    p.onOrder = newOnOrder;
  }
  touch();
}

/* ============================= QUICK UPDATE ============================= */
let quAcResults = []; let quSelectedPart = null;
function renderQuickUpdate(){
  return `
    ${renderBanners()}
    <div class="page-header">
      <div>
        <div class="page-title"><span class="dot"></span> Quick Update</div>
        <div class="page-desc">Scan a reel label or type a part number — matches on any alias, no exact match required.</div>
      </div>
    </div>
    <div class="card" style="max-width:640px;">
      <div class="field autocomplete-wrap">
        <label>Scan / Part Name</label>
        <input type="text" id="quInput" autocomplete="off" placeholder="Scan barcode or type part number..." oninput="quOnInput(this.value)" onkeydown="quKeyNav(event)">
        <div class="autocomplete-list" id="quAcList" style="display:none;"></div>
      </div>
      <div id="quSelectedBox"></div>
    </div>
  `;
}
function quOnInput(val){
  quSelectedPart = null;
  document.getElementById('quSelectedBox').innerHTML = '';
  if(!val.trim()){ document.getElementById('quAcList').style.display='none'; return; }
  quAcResults = fuzzyMatchParts(val);
  const list = document.getElementById('quAcList');
  if(quAcResults.length===0){ list.style.display='none'; return; }
  list.innerHTML = quAcResults.slice(0,8).map((r,i)=>`
    <div class="ac-item" onclick="quSelectPart('${r.part.id}')">
      <div>${escapeHtml(r.alias.value)}</div>
      <div class="sub">${escapeHtml(r.part.category||'')} · on hand ${r.part.currentQty} ${r.alias.comment?('· '+escapeHtml(r.alias.comment)):''}</div>
    </div>`).join('');
  list.style.display='block';
}
function quKeyNav(e){
  if(e.key==='Enter' && quAcResults.length>0){ quSelectPart(quAcResults[0].part.id); }
}
let quCurrentOp = 'add';
function quSelectPart(partId){
  quSelectedPart = findPart(partId);
  quCurrentOp = lastStockOp;
  document.getElementById('quAcList').style.display='none';
  document.getElementById('quInput').value = partPrimaryName(quSelectedPart);
  const st = partLowState(quSelectedPart);
  document.getElementById('quSelectedBox').innerHTML = `
    <div class="card" style="background:var(--panel-2);margin-top:14px;">
      <div class="kv"><span>Matched Part</span><b>${escapeHtml(partPrimaryName(quSelectedPart))}</b></div>
      <div class="kv"><span>On Hand</span><b>${quSelectedPart.currentQty} ${st!=='ok'?(st==='bad'?'<span class=\"badge red\">critical</span>':'<span class=\"badge amber\">low</span>'):''}</b></div>
      <div class="kv"><span>On Order</span><b>${quSelectedPart.onOrder||0}</b></div>
      <div class="field" style="margin-top:12px;"><label>Operation</label>
        ${buildOpButtonsHtml('qu', quCurrentOp)}
      </div>
      <div class="field" id="quQtyField" style="${quCurrentOp==='comment'?'display:none;':''}"><label>Quantity</label><input type="number" id="quQty" value="1"></div>
      <div class="page-desc" id="quOnOrderHint" style="${quCurrentOp==='onorder'?'':'display:none;'}margin-top:-6px;margin-bottom:12px;">Receiving stock via "Add" automatically reduces on order.</div>
      <div class="field"><label>Comment</label><input type="text" id="quComment" placeholder="optional"></div>
      <button class="btn btn-primary" onclick="submitQuickUpdate()">Apply</button>
    </div>
  `;
}
function quSetOp(op){
  quCurrentOp = op; lastStockOp = op;
  document.querySelectorAll('#quOpRow .op-btn').forEach(b=>b.classList.toggle('active', b.dataset.op===op));
  document.getElementById('quQtyField').style.display = op==='comment'?'none':'block';
  document.getElementById('quOnOrderHint').style.display = op==='onorder'?'block':'none';
}
function submitQuickUpdate(){
  if(!quSelectedPart){ toast('Select a valid part first'); return; }
  const qty = Number(document.getElementById('quQty').value)||0;
  const comment = document.getElementById('quComment').value.trim();
  applyStockOp(quSelectedPart, quCurrentOp, qty, comment);
  toast('Applied: ' + partPrimaryName(quSelectedPart));
  document.getElementById('quInput').value='';
  document.getElementById('quSelectedBox').innerHTML='';
  quSelectedPart=null;
}

/* ============================= BOARDS LIST ============================= */
function renderBoardsList(){
  return `
    ${renderBanners()}
    <div class="page-header">
      <div>
        <div class="page-title"><span class="dot"></span> Products</div>
        <div class="page-desc">${DB.boards.length} products · production, BOM, PCB reference &amp; stock.</div>
      </div>
      <button class="btn btn-primary" onclick="openBoardForm()">+ Add Product</button>
    </div>
    <div class="grid grid-3">
      ${DB.boards.map(b=>{
        const buildable = maxBuildable(b);
        const rows = boardPartRows(b);
        const lowCount = rows.filter(r=>boardPartLowState(b, r.part, r.qty)!=='ok').length;
        return `
        <div class="card clickable" onclick="goPage('boards',{boardId:'${b.id}'})">
          <div style="display:flex;justify-content:space-between;align-items:start;">
            <div class="card-title" style="margin-bottom:4px;">${escapeHtml(b.name)}</div>
            <div style="display:flex;gap:10px;align-items:center;">
              <span class="badge" style="cursor:pointer;" onclick="event.stopPropagation();openBoardEditForm('${b.id}')">Edit</span>
              <span class="small-x" onclick="event.stopPropagation();deleteBoard('${b.id}')">❌</span>
            </div>
          </div>
          <div style="font-size:11.5px;color:var(--text-faint);margin-bottom:12px;">${escapeHtml(b.description||'No description')}</div>
          <div class="kv"><span>On Hand</span><b>${b.boardQty} <span class="small-x" style="float:none;color:var(--text-faint);" title="Adjust stock" onclick="event.stopPropagation();openBoardStockAdjustForm('${b.id}')">📝</span></b></div>
          <div class="kv"><span>Stock Target</span><b>${b.stockTarget||25}</b></div>
          <div class="kv"><span>Buildable Now</span><b>${buildable}</b></div>
          <div class="kv"><span>BOM Lines</span><b>${rows.length}</b></div>
          <div class="kv"><span>Low Parts</span><b class="${lowCount>0?'bad':''}" style="color:${lowCount>0?'var(--red)':'inherit'}">${lowCount}</b></div>
        </div>`;
      }).join('') || `<div class="empty">No products yet — add one to get started</div>`}
    </div>
  `;
}
function openBoardForm(){
  openModal(`
    <div class="modal-title">Add New Product</div>
    <div class="field"><label>Product Name</label><input type="text" id="nbName" placeholder="e.g. MainCtrl-RevC"></div>
    <div class="field"><label>Description</label><textarea id="nbDesc" rows="2"></textarea></div>
    <div class="grid grid-2">
      <div class="field"><label>Initial Products On Hand</label><input type="number" id="nbQty" value="0"></div>
      <div class="field"><label>Stock Target (default product count for coverage charts)</label><input type="number" id="nbStockTarget" value="25"></div>
    </div>
    <button class="btn btn-primary" onclick="submitNewBoard()">Create Product</button>
  `);
}
function submitNewBoard(){
  const name = document.getElementById('nbName').value.trim();
  if(!name){ toast('Product name required'); return; }
  const b = {
    id:uid('board'), name, description:document.getElementById('nbDesc').value.trim(),
    boardQty:Number(document.getElementById('nbQty').value)||0,
    stockTarget: Number(document.getElementById('nbStockTarget').value)||25,
    files: [],
    image:{file:null, scale:1, offsetX:0, offsetY:0, rotation:0}, markerSize:12, partsScale:1, view:{scale:1, offsetX:0, offsetY:0},
    partsList:[], productionLog:[], journal:[{id:uid('bj'),date:nowISO(),type:'manual',text:'Product created',qtyDelta:0}]
  };
  DB.boards.push(b); touch(); closeModal(); goPage('boards',{boardId:b.id}); toast('Board created');
}
function deleteBoard(id){
  confirmAction('Delete this product and all its logs?', ()=>{
    DB.boards = DB.boards.filter(b=>b.id!==id); touch(); renderAll(); toast('Board deleted');
  });
}
function openBoardEditForm(id){
  const b = findBoard(id);
  openModal(`
    <div class="modal-title">Edit Product</div>
    <div class="field"><label>Product Name</label><input type="text" id="ebName" value="${escapeHtml(b.name)}"></div>
    <div class="field"><label>Description</label><textarea id="ebDesc" rows="2">${escapeHtml(b.description||'')}</textarea></div>
    <div class="field"><label>Stock Target (default product count for coverage charts)</label><input type="number" id="ebStockTarget" value="${b.stockTarget||25}"></div>
    <button class="btn btn-primary" onclick="submitBoardEdit('${b.id}')">Save Changes</button>
  `);
}
function submitBoardEdit(id){
  const b = findBoard(id);
  const newName = document.getElementById('ebName').value.trim();
  if(!newName){ toast('Product name required'); return; }
  const oldName = b.name;
  b.name = newName;
  b.description = document.getElementById('ebDesc').value.trim();
  b.stockTarget = Number(document.getElementById('ebStockTarget').value)||25;
  if(newName !== oldName){
    b.journal.push({id:uid('bj'), date:nowISO(), type:'manual', text:`Product renamed: "${oldName}" → "${newName}"`, qtyDelta:0});
  }
  touch(); closeModal(); renderAll(); toast('Product updated');
}

/* ============================= BOARD DETAIL ============================= */
let boardTab = 'overview';
let boardJournalFilter = 'all';
let boardStockRange = 'all';
function boardStockSetRange(r){ boardStockRange = r; renderAll(); }
function renderBoardDetail(id){
  const b = findBoard(id);
  if(!b){ currentBoardId=null; return renderBoardsList(); }
  const rows = boardPartRows(b);
  const buildable = maxBuildable(b);
  const totalPrice = rows.reduce((s,r)=>s+r.part.currentPrice*r.qty,0);

  return `
    <div class="page-header">
      <div>
        <div class="page-title"><span class="dot"></span> ${escapeHtml(b.name)} <span class="small-x" style="float:none;font-size:16px;color:var(--text-faint);" title="Edit product" onclick="openBoardEditForm('${b.id}')">📝</span></div>
        <div class="page-desc">${escapeHtml(b.description||'')}</div>
      </div>
      <div style="display:flex;gap:8px;">
        <button class="btn" onclick="goPage('boards',{boardId:null})">← All Products</button>
      </div>
    </div>

    <div class="tabs">
      ${['overview','bom','pcb','production','stock','sales','journal'].map(t=>`<button class="tab-btn ${boardTab===t?'active':''}" onclick="boardTab='${t}';renderAll()">${t.toUpperCase()}</button>`).join('')}
    </div>

    ${boardTab==='overview' ? renderBoardOverview(b, rows, buildable, totalPrice) : ''}
    ${boardTab==='bom' ? renderBoardBOM(b) : ''}
    ${boardTab==='pcb' ? renderBoardPCB(b) : ''}
    ${boardTab==='production' ? renderBoardProduction(b) : ''}
    ${boardTab==='stock' ? renderBoardStock(b, rows) : ''}
    ${boardTab==='sales' ? renderBoardSales(b) : ''}
    ${boardTab==='journal' ? renderBoardJournal(b) : ''}
  `;
}
function afterBoardDetail(){
  const b = findBoard(currentBoardId);
  if(!b) return;
  if(boardTab==='overview') setupPcbReadOnlyInteraction(b);
  if(boardTab==='pcb') setupPcbInteraction(b);
  if(boardTab==='bom') applyBomFilter();
  if(boardTab==='stock'){
    const el = document.getElementById('boardStockChart');
    if(el){
      // Compute the cumulative running total over ALL history first, then only display the
      // points within the selected range — otherwise filtering first would make the running
      // total incorrectly restart from 0 at the start of the window instead of showing the
      // true on-hand level at that point in time.
      const allLog = b.journal.filter(j=>j.qtyDelta).slice().sort((a,b2)=>new Date(a.date)-new Date(b2.date));
      let running = 0;
      const allPoints = allLog.map(j=>{ running+=j.qtyDelta; return {date:j.date, y:running}; });
      const points = filterByRange(allPoints, boardStockRange, x=>x.date);
      makeChart('boardStockChart', el, { type:'line', data:{ labels:points.map(p=>new Date(p.date).toLocaleDateString()), datasets:[{label:'Products On Hand (cumulative)', data:points.map(p=>p.y), borderColor:'#34d399', backgroundColor:'rgba(52,211,153,.15)', fill:true, tension:.2}] },
        options:{ plugins:{legend:{labels:{color:'#8fa79b'}}}, scales:{ x:{ticks:{color:'#8fa79b'},grid:{color:'#1a2926'}}, y:{ticks:{color:'#8fa79b'},grid:{color:'#1a2926'}} } } });
    }
  }
  if(boardTab==='sales') afterBoardSalesChart(b);
}

/* Generic horizontal stock-coverage bar chart, used by Purchase Planning. Expects
   withRatio items shaped as {part, ratio, tooltipLines:[...]}, sorted lowest-coverage-
   first by the caller. Clicking a part name opens that component's page; clicking its
   bar opens an at-a-glance info popup (never jumps straight to an external link) with
   the same stats as the tooltip, the supplier link as a real clickable link inside it,
   and — since this chart only appears in Purchase Planning — a breakdown of how this
   part affects each of the currently-selected products. */
function renderCoverageChart(canvasId, withRatio){
  const el = document.getElementById(canvasId);
  if(!el) return;
  const colors = withRatio.map(x=> !Number.isFinite(x.ratio) ? '#34d399' : x.ratio<1 ? '#ef5b5b' : x.ratio<1.5 ? '#e8b23d' : '#34d399');
  const chartInstance = makeChart(canvasId, el, { type:'bar',
    data:{ labels: withRatio.map(x=>partPrimaryName(x.part)),
      datasets:[{ label:'Coverage', data: withRatio.map(x=>Number.isFinite(x.ratio)?Number(x.ratio.toFixed(3)):0), backgroundColor: colors, borderRadius:3 }]},
    options:{
      indexAxis:'y', responsive:true, maintainAspectRatio:false,
      plugins:{
        legend:{display:false},
        tooltip:{ callbacks:{ label:(ctx)=>{
          const x = withRatio[ctx.dataIndex];
          const lines = x.tooltipLines.slice();
          lines.push('Click bar for part details');
          lines.push('Click part name to view component page →');
          return lines;
        }}}
      },
      scales:{
        x:{ ticks:{ color:'#8fa79b', callback:(v)=> v+'×' }, grid:{color:'#1a2926'}, title:{display:true,text:'Available ÷ Required',color:'#8fa79b'} },
        y:{ ticks:{ color:'#34d399', autoSkip:false, font:{size:10.5} }, grid:{display:false} }
      }
    }
  });
  el.onclick = (e)=>{
    try{
      const pos = Chart.helpers.getRelativePosition(e, chartInstance);
      const area = chartInstance.chartArea;
      if(pos.x < area.left && pos.y >= area.top && pos.y <= area.bottom){
        const idx = Math.round(chartInstance.scales.y.getValueForPixel(pos.y));
        const x = withRatio[idx];
        if(x) goPage('parts',{partId:x.part.id});
        return;
      }
      const elements = chartInstance.getElementsAtEventForMode(e, 'nearest', {intersect:true}, false);
      if(elements.length){
        const x = withRatio[elements[0].index];
        openPartCoveragePopup(x);
      }
    }catch(err){ /* stale chart reference from a fast re-render — ignore this click */ }
  };
  el.onmousemove = (e)=>{
    try{
      const pos = Chart.helpers.getRelativePosition(e, chartInstance);
      const area = chartInstance.chartArea;
      const overLabel = pos.x < area.left && pos.y >= area.top && pos.y <= area.bottom;
      const elements = chartInstance.getElementsAtEventForMode(e, 'nearest', {intersect:true}, false);
      el.style.cursor = (overLabel || elements.length) ? 'pointer' : 'default';
    }catch(err){}
  };
}
function openPartCoveragePopup(x){
  const p = x.part;
  const pp = DB.purchasePlanning;
  const includeOnOrder = pp.stockMode==='inventory_onorder';
  // Cross-reference against every product in the current plan that uses this part, so
  // you can see at a glance which builds are affected and how many of each you could
  // still make — not just this one part's own coverage number.
  const productRows = ppSelectedBoards().map(b=>{
    const rows = boardPartRows(b);
    const row = rows.find(r=>r.part.id===p.id);
    if(!row) return null;
    let buildable = Infinity;
    rows.forEach(r=>{
      const avail = r.part.currentQty + (includeOnOrder ? (r.part.onOrder||0) : 0);
      buildable = Math.min(buildable, Math.floor(avail/r.qty));
    });
    if(!Number.isFinite(buildable)) buildable = 0;
    const thisPartAvail = p.currentQty + (includeOnOrder ? (p.onOrder||0) : 0);
    const enoughFor = row.qty>0 ? Math.floor(thisPartAvail/row.qty) : Infinity;
    return { board:b, qtyPerUnit: row.qty, buildable, enoughFor };
  }).filter(Boolean);

  openModal(`
    <div class="modal-title">${escapeHtml(partPrimaryName(p))}</div>
    <div class="kv"><span>Category</span><b>${escapeHtml(p.category||'—')}</b></div>
    <div style="margin:10px 0;font-size:12.5px;color:var(--text-dim);line-height:1.6;">
      ${x.tooltipLines.map(l=>`<div>${escapeHtml(l)}</div>`).join('')}
    </div>
    <div><label>Notes</label><div style="font-size:12.5px;color:var(--text-dim);white-space:pre-wrap;">${escapeHtml(p.notes||'No notes.')}</div></div>
    ${productRows.length>0 ? `
    <div style="margin-top:16px;">
      <label>Used In Selected Products</label>
      <div class="page-desc" style="margin:4px 0 8px 0;">"Enough Parts For" is what <i>this</i> part alone allows — "Buildable" is the real number once every other part in that product is accounted for too. When they match, this part is the bottleneck.</div>
      <div class="table-wrap" style="max-height:220px;overflow-y:auto;"><table><thead><tr><th>Product</th><th>Qty/Unit</th><th>Enough Parts For</th><th>Buildable</th></tr></thead><tbody>
      ${productRows.map(r=>{
        const isBottleneck = r.enoughFor===r.buildable;
        return `<tr class="clickable" onclick="closeModal();goPage('boards',{boardId:'${r.board.id}'})">
        <td>${escapeHtml(r.board.name)}</td>
        <td>${r.qtyPerUnit}</td>
        <td>${Number.isFinite(r.enoughFor)?r.enoughFor:'∞'} ${isBottleneck?'<span class="badge red" title="This part is the limiting factor for this product">bottleneck</span>':''}</td>
        <td>${r.buildable}</td>
      </tr>`;
      }).join('')}
      </tbody></table></div>
    </div>
    ` : ''}
    <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap;">
      ${p.productLink ? `<a class="btn btn-sm" href="${escapeHtml(p.productLink)}" target="_blank" rel="noopener">Open Supplier Page ↗</a>` : ''}
      <button class="btn btn-sm btn-primary" onclick="closeModal();goPage('parts',{partId:'${p.id}'})">View Component Page →</button>
    </div>
  `);
}

function renderBoardOverview(b, rows, buildable, totalPrice){
  return `
    <div class="grid grid-5">
      <div class="stat"><div class="stat-label">Products On Hand</div><div class="stat-val">${b.boardQty}</div></div>
      <div class="stat"><div class="stat-label">Stock Target</div><div class="stat-val">${b.stockTarget||25}</div></div>
      <div class="stat"><div class="stat-label">Buildable Now</div><div class="stat-val ${buildable<10?'warn':'good'}">${buildable}</div></div>
      <div class="stat"><div class="stat-label">Unique Parts Used</div><div class="stat-val">${rows.length}</div></div>
      <div class="stat"><div class="stat-label">BOM Cost / Product</div><div class="stat-val good">${fmtMoney2(totalPrice)}</div></div>
    </div>
    <div class="card">
      <div class="card-title">PCB Reference</div>
      <div class="page-desc" style="margin-bottom:8px;">Read-only view — drag to pan, scroll to zoom, click a bubble for part details. Use the PCB tab to upload a photo or edit alignment.</div>
      <div class="pcb-canvas-wrap" id="pcbWrap">
        <div id="pcbWorld" style="position:absolute;top:0;left:0;transform-origin:0 0;">
          ${b.image.file ? `<img class="pcb-img" id="pcbImg" src="${mediaUrl(b.image.file)}">` : ''}
          <div id="pcbMarkers"></div>
        </div>
        ${!b.image.file ? `<div class="empty" style="padding-top:180px;position:relative;pointer-events:none;">No PCB image uploaded yet — add one from the PCB tab</div>` : ''}
      </div>
    </div>
    <div class="card">
      <div class="card-title">Full Parts List &amp; Qty Used</div>
      <div class="table-wrap" style="max-height:260px;overflow-y:auto;"><table><thead><tr><th>Part</th><th>Qty/Product</th><th>Unit Price</th><th>Extended Price</th></tr></thead><tbody>
      ${rows.map(r=>`<tr class="clickable" onclick="goPage('parts',{partId:'${r.part.id}'})"><td>${escapeHtml(partPrimaryName(r.part))}</td><td>${r.qty}</td><td>${fmtMoney(r.part.currentPrice)}</td><td>${fmtMoney2(r.qty*r.part.currentPrice)}</td></tr>`).join('') || `<tr><td colspan="4" class="empty">No parts mapped yet — add via BOM tab</td></tr>`}
      </tbody></table></div>
    </div>
    <div class="card">
      <div class="card-title">Component Inventory Status</div>
      <div class="page-desc" style="margin-bottom:10px;">Stock coverage, low-part breakdowns, and multi-product purchase math now live in Purchase Planning, where you can analyze this product alongside any others you're building at the same time.</div>
      <button class="btn btn-primary" onclick="goToPurchasePlanningForBoard('${b.id}')">Analyze In Purchase Planning →</button>
    </div>
    <div class="card">
      <div class="card-title">Files <span class="badge" style="cursor:pointer;" onclick="openBoardFileAttachPicker('${b.id}')">+ Attach</span></div>
      <div class="page-desc" style="margin-bottom:10px;">Assembly drawings, gerbers, fabrication notes, or any other reference file for this product.</div>
      ${renderFilesListHtml(b.files, 'board', b.id)}
    </div>
  `;
}

/* ---- BOM tab: paste-from-spreadsheet table ---- */
let bomEditMode = false;
function bomToggleEdit(){
  bomEditMode = !bomEditMode;
  renderAll();
}
let bomFilterText = '';
function bomFilterLive(v){
  bomFilterText = v;
  applyBomFilter();
}
function applyBomFilter(){
  const s = bomFilterText.trim().toLowerCase();
  let visible = 0;
  document.querySelectorAll('.bom-row').forEach(el=>{
    const show = !s || el.dataset.s.includes(s);
    el.style.display = show ? '' : 'none';
    if(show) visible++;
  });
  const countEl = document.getElementById('bomRowCount');
  if(countEl) countEl.textContent = s ? `${visible} of ${document.querySelectorAll('.bom-row').length}` : `${document.querySelectorAll('.bom-row').length}`;
}
function renderBoardBOM(b){
  return `
    <div class="card">
      <div class="card-title">Paste BOM From Spreadsheet</div>
      <div class="page-desc" style="margin-bottom:8px;">Copy columns <b>Part Number, X, Y, Angle, Comment</b> from a spreadsheet (tab-separated) and paste below, then click Import.</div>
      <textarea id="bomPaste" rows="5" placeholder="Paste tab-separated rows here..."></textarea>
      <div style="margin-top:8px;display:flex;gap:8px;">
        <button class="btn btn-primary" onclick="importBomPaste('${b.id}')">Import Rows</button>
        <button class="btn" onclick="openBomRowForm('${b.id}')">+ Add Single Row</button>
      </div>
    </div>
    <div class="card">
      <div class="card-title">
        BOM Table (<span id="bomRowCount">${b.partsList.length}</span> lines)
        <div style="display:flex;gap:8px;">
          <button class="btn btn-sm" onclick="exportPickPlaceCsv('${b.id}')">📥 Export Pick &amp; Place CSV</button>
          ${bomEditMode ? `<button class="btn btn-sm btn-danger" onclick="deleteAllBomRows('${b.id}')">🗑️ Delete All Rows</button>` : ''}
          <button class="tab-btn ${bomEditMode?'active':''}" onclick="bomToggleEdit()">${bomEditMode?'✅ Editing Rows':'📝 Edit Rows'}</button>
        </div>
      </div>
      <div class="field" style="max-width:320px;"><input type="text" value="${escapeHtml(bomFilterText)}" placeholder="Filter by part number, comment, or matched name..." oninput="bomFilterLive(this.value)"></div>
      <div class="page-desc" style="margin-bottom:8px;">${bomEditMode ? 'Click any field to edit it directly. Editing Part Number re-checks the match automatically.' : 'Turn on "Edit Rows" to modify Part Number, X, Y, Angle or Comment directly in the table.'}</div>
      <div class="table-wrap"><table><thead><tr><th></th><th>Part Number</th><th>X</th><th>Y</th><th>Angle</th><th>Comment</th><th>Matched</th>${bomEditMode?'<th></th>':''}</tr></thead><tbody>
      ${b.partsList.map(bp=>{
        const matchedName = bp.matchedPartId ? partPrimaryName(findPart(bp.matchedPartId)) : '';
        const searchText = [bp.partNumber, bp.comment||'', matchedName].join(' ').toLowerCase();
        return `
        <tr class="bom-row" data-s="${escapeHtml(searchText)}">
          <td>${bp.matchedPartId?'<span class="check-y">✅</span>':'<span class="check-n">❌</span>'}</td>
          ${bomEditMode ? `
          <td><input type="text" class="table-input" value="${escapeHtml(bp.partNumber)}" style="width:130px;font-family:var(--mono);" onchange="updateBomField('${b.id}','${bp.id}','partNumber',this.value)"></td>
          <td><input type="number" class="table-input" value="${bp.x}" style="width:52px;" onchange="updateBomField('${b.id}','${bp.id}','x',this.value)"></td>
          <td><input type="number" class="table-input" value="${bp.y}" style="width:52px;" onchange="updateBomField('${b.id}','${bp.id}','y',this.value)"></td>
          <td><input type="number" class="table-input" value="${bp.angle}" style="width:48px;" onchange="updateBomField('${b.id}','${bp.id}','angle',this.value)"></td>
          <td><input type="text" class="table-input" value="${escapeHtml(bp.comment||'')}" style="width:90px;" onchange="updateBomField('${b.id}','${bp.id}','comment',this.value)"></td>
          ` : `
          <td style="font-family:var(--mono);">${escapeHtml(bp.partNumber)}</td>
          <td>${bp.x}</td><td>${bp.y}</td><td>${bp.angle}</td>
          <td>${escapeHtml(bp.comment||'')}</td>
          `}
          <td>${bp.matchedPartId ? `<span class="badge green" style="cursor:pointer;" onclick="openMatchPicker('${b.id}','${bp.id}')" title="Click to change match">${escapeHtml(partPrimaryName(findPart(bp.matchedPartId)))}</span>` : `<button class="btn btn-sm" onclick="openMatchPicker('${b.id}','${bp.id}')">Match</button>`}</td>
          ${bomEditMode ? `<td><span class="small-x" onclick="removeBomRow('${b.id}','${bp.id}')" style="float:none;">❌</span></td>` : ''}
        </tr>`;
      }).join('') || `<tr><td colspan="${bomEditMode?8:7}" class="empty">No BOM rows yet</td></tr>`}
      </tbody></table></div>
    </div>
  `;
}
function importBomPaste(boardId){
  const raw = document.getElementById('bomPaste').value;
  if(!raw.trim()) return;
  const b = findBoard(boardId);
  const lines = raw.trim().split(/\r?\n/);
  let added = 0;
  lines.forEach(line=>{
    const cols = line.split('\t');
    if(cols.length<1 || !cols[0].trim()) return;
    // skip header-like row
    if(/^part\s*number$/i.test(cols[0].trim())) return;
    const partNumber = cols[0].trim();
    const match = fuzzyMatchParts(partNumber);
    b.partsList.push({
      id:uid('bp'), partNumber,
      x:Number(cols[1])||0, y:Number(cols[2])||0, angle:Number(cols[3])||0, comment:cols[4]||'',
      matchedPartId: match.length? match[0].part.id : null, qtyPerBoard:1
    });
    added++;
  });
  document.getElementById('bomPaste').value='';
  touch(); renderAll(); toast(`Imported ${added} row(s)`);
}
function openBomRowForm(boardId, x, y){
  openModal(`
    <div class="modal-title">Add BOM Row</div>
    <div class="field">
      <label>Part Number</label>
      <input type="text" id="brPn" autocomplete="off" placeholder="Type to search components, or enter a new part number" oninput="brPnFilter(this.value)">
      <div id="brPnList" style="max-height:180px;overflow-y:auto;margin-top:6px;border:1px solid var(--border);border-radius:6px;">
        ${DB.parts.map(p=>`<div class="ac-item brpn-row" data-s="${escapeHtml(allAliasStrings(p).concat(p.name?[p.name]:[]).join(' ').toLowerCase())}" data-val="${escapeHtml(p.aliases[0]?p.aliases[0].value:partPrimaryName(p))}" onclick="brPnSelect(this.dataset.val)">${escapeHtml(partPrimaryName(p))} <span class="sub">${escapeHtml(p.category||'')}${p.aliases[0]?' · '+escapeHtml(p.aliases[0].value):''}</span></div>`).join('') || `<div class="empty" style="padding:16px;">No components yet</div>`}
      </div>
    </div>
    <div class="grid grid-3">
      <div class="field"><label>X</label><input type="number" id="brX" value="${x!==undefined?x:0}"></div>
      <div class="field"><label>Y</label><input type="number" id="brY" value="${y!==undefined?y:0}"></div>
      <div class="field"><label>Angle</label><input type="number" id="brA" value="0"></div>
    </div>
    <div class="field"><label>Comment / Reference Designator</label><input type="text" id="brC"></div>
    <button class="btn btn-primary" onclick="submitBomRow('${boardId}')">Add</button>
  `);
}
function brPnFilter(v){
  const s = v.toLowerCase();
  document.querySelectorAll('.brpn-row').forEach(el=>{ el.style.display = el.dataset.s.includes(s) ? 'block':'none'; });
}
function brPnSelect(value){
  const input = document.getElementById('brPn');
  if(input) input.value = value;
  brPnFilter(value);
}
function submitBomRow(boardId){
  const b = findBoard(boardId);
  const pn = document.getElementById('brPn').value.trim();
  if(!pn) return;
  const match = fuzzyMatchParts(pn);
  b.partsList.push({id:uid('bp'), partNumber:pn, x:Number(document.getElementById('brX').value)||0, y:Number(document.getElementById('brY').value)||0, angle:Number(document.getElementById('brA').value)||0, comment:document.getElementById('brC').value.trim(), matchedPartId: match.length?match[0].part.id:null, qtyPerBoard:1});
  touch(); closeModal(); renderAll(); toast('Row added');
}
function removeBomRow(boardId, rowId){
  const b = findBoard(boardId);
  b.partsList = b.partsList.filter(r=>r.id!==rowId);
  touch(); renderAll();
}
function deleteAllBomRows(boardId){
  const b = findBoard(boardId);
  if(!b || b.partsList.length===0){ toast('No rows to delete'); return; }
  confirmAction(`Delete all ${b.partsList.length} BOM rows for ${b.name}? This cannot be undone.`, ()=>{
    b.partsList = [];
    touch(); renderAll(); toast('All BOM rows deleted');
  });
}
function csvEscape(val){
  const s = String(val===undefined||val===null?'':val);
  if(/[",\n]/.test(s)) return '"' + s.replace(/"/g,'""') + '"';
  return s;
}
function exportPickPlaceCsv(boardId){
  const b = findBoard(boardId);
  if(!b) return;
  if(b.partsList.length===0){ toast('No BOM rows to export'); return; }
  openModal(`
    <div class="modal-title">Export Pick &amp; Place CSV — ${escapeHtml(b.name)}</div>
    <div class="field"><label><input type="checkbox" id="ppCsvUseCompName" style="width:auto;" checked> Use part names from components instead of BOM</label></div>
    <div class="field"><label><input type="checkbox" id="ppCsvMachineOnly" style="width:auto;" checked> Machine placed parts only</label></div>
    <button class="btn btn-primary" onclick="submitExportPickPlaceCsv('${boardId}')">Export</button>
  `);
}
function submitExportPickPlaceCsv(boardId){
  const b = findBoard(boardId);
  if(!b) return;
  const useCompName = document.getElementById('ppCsvUseCompName').checked;
  const machineOnly = document.getElementById('ppCsvMachineOnly').checked;

  let bomRows = b.partsList;
  if(machineOnly){
    bomRows = bomRows.filter(bp=>{
      const part = bp.matchedPartId ? findPart(bp.matchedPartId) : null;
      // Rows with no matched part have no known placement — exclude them when filtering
      // to machine-placed only, since we can't confirm they belong on the pick & place file.
      return part && part.placement==='Machine Placed';
    });
  }
  if(bomRows.length===0){ toast('No rows match those options'); return; }

  const rows = [['Pick and Place Name','X','Y','Angle','Comment']];
  bomRows.forEach(bp=>{
    const part = bp.matchedPartId ? findPart(bp.matchedPartId) : null;
    const name = (useCompName && part) ? partPrimaryName(part) : bp.partNumber;
    rows.push([name, bp.x, bp.y, bp.angle, bp.comment||'']);
  });
  const csv = rows.map(r=>r.map(csvEscape).join(',')).join('\r\n');
  const blob = new Blob([csv], {type:'text/csv'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const safeName = b.name.replace(/[^a-z0-9\-_]+/gi,'_');
  a.href = url; a.download = `${safeName}-pick-and-place.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  closeModal();
  toast('Pick & place CSV exported');
}
function updateBomField(boardId, rowId, field, value){
  const b = findBoard(boardId);
  const row = b.partsList.find(r=>r.id===rowId);
  if(!row) return;
  if(field==='x' || field==='y' || field==='angle'){
    row[field] = Number(value)||0;
  } else if(field==='partNumber'){
    const v = value.trim();
    if(!v) return; // part number can't be blank
    row.partNumber = v;
    const match = fuzzyMatchParts(v);
    row.matchedPartId = match.length ? match[0].part.id : null;
  } else if(field==='comment'){
    row.comment = value.trim();
  }
  touch(); renderAll();
}
function openMatchPicker(boardId, rowId){
  const b = findBoard(boardId);
  const row = b ? b.partsList.find(r=>r.id===rowId) : null;
  const prefill = row ? row.partNumber : '';
  openModal(`
    <div class="modal-title">Match Part</div>
    <div class="field"><label>Search parts</label><input type="text" id="mpSearch" value="${escapeHtml(prefill)}" oninput="mpFilter(this.value)"></div>
    <div id="mpList" style="max-height:300px;overflow-y:auto;margin-bottom:12px;">
    ${DB.parts.map(p=>`<div class="ac-item mp-row" data-s="${escapeHtml(allAliasStrings(p).join(' ').toLowerCase())}" onclick="submitMatch('${boardId}','${rowId}','${p.id}')">${escapeHtml(partPrimaryName(p))} <span class="sub">${escapeHtml(p.category||'')}</span></div>`).join('')}
    </div>
    <button class="btn btn-sm btn-primary" onclick="openPartForm('${jsAttrEscape(prefill)}', {boardId:'${boardId}', rowId:'${rowId}'})">+ Add New Part</button>
  `);
  if(prefill) mpFilter(prefill);
}
function mpFilter(v){
  const s = v.toLowerCase();
  document.querySelectorAll('.mp-row').forEach(el=>{ el.style.display = el.dataset.s.includes(s) ? 'block':'none'; });
}
function submitMatch(boardId, rowId, partId){
  const b = findBoard(boardId);
  const row = b.partsList.find(r=>r.id===rowId);
  if(!row) return;
  const targetPn = row.partNumber.trim().toLowerCase();
  let count = 0;
  b.partsList.forEach(r=>{
    if(!r.matchedPartId && r.partNumber.trim().toLowerCase()===targetPn){
      r.matchedPartId = partId;
      count++;
    }
  });
  touch(); closeModal(); renderAll();
  toast(count>1 ? `Matched ${count} rows with "${row.partNumber}"` : 'Matched');
}

/* ---- PCB tab: image, pan/zoom, hover highlights ----
   Two independent transforms:
   - VIEW transform (b.view): normal browsing pan/zoom of the whole scene (image + bubbles
     together), always active — this is what dragging/scrolling does by default.
   - IMAGE transform (b.image): only active while "Edit Image" is toggled on. In that
     mode dragging/scrolling instead resizes and slides the photo underneath the fixed
     bubbles, which is how you calibrate the photo to match the BOM X/Y positions. */
let pcbDrag = null;
let pcbEditMode = false;
function ensurePcbDefaults(b){
  if(b.markerSize===undefined){
    // Migrate legacy coordScale (which used to multiply marker X/Y to spread them out) by
    // baking it directly into each part's X/Y once, so existing layouts don't visually jump.
    // Marker Size now only controls the bubble's on-screen diameter, not its position —
    // aligning the photo (via Image Scale) is how positions get matched now instead.
    if(b.coordScale && b.coordScale!==1 && b.partsList){
      b.partsList.forEach(bp=>{ bp.x = bp.x*b.coordScale; bp.y = bp.y*b.coordScale; });
    }
    b.markerSize = 12;
    delete b.coordScale;
  }
  if(b.partsScale===undefined){
    // Scaling now applies to the component (bubble) positions instead of the photo — with
    // photos usually being thousands of pixels across and BOM units often in mm, having to
    // scale the *image* down meant Image Scale sat at tiny, imprecise values like 0.05. Since
    // any board that was already aligned had Image Scale doing that job, migrate the existing
    // scale factor onto Parts Scale instead (and reset Image Scale to 1) so the current
    // alignment looks the same — Image Scale becomes a much easier, near-1.0 fine-tune knob.
    const oldImageScale = (b.image && b.image.scale) || 1;
    b.partsScale = oldImageScale !== 1 ? (1/oldImageScale) : 1;
    if(b.image) b.image.scale = 1;
  }
  if(!b.view) b.view = {scale:1, offsetX:0, offsetY:0};
  if(b.mirrorX===undefined) b.mirrorX = false;
  if(b.mirrorY===undefined) b.mirrorY = false;
}
function renderBoardPCB(b){
  ensurePcbDefaults(b);
  return `
    <div class="card">
      <div class="card-title">
        PCB Reference Image
        <button class="tab-btn ${pcbEditMode?'active':''}" onclick="pcbToggleEdit()">${pcbEditMode?'✅ Editing Image':'📝 Edit Image'}</button>
      </div>
      <div style="display:flex;gap:10px;align-items:center;margin-bottom:6px;flex-wrap:wrap;">
        ${pcbEditMode ? `
        <button class="btn btn-sm" onclick="openBoardImagePicker('${b.id}')">${b.image.file?'Change Image':'Upload Image'}</button>
        ` : ''}
        <button class="btn btn-sm" onclick="pcbResetView('${b.id}')">Reset View</button>
      </div>
      ${pcbEditMode ? `
      <div style="display:flex;gap:16px;align-items:center;margin-bottom:6px;flex-wrap:wrap;padding:10px;border:1px solid var(--copper-dim);border-radius:8px;background:rgba(217,154,84,.06);">
        <div style="display:flex;align-items:center;gap:6px;">
          <label style="margin:0;">Image Scale</label>
          <input type="range" id="pcbScaleRange" min="0.05" max="8" step="0.01" value="${b.image.scale}" style="width:110px;" oninput="pcbSetScale('${b.id}',this.value)">
          <input type="number" id="pcbScaleNum" step="0.01" min="0.05" max="8" value="${b.image.scale.toFixed(3)}" style="width:72px;" onchange="pcbSetScale('${b.id}',this.value)">
        </div>
        <div style="display:flex;align-items:center;gap:6px;">
          <label style="margin:0;">Parts Scale</label>
          <input type="number" id="pcbPartsScale" step="0.1" min="0.001" value="${b.partsScale}" style="width:80px;" onchange="pcbSetPartsScale('${b.id}',this.value)">
        </div>
        <div style="display:flex;align-items:center;gap:6px;">
          <label style="margin:0;">Image Offset X</label>
          <input type="number" id="pcbOffsetX" value="${Math.round(b.image.offsetX)}" style="width:72px;" onchange="pcbSetOffset('${b.id}','x',this.value)">
          <label style="margin:0;">Y</label>
          <input type="number" id="pcbOffsetY" value="${Math.round(b.image.offsetY)}" style="width:72px;" onchange="pcbSetOffset('${b.id}','y',this.value)">
        </div>
        <div style="display:flex;align-items:center;gap:6px;">
          <label style="margin:0;">Image Rotation</label>
          <button class="btn btn-sm" onclick="pcbNudgeRotation('${b.id}',-0.1)" title="Rotate -0.1°">↺️</button>
          <input type="range" id="pcbRotationRange" min="-180" max="180" step="0.1" value="${b.image.rotation||0}" style="width:110px;" oninput="pcbSetRotation('${b.id}',this.value)">
          <button class="btn btn-sm" onclick="pcbNudgeRotation('${b.id}',0.1)" title="Rotate +0.1°">↻️</button>
          <input type="number" id="pcbRotationNum" step="0.1" min="-180" max="180" value="${b.image.rotation||0}" style="width:64px;" onchange="pcbSetRotation('${b.id}',this.value)">
          <span style="color:var(--text-faint);">°</span>
        </div>
        <div style="display:flex;align-items:center;gap:6px;">
          <label style="margin:0;">Marker Size</label>
          <input type="number" id="pcbMarkerSize" step="1" min="2" max="80" value="${b.markerSize}" style="width:60px;" onchange="pcbSetMarkerSize('${b.id}',this.value)">
          <span style="color:var(--text-faint);">px</span>
        </div>
        <div style="display:flex;align-items:center;gap:12px;">
          <label style="margin:0;display:flex;align-items:center;gap:5px;cursor:pointer;">
            <input type="checkbox" style="width:auto;" ${b.mirrorX?'checked':''} onchange="pcbSetMirror('${b.id}','x',this.checked)"> Mirror X
          </label>
          <label style="margin:0;display:flex;align-items:center;gap:5px;cursor:pointer;">
            <input type="checkbox" style="width:auto;" ${b.mirrorY?'checked':''} onchange="pcbSetMirror('${b.id}','y',this.checked)"> Mirror Y
          </label>
        </div>
        <button class="btn btn-sm" onclick="pcbResetAlignment('${b.id}')">Reset Alignment</button>
        <button class="btn btn-sm btn-primary" onclick="savePcbAlignment('${b.id}')">Save Alignment</button>
      </div>
      <div class="page-desc" style="margin-bottom:8px;">Editing mode: <b>left-drag</b> or <b>scroll</b> to pan/zoom the view around, same as normal browsing. Hold <b>Shift</b> and left-drag to move the photo itself. <b>Parts Scale</b> is the main knob for matching sizes — it scales the bubbles' positions to the photo's pixel dimensions (BOM units are usually much smaller than a photo's pixel size), so Image Scale stays a small fine-tune around 1.0 instead of needing tiny imprecise values. Rotation still applies to the photo, for when it was taken at an angle. Use Mirror X/Y if your pick &amp; place machine's coordinate origin runs opposite to your BOM data (e.g. X decreasing left-to-right).</div>
      ` : `
      <div class="page-desc" style="margin-bottom:8px;">Drag to pan, scroll to zoom the view. Click a bubble for part details, double-click empty space to add a new BOM row at that position. Turn on "Edit Image" to upload or reposition the photo itself.</div>
      `}
      <div class="pcb-canvas-wrap ${pcbEditMode?'edit-mode':''}" id="pcbWrap">
        <div id="pcbWorld" style="position:absolute;top:0;left:0;transform-origin:0 0;">
          ${b.image.file ? `<img class="pcb-img" id="pcbImg" src="${mediaUrl(b.image.file)}">` : ''}
          <div id="pcbMarkers"></div>
        </div>
        ${!b.image.file ? `<div class="empty" style="padding-top:180px;position:relative;pointer-events:none;">Turn on "Edit Image" to upload a PCB photo, then line it up with the fixed bubbles below</div>` : ''}
      </div>
    </div>
    <div class="card">
      <div class="card-title">Reference Designators</div>
      <div class="table-wrap" style="max-height:240px;overflow-y:auto;"><table><thead><tr><th>Ref</th><th>Part</th><th>X</th><th>Y</th></tr></thead><tbody>
      ${b.partsList.map(bp=>`<tr class="clickable" onmouseenter="pcbHighlight('${bp.id}',true)" onmouseleave="pcbHighlight('${bp.id}',false)" onclick="openPcbPartPopup('${b.id}','${bp.id}')">
        <td>${escapeHtml(bp.comment||'—')}</td><td>${bp.matchedPartId?escapeHtml(partPrimaryName(findPart(bp.matchedPartId))):escapeHtml(bp.partNumber)}</td><td>${bp.x}</td><td>${bp.y}</td>
      </tr>`).join('') || `<tr><td colspan="4" class="empty">No parts placed yet</td></tr>`}
      </tbody></table></div>
    </div>
  `;
}
function pcbToggleEdit(){
  pcbEditMode = !pcbEditMode;
  renderAll();
}
function openBoardImagePicker(boardId){
  mediaPickerContext = {type:'boardImage', id:boardId};
  openModal(`
    <div class="modal-title">Set PCB Reference Image</div>
    <div class="field"><label>Upload New Image</label><input type="file" id="genericMediaUpload" accept="image/*"></div>
    <button class="btn btn-sm btn-primary" onclick="submitGenericMediaUpload()">Upload &amp; Use</button>
    <label style="margin-top:16px;">Or Pick An Existing Media File</label>
    <input type="text" autocomplete="off" placeholder="Search media files..." oninput="mediaFilterList('genericMediaPickList', this.value)">
    ${mediaPickerListHtml('genericMediaPickList', 'onMediaPicked')}
  `);
}
function setBoardImage(boardId, filename){
  const b = findBoard(boardId);
  if(!b) return;
  b.image.file = filename;
  touch(); closeModal(); renderAll(); toast('PCB image set');
}
/* ---- File attachments (datasheets, spec sheets, etc.) shared by parts and products ---- */
function openPartFileAttachPicker(partId){
  const p = findPart(partId);
  mediaPickerContext = {type:'partFile', id:partId};
  openModal(`
    <div class="modal-title">Attach File — ${escapeHtml(partPrimaryName(p))}</div>
    <div class="field"><label>Upload New File</label><input type="file" id="genericMediaUpload"></div>
    <button class="btn btn-sm btn-primary" onclick="submitGenericMediaUpload()">Upload &amp; Attach</button>
    <label style="margin-top:16px;">Or Pick An Existing Media File</label>
    <input type="text" autocomplete="off" placeholder="Search media files..." oninput="mediaFilterList('genericMediaPickList', this.value)">
    ${mediaPickerListHtml('genericMediaPickList', 'onMediaPicked', p.files||[])}
  `);
}
function addFileToPart(partId, filename){
  const p = findPart(partId);
  if(!p) return;
  if(!p.files) p.files = [];
  if(!p.files.includes(filename)) p.files.push(filename);
  touch(); closeModal(); renderAll(); toast('File attached');
}
function openBoardFileAttachPicker(boardId){
  const b = findBoard(boardId);
  mediaPickerContext = {type:'boardFile', id:boardId};
  openModal(`
    <div class="modal-title">Attach File — ${escapeHtml(b.name)}</div>
    <div class="field"><label>Upload New File</label><input type="file" id="genericMediaUpload"></div>
    <button class="btn btn-sm btn-primary" onclick="submitGenericMediaUpload()">Upload &amp; Attach</button>
    <label style="margin-top:16px;">Or Pick An Existing Media File</label>
    <input type="text" autocomplete="off" placeholder="Search media files..." oninput="mediaFilterList('genericMediaPickList', this.value)">
    ${mediaPickerListHtml('genericMediaPickList', 'onMediaPicked', b.files||[])}
  `);
}
function addFileToBoard(boardId, filename){
  const b = findBoard(boardId);
  if(!b) return;
  if(!b.files) b.files = [];
  if(!b.files.includes(filename)) b.files.push(filename);
  touch(); closeModal(); renderAll(); toast('File attached');
}
/* Removing an attachment asks whether to just unlink it (file stays in Media, might be
   used elsewhere) or delete the underlying file entirely — warns if other parts/products
   are also using it so a delete doesn't silently break something else. */
function promptRemoveFile(entityType, entityId, filename){
  const otherUsage = mediaUsageFor(filename).filter(u=> !(u.type===entityType && u.id===entityId));
  const usageNote = otherUsage.length>0 ? ` Note: this file is also used by ${otherUsage.length} other item${otherUsage.length===1?'':'s'} — deleting it will break ${otherUsage.length===1?'that reference':'those references'} too.` : '';
  openModal(`
    <div class="modal-title">Remove File</div>
    <div class="page-desc" style="margin-bottom:16px;">"${escapeHtml(filename)}" — just unlink it from this ${entityType==='part'?'component':'product'}, or also delete it permanently from the Media library?${usageNote}</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;">
      <button class="btn btn-sm" onclick="submitRemoveFile('${entityType}','${entityId}','${jsAttrEscape(filename)}',false)">Just Remove</button>
      <button class="btn btn-sm btn-danger" onclick="submitRemoveFile('${entityType}','${entityId}','${jsAttrEscape(filename)}',true)">Remove &amp; Delete File</button>
    </div>
  `);
}
async function submitRemoveFile(entityType, entityId, filename, alsoDelete){
  if(entityType==='part'){
    const p = findPart(entityId);
    if(p) p.files = (p.files||[]).filter(f=>f!==filename);
  } else {
    const b = findBoard(entityId);
    if(b) b.files = (b.files||[]).filter(f=>f!==filename);
  }
  touch();
  closeModal();
  if(alsoDelete){
    try{
      await deleteMediaFile(filename);
      toast('File removed and deleted from Media');
    }catch(err){
      toast('Removed from item, but delete failed: ' + err.message);
    }
  } else {
    toast('File removed (still in Media)');
  }
  renderAll();
}
function promptReplaceFile(filename){
  const usage = mediaUsageFor(filename);
  const usageNote = usage.length>0 ? ` This will update the content for all ${usage.length} place${usage.length===1?'':'s'} that reference it — nothing needs to be re-linked.` : '';
  openModal(`
    <div class="modal-title">Replace File</div>
    <div class="page-desc" style="margin-bottom:12px;">Choose a new file to replace "${escapeHtml(filename)}" — the filename stays the same, only the content changes.${usageNote}</div>
    <div class="field"><label>New File</label><input type="file" id="replaceFileInput"></div>
    <button class="btn btn-sm btn-primary" onclick="submitReplaceFile('${jsAttrEscape(filename)}')">Replace</button>
  `);
}
async function submitReplaceFile(filename){
  const input = document.getElementById('replaceFileInput');
  const file = input.files[0];
  if(!file){ toast('Choose a file first'); return; }
  try{
    await replaceMediaFile(filename, file);
    closeModal();
    renderAll();
    toast('File replaced');
  }catch(err){
    toast('Replace failed: ' + err.message);
  }
}
function renderFilesListHtml(files, entityType, entityId){
  if(!files || files.length===0) return `<div class="empty" style="padding:12px;">No files attached</div>`;
  return `<div style="display:flex;flex-direction:column;gap:6px;">` + files.map(f=>`
    <div style="display:flex;justify-content:space-between;align-items:center;background:var(--panel-2);border:1px solid var(--border);border-radius:6px;padding:8px 10px;">
      <a href="${mediaUrl(f)}" target="_blank" rel="noopener" style="color:var(--trace);text-decoration:none;font-size:12px;">${isImageFile(f)?'🖼️':'📄'} ${escapeHtml(f)}</a>
      <span style="display:flex;gap:10px;align-items:center;">
        <span class="small-x" style="float:none;color:var(--text-faint);" title="Replace this file's content" onclick="promptReplaceFile('${jsAttrEscape(f)}')">🔄</span>
        <span class="small-x" style="float:none;" title="Remove" onclick="promptRemoveFile('${entityType}','${entityId}','${jsAttrEscape(f)}')">❌</span>
      </span>
    </div>`).join('') + `</div>`;
}
function applyPcbWorldTransform(b){
  const world = document.getElementById('pcbWorld');
  if(world) world.style.transform = `translate(${b.view.offsetX}px,${b.view.offsetY}px) scale(${b.view.scale})`;
}
function applyPcbImageTransform(b){
  const img = document.getElementById('pcbImg');
  if(img) img.style.transform = `translate(${b.image.offsetX}px,${b.image.offsetY}px) rotate(${b.image.rotation||0}deg) scale(${b.image.scale})`;
}
function syncPcbInputs(b){
  const sc = document.getElementById('pcbScaleNum'); if(sc) sc.value = b.image.scale.toFixed(3);
  const scR = document.getElementById('pcbScaleRange'); if(scR) scR.value = b.image.scale;
  const ox = document.getElementById('pcbOffsetX'); if(ox) ox.value = Math.round(b.image.offsetX);
  const oy = document.getElementById('pcbOffsetY'); if(oy) oy.value = Math.round(b.image.offsetY);
  const rot = document.getElementById('pcbRotationNum'); if(rot) rot.value = (b.image.rotation||0);
  const rotR = document.getElementById('pcbRotationRange'); if(rotR) rotR.value = (b.image.rotation||0);
}
function pcbSetScale(boardId, val){
  const b = findBoard(boardId);
  const num = Math.max(0.05, Math.min(8, Number(val)||1));
  b.image.scale = num;
  applyPcbImageTransform(b); syncPcbInputs(b);
}
function pcbSetRotation(boardId, val){
  const b = findBoard(boardId);
  let num = Number(val)||0;
  num = Math.max(-180, Math.min(180, num));
  num = Math.round(num*10)/10;
  b.image.rotation = num;
  applyPcbImageTransform(b); syncPcbInputs(b);
}
function pcbNudgeRotation(boardId, delta){
  const b = findBoard(boardId);
  pcbSetRotation(boardId, (b.image.rotation||0) + delta);
}
function pcbSetOffset(boardId, axis, val){
  const b = findBoard(boardId);
  const num = Number(val)||0;
  if(axis==='x') b.image.offsetX = num; else b.image.offsetY = num;
  applyPcbImageTransform(b);
}
function pcbSetMarkerSize(boardId, val){
  const b = findBoard(boardId);
  b.markerSize = Math.max(2, Math.min(80, Number(val)||12));
  positionPcbMarkers(b);
  touch();
}
function pcbSetPartsScale(boardId, val){
  const b = findBoard(boardId);
  b.partsScale = Math.max(0.001, Number(val)||1);
  positionPcbMarkers(b);
  touch();
}
function pcbSetMirror(boardId, axis, checked){
  const b = findBoard(boardId);
  if(axis==='x') b.mirrorX = checked; else b.mirrorY = checked;
  positionPcbMarkers(b);
  touch();
}
function pcbResetAlignment(boardId){
  const b = findBoard(boardId);
  b.image.scale = 1; b.image.offsetX = 0; b.image.offsetY = 0; b.image.rotation = 0;
  applyPcbImageTransform(b); syncPcbInputs(b);
  touch(); toast('Image alignment reset');
}
function pcbResetView(boardId){
  const b = findBoard(boardId);
  ensurePcbDefaults(b);
  b.view.scale = 1; b.view.offsetX = 0; b.view.offsetY = 0;
  applyPcbWorldTransform(b);
  applyPcbMarkerCounterScale(b);
  toast('View reset');
}
function savePcbAlignment(boardId){
  touch();
  pcbEditMode = false;
  renderAll();
  toast('Alignment saved');
}
/* Read-only PCB viewer used on the board Overview tab — pan/zoom the view and click a
   bubble for details, but no image upload, no alignment editing, no double-click-to-add.
   Deliberately independent of the global pcbEditMode flag so it can never enter edit mode. */
/* Panning/zooming the view fires very frequently (every mousemove/wheel tick), so we
   don't want to call touch() (and therefore trigger a save + version bump other users'
   pollers would notice) that often — it'd be a lot of noisy syncs for something as
   low-stakes as "where you're currently looking". Instead we save once a gesture settles,
   so the last viewed spot still persists (and shows up for the next person to open the
   product) without spamming saves mid-drag/mid-scroll. */
let pcbViewSaveTimer = null;
function schedulePcbViewSave(){
  clearTimeout(pcbViewSaveTimer);
  pcbViewSaveTimer = setTimeout(()=>touch(), 400);
}
function setupPcbReadOnlyInteraction(b){
  const wrap = document.getElementById('pcbWrap');
  if(!wrap) return;
  ensurePcbDefaults(b);
  applyPcbWorldTransform(b);
  applyPcbImageTransform(b);
  positionPcbMarkers(b);

  const CLICK_THRESHOLD = 4;
  let drag = null;
  wrap.onpointerdown = e=>{
    const markerEl = e.target && e.target.closest ? e.target.closest('.pcb-marker') : null;
    drag = { startX:e.clientX, startY:e.clientY, ox:b.view.offsetX, oy:b.view.offsetY, pointerId:e.pointerId, markerBpId: markerEl?markerEl.dataset.bpId:null, moved:false };
    wrap.classList.add('dragging');
    wrap.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  wrap.onpointermove = e=>{
    if(!drag) return;
    const dx = e.clientX-drag.startX, dy = e.clientY-drag.startY;
    if(Math.abs(dx)>CLICK_THRESHOLD || Math.abs(dy)>CLICK_THRESHOLD) drag.moved = true;
    b.view.offsetX = drag.ox + dx;
    b.view.offsetY = drag.oy + dy;
    applyPcbWorldTransform(b);
  };
  const endDrag = ()=>{
    if(drag){
      try{ wrap.releasePointerCapture(drag.pointerId); }catch(err){}
      if(!drag.moved && drag.markerBpId) openPcbPartPopup(b.id, drag.markerBpId);
      else if(drag.moved) schedulePcbViewSave();
    }
    drag = null;
    wrap.classList.remove('dragging');
  };
  wrap.onpointerup = endDrag;
  wrap.onpointercancel = ()=>{ drag=null; wrap.classList.remove('dragging'); };
  wrap.ondblclick = null;
  wrap.onwheel = e=>{
    e.preventDefault();
    const rect = wrap.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const oldScale = b.view.scale;
    const newScale = Math.max(0.1, Math.min(10, oldScale + (e.deltaY<0?oldScale*0.1:-oldScale*0.1)));
    const worldX = (mx - b.view.offsetX) / oldScale;
    const worldY = (my - b.view.offsetY) / oldScale;
    b.view.offsetX = mx - worldX*newScale;
    b.view.offsetY = my - worldY*newScale;
    b.view.scale = newScale;
    applyPcbWorldTransform(b);
    applyPcbMarkerCounterScale(b);
    schedulePcbViewSave();
  };
}
function setupPcbInteraction(b){
  const wrap = document.getElementById('pcbWrap');
  if(!wrap) return;
  ensurePcbDefaults(b);
  applyPcbWorldTransform(b);
  applyPcbImageTransform(b);
  positionPcbMarkers(b);

  const CLICK_THRESHOLD = 4; // px of movement below which a pointerdown+up counts as a click, not a drag

  wrap.onpointerdown = e=>{
    const markerEl = e.target && e.target.closest ? e.target.closest('.pcb-marker') : null;
    const isImageMove = pcbEditMode && e.button===0 && e.shiftKey;
    // Shift+left-drag moves the photo itself (edit mode only) — a plain left-drag always
    // pans the view, same gesture whether or not you're editing, so you can navigate
    // around a large board and still nudge the image into place without switching modes.
    pcbDrag = {
      startX:e.clientX, startY:e.clientY,
      isImageMove,
      ox: isImageMove ? b.image.offsetX : b.view.offsetX,
      oy: isImageMove ? b.image.offsetY : b.view.offsetY,
      pointerId:e.pointerId,
      markerBpId: markerEl ? markerEl.dataset.bpId : null,
      moved:false
    };
    wrap.classList.add('dragging');
    wrap.setPointerCapture(e.pointerId);
    e.preventDefault();
  };
  wrap.onpointermove = e=>{
    if(!pcbDrag) return;
    const dx = e.clientX-pcbDrag.startX, dy = e.clientY-pcbDrag.startY;
    if(Math.abs(dx)>CLICK_THRESHOLD || Math.abs(dy)>CLICK_THRESHOLD) pcbDrag.moved = true;
    if(pcbDrag.isImageMove){
      if(!b.image.file) return;
      b.image.offsetX = pcbDrag.ox + dx;
      b.image.offsetY = pcbDrag.oy + dy;
      applyPcbImageTransform(b);
      syncPcbInputs(b);
    } else {
      b.view.offsetX = pcbDrag.ox + dx;
      b.view.offsetY = pcbDrag.oy + dy;
      applyPcbWorldTransform(b);
    }
  };
  const endDrag = ()=>{
    if(pcbDrag){
      try{ wrap.releasePointerCapture(pcbDrag.pointerId); }catch(err){}
      if(!pcbDrag.moved && pcbDrag.markerBpId && !pcbDrag.isImageMove){
        openPcbPartPopup(b.id, pcbDrag.markerBpId);
      } else if(pcbDrag.moved){
        schedulePcbViewSave();
      }
    }
    pcbDrag = null;
    wrap.classList.remove('dragging');
  };
  wrap.onpointerup = endDrag;
  wrap.onpointercancel = ()=>{ pcbDrag=null; wrap.classList.remove('dragging'); };
  wrap.oncontextmenu = e=>{ e.preventDefault(); }; // avoid any stray context menu from middle/right click while dragging
  wrap.onwheel = e=>{
    e.preventDefault();
    // Scroll-to-zoom always zooms the view, in and out of edit mode — the Image Scale
    // slider is the only thing that adjusts the photo's own scale now, so the wheel can't
    // accidentally throw off a calibrated image scale while you're just browsing around.
    const rect = wrap.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    const oldScale = b.view.scale;
    const newScale = Math.max(0.1, Math.min(10, oldScale + (e.deltaY<0?oldScale*0.1:-oldScale*0.1)));
    const worldX = (mx - b.view.offsetX) / oldScale;
    const worldY = (my - b.view.offsetY) / oldScale;
    b.view.offsetX = mx - worldX*newScale;
    b.view.offsetY = my - worldY*newScale;
    b.view.scale = newScale;
    applyPcbWorldTransform(b);
    applyPcbMarkerCounterScale(b);
    schedulePcbViewSave();
  };
  wrap.ondblclick = e=>{
    // Ignore double-clicks that land on an existing bubble — that's handled by the
    // single-click-to-open-popup logic above, not "add a new part here".
    if(e.target && e.target.closest && e.target.closest('.pcb-marker')) return;
    const rect = wrap.getBoundingClientRect();
    const relX = e.clientX - rect.left, relY = e.clientY - rect.top;
    const worldX = (relX - b.view.offsetX) / b.view.scale;
    const worldY = (relY - b.view.offsetY) / b.view.scale;
    const ps = b.partsScale || 1;
    let x = worldX/ps, y = worldY/ps;
    if(b.mirrorX) x = -x;
    if(b.mirrorY) y = -y;
    x = Math.round(x*100)/100;
    y = Math.round(y*100)/100;
    openBomRowForm(b.id, x, y);
  };
}
function positionPcbMarkers(b){
  const holder = document.getElementById('pcbMarkers');
  if(!holder) return;
  const size = b.markerSize || 12;
  const half = size/2;
  const ps = b.partsScale || 1;
  holder.innerHTML = b.partsList.map(bp=>{
    const left = (b.mirrorX ? -bp.x : bp.x) * ps;
    const top = (b.mirrorY ? -bp.y : bp.y) * ps;
    const partName = bp.matchedPartId ? partPrimaryName(findPart(bp.matchedPartId)) : bp.partNumber;
    const label = bp.comment ? `${bp.comment} · ${partName}` : partName;
    const unmatched = !bp.matchedPartId;
    return `<div class="pcb-marker${unmatched?' unmatched':''}" id="mk_${bp.id}" data-bp-id="${bp.id}" style="left:${left}px;top:${top}px;width:${size}px;height:${size}px;margin-left:${-half}px;margin-top:${-half}px;" onmouseenter="pcbHighlight('${bp.id}',true)" onmouseleave="pcbHighlight('${bp.id}',false)">
      <div class="tip">${escapeHtml(label)}${unmatched?' (unmatched)':''}</div>
    </div>`;
  }).join('');
  applyPcbMarkerCounterScale(b);
}
/* Counteracts the view's zoom scale on each marker (and, since the tooltip is nested
   inside it, the tooltip text too) so both stay a constant on-screen size while panning/
   zooming — the same way map pins/labels don't grow or shrink as you zoom a map. */
function applyPcbMarkerCounterScale(b){
  const s = 1 / ((b.view && b.view.scale) || 1);
  document.querySelectorAll('.pcb-marker').forEach(el=>{ el.style.transform = `scale(${s})`; });
}
function pcbHighlight(rowId, on){
  const el = document.getElementById('mk_'+rowId);
  if(el) el.classList.toggle('hi', on);
}
function openPcbPartPopup(boardId, bpRowId){
  const b = findBoard(boardId);
  if(!b) return;
  const bp = b.partsList.find(r=>r.id===bpRowId);
  if(!bp) return;
  const part = bp.matchedPartId ? findPart(bp.matchedPartId) : null;

  if(!part){
    openModal(`
      <div class="modal-title">${escapeHtml(bp.comment||bp.partNumber)}</div>
      <div class="page-desc" style="margin-bottom:14px;">"${escapeHtml(bp.partNumber)}" isn't matched to a component yet.</div>
      <button class="btn btn-primary btn-sm" onclick="closeModal();boardTab='bom';renderAll();">Go Match It in BOM →</button>
    `);
    return;
  }

  // Total qty of this part used per board (it may appear in more than one BOM row, e.g. R1,R2,R3 all 10K)
  const qtyPerBoard = boardPartRows(b).find(r=>r.part.id===part.id)?.qty || 1;
  const boardsFromStock = boardPartBuildable(part, qtyPerBoard);
  const st = boardPartLowState(b, part, qtyPerBoard);

  openModal(`
    <div class="modal-title">${escapeHtml(bp.comment||'')}${bp.comment?' · ':''}${escapeHtml(partPrimaryName(part))}</div>
    <div class="kv"><span>Category</span><b>${escapeHtml(part.category||'—')}</b></div>
    <div class="kv"><span>Qty Used On This Product</span><b>${qtyPerBoard}</b></div>
    <div class="kv"><span>Products Buildable From Stock On Hand</span><b>${Number.isFinite(boardsFromStock)?boardsFromStock:'∞'} ${st!=='ok'?(st==='bad'?'<span class=\"badge red\">critical</span>':'<span class=\"badge amber\">low</span>'):''}</b></div>
    <div class="kv"><span>Product Stock Target</span><b>${b.stockTarget||25}</b></div>
    <div class="kv"><span>Current Stock</span><b>${part.currentQty}</b></div>
    <div class="kv"><span>Unit Cost</span><b>${fmtMoney(part.currentPrice)}</b></div>
    <div class="kv"><span>Line Cost (this product)</span><b>${fmtMoney2(part.currentPrice*qtyPerBoard)}</b></div>
    <div class="kv"><span>Supplier</span><b>${part.currentSupplier ? (part.productLink ? `<a href="${escapeHtml(part.productLink)}" target="_blank" rel="noopener" style="color:var(--trace);">${escapeHtml(part.currentSupplier)} ↗</a>` : escapeHtml(part.currentSupplier)) : '—'}</b></div>
    <div style="display:flex;gap:8px;margin-top:16px;flex-wrap:wrap;">
      ${part.productLink ? `<a class="btn btn-sm" href="${escapeHtml(part.productLink)}" target="_blank" rel="noopener">Open Supplier Page ↗</a>` : ''}
      <button class="btn btn-sm btn-primary" onclick="closeModal();goPage('parts',{partId:'${part.id}'})">View Component Page →</button>
    </div>
  `);
}

/* ---- Production tab ---- */
function renderBoardProduction(b){
  return `
    <div class="card">
      <div class="card-title">Log Production Run</div>
      <div class="grid grid-3" style="align-items:end;">
        <div class="field" style="margin-bottom:0;"><label>Qty Produced</label><input type="number" id="prodQty" value="1"></div>
        <div class="field" style="margin-bottom:0;"><label>Date</label><input type="date" id="prodDate" value="${new Date().toISOString().slice(0,10)}"></div>
        <div class="field" style="margin-bottom:0;"><label>Comment</label><input type="text" id="prodComment" placeholder="e.g. run #14"></div>
      </div>
      <button class="btn btn-primary" style="margin-top:10px;" onclick="submitProductionRun('${b.id}')">Log Run &amp; Subtract Parts</button>
      <div class="page-desc" style="margin-top:6px;">This adds to products on hand and subtracts BOM quantities from parts with auto-subtract enabled.</div>
    </div>
    <div class="card">
      <div class="card-title">Production History</div>
      <div class="table-wrap"><table><thead><tr><th>Date</th><th>Qty</th><th>Comment</th></tr></thead><tbody>
      ${b.productionLog.slice().reverse().map(pl=>`<tr><td>${fmtDate(pl.date)}</td><td>${pl.qty}</td><td>${escapeHtml(pl.comment||'')}</td></tr>`).join('') || `<tr><td colspan="3" class="empty">No production runs yet</td></tr>`}
      </tbody></table></div>
    </div>
  `;
}
function submitProductionRun(boardId){
  const b = findBoard(boardId);
  const qty = Number(document.getElementById('prodQty').value)||0;
  if(qty<=0){ toast('Enter a valid quantity'); return; }
  const date = dateInputToISO(document.getElementById('prodDate').value);
  const comment = document.getElementById('prodComment').value.trim();
  b.boardQty += qty;
  b.productionLog.push({id:uid('pl'), date, qty, comment});
  b.journal.push({id:uid('bj'), date, type:'production', text:`Produced ${qty} product(s)${comment?': '+comment:''}`, qtyDelta:qty});
  // subtract parts
  const rows = boardPartRows(b);
  rows.forEach(r=>{
    if(r.part.autoSubtractEnabled){
      applyStockOp(r.part, 'remove', r.qty*qty, `Used in production of ${b.name} (${qty} products)`, 'production');
    }
  });
  touch(); renderAll(); toast(`Logged production of ${qty}`);
}

/* ---- Stock tab (board stock adjustments + graph) ---- */
function renderBoardStock(b, rows){
  return `
    <div class="card">
      <div class="card-title">Product Stock</div>
      <div class="page-desc">Current on-hand assembled products: <b>${b.boardQty}</b></div>
      <button class="btn btn-primary" style="margin-top:10px;" onclick="openBoardStockAdjustForm('${b.id}')">Adjust Stock</button>
    </div>
    <div class="card">
      <div class="card-title">Products On Hand Over Time</div>
      ${rangeButtonsHtml('boardStock', boardStockRange)}
      <canvas id="boardStockChart" height="200"></canvas>
    </div>
    <div class="card">
      <div class="card-title">Parts Committed To This Product's Stock</div>
      <div class="table-wrap"><table><thead><tr><th>Part</th><th>Qty/Product</th><th>Total for ${b.boardQty} products</th><th>On Hand (part)</th></tr></thead><tbody>
      ${rows.map(r=>`<tr class="clickable" onclick="goPage('parts',{partId:'${r.part.id}'})"><td>${escapeHtml(partPrimaryName(r.part))}</td><td>${r.qty}</td><td>${r.qty*b.boardQty}</td><td>${r.part.currentQty}</td></tr>`).join('') || `<tr><td colspan="4" class="empty">No BOM mapped</td></tr>`}
      </tbody></table></div>
    </div>
  `;
}
const BOARD_STOCK_OPS = [
  {key:'add', label:'Add', desc:'Add to on-hand assembled product count — e.g. a completed production run.'},
  {key:'remove', label:'Remove', desc:'Subtract from on-hand assembled product count — e.g. scrapped or written off.'},
  {key:'set', label:'Set', desc:'Directly set on-hand assembled product count to an exact number, e.g. after a physical count.'}
];
function buildBoardOpButtonsHtml(prefix, activeOp){
  return `<div class="op-btn-row" id="${prefix}OpRow">` + BOARD_STOCK_OPS.map(o=>`
    <button type="button" class="op-btn ${o.key===activeOp?'active':''}" data-op="${o.key}" onclick="${prefix}SetOp('${o.key}')">
      ${o.label}
      <span class="op-tip">${escapeHtml(o.desc)}</span>
    </button>`).join('') + `</div>`;
}
let lastBoardStockOp = 'add';
let bsCurrentOp = 'add';
function openBoardStockAdjustForm(boardId){
  const b = findBoard(boardId);
  if(!b) return;
  bsCurrentOp = lastBoardStockOp;
  openModal(`
    <div class="modal-title">Adjust Stock — ${escapeHtml(b.name)}</div>
    <div class="page-desc" style="margin-bottom:12px;">Current on-hand: <b>${b.boardQty}</b></div>
    <div class="field"><label>Operation</label>
      ${buildBoardOpButtonsHtml('bs', bsCurrentOp)}
    </div>
    <div class="field"><label>Quantity</label><input type="number" id="bsQty" value="1"></div>
    <div class="field"><label>Comment</label><input type="text" id="bsComment" placeholder="optional"></div>
    <button class="btn btn-primary" onclick="submitBoardStock('${boardId}')">Apply</button>
  `);
}
function bsSetOp(op){
  bsCurrentOp = op; lastBoardStockOp = op;
  document.querySelectorAll('#bsOpRow .op-btn').forEach(b=>b.classList.toggle('active', b.dataset.op===op));
}
function submitBoardStock(boardId){
  const b = findBoard(boardId);
  const op = bsCurrentOp;
  const qty = Number(document.getElementById('bsQty').value)||0;
  const comment = document.getElementById('bsComment').value.trim();
  let delta = 0;
  if(op==='add'){ delta=qty; b.boardQty+=qty; }
  else if(op==='remove'){ delta=-qty; b.boardQty-=qty; }
  else { delta = qty-b.boardQty; b.boardQty = qty; }
  b.journal.push({id:uid('bj'), date:nowISO(), type:'manual', text:`Manual adjustment: ${op} ${qty}${comment?' — '+comment:''}`, qtyDelta:delta});
  touch(); closeModal(); renderAll(); toast('Product stock updated');
}

/* ---- Journal tab with filters ---- */
let boardSalesRange = 'all';
function boardSalesSetRange(r){ boardSalesRange = r; renderAll(); }
function renderBoardSales(b){
  const salesData = salesForBoard(b.id);
  const totalRevenue = salesData.reduce((s,x)=>s+x.value,0);
  const totalQty = salesData.reduce((s,x)=>s+x.qty,0);
  return `
    <div class="grid grid-3">
      <div class="stat"><div class="stat-label">Total Revenue</div><div class="stat-val good">${fmtMoney2(totalRevenue)}</div></div>
      <div class="stat"><div class="stat-label">Units Sold</div><div class="stat-val">${totalQty}</div></div>
      <div class="stat"><div class="stat-label">Transactions</div><div class="stat-val">${salesData.length}</div></div>
    </div>
    <div class="card">
      <div class="card-title">Sales Over Time</div>
      ${rangeButtonsHtml('boardSales', boardSalesRange)}
      ${salesData.length===0 ? `<div class="empty">No sales recorded for this product yet</div>` : `<canvas id="boardSalesChart" height="220"></canvas>`}
    </div>
    <div class="card">
      <div class="card-title">Transactions</div>
      <div class="table-wrap" style="max-height:300px;overflow-y:auto;"><table><thead><tr><th>Date</th><th>Customer</th><th>Qty</th><th>Value</th></tr></thead><tbody>
      ${salesData.slice().sort((a,c)=>new Date(c.date)-new Date(a.date)).map(x=>`<tr class="clickable" onclick="goPage('sales')"><td>${fmtDate(x.date)}</td><td>${escapeHtml(x.sale.customer)}</td><td>${x.qty}</td><td>${fmtMoney2(x.value)}</td></tr>`).join('') || `<tr><td colspan="4" class="empty">No sales yet</td></tr>`}
      </tbody></table></div>
    </div>
  `;
}
function afterBoardSalesChart(b){
  const el = document.getElementById('boardSalesChart');
  if(!el) return;
  const events = salesForBoard(b.id).map(x=>({date:x.date, value:x.value}));
  const allPoints = computeCumulativePoints(events);
  const points = filterByRange(allPoints, boardSalesRange, x=>x.date);
  makeChart('boardSalesChart', el, { type:'line',
    data:{ labels: points.map(p=>new Date(p.date).toLocaleDateString()), datasets:[{label:'Cumulative Revenue', data:points.map(p=>p.y), borderColor:'#34d399', backgroundColor:'rgba(52,211,153,.15)', fill:true, tension:.2}] },
    options:{ plugins:{legend:{display:false}, tooltip:{callbacks:{label:(ctx)=>fmtMoney2(ctx.parsed.y)}}}, scales:{ x:{ticks:{color:'#8fa79b'},grid:{color:'#1a2926'}}, y:{ticks:{color:'#8fa79b', callback:(v)=>fmtMoney2(v)},grid:{color:'#1a2926'}} } }
  });
}
function renderBoardJournal(b){
  const filters = [
    {id:'all', label:'All'},
    {id:'production', label:'Production Runs'},
    {id:'manual', label:'Manual Adjustments'},
    {id:'sale', label:'Sales'},
    {id:'comment', label:'Comments'},
  ];
  const items = b.journal.filter(j=> boardJournalFilter==='all' || j.type===boardJournalFilter).slice().sort((a,c)=>new Date(c.date)-new Date(a.date));
  return `
    <div class="card">
      <div class="card-title">Product Journal <span class="badge" style="cursor:pointer;" onclick="openBoardCommentForm('${b.id}')">+ Comment</span></div>
      <div class="tabs">
        ${filters.map(f=>`<button class="tab-btn ${boardJournalFilter===f.id?'active':''}" onclick="boardJournalFilter='${f.id}';renderAll()">${f.label}</button>`).join('')}
      </div>
      ${items.length===0?`<div class="empty">No entries for this filter</div>`:
      items.map(j=>`<div class="hist-row ${j.type==='comment'?'journal-comment':''}" style="${j.type==='comment'?'border:1px solid var(--trace-dim);background:rgba(52,211,153,.06);border-radius:6px;padding:8px;margin:2px 0;':''}"><span>${j.type==='comment'?'<span class="badge green" style="margin-right:6px;">📌 NOTE</span>':''}${escapeHtml(j.text)} ${j.qtyDelta?`<span class="badge ${j.qtyDelta>0?'green':'red'}">${j.qtyDelta>0?'+':''}${j.qtyDelta}</span>`:''}</span><span class="d">${fmtDate(j.date)}</span></div>`).join('')}
    </div>
  `;
}
function openBoardCommentForm(boardId){
  openModal(`
    <div class="modal-title">Add Journal Comment</div>
    <div class="field"><label>Comment</label><textarea id="bjText" rows="3"></textarea></div>
    <button class="btn btn-primary" onclick="submitBoardComment('${boardId}')">Add</button>
  `);
}
function submitBoardComment(boardId){
  const t = document.getElementById('bjText').value.trim();
  if(!t) return;
  findBoard(boardId).journal.push({id:uid('bj'), date:nowISO(), type:'comment', text:t, qtyDelta:0});
  touch(); closeModal(); renderAll(); toast('Comment added');
}

/* ============================= PURCHASE PLANNING ============================= */
/* Config lives in DB.purchasePlanning = { boardQtys:{boardId:qty}, stockMode:'inventory'|'inventory_onorder' }
   so the selected boards/quantities travel with the exported database, same as everything else.
   Only boards explicitly added (present as a key in boardQtys) show in the list — this keeps
   old/discontinued boards from cluttering the page. */
function ppSetBoardQty(boardId, val){
  const n = Math.max(0, Number(val)||0);
  DB.purchasePlanning.boardQtys[boardId] = n;
  touch(); renderAll();
}
function ppAddBoard(boardId){
  const b = findBoard(boardId);
  if(!b) return;
  DB.purchasePlanning.boardQtys[boardId] = b.stockTarget||25;
  touch(); renderAll(); toast(`${b.name} added to plan`);
}
function ppRemoveBoard(boardId){
  delete DB.purchasePlanning.boardQtys[boardId];
  touch(); renderAll();
}
function ppFilterAddList(v){
  const s = v.toLowerCase();
  document.querySelectorAll('.pp-add-row').forEach(el=>{ el.style.display = el.dataset.s.includes(s) ? 'flex':'none'; });
}
function ppSetStockMode(mode){
  DB.purchasePlanning.stockMode = mode;
  touch(); renderAll();
}
function ppClearAll(){
  confirmAction('Remove all products from this plan?', ()=>{
    DB.purchasePlanning.boardQtys = {};
    touch(); renderAll(); toast('Plan cleared');
  });
}
function goToPurchasePlanningForBoard(boardId){
  const b = findBoard(boardId);
  if(!b) return;
  if(!DB.purchasePlanning.boardQtys[boardId] || DB.purchasePlanning.boardQtys[boardId]<=0){
    DB.purchasePlanning.boardQtys[boardId] = b.stockTarget||25;
    touch();
  }
  goPage('purchasing');
}
function ppSelectedBoards(){
  return Object.keys(DB.purchasePlanning.boardQtys).map(id=>findBoard(id)).filter(Boolean);
}
function ppComputeAggregate(){
  const pp = DB.purchasePlanning;
  const requiredMap = new Map(); // partId -> {part, required}
  DB.boards.forEach(b=>{
    const qty = pp.boardQtys[b.id]||0;
    if(qty<=0) return;
    boardPartRows(b).forEach(r=>{
      const cur = requiredMap.get(r.part.id) || {part:r.part, required:0};
      cur.required += r.qty*qty;
      requiredMap.set(r.part.id, cur);
    });
  });
  const includeOnOrder = pp.stockMode==='inventory_onorder';
  return Array.from(requiredMap.values()).map(entry=>{
    const p = entry.part;
    const available = p.currentQty + (includeOnOrder ? (p.onOrder||0) : 0);
    const ratio = entry.required>0 ? available/entry.required : Infinity;
    const pct = Number.isFinite(ratio) ? (ratio*100).toFixed(0) : '∞';
    const tooltipLines = [
      includeOnOrder
        ? `${p.currentQty} in inventory + ${p.onOrder||0} on order = ${available} available.`
        : `${p.currentQty} in inventory available.`,
      `(${entry.required} needed for this plan — ${pct}% coverage)`
    ];
    return { part:p, required:entry.required, available, ratio, tooltipLines };
  }).sort((a,b)=>a.ratio-b.ratio);
}
function ppComputeBuildable(){
  const pp = DB.purchasePlanning;
  const includeOnOrder = pp.stockMode==='inventory_onorder';
  return ppSelectedBoards().map(b=>{
    const rows = boardPartRows(b);
    let buildable = Infinity;
    rows.forEach(r=>{
      const avail = r.part.currentQty + (includeOnOrder ? (r.part.onOrder||0) : 0);
      buildable = Math.min(buildable, Math.floor(avail/r.qty));
    });
    if(!Number.isFinite(buildable)) buildable = 0;
    return { board:b, buildable, planned: pp.boardQtys[b.id]||0 };
  }).sort((a,c)=>a.buildable-c.buildable);
}
function renderPurchasePlanning(){
  const pp = DB.purchasePlanning;
  const selectedBoards = ppSelectedBoards();
  const withRatio = ppComputeAggregate();
  const buildableList = ppComputeBuildable();
  const critical = withRatio.filter(x=>Number.isFinite(x.ratio) && x.ratio<1).length;
  const totalCost = withRatio.reduce((s,x)=>s+x.required*x.part.currentPrice,0);
  const addableBoards = DB.boards.filter(b=>!(b.id in pp.boardQtys));

  return `
    ${renderBanners()}
    <div class="page-header">
      <div>
        <div class="page-title"><span class="dot"></span> Purchase Planning</div>
        <div class="page-desc">Add products and quantities to build, then see the aggregate part requirements across all of them.</div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Products To Build</div>
      <div class="page-desc" style="margin-bottom:8px;">Only products added to this plan are listed, so old or discontinued products don't clutter the page. Search below to add one.</div>
      <div class="field">
        <label>Add Product</label>
        <input type="text" id="ppAddFilter" autocomplete="off" placeholder="Search products to add..." oninput="ppFilterAddList(this.value)">
        <div style="max-height:160px;overflow-y:auto;margin-top:6px;border:1px solid var(--border);border-radius:6px;">
          ${addableBoards.map(b=>`<div class="ac-item pp-add-row" style="display:flex;justify-content:space-between;align-items:center;" data-s="${escapeHtml(b.name.toLowerCase())}" onclick="ppAddBoard('${b.id}')"><span>${escapeHtml(b.name)}</span><span class="sub">${escapeHtml(b.description||'')}</span></div>`).join('') || `<div class="empty" style="padding:14px;">All products are already in the plan</div>`}
        </div>
      </div>
      ${selectedBoards.length>0 ? `
      <div class="table-wrap" style="margin-top:14px;"><table><thead><tr><th>Product</th><th>Qty To Build</th><th></th></tr></thead><tbody>
      ${selectedBoards.map(b=>`<tr>
        <td class="clickable" onclick="goPage('boards',{boardId:'${b.id}'})">${escapeHtml(b.name)}</td>
        <td><input type="number" min="0" value="${pp.boardQtys[b.id]||0}" style="width:100px;" onchange="ppSetBoardQty('${b.id}',this.value)"></td>
        <td><span class="small-x" onclick="ppRemoveBoard('${b.id}')" style="float:none;">❌</span></td>
      </tr>`).join('')}
      </tbody></table></div>
      <button class="btn btn-sm" style="margin-top:10px;" onclick="ppClearAll()">Clear All</button>
      ` : `<div class="empty" style="margin-top:14px;">No products added yet</div>`}
    </div>

    <div class="grid grid-4">
      <div class="stat"><div class="stat-label">Products Selected</div><div class="stat-val">${selectedBoards.length}</div></div>
      <div class="stat"><div class="stat-label">Unique Parts Needed</div><div class="stat-val">${withRatio.length}</div></div>
      <div class="stat"><div class="stat-label">Parts Below 100% Coverage</div><div class="stat-val ${critical>0?'bad':'good'}">${critical}</div></div>
      <div class="stat"><div class="stat-label">Est. Cost To Fulfill</div><div class="stat-val good">${fmtMoney2(totalCost)}</div></div>
    </div>

    <div class="card">
      <div class="card-title">
        Stock Coverage For This Plan
        <div class="tabs" style="margin-bottom:0;">
          <button class="tab-btn ${pp.stockMode==='inventory'?'active':''}" onclick="ppSetStockMode('inventory')">Inventory Only</button>
          <button class="tab-btn ${pp.stockMode==='inventory_onorder'?'active':''}" onclick="ppSetStockMode('inventory_onorder')">Inventory + On Order</button>
        </div>
      </div>
      <div class="page-desc" style="margin-bottom:10px;">Sorted lowest coverage first. Click a part name to open its component page, or click its bar for an at-a-glance popup — stats, notes, the supplier link, and how it affects each selected product.</div>
      ${withRatio.length===0 ? `<div class="empty"><div class="big">No products selected</div>Add a product above to see aggregate part requirements.</div>` : `
      <div style="max-height:600px;overflow-y:auto;border:1px solid var(--border-soft);border-radius:6px;">
        <div style="position:relative;height:${Math.max(240, withRatio.length*22)}px;">
          <canvas id="ppChart"></canvas>
        </div>
      </div>
      `}
    </div>

    ${selectedBoards.length>0 ? `
    <div class="card">
      <div class="card-title">Products Buildable From Available Stock</div>
      <div class="page-desc" style="margin-bottom:10px;">How many of each selected product you could build right now, per-product (not accounting for parts shared between products competing with each other). Sorted lowest first. Click a bar to jump to that product.</div>
      <div style="position:relative;height:${Math.max(180, buildableList.length*40)}px;">
        <canvas id="ppBuildableChart"></canvas>
      </div>
    </div>
    ` : ''}

    ${withRatio.length>0 ? `
    <div class="card">
      <div class="card-title">
        Aggregate Parts Needed
        <button class="btn btn-sm" onclick="promptSetAllTargets()">Set All Target Qtys To Required</button>
      </div>
      <div class="page-desc" style="margin-bottom:10px;">"Target" is each part's configured Target Qty against what this plan needs — 100% means the target is set exactly high enough to cover this plan. "Coverage" is available stock (on hand${pp.stockMode==='inventory_onorder'?' + on order':''}) against what this plan needs.</div>
      <div class="table-wrap" style="max-height:400px;overflow-y:auto;"><table><thead><tr><th>Part</th><th>Required</th><th>On Hand</th>${pp.stockMode==='inventory_onorder'?'<th>On Order</th>':''}<th>Target</th><th>Coverage</th></tr></thead><tbody>
      ${withRatio.map(x=>{
        const pct = Number.isFinite(x.ratio) ? (x.ratio*100).toFixed(0)+'%' : '∞';
        const badge = !Number.isFinite(x.ratio) || x.ratio>=1.5 ? '<span class="badge green">OK</span>' : x.ratio>=1 ? '<span class="badge amber">Tight</span>' : '<span class="badge red">Short</span>';
        const targetQty = x.part.targetQty||0;
        const targetRatio = x.required>0 ? (targetQty/x.required) : Infinity;
        const targetPct = Number.isFinite(targetRatio) ? (targetRatio*100).toFixed(0)+'%' : '—';
        const targetBadge = targetQty<=0 ? '<span class="badge">No Target</span>' : targetRatio>=1 ? '<span class="badge green">OK</span>' : '<span class="badge amber">Low</span>';
        return `<tr class="clickable" onclick="goPage('parts',{partId:'${x.part.id}'})">
          <td>${escapeHtml(partPrimaryName(x.part))}</td>
          <td>${x.required} <span class="badge" style="cursor:pointer;" title="Set as Target Qty for this Part" onclick="event.stopPropagation();setPartTargetToRequired('${x.part.id}')">🎯</span></td>
          <td>${x.part.currentQty}</td>
          ${pp.stockMode==='inventory_onorder'?`<td>${x.part.onOrder||0}</td>`:''}
          <td>${targetQty}pcs (${targetPct}) ${targetBadge}</td>
          <td>${pct} ${badge}</td>
        </tr>`;
      }).join('')}
      </tbody></table></div>
    </div>
    ` : ''}
  `;
}
function promptSetAllTargets(){
  const withRatio = ppComputeAggregate();
  if(withRatio.length===0){ toast('No parts to update — add products to the plan first'); return; }
  openModal(`
    <div class="modal-title">Set All Target Quantities</div>
    <div class="page-desc" style="margin-bottom:16px;">This will set the Target Qty for all ${withRatio.length} part${withRatio.length===1?'':'s'} in this plan to match what's required to fulfill it — existing target values will be overwritten. This only changes the target used for low-stock alerts elsewhere in the app; it doesn't touch current stock on hand.</div>
    <button class="btn btn-primary" onclick="submitSetAllTargets()">Set ${withRatio.length} Target${withRatio.length===1?'':'s'}</button>
  `);
}
function submitSetAllTargets(){
  const withRatio = ppComputeAggregate();
  withRatio.forEach(x=>{ x.part.targetQty = x.required; });
  touch();
  closeModal();
  renderAll();
  toast(`Updated target quantity for ${withRatio.length} part${withRatio.length===1?'':'s'}`);
}
function setPartTargetToRequired(partId){
  const withRatio = ppComputeAggregate();
  const x = withRatio.find(r=>r.part.id===partId);
  if(!x){ toast('Could not find that part in the current plan'); return; }
  x.part.targetQty = x.required;
  touch();
  renderAll();
  toast(`Target set to ${x.required} for ${partPrimaryName(x.part)}`);
}

/* ============================= SALES ============================= */
/* Each sale: {id, date, customer, comment, items:[{id, boardId, qty, price}]} — a sale can cover multiple boards. */
function saleTotal(s){ return (s.items||[]).reduce((sum,it)=>sum+it.qty*it.price,0); }
function saleTotalQty(s){ return (s.items||[]).reduce((sum,it)=>sum+it.qty,0); }
/* Returns one entry per sale-line-item that includes this board: {date, qty, value, sale} */
function salesForBoard(boardId){
  const out = [];
  DB.sales.forEach(s=>{
    (s.items||[]).forEach(it=>{
      if(it.boardId===boardId) out.push({date:s.date, qty:it.qty, value:it.qty*it.price, sale:s});
    });
  });
  return out;
}
/* Turns a list of {date, value} events into a chronological cumulative running total —
   shared by the Sales page graph and each product's own Sales tab graph. */
function computeCumulativePoints(events){
  const sorted = events.slice().sort((a,b)=>new Date(a.date)-new Date(b.date));
  let running = 0;
  return sorted.map(e=>{ running+=e.value; return {date:e.date, y:running}; });
}

let salesGroupBy = 'customer';
let salesPageTab = 'overview';
let salesGraphRange = 'all';
function salesGraphSetRange(r){ salesGraphRange = r; renderAll(); }
function renderSales(){
  const customers = Array.from(new Set(DB.sales.map(s=>s.customer))).filter(Boolean);
  const totalValue = DB.sales.reduce((s,x)=>s+saleTotal(x),0);
  const thisYear = new Date().getFullYear();
  const yearValue = DB.sales.filter(s=>new Date(s.date).getFullYear()===thisYear).reduce((s,x)=>s+saleTotal(x),0);
  const byCustomer = {};
  DB.sales.forEach(s=>{ byCustomer[s.customer] = (byCustomer[s.customer]||0) + saleTotal(s); });
  const custRows = Object.entries(byCustomer).sort((a,b)=>b[1]-a[1]);
  const byLocation = {};
  DB.sales.forEach(s=>{ const loc = s.location || 'Unspecified'; byLocation[loc] = (byLocation[loc]||0) + saleTotal(s); });
  const locRows = Object.entries(byLocation).sort((a,b)=>b[1]-a[1]);
  const byProductMap = new Map();
  DB.sales.forEach(s=>{
    (s.items||[]).forEach(it=>{
      const b = findBoard(it.boardId);
      if(!b) return;
      const cur = byProductMap.get(it.boardId) || {board:b, qty:0, revenue:0};
      cur.qty += it.qty;
      cur.revenue += it.qty*it.price;
      byProductMap.set(it.boardId, cur);
    });
  });
  const byProductRows = Array.from(byProductMap.values()).sort((a,b)=>b.revenue-a.revenue);

  return `
    ${renderBanners()}
    <div class="page-header">
      <div>
        <div class="page-title"><span class="dot"></span> Sales</div>
        <div class="page-desc">${DB.sales.length} transactions recorded.</div>
      </div>
      <button class="btn btn-primary" onclick="openSaleForm()">+ New Sale</button>
    </div>

    <div class="tabs">
      <button class="tab-btn ${salesPageTab==='overview'?'active':''}" onclick="salesPageTab='overview';renderAll()">Overview</button>
      <button class="tab-btn ${salesPageTab==='graph'?'active':''}" onclick="salesPageTab='graph';renderAll()">Sales Over Time</button>
      <button class="tab-btn ${salesPageTab==='reports'?'active':''}" onclick="salesPageTab='reports';renderAll()">Sales Reports</button>
    </div>

    ${salesPageTab==='graph' ? `
    <div class="card">
      <div class="card-title">Total Sales Over Time</div>
      ${rangeButtonsHtml('salesGraph', salesGraphRange)}
      ${DB.sales.length===0 ? `<div class="empty">No sales recorded yet</div>` : `<canvas id="salesOverTimeChart" height="240"></canvas>`}
    </div>
    ` : salesPageTab==='reports' ? `
    <div class="card">
      <div class="card-title">
        Sales Reports
        <div class="tabs" style="margin-bottom:0;">
          <button class="tab-btn ${salesGroupBy==='customer'?'active':''}" onclick="salesGroupBy='customer';renderAll()">By Customer</button>
          <button class="tab-btn ${salesGroupBy==='location'?'active':''}" onclick="salesGroupBy='location';renderAll()">By Location</button>
          <button class="tab-btn ${salesGroupBy==='product'?'active':''}" onclick="salesGroupBy='product';renderAll()">By Product</button>
        </div>
      </div>
      ${salesGroupBy==='product' ? `
      <div class="table-wrap" style="max-height:500px;overflow-y:auto;"><table><thead><tr><th>Product</th><th>Qty Sold</th><th>Total Revenue</th></tr></thead><tbody>
      ${byProductRows.map(x=>`<tr class="clickable" onclick="goPage('boards',{boardId:'${x.board.id}'})"><td>${escapeHtml(x.board.name)}</td><td>${x.qty}</td><td>${fmtMoney2(x.revenue)}</td></tr>`).join('') || `<tr><td colspan="3" class="empty">No sales yet</td></tr>`}
      </tbody></table></div>
      ` : `
      <div class="table-wrap" style="max-height:500px;overflow-y:auto;"><table><thead><tr><th>${salesGroupBy==='location'?'Location':'Customer'}</th><th>Total Value</th></tr></thead><tbody>
      ${(salesGroupBy==='location'?locRows:custRows).map(([c,v])=>`<tr><td>${escapeHtml(c)}</td><td>${fmtMoney2(v)}</td></tr>`).join('') || `<tr><td colspan="2" class="empty">No ${salesGroupBy==='location'?'locations':'customers'} yet</td></tr>`}
      </tbody></table></div>
      `}
    </div>
    ` : `

    <div class="grid grid-4">
      <div class="stat"><div class="stat-label">Total Sales Value</div><div class="stat-val good">${fmtMoney2(totalValue)}</div></div>
      <div class="stat"><div class="stat-label">${thisYear} Sales Value</div><div class="stat-val">${fmtMoney2(yearValue)}</div></div>
      <div class="stat"><div class="stat-label">Transactions</div><div class="stat-val">${DB.sales.length}</div></div>
      <div class="stat"><div class="stat-label">Unique Customers</div><div class="stat-val">${customers.length}</div></div>
    </div>

    <div class="card">
      <div class="card-title">Recent Transactions</div>
      <div class="table-wrap" style="max-height:440px;overflow-y:auto;"><table><thead><tr><th>Date</th><th>Customer</th><th>Location</th><th>Products</th><th>Total Qty</th><th>Value</th><th>Notes</th><th></th></tr></thead><tbody>
      ${DB.sales.slice().sort((a,b)=>new Date(b.date)-new Date(a.date)).map(s=>{
        const items = s.items||[];
        const boardSummary = items.map(it=>{ const b=findBoard(it.boardId); return `${b?escapeHtml(b.name):'—'} ×${it.qty}`; }).join(', ');
        return `<tr>
          <td>${fmtDate(s.date)}</td><td>${escapeHtml(s.customer)}</td><td>${escapeHtml(s.location||'—')}</td><td>${boardSummary||'—'}</td><td>${saleTotalQty(s)}</td><td>${fmtMoney2(saleTotal(s))}</td>
          <td style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(s.notes||'')}">${s.notes ? escapeHtml(s.notes) : '<span style="color:var(--text-faint);">—</span>'}</td>
          <td><span class="badge" style="cursor:pointer;" onclick="openSaleForm('${s.id}')">Edit</span> <span class="small-x" onclick="deleteSale('${s.id}')" style="float:none;">❌</span></td>
        </tr>`;
      }).join('') || `<tr><td colspan="8" class="empty">No transactions yet</td></tr>`}
      </tbody></table></div>
    </div>
    `}
  `;
}
function afterSalesGraph(){
  const el = document.getElementById('salesOverTimeChart');
  if(!el) return;
  const events = DB.sales.map(s=>({date:s.date, value:saleTotal(s)}));
  const allPoints = computeCumulativePoints(events);
  const points = filterByRange(allPoints, salesGraphRange, x=>x.date);
  makeChart('salesOverTimeChart', el, { type:'line',
    data:{ labels: points.map(p=>new Date(p.date).toLocaleDateString()), datasets:[{label:'Cumulative Sales', data:points.map(p=>p.y), borderColor:'#34d399', backgroundColor:'rgba(52,211,153,.15)', fill:true, tension:.2}] },
    options:{ plugins:{legend:{display:false}, tooltip:{callbacks:{label:(ctx)=>fmtMoney2(ctx.parsed.y)}}}, scales:{ x:{ticks:{color:'#8fa79b'},grid:{color:'#1a2926'}}, y:{ticks:{color:'#8fa79b', callback:(v)=>fmtMoney2(v)},grid:{color:'#1a2926'}} } }
  });
}

function openSaleForm(saleId){
  const s = saleId ? DB.sales.find(x=>x.id===saleId) : null;
  const customers = Array.from(new Set(DB.sales.map(x=>x.customer))).filter(Boolean);
  const locations = Array.from(new Set(DB.sales.map(x=>x.location))).filter(Boolean);
  openModal(`
    <div class="modal-title">${s?'Edit Sale':'New Sale'}</div>
    <div class="grid grid-2">
      <div class="field autocomplete-wrap">
        <label>Customer</label>
        <input type="text" id="slCustomer" value="${s?escapeHtml(s.customer):''}" list="custList" placeholder="Customer name">
        <datalist id="custList">${customers.map(c=>`<option value="${escapeHtml(c)}">`).join('')}</datalist>
      </div>
      <div class="field autocomplete-wrap">
        <label>End User Location</label>
        <input type="text" id="slLocation" value="${s?escapeHtml(s.location||''):''}" list="locList" placeholder="City, State / Country">
        <datalist id="locList">${locations.map(l=>`<option value="${escapeHtml(l)}">`).join('')}</datalist>
      </div>
    </div>
    <div class="grid grid-2">
      <div class="field"><label>Date</label><input type="date" id="slDate" value="${s?new Date(s.date).toISOString().slice(0,10):new Date().toISOString().slice(0,10)}"></div>
      <div class="field"><label>Comment</label><input type="text" id="slComment" value="${s?escapeHtml(s.comment||''):''}"></div>
    </div>
    <div class="field"><label>Notes (e.g. device serial numbers)</label><textarea id="slNotes" rows="3" placeholder="One per line, e.g.&#10;SN: MC-B-1001&#10;SN: MC-B-1002">${s?escapeHtml(s.notes||''):''}</textarea></div>
    <label style="margin-top:4px;">Products In This Sale</label>
    <div id="slItemsContainer" style="margin-bottom:8px;"></div>
    <button class="btn btn-sm" onclick="slAddItemRow()">+ Add Product</button>
    <div style="margin-top:16px;">
      <button class="btn btn-primary" onclick="submitSale(${s?`'${s.id}'`:'null'})">${s?'Save Changes':'Record Sale'}</button>
    </div>
  `);
  if(s && s.items && s.items.length){
    s.items.forEach(it=>slAddItemRow(it.boardId, it.qty, it.price));
  } else {
    slAddItemRow();
  }
}
function slAddItemRow(boardId, qty, price){
  const container = document.getElementById('slItemsContainer');
  if(!container) return;
  const row = document.createElement('div');
  row.className = 'sale-item-row';
  row.style = 'display:flex;gap:8px;margin-bottom:8px;align-items:center;';
  row.innerHTML = `
    <select class="sl-item-board" style="flex:2;">
      ${DB.boards.map(b=>`<option value="${b.id}" ${boardId===b.id?'selected':''}>${escapeHtml(b.name)}</option>`).join('') || '<option disabled>No products available</option>'}
    </select>
    <input type="number" class="sl-item-qty" value="${qty!=null?qty:1}" placeholder="Qty" style="flex:1;">
    <input type="number" step="0.01" class="sl-item-price" value="${price!=null?price:0}" placeholder="Unit Price" style="flex:1;">
    <span class="small-x" onclick="this.closest('.sale-item-row').remove()" style="float:none;">❌</span>
  `;
  container.appendChild(row);
}
function readSaleItemRows(){
  return Array.from(document.querySelectorAll('#slItemsContainer .sale-item-row')).map(row=>({
    boardId: row.querySelector('.sl-item-board').value,
    qty: Number(row.querySelector('.sl-item-qty').value)||0,
    price: Number(row.querySelector('.sl-item-price').value)||0
  })).filter(it=>it.boardId && it.qty>0);
}
function applySaleItemsToBoards(items, date, customer, comment, verb){
  items.forEach(it=>{
    const board = findBoard(it.boardId);
    if(!board) return;
    board.boardQty -= it.qty;
    board.journal.push({id:uid('bj'), date, type:'sale', text:`${verb} ${it.qty} to ${customer}${comment?' — '+comment:''}`, qtyDelta:-it.qty});
  });
}
function revertSaleItemsFromBoards(items, note){
  (items||[]).forEach(it=>{
    const board = findBoard(it.boardId);
    if(!board) return;
    board.boardQty += it.qty;
    if(note) board.journal.push({id:uid('bj'), date:nowISO(), type:'sale', text:`${note} (restored ${it.qty})`, qtyDelta:it.qty});
  });
}
function submitSale(saleId){
  const customer = document.getElementById('slCustomer').value.trim();
  const location = document.getElementById('slLocation').value.trim();
  const date = dateInputToISO(document.getElementById('slDate').value);
  const comment = document.getElementById('slComment').value.trim();
  const notes = document.getElementById('slNotes').value.trim();
  const items = readSaleItemRows().map(it=>({id:uid('si'), ...it}));
  if(!customer || items.length===0){ toast('Customer and at least one product line are required'); return; }

  if(saleId){
    const s = DB.sales.find(x=>x.id===saleId);
    revertSaleItemsFromBoards(s.items, null); // silently undo old effect, no extra journal noise
    s.customer=customer; s.location=location; s.date=date; s.comment=comment; s.notes=notes; s.items=items;
    applySaleItemsToBoards(items, date, customer, comment, 'Sale edited:');
  } else {
    DB.sales.push({id:uid('sale'), date, customer, location, comment, notes, items});
    applySaleItemsToBoards(items, date, customer, comment, 'Sold');
  }
  touch(); closeModal(); renderAll(); toast('Sale saved');
}
function deleteSale(saleId){
  confirmAction('Delete this sale? Product stock will be restored.', ()=>{
    const s = DB.sales.find(x=>x.id===saleId);
    revertSaleItemsFromBoards(s.items, 'Sale deleted');
    DB.sales = DB.sales.filter(x=>x.id!==saleId);
    touch(); renderAll(); toast('Sale deleted');
  });
}

/* ============================= JOURNAL PAGE ============================= */
function renderJournalPage(){
  return `
    ${renderBanners()}
    <div class="page-header">
      <div>
        <div class="page-title"><span class="dot"></span> Journal</div>
        <div class="page-desc">Global activity feed across parts, products and sales.</div>
      </div>
      <button class="btn btn-primary" onclick="openGlobalCommentForm()">+ Add Comment</button>
    </div>
    <div class="card">
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin:0 0 10px 0;">
        <input type="checkbox" style="width:auto;" ${journalHideProductionReductions?'checked':''} onchange="journalHideProductionReductions=this.checked;renderAll()">
        <span style="font-size:12.5px;color:var(--text-dim);text-transform:none;letter-spacing:normal;font-family:var(--sans);">Hide individual component reductions from production runs</span>
      </label>
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin:0 0 10px 0;">
        <input type="checkbox" style="width:auto;" ${journalHideComponentQtyChanges?'checked':''} onchange="journalHideComponentQtyChanges=this.checked;renderAll()">
        <span style="font-size:12.5px;color:var(--text-dim);text-transform:none;letter-spacing:normal;font-family:var(--sans);">Hide other component quantity changes</span>
      </label>
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;margin:0;">
        <input type="checkbox" style="width:auto;" ${journalHideComponentOnOrder?'checked':''} onchange="journalHideComponentOnOrder=this.checked;renderAll()">
        <span style="font-size:12.5px;color:var(--text-dim);text-transform:none;letter-spacing:normal;font-family:var(--sans);">Hide component on order changes</span>
      </label>
    </div>
    <div class="card">
      ${renderJournalFeed(500)}
    </div>
  `;
}
function openGlobalCommentForm(){
  openModal(`
    <div class="modal-title">Add Journal Comment</div>
    <div class="field"><label>Comment</label><textarea id="gjText" rows="3"></textarea></div>
    <button class="btn btn-primary" onclick="submitGlobalComment()">Add</button>
  `);
}
function submitGlobalComment(){
  const t = document.getElementById('gjText').value.trim();
  if(!t) return;
  DB.journal.push({id:uid('gj'), date:nowISO(), type:'comment', text:t});
  touch(); closeModal(); renderAll(); toast('Comment added');
}

/* ============================= MEDIA PAGE ============================= */
function mediaUsageFor(filename){
  const usedBy = [];
  DB.parts.forEach(p=>{
    if(p.imageFile===filename) usedBy.push({type:'part', id:p.id, name:partPrimaryName(p), as:'image'});
    if((p.files||[]).includes(filename)) usedBy.push({type:'part', id:p.id, name:partPrimaryName(p), as:'attachment'});
  });
  DB.boards.forEach(b=>{
    if(b.image && b.image.file===filename) usedBy.push({type:'board', id:b.id, name:b.name, as:'PCB image'});
    if((b.files||[]).includes(filename)) usedBy.push({type:'board', id:b.id, name:b.name, as:'attachment'});
  });
  return usedBy;
}
function renderMediaPage(){
  return `
    ${renderBanners()}
    <div class="page-header">
      <div>
        <div class="page-title"><span class="dot"></span> Media</div>
        <div class="page-desc">${mediaFiles.length} file(s) stored on the server — images, datasheets, spec sheets, anything referenced from Components or Products.</div>
      </div>
      <div>
        <input type="file" id="mediaPageUpload" style="display:none" multiple onchange="handleMediaPageUpload(this)">
        <button class="btn btn-primary" onclick="document.getElementById('mediaPageUpload').click()">📤 Upload File(s)</button>
      </div>
    </div>
    <div class="card">
      ${mediaFiles.length===0 ? `<div class="empty"><div class="big">No files uploaded yet</div>Upload images, datasheets, or spec sheets to use across your components and products.</div>` : `
      <div class="table-wrap"><table><thead><tr><th></th><th>File</th><th>Size</th><th>Uploaded</th><th>Used By</th><th></th></tr></thead><tbody>
      ${mediaFiles.slice().sort((a,b)=>new Date(b.modified)-new Date(a.modified)).map(f=>{
        const usage = mediaUsageFor(f.name);
        return `<tr>
          <td>${isImageFile(f.name) ? `<img src="${mediaUrl(f.name)}" style="width:36px;height:36px;object-fit:cover;border-radius:4px;border:1px solid var(--border);">` : `<span style="font-size:20px;">📄</span>`}</td>
          <td><a href="${mediaUrl(f.name)}" target="_blank" rel="noopener" style="color:var(--trace);text-decoration:none;font-family:var(--mono);font-size:11.5px;">${escapeHtml(f.name)}</a></td>
          <td>${fmtFileSize(f.size)}</td>
          <td>${fmtDate(f.modified)}</td>
          <td>${usage.length===0?'<span style="color:var(--text-faint);">Unused</span>':usage.map(u=>`<span class="badge blue" style="cursor:pointer;margin-right:4px;" title="${escapeHtml(u.as)}" onclick="goPage('${u.type==='part'?'parts':'boards'}',{${u.type==='part'?'partId':'boardId'}:'${u.id}'})">${escapeHtml(u.name)}</span>`).join('')}</td>
          <td><span class="small-x" style="float:none;color:var(--text-faint);" title="Replace this file's content" onclick="promptReplaceFile('${jsAttrEscape(f.name)}')">🔄</span> <span class="small-x" onclick="confirmDeleteMediaFile('${jsAttrEscape(f.name)}')" style="float:none;" title="Delete">❌</span></td>
        </tr>`;
      }).join('')}
      </tbody></table></div>
      `}
    </div>
  `;
}
async function handleMediaPageUpload(input){
  const files = Array.from(input.files||[]);
  if(files.length===0) return;
  let ok = 0;
  for(const file of files){
    try{ await uploadFileToMedia(file); ok++; }
    catch(err){ toast('Upload failed for ' + file.name + ': ' + err.message); }
  }
  input.value = '';
  renderAll();
  if(ok>0) toast(`${ok} file(s) uploaded`);
}
function confirmDeleteMediaFile(filename){
  const usage = mediaUsageFor(filename);
  const usageWarning = usage.length>0 ? ` This file is currently used by ${usage.length} item(s) — removing it will leave those references broken.` : '';
  confirmAction(`Delete "${filename}" from Media?${usageWarning}`, async ()=>{
    try{
      await deleteMediaFile(filename);
      renderAll();
      toast('File deleted');
    }catch(err){
      toast('Delete failed: ' + err.message);
    }
  });
}

/* ============================= IMPORT / EXPORT ============================= */
function exportDB(){
  DB.meta.lastModified = nowISO();
  const blob = new Blob([JSON.stringify(DB,null,2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0,19).replace(/[:T]/g,'-');
  a.href = url; a.download = `inventory-db-${stamp}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
  toast('Backup file downloaded (server copy is saved automatically)');
}
document.getElementById('importFile').addEventListener('change', function(e){
  const file = e.target.files[0]; if(!file) return;
  const reader = new FileReader();
  reader.onload = async evt=>{
    try{
      const data = JSON.parse(evt.target.result);
      if(!data.parts || !data.boards){ throw new Error('Invalid database file'); }
      DB = data;
      DB.banners = DB.banners || [];
      DB.journal = DB.journal || [];
      DB.purchasePlanning = DB.purchasePlanning || { boardQtys:{}, stockMode:'inventory' };
      DB.sales = (DB.sales||[]).map(s=>{
        if(!s.items){ // migrate legacy single-board sale shape
          s = {...s, items:[{id:uid('si'), boardId:s.boardId, qty:s.qty, price:s.price}]};
          delete s.boardId; delete s.qty; delete s.price;
        }
        return s;
      });
      // Older exports embedded images as base64 (p.image / b.image.dataUrl). Migrate any
      // of those into real files in the media library instead of just discarding them.
      let migratedCount = 0;
      for(const p of DB.parts){
        if(!p.files) p.files = [];
        if(p.image && typeof p.image==='string' && p.image.startsWith('data:')){
          try{
            const f = dataUrlToFile(p.image, `${(p.name||p.aliases?.[0]?.value||'part').replace(/[^a-z0-9._-]+/gi,'_')}.png`);
            p.imageFile = await uploadFileToMedia(f);
            migratedCount++;
          }catch(err){ p.imageFile = null; }
          delete p.image;
        } else if(p.imageFile===undefined){
          p.imageFile = null;
        }
      }
      for(const b of DB.boards){
        if(!b.files) b.files = [];
        if(b.image && b.image.dataUrl && typeof b.image.dataUrl==='string' && b.image.dataUrl.startsWith('data:')){
          try{
            const f = dataUrlToFile(b.image.dataUrl, `${(b.name||'board').replace(/[^a-z0-9._-]+/gi,'_')}-pcb.png`);
            b.image.file = await uploadFileToMedia(f);
            migratedCount++;
          }catch(err){ b.image.file = null; }
          delete b.image.dataUrl;
        } else if(b.image && b.image.file===undefined){
          b.image.file = null;
        }
      }
      currentPartId=null; currentBoardId=null; currentPage='dashboard';
      renderAll();
      await saveConfigToServer();
      toast(migratedCount>0
        ? `Database imported — ${migratedCount} embedded image(s) migrated to Media`
        : 'Database imported and saved: ' + (data.meta && data.meta.name || file.name));
    }catch(err){
      toast('Could not import file: ' + err.message);
    }
  };
  reader.readAsText(file);
  e.target.value = '';
});
function dataUrlToFile(dataUrl, filename){
  const arr = dataUrl.split(',');
  const mimeMatch = arr[0].match(/:(.*?);/);
  const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while(n--){ u8arr[n] = bstr.charCodeAt(n); }
  return new File([u8arr], filename, {type:mime});
}

/* Warn before closing/reloading the tab if there are unsaved changes that haven't made
   it to the server yet (e.g. the debounced save is still pending or a save failed). */
window.addEventListener('beforeunload', function(e){
  if(hasUnsavedChanges){
    e.preventDefault();
    e.returnValue = '';
    return '';
  }
});
