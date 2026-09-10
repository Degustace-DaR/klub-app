// Degustační klub – hlavní logika aplikace.
// Sdílí index.html (ostrá) i index-test.html (testovací).
// Konfigurace (FIREBASE_CONFIG, PINy) je v <script> bloku každé z nich, PŘED tímto souborem.

let db = null;
let storage = null;
let isGuest = false;
let isAdmin = false;
let currentUser = null;

/* ---------------- Oprávnění nad rámec běžného člena ---------------- */
const PERM_SPRAVCI = ['Broněk', 'Libor'];   // potvrzování a zadávání termínů, účet, mazání účasti
const PERM_MAZANI = ['Broněk', 'Libor'];    // mazání rumů a položek wishlistu
function hasPerm(names) {
  return isAdmin || (!!currentUser && names.includes(currentUser));
}
let state = { members: [], rums: [], ratings: [], ledger: [], wishlist: [], cigars: [], cigarLog: [], terminUcastnici: [], terminKola: [], ucasti: [], cigarRatings: [], ledgerDoutniky: [] };
let _chartPriceQuality = null;
let _chartMemberTimeline = null;
function cssVarVal(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
let ui = {
  tab: 'rumy',
  selectedRatingRumId: null,
  selectedMember: null,
  rateShowDone: false,
  rateAllUnrated: false,
  scores: { barva: 15, aroma: 15, chut: 15, plnost: 15, dojezd: 15 },
  showNewRum: false,
  showNewRumRumy: false,
  showNewMember: false,
  wishFilter: 'kandidát',
  wishFormOpen: false,
  detailRumId: null,
  statMember: 'vse',
  statOrigin: 'vse',
  showNewCigarHumidor: false,
  detailCigarId: null,
  cigarShowNakupForm: false,
  cigarShowLogForm: false,
  cigarLogMember: null,
  cigarLogDatum: null,
  editingCigarLogId: null,
  detailKoloId: null,
  showNewKoloTerminy: false,
  newKoloDatumy: ['', ''],
  showTerminUcastnikForm: false,
  showNewUcast: false,
  newUcastDatum: '',
  newUcastMisto: '',
  newUcastLidi: [],
  newUcastDalsi: '',
  detailUcastId: null,
  showPuvodCleanup: false,
  showDatumBackfill: false,
  showCenaBackfill: false,
  rumOrigin: 'vse',
  puvodGroups: null,
  puvodCanon: {},
  puvodChecked: {},
  typ: 'rum',
  editingRumId: null,
  cigarScores: { vzhled: 8, vune: 8, tah: 8, chut: 15, kour: 15, horeni: 15, popel: 8 },
};

function uid(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2,7);
}

function toast(msg, kind) {
  const t = document.getElementById('toast');
  t.textContent = (kind === 'ok' ? '✓ ' : '') + msg;
  t.classList.toggle('ok', kind === 'ok');
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(()=>t.classList.remove('show'), kind === 'ok' ? 2600 : 2200);
}

/* ---------------- Ukládání: pojistka proti dvojímu ťuknutí + indikace stavu ---------------- */

// Deduplikace kliků: druhé ťuknutí na stejné submit-tlačítko do 1200 ms se zahodí
// (capture fáze → inline onclick 2. ťuknutí vůbec neproběhne). Po překreslení sekce
// je tlačítko nový element, takže se nic omylem neblokuje.
function _isGuardedBtn(el) {
  const btn = el && el.closest ? el.closest('.btn-primary, [data-once]') : null;
  if (!btn || btn.id === 'pinUnlockBtn') return null;
  return btn;
}

let _lastSubmitEl = null, _lastSubmitAt = 0;
document.addEventListener('click', (e) => {
  const btn = _isGuardedBtn(e.target);
  if (!btn || btn.disabled) return;
  const now = Date.now();
  if (btn === _lastSubmitEl && now - _lastSubmitAt < 1200) {
    _lastSubmitAt = now;               // opakované ťukání blokaci prodlužuje
    e.stopImmediatePropagation();
    e.preventDefault();
    return;
  }
  _lastSubmitEl = btn;
  _lastSubmitAt = now;
}, true);

// Po odpálení akce dát tlačítku viditelný „pracuji" stav (bubble fáze — inline
// onclick už běží). Když sekce přerenderuje, staré tlačítko zmizí; jinak se po 1,5 s obnoví.
document.addEventListener('click', (e) => {
  const btn = _isGuardedBtn(e.target);
  if (!btn || btn.disabled || btn.dataset.busy === '1') return;
  btn.dataset.busy = '1';
  btn.setAttribute('aria-busy', 'true');
  btn.disabled = true;
  setTimeout(() => {
    if (!btn.isConnected) return;
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    btn.dataset.busy = '0';
  }, 1500);
});

// Počet zápisů čekajících na potvrzení serverem.
let _pending = 0;
let _savedTimer = null;

function whoLabel() {
  if (currentUser) return currentUser;
  if (isAdmin) return 'Admin';
  if (isGuest) return 'Host';
  return '';
}

function updateSyncIndicator() {
  const el = document.getElementById('syncLabel');
  if (!el) return;
  let cls = '', text = '';
  if (!db) { cls = 'is-offline'; text = 'offline'; }
  else if (!navigator.onLine) { cls = 'is-offline'; text = _pending ? _pending + ' čeká na síť' : 'offline'; }
  else if (_pending > 0) { cls = 'is-saving'; text = 'ukládám…'; }
  else if (el.dataset.justSaved === '1') { cls = 'is-saved'; text = '✓ uloženo'; }
  else { cls = 'is-user'; text = whoLabel(); }  // v klidu: kdo je přihlášený
  el.className = 'sync-label ' + cls;
  el.textContent = text;
}

// Jednorázově obalí zápisové metody Firestore, aby appka věděla, kolik změn ještě
// nedorazilo na server (db.waitForPendingWrites()). Bez zásahu do ~30 volání.
function instrumentWrites() {
  try {
    const F = firebase.firestore;
    const wrap = (proto, method) => {
      if (!proto || typeof proto[method] !== 'function' || proto[method]._wrapped) return;
      const orig = proto[method];
      const wrapped = function (...args) {
        _pending++;
        updateSyncIndicator();
        const ret = orig.apply(this, args);
        const done = () => {
          _pending = Math.max(0, _pending - 1);
          if (_pending === 0 && navigator.onLine) {
            const el = document.getElementById('syncLabel');
            if (el) {
              el.dataset.justSaved = '1';
              clearTimeout(_savedTimer);
              _savedTimer = setTimeout(() => { el.dataset.justSaved = '0'; updateSyncIndicator(); }, 1600);
            }
          }
          updateSyncIndicator();
        };
        Promise.resolve(ret).then(() => db.waitForPendingWrites()).then(done, done);
        return ret;
      };
      wrapped._wrapped = true;
      proto[method] = wrapped;
    };
    wrap(F.DocumentReference.prototype, 'set');
    wrap(F.DocumentReference.prototype, 'update');
    wrap(F.DocumentReference.prototype, 'delete');
    wrap(F.CollectionReference.prototype, 'add');
    wrap(F.WriteBatch.prototype, 'commit');
  } catch (e) {
    console.warn('instrumentWrites selhalo (indikátor ukládání bude statický):', e);
  }
}

window.addEventListener('online', updateSyncIndicator);
window.addEventListener('offline', updateSyncIndicator);

// Dvě tlačítka pro fotku: přímo foťák vs. galerie. onPick = JS výraz, který dostane `this.files[0]`.
function fotoButtonsHtml(pickExpr, labelPrefix) {
  const p = labelPrefix || '';
  return `
    <div class="btn-row foto-btns">
      <label class="btn btn-ghost btn-sm">📷 ${p}Vyfotit
        <input type="file" accept="image/*" capture="environment" hidden onchange="if(this.files[0]){ ${pickExpr} }">
      </label>
      <label class="btn btn-ghost btn-sm">🖼️ ${p}Z galerie
        <input type="file" accept="image/*" hidden onchange="if(this.files[0]){ ${pickExpr} }">
      </label>
    </div>`;
}

const MORE_TABS = ['ucet', 'terminy', 'ucast', 'klub', 'info', 'humidor'];

function goTab(tab) {
  // Humidor je vždy o doutnících – přepni přepínač, pokud je na Rumu
  if (tab === 'humidor' && ui.typ !== 'doutnik') { ui.typ = 'doutnik'; syncTypUI(); }
  ui.tab = tab;
  document.querySelectorAll('[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  const moreBtn = document.getElementById('botnavMore');
  if (moreBtn) moreBtn.classList.toggle('active', MORE_TABS.includes(tab));
  closeMoreMenu();
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + tab));
  window.scrollTo(0, 0);
  if (tab === 'rumy') renderRumy();
  if (tab === 'degustace') renderActiveDegustaceForm();
  if (tab === 'ucet') renderUcet();
  if (tab === 'wishlist') renderWishlist();
  if (tab === 'humidor') renderHumidor();
  if (tab === 'terminy') renderTerminy();
  if (tab === 'ucast') renderUcast();
  if (tab === 'statistika') renderStatistika();
  if (tab === 'info') renderInfo();
  if (tab === 'klub') renderKlub();
}

/* ---------------- Rum / Doutník přepínač ---------------- */
function syncTypUI() {
  document.querySelectorAll('.toggle-seg').forEach(el => el.classList.toggle('active', el.dataset.typ === ui.typ));
  const isDoutnik = ui.typ === 'doutnik';
  const rumyBtn = document.getElementById('rumyTabBtn');
  if (rumyBtn) rumyBtn.innerHTML = isDoutnik ? '🚬 Doutníky' : '🥃 Rumy';
  const katIco = document.getElementById('botnavKatalogIco');
  if (katIco) {
    if (katIco.tagName === 'IMG') katIco.src = isDoutnik ? 'icon-cigar.svg' : 'icon-glass.svg';
    else katIco.textContent = isDoutnik ? '🚬' : '🥃';
  }
  const rumyTitle = document.getElementById('rumyViewTitle');
  if (rumyTitle) rumyTitle.textContent = isDoutnik ? 'Doutníky' : 'Rumy';
  const degTitle = document.getElementById('degustaceViewTitle');
  if (degTitle) degTitle.textContent = isDoutnik ? 'Hodnocení – Doutníky' : 'Hodnocení – Rumy';
  const ucetTitle = document.getElementById('ucetViewTitle');
  if (ucetTitle) ucetTitle.textContent = isDoutnik ? 'Účet klubu – Doutníky' : 'Účet klubu – Rumy';
  const wishTitle = document.getElementById('wishlistViewTitle');
  if (wishTitle) wishTitle.textContent = isDoutnik ? 'Wishlist – Doutníky' : 'Wishlist – Rumy';
  const statTitle = document.getElementById('statistikaViewTitle');
  if (statTitle) statTitle.textContent = isDoutnik ? 'Statistika – Doutníky' : 'Statistika – Rumy';
  const humidorBtn = document.getElementById('humidorTabBtn');
  if (humidorBtn) humidorBtn.hidden = !isDoutnik;
}

function setTyp(t) {
  ui.typ = t;
  syncTypUI();
  ui.selectedRatingRumId = null;
  ui.rateAllUnrated = false;
  ui.showNameCleanup = false; ui.nameGroups = null;
  if (typeof renderNameCleanupSection === 'function') renderNameCleanupSection();
  if (t === 'rum' && ui.tab === 'humidor') { goTab('rumy'); return; }
  rerenderActive();
}

/* ---------------- Spodní navigace – panel „Víc" + přepínač motivu ---------------- */
function toggleMoreMenu() {
  const ov = document.getElementById('moreMenuOverlay');
  if (!ov) return;
  if (ov.hidden) { renderMoreMenu(); ov.hidden = false; }
  else ov.hidden = true;
}
function closeMoreMenu() {
  const ov = document.getElementById('moreMenuOverlay');
  if (ov) ov.hidden = true;
}
function renderMoreMenu() {
  const el = document.getElementById('moreMenuSheet');
  if (!el) return;
  // Pevná 2sloupcová mřížka, stejná pro Rum i Doutník (host nemá Účet).
  let cells = [
    ['humidor', '🚬', 'Humidor'],
    ['terminy', '🗓️', 'Termíny'],
    ['ucet', '💰', 'Účet'],
    ['ucast', '🙋', 'Účast'],
    ['klub', '👥', 'Klub'],
    ['info', 'ℹ️', 'Info'],
  ];
  if (isGuest) cells = cells.filter(([tab]) => tab !== 'ucet');
  const cur = (() => { try { return localStorage.getItem('rumklub_theme') || 'auto'; } catch (e) { return 'auto'; } })();
  const themeBtn = (val, label) => `<button class="toggle-seg ${cur === val ? 'active' : ''}" onclick="setTheme('${val}')">${label}</button>`;
  el.innerHTML = `
    <div class="sheet-head">
      <h2 style="font-family:var(--font-display);font-weight:600;font-size:1.4rem;margin:0;">Více</h2>
      <button class="sheet-close" onclick="closeMoreMenu()" aria-label="Zavřít">×</button>
    </div>
    <div class="more-grid">
      ${cells.map(([tab, ico, label]) =>
        `<button class="more-item ${ui.tab === tab ? 'active' : ''}" data-tab="${tab}" onclick="goTab('${tab}')"><span class="more-ico">${ico}</span>${label}</button>`
      ).join('')}
    </div>
    <div class="stat-section-title" style="margin-top:18px;">Vzhled</div>
    <div class="toggle-row" style="max-width:100%;">
      ${themeBtn('auto', 'Automaticky')}
      ${themeBtn('light', '☀️ Světlý')}
      ${themeBtn('dark', '🌙 Tmavý')}
    </div>
    <div class="btn-row" style="margin-top:18px;">
      <button class="btn btn-ghost" onclick="closeMoreMenu()">Zavřít</button>
    </div>`;
}

function setTheme(t) {
  try {
    if (t === 'auto') { delete document.documentElement.dataset.theme; localStorage.removeItem('rumklub_theme'); }
    else { document.documentElement.dataset.theme = t; localStorage.setItem('rumklub_theme', t); }
  } catch (e) { if (t !== 'auto') document.documentElement.dataset.theme = t; }
  renderMoreMenu();
}
function initTheme() {
  try {
    const t = localStorage.getItem('rumklub_theme');
    if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  } catch (e) {}
}

function renderActiveDegustaceForm() {
  if (ui.typ === 'doutnik') renderCigarDegustaceForm();
  else renderDegustaceForm();
}

/* ---------- Hodnocení: úvodní seznam „co ještě nemám ohodnocené" ---------- */
// Koho hodnotíme: přihlášený člen = sám sebe; admin = vybraný člen (chipy).
function ratingWhoLabel() {
  return currentUser || ui.selectedMember || null;
}
function myRatingFor(rumId, who) {
  if (!who) return null;
  const pool = ui.typ === 'doutnik' ? state.cigarRatings : state.ratings;
  return pool.find(r => r.rumId === rumId && r.clen === who) || null;
}

function ratingLandingHtml() {
  const isDoutnik = ui.typ === 'doutnik';
  const noun = isDoutnik ? 'doutník' : 'rum';
  const who = ratingWhoLabel();

  let html = '<div class="card">';

  // Admin (bez jména) volí, za koho zapisuje
  if (isAdmin && !currentUser) {
    if (who) {
      html += `<div class="field"><label>Za koho hodnotíš</label>
        <div class="selected-chip"><span>${esc(who)}</span>
        <button class="x" onclick="ui.selectedMember=null; renderActiveDegustaceForm();">×</button></div></div>`;
    } else {
      const ms = state.members.filter(m => m.aktivni !== false).slice().sort((a, b) => {
        const ia = CLUB_MEMBER_ORDER.indexOf(a.jmeno), ib = CLUB_MEMBER_ORDER.indexOf(b.jmeno);
        const ra = ia === -1 ? 99 : ia, rb = ib === -1 ? 99 : ib;
        return ra !== rb ? ra - rb : a.jmeno.localeCompare(b.jmeno, 'cs');
      });
      html += '<div class="field"><label>Za koho hodnotíš</label><div class="member-chips">' +
        ms.map(m => `<button class="member-chip" onclick="ui.selectedMember='${esc(m.jmeno).replace(/'/g, "\\'")}'; renderActiveDegustaceForm();">${esc(m.jmeno)}</button>`).join('') +
        '</div></div>';
    }
  }

  html += `<input class="input" id="rumPickSearch" placeholder="Hledat ${noun}…" oninput="renderRatingLandingList()">`;
  html += '<div id="rumPickList" style="margin-top:8px;"></div>';
  html += '</div>';

  if (who) {
    const items = state.rums.filter(r => (r.typ || 'rum') === ui.typ);
    const doneCount = items.filter(r => myRatingFor(r.id, who)).length;
    html += `<div class="card" style="margin-top:14px;">
      <button class="rate-acc-head" onclick="ui.rateShowDone=!ui.rateShowDone; renderActiveDegustaceForm();">
        <span>Hodnoceno <b>${doneCount}</b></span>
        <span class="rate-acc-chev">${ui.rateShowDone ? '▾ skrýt' : '▸ zobrazit'}</span>
      </button>
      <div id="rateDoneList" ${ui.rateShowDone ? '' : 'hidden'}></div>
    </div>`;
  }
  return html;
}

function ratingRow(r, who) {
  const st = ui.typ === 'doutnik' ? cigarStats(r.id) : rumStats(r.id);
  const mine = who ? myRatingFor(r.id, who) : null;
  const sub = mine
    ? `tvoje ${mine.celkem} b.` + (st ? ` · Ø klubu ${st.celkem}` : '')
    : (st ? `Ø klubu ${st.celkem} · ${st.count}×` : 'zatím nikdo nehodnotil');
  const fn = mine ? 'editRating' : 'startRating';
  return `<div class="picker-item" onclick="${fn}('${r.id}')">${esc(r.nazev)}${r.znacka ? ' – ' + esc(r.znacka) : ''}<div class="sub">${sub}</div></div>`;
}

function renderRatingLanding() {
  const el = document.getElementById('degustaceForm');
  if (!el) return;
  el.innerHTML = ratingLandingHtml();
  renderRatingLandingList();
  renderRatingDoneList();
  const rec = document.getElementById('recentRatings');
  if (rec) { rec.innerHTML = ''; rec.style.display = 'none'; }
}

function renderRatingLandingList() {
  const el = document.getElementById('rumPickList');
  if (!el) return;
  const isDoutnik = ui.typ === 'doutnik';
  const nounGen = isDoutnik ? 'doutníků' : 'rumů';
  const who = ratingWhoLabel();
  const q = (document.getElementById('rumPickSearch')?.value || '').trim().toLowerCase();
  const items = state.rums.filter(r => (r.typ || 'rum') === ui.typ);

  if (q) {
    const hits = items
      .filter(r => (r.nazev || '').toLowerCase().includes(q) || (r.znacka || '').toLowerCase().includes(q))
      .sort((a, b) => (b._seq || 0) - (a._seq || 0)).slice(0, 40);
    el.innerHTML = '<div class="picker-list">' +
      (hits.map(r => ratingRow(r, who)).join('') || '<div class="picker-item muted">Nic nenalezeno</div>') +
      '</div>';
    return;
  }

  if (!who) {
    el.innerHTML = `<div class="muted" style="font-size:13px;">${isAdmin ? 'Vyber člena výše.' : 'Přihlas se, abys mohl hodnotit.'}</div>`;
    return;
  }

  const unrated = items.filter(r => !myRatingFor(r.id, who)).sort((a, b) => (b._seq || 0) - (a._seq || 0));
  const total = items.length;
  let h = `<div class="rate-progress">Ohodnoceno <b>${total - unrated.length}</b> · Chybí <b>${unrated.length}</b> z ${total} ${nounGen}</div>`;
  if (unrated.length === 0) {
    h += '<div class="muted" style="font-size:13px;">Všechno máš ohodnocené 🎉</div>';
  } else {
    const LIM = 8;
    const shown = ui.rateAllUnrated ? unrated : unrated.slice(0, LIM);
    h += '<div class="picker-list">' + shown.map(r => ratingRow(r, who)).join('') + '</div>';
    if (!ui.rateAllUnrated && unrated.length > LIM) {
      h += `<button class="btn btn-ghost btn-sm" style="margin-top:8px;" onclick="ui.rateAllUnrated=true; renderRatingLandingList();">Zobrazit všech ${unrated.length}</button>`;
    }
  }
  el.innerHTML = h;
}

function renderRatingDoneList() {
  const el = document.getElementById('rateDoneList');
  if (!el) return;
  const who = ratingWhoLabel();
  if (!who) { el.innerHTML = ''; return; }
  const pool = ui.typ === 'doutnik' ? state.cigarRatings : state.ratings;
  const mine = pool.filter(r => r.clen === who).slice().sort((a, b) => (b._seq || 0) - (a._seq || 0));
  if (mine.length === 0) { el.innerHTML = '<div class="muted" style="font-size:13px;margin-top:8px;">Zatím nic.</div>'; return; }
  el.innerHTML = '<div class="recent-list-scroll" style="margin-top:8px;">' + mine.map(rt => {
    const rum = state.rums.find(x => x.id === rt.rumId);
    if (!rum) return '';
    return `<div class="recent-item clickable" onclick="editRating('${rt.rumId}')"><span>${esc(rum.nazev)}${rum.znacka ? ' – ' + esc(rum.znacka) : ''}</span><b>${rt.celkem}</b></div>`;
  }).join('') + '</div>';
}

function startRating(rumId) {
  const rum = state.rums.find(r => r.id === rumId);
  if (!rum) return;
  if ((rum.typ || 'rum') !== ui.typ) { ui.typ = (rum.typ || 'rum'); syncTypUI(); }
  ui.selectedRatingRumId = rumId;
  if (!ui.selectedMember) ui.selectedMember = currentUser || null;
  ui.showNewRum = false;
  ui.rateAllUnrated = false;
  if (ui.typ === 'doutnik') ui.cigarScores = { vzhled: 8, vune: 8, tah: 8, chut: 15, kour: 15, horeni: 15, popel: 8 };
  else ui.scores = { barva: 15, aroma: 15, chut: 15, plnost: 15, dojezd: 15 };
  renderActiveDegustaceForm();
  const v = document.getElementById('view-degustace');
  if (v) v.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function editRating(rumId) {
  const r = myRatingFor(rumId, ratingWhoLabel());
  if (!r) { startRating(rumId); return; }
  if (ui.typ === 'doutnik') editRecentCigarRating(r.id);
  else editRecentRating(r.id);
}

/* ---------------- derived data helpers ---------------- */
function ceilTo05(n) { return Math.ceil(n * 2) / 2; }

function ratingsForRum(rumId) {
  return state.ratings.filter(r => r.rumId === rumId);
}

function rumStats(rumId) {
  const rs = ratingsForRum(rumId);
  if (rs.length === 0) return null;
  const avg = (key) => ceilTo05(rs.reduce((s,r)=>s+(Number(r[key])||0),0) / rs.length);
  return {
    count: rs.length,
    barva: avg('barva'), aroma: avg('aroma'), chut: avg('chut'), plnost: avg('plnost'), dojezd: avg('dojezd'),
    celkem: avg('celkem'),
    perPerson: rs.map(r => ({clen: r.clen, celkem: r.celkem})),
  };
}

const RUM_CRIT = [['barva','Barva',20],['aroma','Aroma',20],['chut','Chuť',20],['plnost','Plnost',20],['dojezd','Dojezd',20]];
const CIGAR_CRIT = [['vzhled','Vzhled',10],['vune','Vůně',10],['tah','Tah',10],['chut','Chuť',20],['kour','Kouř',20],['horeni','Hoření',20],['popel','Popel',10]];

function ratingsForCigar(rumId) {
  return state.cigarRatings.filter(r => r.rumId === rumId);
}

function cigarStats(rumId) {
  const rs = ratingsForCigar(rumId);
  if (rs.length === 0) return null;
  const avg = (key) => ceilTo05(rs.reduce((s,r)=>s+(Number(r[key])||0),0) / rs.length);
  return {
    count: rs.length,
    vzhled: avg('vzhled'), vune: avg('vune'), tah: avg('tah'), chut: avg('chut'), kour: avg('kour'), horeni: avg('horeni'), popel: avg('popel'),
    celkem: avg('celkem'),
    perPerson: rs.map(r => ({clen: r.clen, celkem: r.celkem})),
  };
}

function scoreClass(score) {
  if (score == null) return 'score-none';
  if (score >= 95) return 'score-gold';
  if (score >= 90) return 'score-good';
  return 'score-mid';
}

function ledgerCollectionName() { return ui.typ === 'doutnik' ? 'ledger_doutniky' : 'ledger'; }
function ledgerSourceArray() { return ui.typ === 'doutnik' ? state.ledgerDoutniky : state.ledger; }

function currentBalance(typ) {
  const t = typ || ui.typ;
  const src = t === 'doutnik' ? state.ledgerDoutniky : state.ledger;
  return src.reduce((s,l)=>s + (Number(l.castka)||0), 0);
}

/* ---------------- RUMY tab ---------------- */
// Volby řazení v katalogu se mění podle typu (rum/doutník) – přidávají se
// hodnotící kritéria. Přebuduje se jen při přepnutí typu.
function syncRumSortOptions() {
  const sel = document.getElementById('rumSort');
  if (!sel || sel.dataset.typ === ui.typ) return;
  const cur = sel.value || 'new';
  const crit = ui.typ === 'doutnik' ? CIGAR_CRIT : RUM_CRIT;
  const base = [
    ['new', 'Nejnovější'],
    ['score_desc', 'Nejlépe hodnocené'],
    ['score_asc', 'Nejhůře hodnocené'],
    ['name', 'Podle názvu'],
    ['count', 'Podle počtu hodnocení'],
  ];
  const critOpts = crit.map(([k, label]) => ['crit_' + k, 'Nejlepší ' + label.toLowerCase()]);
  const all = [...base, ...critOpts];
  const keep = all.some(([v]) => v === cur) ? cur : 'new';
  sel.innerHTML =
    base.map(([v, t]) => `<option value="${v}">${t}</option>`).join('') +
    '<optgroup label="Podle kritéria (nejlepší)">' +
    critOpts.map(([v, t]) => `<option value="${v}">${t}</option>`).join('') +
    '</optgroup>';
  sel.value = keep;
  sel.dataset.typ = ui.typ;
}

function renderRumy() {
  syncRumSortOptions();
  const search = (document.getElementById('rumSearch').value || '').toLowerCase();
  const sort = document.getElementById('rumSort').value;
  const isDoutnik = ui.typ === 'doutnik';
  const critKey = sort.startsWith('crit_') ? sort.slice(5) : null;
  const critLabel = critKey ? ((isDoutnik ? CIGAR_CRIT : RUM_CRIT).find(c => c[0] === critKey) || [,''])[1] : '';

  // filtr podle původu
  const originSel = document.getElementById('rumOrigin');
  const allOrigins = [...new Set(state.rums.filter(r => (r.typ||'rum') === ui.typ).flatMap(r => puvodList(r)))].sort((a,b) => a.localeCompare(b, 'cs'));
  if (ui.rumOrigin !== 'vse' && !allOrigins.includes(ui.rumOrigin)) ui.rumOrigin = 'vse';
  if (originSel) originSel.innerHTML = '<option value="vse">Všechny země</option>' +
    allOrigins.map(o => `<option value="${esc(o)}" ${ui.rumOrigin===o?'selected':''}>Jen ${esc(o)}</option>`).join('');

  let rows = state.rums.filter(r => (r.typ||'rum') === ui.typ).map(r => ({ rum: r, stats: isDoutnik ? cigarStats(r.id) : rumStats(r.id) }));
  if (search) {
    rows = rows.filter(({rum}) =>
      (rum.nazev||'').toLowerCase().includes(search) ||
      (rum.znacka||'').toLowerCase().includes(search) ||
      (rum.puvod||'').toLowerCase().includes(search)
    );
  }
  if (ui.rumOrigin !== 'vse') {
    rows = rows.filter(({rum}) => puvodList(rum).includes(ui.rumOrigin));
  }
  rows.sort((a,b) => {
    if (sort === 'name') return (a.rum.nazev||'').localeCompare(b.rum.nazev||'');
    if (sort === 'count') return (b.stats?.count||0) - (a.stats?.count||0);
    if (sort === 'new') return (b.rum._seq||0) - (a.rum._seq||0);
    if (critKey) {
      const av = a.stats?.[critKey] ?? -1, bv = b.stats?.[critKey] ?? -1;
      return bv - av || (b.stats?.celkem||0) - (a.stats?.celkem||0);
    }
    const av = a.stats?.celkem ?? -1, bv = b.stats?.celkem ?? -1;
    return sort === 'score_asc' ? av - bv : bv - av;
  });

  const list = document.getElementById('rumList');
  renderNewRumSection();
  const filtered = !!search || ui.rumOrigin !== 'vse';
  if (rows.length === 0) {
    list.innerHTML = `<div class="empty-note">Žádný ${isDoutnik?'doutník':'rum'} neodpovídá filtru.</div>`;
    return;
  }
  const total = rows.length;
  const totalAll = state.rums.filter(r => (r.typ||'rum') === ui.typ).length;
  const countLine = `<div class="list-count">${filtered ? total + ' z ' + totalAll : total} ${isDoutnik ? 'doutníků' : 'rumů'}</div>`;
  list.innerHTML = countLine + rows.map(({rum, stats}, i) => {
    const expr = (isDoutnik
      ? [rum.znacka, rum.format, rum.sila]
      : [rum.znacka, rum.abv ? String(rum.abv) + ' %' : null]
    ).filter(Boolean).map(esc).join(' · ');
    const meta = [
      ...puvodList(rum),
      rum.cena ? esc(String(rum.cena)) + ' Kč' : null,
    ].filter(Boolean).join(' · ');
    return `
    <div class="card rum-card" onclick="openRumDetail('${rum.id}')">
      <div class="rum-rank">${i + 1}</div>
      ${rum.foto
        ? `<img src="${esc(rum.foto)}" alt="" class="rum-thumb" loading="lazy" decoding="async" onerror="this.classList.add('rum-thumb-empty');this.removeAttribute('src');">`
        : `<div class="rum-thumb rum-thumb-empty"></div>`}
      <div class="rum-main">
        <div class="rum-title">${esc(rum.nazev)}</div>
        ${expr ? `<div class="rum-expr">${expr}</div>` : ''}
        ${meta ? `<div class="rum-meta">${meta}</div>` : ''}
      </div>
      <div class="rum-score">
        <div class="num ${scoreClass(stats?.celkem)}">${stats ? stats.celkem : '–'}</div>
        ${critKey && stats && stats[critKey] != null ? `<div class="crit">${esc(critLabel)} ${stats[critKey]}</div>` : ''}
        <div class="cnt">${stats ? stats.count + '×' : '–'}</div>
      </div>
    </div>
  `;
  }).join('');
}

function esc(s) {
  return String(s==null?'':s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// Původ může být blend z více zemí zapsaný v jednom poli oddělený čárkou / lomítkem.
function puvodList(x) {
  const s = typeof x === 'string' ? x : (x && x.puvod) || '';
  return s.split(/\s*[,;/]\s*/).map(v => v.trim()).filter(Boolean);
}
function puvodBadges(x) {
  return puvodList(x).map(p => `<span class="origin-badge">${esc(p)}</span>`).join('');
}

// Surovina rumu jako rozbalovací seznam (přednastavené + už použité + „jiná…") kvůli překlepům.
const SUROVINA_PRESETY = ['Melasa', 'Čerstvá třtinová šťáva', 'Třtinový sirup'];
function surovinaSelectHtml(id, current) {
  const existing = [...new Set(state.rums
    .filter(r => (r.typ || 'rum') === 'rum')
    .map(r => (r.surovina || '').trim())
    .filter(Boolean))];
  const opts = [...new Set([...SUROVINA_PRESETY, ...existing])].sort((a, b) => a.localeCompare(b, 'cs'));
  const cur = (current || '').trim();
  const known = !cur || opts.includes(cur);
  return `
    <select class="input" id="${id}" onchange="var j=document.getElementById('${id}Jina'); if(j){ j.hidden = this.value!=='__jina__'; if(!j.hidden) j.focus(); }">
      <option value="">—</option>
      ${opts.map(o => `<option value="${esc(o)}" ${cur === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}
      <option value="__jina__" ${!known ? 'selected' : ''}>jiná…</option>
    </select>
    <input class="input" id="${id}Jina" placeholder="jiná surovina" value="${!known ? esc(cur) : ''}" ${known ? 'hidden' : ''} style="margin-top:6px;">`;
}
function readSurovina(id) {
  const sel = document.getElementById(id);
  if (!sel) return '';
  if (sel.value === '__jina__') return (document.getElementById(id + 'Jina')?.value || '').trim();
  return sel.value.trim();
}

// Síla/plnost doutníku – pevná škála (v pořadí) + už použité hodnoty + „jiná…".
const SILA_PRESETY = ['Lehká', 'Lehká až střední', 'Střední', 'Střední až silná', 'Silná'];
function silaSelectHtml(id, current) {
  const existing = [...new Set(state.rums
    .filter(r => (r.typ || 'rum') === 'doutnik')
    .map(r => (r.sila || '').trim())
    .filter(Boolean))];
  const extra = existing.filter(v => !SILA_PRESETY.includes(v)).sort((a, b) => a.localeCompare(b, 'cs'));
  const opts = [...SILA_PRESETY, ...extra];
  const cur = (current || '').trim();
  const known = !cur || opts.includes(cur);
  return `
    <select class="input" id="${id}" onchange="var j=document.getElementById('${id}Jina'); if(j){ j.hidden = this.value!=='__jina__'; if(!j.hidden) j.focus(); }">
      <option value="">—</option>
      ${opts.map(o => `<option value="${esc(o)}" ${cur === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}
      <option value="__jina__" ${!known ? 'selected' : ''}>jiná…</option>
    </select>
    <input class="input" id="${id}Jina" placeholder="jiná síla/plnost" value="${!known ? esc(cur) : ''}" ${known ? 'hidden' : ''} style="margin-top:6px;">`;
}
function readSila(id) {
  const sel = document.getElementById(id);
  if (!sel) return '';
  if (sel.value === '__jina__') return (document.getElementById(id + 'Jina')?.value || '').trim();
  return sel.value.trim();
}

// Původ jako rozbalovací seznam už použitých zemí + „jiná…" (kam se dá napsat i blend).
function puvodSelectHtml(id, current) {
  const opts = [...new Set(state.rums.flatMap(r => puvodList(r)))].sort((a, b) => a.localeCompare(b, 'cs'));
  const cur = (current || '').trim();
  const known = cur && !cur.includes(',') && opts.includes(cur);
  return `
    <select class="input" id="${id}" onchange="var j=document.getElementById('${id}Jina'); if(j){ j.hidden = this.value!=='__jina__'; if(!j.hidden) j.focus(); }">
      <option value="">—</option>
      ${opts.map(o => `<option value="${esc(o)}" ${cur === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}
      <option value="__jina__" ${(cur && !known) ? 'selected' : ''}>jiná / blend…</option>
    </select>
    <input class="input" id="${id}Jina" placeholder="nová země nebo blend: Barbados, Jamajka" value="${(cur && !known) ? esc(cur) : ''}" ${(cur && !known) ? '' : 'hidden'} style="margin-top:6px;">`;
}
function readPuvod(id) {
  const sel = document.getElementById(id);
  if (!sel) return '';
  if (sel.value === '__jina__') return puvodList(document.getElementById(id + 'Jina')?.value || '').join(', ');
  return sel.value.trim();
}

function openRumDetail(rumId) {
  ui.detailRumId = rumId;
  const rum = state.rums.find(r => r.id === rumId);
  const isDoutnik = (rum.typ||'rum') === 'doutnik';
  const stats = isDoutnik ? cigarStats(rumId) : rumStats(rumId);
  const crit = isDoutnik ? CIGAR_CRIT : RUM_CRIT;
  const has = (v) => v != null && String(v).trim() !== '';

  // Info řádky v pořadí podle typu
  const infoRows = [];
  if (isDoutnik) {
    if (has(rum.format)) infoRows.push(`Formát: <b>${esc(rum.format)}</b>`);
    if (has(rum.sila)) infoRows.push(`Síla/plnost: <b>${esc(rum.sila)}</b>`);
  } else {
    if (has(rum.surovina)) infoRows.push(`Surovina: <b>${esc(rum.surovina)}</b>`);
    if (has(rum.cukr)) infoRows.push(`Obsah cukru: <b>${esc(String(rum.cukr))} g/l</b>`);
  }
  if (rum.puvod) infoRows.push(puvodBadges(rum));
  if (has(rum.cena)) infoRows.push(`Cena: <b>${esc(String(rum.cena))} Kč</b>`);
  if (rum.datum) infoRows.push(`Ochutnáno: <b>${esc(formatDatumCz(rum.datum))}</b>`);

  const editFormHtml = `
    <div class="card" style="margin-top:12px;">
      <div class="field"><label>Značka ${isDoutnik?'doutníku':'rumu'}</label><input class="input" id="editRumNazev" value="${esc(rum.nazev||'')}"></div>
      <div class="row2">
        <div class="field"><label>Název ${isDoutnik?'doutníku':'rumu'}</label><input class="input" id="editRumZnacka" value="${esc(rum.znacka||'')}"></div>
        <div class="field"><label>Původ</label>${puvodSelectHtml('editRumPuvod', rum.puvod)}</div>
      </div>
      <div class="field"><label>Datum ochutnání</label><input class="input" type="date" id="editRumDatum" value="${esc(rum.datum||'')}"></div>
      <div class="row2">
        <div class="field"><label>Cena (Kč)</label><input class="input" type="number" id="editRumCena" value="${has(rum.cena)?esc(String(rum.cena)):''}"></div>
        ${isDoutnik
          ? `<div class="field"><label>Formát</label><input class="input" id="editRumFormat" value="${esc(rum.format||'')}" placeholder="Toro, Robusto…"></div>`
          : `<div class="field"><label>Obsah alkoholu (%)</label><input class="input" type="number" step="0.1" id="editRumAbv" value="${has(rum.abv)?esc(String(rum.abv)):''}"></div>`}
      </div>
      <div class="row2">
        ${isDoutnik
          ? `<div class="field"><label>Síla/plnost</label>${silaSelectHtml('editRumSila', rum.sila)}</div>`
          : `<div class="field"><label>Surovina</label>${surovinaSelectHtml('editRumSurovina', rum.surovina)}</div>`}
        ${isDoutnik
          ? ''
          : `<div class="field"><label>Obsah cukru (g/l)</label><input class="input" type="number" step="0.1" id="editRumCukr" value="${has(rum.cukr)?esc(String(rum.cukr)):''}"></div>`}
      </div>
      <div class="muted" style="font-size:11.5px;margin:-4px 0 8px;">Víc zemí (blend) odděl čárkou: „Barbados, Jamajka, Guyana". Ve statistice se pak započítá u každé.</div>
      <div class="btn-row">
        <button class="btn btn-primary btn-sm" onclick="saveRumEdit('${rum.id}')">Uložit</button>
        <button class="btn btn-ghost btn-sm" onclick="ui.editingRumId=null; openRumDetail('${rum.id}');">Zpět</button>
      </div>
    </div>`;

  document.getElementById('rumDetailSheet').innerHTML = `
    <div class="sheet-head">
      <div>
        <h2 style="font-family:var(--font-display);font-weight:600;font-size:1.75rem;margin:0;">${esc(rum.nazev)}</h2>
        <div style="font-size:17px;font-weight:500;color:var(--ink-soft);margin-top:3px;">${[rum.znacka?esc(rum.znacka):null, (!isDoutnik && rum.abv)?esc(String(rum.abv))+' %':null].filter(Boolean).join(' · ')}</div>
      </div>
      <button class="sheet-close" onclick="closeRumDetail()" aria-label="Zavřít">×</button>
    </div>
    ${infoRows.length ? `<div class="detail-info">${infoRows.map(r => `<div class="detail-info-row">${r}</div>`).join('')}</div>` : ''}
    ${rum.foto ? `<img src="${esc(rum.foto)}" alt="Fotka: ${esc(rum.nazev)}" class="rum-foto" loading="lazy" decoding="async" onerror="this.style.display='none';">` : ''}
    ${stats ? `
      <div style="text-align:center; margin: 10px 0 18px;">
        <div class="num ${scoreClass(stats.celkem)}" style="font-family:var(--font-display);font-weight:700;font-size:2.2rem;">${stats.celkem}</div>
        <div class="muted" style="font-size:12px;">průměr z ${stats.count} hodnocení</div>
      </div>
      ${crit.map(([k,label,max]) => `
        <div class="crit-row">
          <div class="crit-label">${label}</div>
          <div class="crit-bar-track"><div class="crit-bar-fill" style="width:${(stats[k]/max*100).toFixed(0)}%"></div></div>
          <div class="crit-val">${stats[k]}</div>
        </div>
      `).join('')}
      <div style="margin-top:14px;">
        ${stats.perPerson.map(p => `<span class="person-chip">${esc(p.clen)} <b>${p.celkem}</b></span>`).join('')}
      </div>
    ` : '<div class="empty-note">Zatím bez hodnocení.</div>'}

    <div class="btn-row" style="margin-top:18px;">
      <button class="btn btn-ghost" onclick="closeRumDetail()">← Zpět</button>
      ${stats ? `<button class="btn btn-ghost" onclick="shareRumCard('${rum.id}')">📤 Sdílet</button>` : ''}
    </div>
    ${isGuest ? '' : `
    <div class="btn-row" style="margin-top:8px;">
      <button class="btn btn-primary" onclick="closeRumDetail(); presetRatingRum('${rum.id}'); goTab('degustace');">+ Přidat hodnocení</button>
    </div>`}
    ${hasPerm(PERM_SPRAVCI) ? `
    ${ui.editingRumId === rum.id ? editFormHtml : `
        <div class="btn-row" style="margin-top:8px;">
          <button class="btn btn-ghost btn-sm" onclick="ui.editingRumId='${rum.id}'; openRumDetail('${rum.id}');">✏️ Upravit údaje</button>
        </div>`}
    <div class="muted" style="font-size:12px;margin-top:14px;margin-bottom:2px;">${rum.foto ? 'Změnit fotku' : 'Přidat fotku'}</div>
    ${fotoButtonsHtml(`uploadRumFoto('${rum.id}', this.files[0])`)}
    ${rum.foto ? `<div class="btn-row" style="margin-top:6px;">
      <button class="btn btn-ghost btn-sm" onclick="recropRumFoto('${rum.id}')">✂️ Oříznout</button>
      <button class="btn btn-ghost btn-sm" onclick="removeRumFoto('${rum.id}')">Smazat fotku</button>
    </div>` : ''}
    ` : ''}
    ${hasPerm(PERM_MAZANI) ? `
    <div class="btn-row" style="margin-top:8px;">
      <button class="btn btn-danger btn-sm" onclick="deleteRum('${rum.id}')">Smazat ${isDoutnik?'doutník':'rum'}</button>
    </div>
    ` : ''}
  `;
  document.getElementById('rumDetailOverlay').hidden = false;
}
function closeRumDetail() { ui.editingRumId = null; document.getElementById('rumDetailOverlay').hidden = true; }

// --- Sdílení produktu jako obrázek (karta se skóre a pruhy kritérií) ---
function _wrapCanvasText(ctx, text, maxW, maxLines) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (ctx.measureText(t).width > maxW && cur) { lines.push(cur); cur = w; } else { cur = t; }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    let last = lines[maxLines - 1];
    while (last && ctx.measureText(last + '…').width > maxW) last = last.slice(0, -1);
    lines[maxLines - 1] = last + '…';
  }
  return lines;
}

async function shareRumCard(rumId) {
  const rum = state.rums.find(r => r.id === rumId);
  if (!rum) return;
  const isDoutnik = (rum.typ || 'rum') === 'doutnik';
  const stats = isDoutnik ? cigarStats(rumId) : rumStats(rumId);
  if (!stats) { toast('Zatím bez hodnocení – není co sdílet.'); return; }
  const crit = isDoutnik ? CIGAR_CRIT : RUM_CRIT;
  toast('Připravuji obrázek…');
  try {
    try {
      await Promise.all([
        document.fonts.load('700 60px Fraunces'),
        document.fonts.load('500 40px "Public Sans"'),
        document.fonts.load('500 40px "IBM Plex Mono"'),
      ]);
    } catch (e) { /* fallback fonty */ }

    const C = { bg: '#EAE2D0', surf: '#FBF8F0', ink: '#2B2013', soft: '#6B5D46', faint: '#948566', accent: '#9C5D18' };
    const scoreCol = stats.celkem >= 95 ? '#B8860B' : stats.celkem >= 90 ? '#3F6E4C' : C.ink;
    const W = 1080, pad = 76, rowH = 74;

    const measure = document.createElement('canvas').getContext('2d');
    measure.font = '700 76px Fraunces, Georgia, serif';
    const nameLines = _wrapCanvasText(measure, rum.nazev, W - pad * 2, 3);

    const H = pad + 40 + nameLines.length * 88 + 150 + 300 + crit.length * rowH + pad + 40;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const c = cv.getContext('2d');

    c.fillStyle = C.bg; c.fillRect(0, 0, W, H);

    c.textBaseline = 'alphabetic';
    c.fillStyle = C.faint;
    c.font = '500 26px "IBM Plex Mono", monospace';
    c.fillText('DEGUSTAČNÍ KLUB', pad, pad + 20);
    c.textAlign = 'right';
    c.fillText(isDoutnik ? 'DOUTNÍK' : 'RUM', W - pad, pad + 20);
    c.textAlign = 'left';

    let y = pad + 110;
    c.fillStyle = C.ink;
    c.font = '700 76px Fraunces, Georgia, serif';
    nameLines.forEach(ln => { c.fillText(ln, pad, y); y += 88; });
    y += 2;

    const abvStr = (!isDoutnik && rum.abv && !String(rum.znacka || '').replace(/\s/g, '').includes(String(rum.abv))) ? rum.abv + ' %' : null;
    const sub = [rum.znacka, isDoutnik ? rum.format : abvStr, isDoutnik ? rum.sila : null].filter(Boolean).join('   ·   ');
    if (sub) { c.fillStyle = C.soft; c.font = '500 36px "Public Sans", sans-serif'; c.fillText(sub, pad, y); y += 46; }
    const meta = [...puvodList(rum), rum.cena ? rum.cena + ' Kč' : null].filter(Boolean).join('   ·   ');
    if (meta) { c.fillStyle = C.faint; c.font = '500 30px "Public Sans", sans-serif'; c.fillText(meta, pad, y); y += 38; }

    y += 40;
    c.textAlign = 'center';
    c.fillStyle = scoreCol;
    c.font = '700 190px Fraunces, Georgia, serif';
    c.fillText(String(stats.celkem), W / 2, y + 150);
    c.fillStyle = C.faint;
    c.font = '500 30px "IBM Plex Mono", monospace';
    c.fillText('průměr z ' + stats.count + ' hodnocení', W / 2, y + 205);
    c.textAlign = 'left';
    y += 280;

    const labelW = 210, valW = 80, g = 26;
    const barX = pad + labelW + g;
    const barW = W - pad - valW - g - barX;
    c.textBaseline = 'middle';
    crit.forEach(([k, label, max]) => {
      const val = stats[k];
      c.fillStyle = C.soft; c.font = '500 32px "Public Sans", sans-serif';
      c.fillText(label, pad, y + rowH / 2);
      c.fillStyle = C.surf;
      c.beginPath(); c.roundRect(barX, y + rowH / 2 - 13, barW, 26, 13); c.fill();
      c.fillStyle = C.accent;
      c.beginPath(); c.roundRect(barX, y + rowH / 2 - 13, Math.max(26, barW * (val / max)), 26, 13); c.fill();
      c.fillStyle = C.ink; c.font = '500 32px "IBM Plex Mono", monospace'; c.textAlign = 'right';
      c.fillText(String(val), W - pad, y + rowH / 2);
      c.textAlign = 'left';
      y += rowH;
    });
    c.textBaseline = 'alphabetic';

    c.fillStyle = C.faint;
    c.font = 'italic 500 28px "Public Sans", sans-serif';
    c.textAlign = 'center';
    c.fillText('Společné chutě. Vlastní názor.', W / 2, H - pad + 4);
    c.textAlign = 'left';

    const blob = await new Promise(res => cv.toBlob(res, 'image/png'));
    const slug = (rum.nazev || 'produkt').toLowerCase().normalize('NFD')
      .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'produkt';
    const fname = 'degustace-' + slug + '.png';
    const file = new File([blob], fname, { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: rum.nazev, text: `${rum.nazev} – ${stats.celkem} b.` }); return; }
      catch (e) { if (e && e.name === 'AbortError') return; }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fname;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Obrázek stažen', 'ok');
  } catch (e) {
    console.error('shareRumCard:', e);
    toast('Obrázek se nepodařilo vytvořit.');
  }
}

async function deleteRum(rumId) {
  try {
    if (!hasPerm(PERM_MAZANI)) return;
    const rum = state.rums.find(r => r.id === rumId);
    if (!rum) return;
    const isDoutnik = (rum.typ||'rum') === 'doutnik';
    const ratingsCol = isDoutnik ? 'cigar_ratings' : 'ratings';
    const relatedRatings = (isDoutnik ? state.cigarRatings : state.ratings).filter(r => r.rumId === rumId);
    const label = isDoutnik ? 'doutník' : 'rum';
    const warn = relatedRatings.length
      ? `Opravdu smazat ${label} "${rum.nazev}${rum.znacka?' – '+rum.znacka:''}"? Smaže se i všech ${relatedRatings.length} hodnocení k němu.`
      : `Opravdu smazat ${label} "${rum.nazev}${rum.znacka?' – '+rum.znacka:''}"?`;
    if (!confirm(warn)) return;
    const batch = db.batch();
    batch.delete(db.collection('rums').doc(rumId));
    relatedRatings.forEach(r => batch.delete(db.collection(ratingsCol).doc(r.id)));
    await batch.commit();
    closeRumDetail();
    toast(isDoutnik ? 'Doutník smazán' : 'Rum smazán');
    logChange(isDoutnik ? 'Smazán doutník' : 'Smazán rum', `${rum.nazev}${rum.znacka?' – '+rum.znacka:''}${relatedRatings.length?' (+'+relatedRatings.length+' hodnocení)':''}`);

  } catch (e) {
    console.error('deleteRum:', e);
    toast('Uložení se nezdařilo, zkus to znovu.');
  }
}

/* ---------------- DEGUSTACE (add rating) tab ---------------- */
function backToRatingStart() {
  ui.selectedRatingRumId = null;
  ui.selectedMember = currentUser || ui.selectedMember || null;
  ui.showNewRum = false;
  ui.showNewMember = false;
  ui.rateAllUnrated = false;
  if (ui.typ === 'doutnik') {
    ui.cigarScores = { vzhled: 8, vune: 8, tah: 8, chut: 15, kour: 15, horeni: 15, popel: 8 };
  } else {
    ui.scores = { barva: 15, aroma: 15, chut: 15, plnost: 15, dojezd: 15 };
  }
  renderActiveDegustaceForm();
  document.getElementById('view-degustace').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function presetRatingRum(rumId) {
  const rum = state.rums.find(r => r.id === rumId);
  if (rum) { ui.typ = (rum.typ||'rum'); syncTypUI(); }
  ui.selectedRatingRumId = rumId;
  renderActiveDegustaceForm();
}

function renderDegustaceForm() {
  const rum = state.rums.find(r => r.id === ui.selectedRatingRumId);
  if (!rum || (rum.typ || 'rum') !== ui.typ) { renderRatingLanding(); return; }
  const crit = RUM_CRIT;
  const total = crit.reduce((s,[k])=>s+Number(ui.scores[k]||0),0);

  let dup = null;
  if (rum && ui.selectedMember) {
    dup = state.ratings.find(r => r.rumId === rum.id && r.clen === ui.selectedMember);
  }

  let html = '<div class="card">';
  html += '<div class="field"><label>1. Rum</label>';
  if (rum) {
    html += `<div class="selected-chip"><span>${esc(rum.nazev)} ${rum.znacka?'– '+esc(rum.znacka):''}</span><button class="x" onclick="ui.selectedRatingRumId=null; renderDegustaceForm();">×</button></div>`;
  } else {
    html += `<input class="input" id="rumPickSearch" placeholder="Hledat rum…" oninput="renderRatingRumPicker()">`;
    html += `<div class="picker-list" id="rumPickList"></div>`;
  }
  html += '</div>';

  if (rum) {
    html += '<div class="field"><label>2. Kdo hodnotí</label><div class="member-chips">';
    const ratingMembers = state.members.filter(m=>m.aktivni!==false).slice().sort((a,b) => {
      const ia = CLUB_MEMBER_ORDER.indexOf(a.jmeno), ib = CLUB_MEMBER_ORDER.indexOf(b.jmeno);
      const ra = ia === -1 ? CLUB_MEMBER_ORDER.length : ia;
      const rb = ib === -1 ? CLUB_MEMBER_ORDER.length : ib;
      return ra !== rb ? ra - rb : a.jmeno.localeCompare(b.jmeno, 'cs');
    });
    const restrictToSelf = !isAdmin && !!currentUser;
    html += ratingMembers.map(m => {
      const locked = restrictToSelf && m.jmeno !== currentUser;
      const cls = 'member-chip' + (ui.selectedMember===m.jmeno ? ' active' : '');
      const click = locked ? '' : ` onclick="ui.selectedMember='${esc(m.jmeno).replace(/'/g,"\\'")}'; renderDegustaceForm();"`;
      return `<button class="${cls}"${click} ${locked ? 'disabled' : ''}>${esc(m.jmeno)}</button>`;
    }).join('');
    html += '</div>';
    if (restrictToSelf) html += `<div class="muted" style="font-size:12px;margin-top:4px;">Hodnotíš jen za sebe (${esc(currentUser)}).</div>`;
    html += '</div>';
  }

  if (rum && ui.selectedMember) {
    if (dup) {
      html += `<div class="warn-banner">${esc(ui.selectedMember)} už tenhle rum hodnotil/a (${dup.celkem} b.). Uložením staré hodnocení přepíšeš.</div>`;
    }
    html += '<div class="field"><label>3. Hodnocení (1–20 každé)</label>';
    crit.forEach(([k,label]) => {
      html += `
        <div class="slider-row">
          <div class="slider-head"><span>${label}</span><b id="scoreVal-${k}">${ui.scores[k]}</b></div>
          <input type="range" min="1" max="20" step="1" value="${ui.scores[k]}" oninput="updateScore('${k}', this.value)">
        </div>`;
    });
    html += '</div>';
    html += `<div class="total-box"><span class="muted">Celkem</span><span class="num">${total}</span></div>`;
    html += `<button class="btn btn-primary" onclick="submitRating()">${dup ? 'Přepsat hodnocení' : 'Uložit hodnocení'}</button>`;
    html += `<div class="btn-row" style="margin-top:8px;"><button class="btn btn-ghost" onclick="backToRatingStart()">← Zpět</button></div>`;
  }
  html += '</div>';

  document.getElementById('degustaceForm').innerHTML = html;
  if (!rum) renderRatingRumPicker();
  renderRecentRatings();
}

function renderRatingRumPicker() {
  const el = document.getElementById('rumPickList');
  if (!el) return;
  const q = (document.getElementById('rumPickSearch')?.value || '').toLowerCase();
  let rows = state.rums.filter(r => (r.typ||'rum') === ui.typ).sort((a,b) => (b._seq||0) - (a._seq||0));
  if (q) rows = rows.filter(r => (r.nazev||'').toLowerCase().includes(q) || (r.znacka||'').toLowerCase().includes(q));
  rows = rows.slice(0, 40);
  el.innerHTML = rows.map(r => `
    <div class="picker-item" onclick="ui.selectedRatingRumId='${r.id}'; renderActiveDegustaceForm();">
      ${esc(r.nazev)} ${r.znacka?'– '+esc(r.znacka):''}
      <div class="sub">${esc(r.puvod||'')}</div>
    </div>
  `).join('') || '<div class="picker-item muted">Nic nenalezeno</div>';
}

function updateScore(key, val) {
  ui.scores[key] = Number(val);
  document.getElementById('scoreVal-'+key).textContent = val;
  const crit = ['barva','aroma','chut','plnost','dojezd'];
  const total = crit.reduce((s,k)=>s+Number(ui.scores[k]||0),0);
  const totalEl = document.querySelector('#degustaceForm .total-box .num');
  if (totalEl) totalEl.textContent = total;
  const btn = document.querySelector('#degustaceForm .btn-primary');
  // no full re-render needed for slider drags -> keeps UI snappy
}

/* ---------------- DEGUSTACE DOUTNÍKŮ (add cigar rating) ---------------- */
function renderCigarDegustaceForm() {
  const rum = state.rums.find(r => r.id === ui.selectedRatingRumId);
  if (!rum || (rum.typ || 'rum') !== ui.typ) { renderRatingLanding(); return; }
  const crit = CIGAR_CRIT;
  const total = crit.reduce((s,[k])=>s+Number(ui.cigarScores[k]||0),0);

  let dup = null;
  if (rum && ui.selectedMember) {
    dup = state.cigarRatings.find(r => r.rumId === rum.id && r.clen === ui.selectedMember);
  }

  let html = '<div class="card">';
  html += '<div class="field"><label>1. Doutník</label>';
  if (rum) {
    html += `<div class="selected-chip"><span>${esc(rum.nazev)} ${rum.znacka?'– '+esc(rum.znacka):''}</span><button class="x" onclick="ui.selectedRatingRumId=null; renderCigarDegustaceForm();">×</button></div>`;
  } else {
    html += `<input class="input" id="rumPickSearch" placeholder="Hledat doutník…" oninput="renderRatingRumPicker()">`;
    html += `<div class="picker-list" id="rumPickList"></div>`;
  }
  html += '</div>';

  if (rum) {
    html += '<div class="field"><label>2. Kdo hodnotí</label><div class="member-chips">';
    const ratingMembers = state.members.filter(m=>m.aktivni!==false).slice().sort((a,b) => {
      const ia = CLUB_MEMBER_ORDER.indexOf(a.jmeno), ib = CLUB_MEMBER_ORDER.indexOf(b.jmeno);
      const ra = ia === -1 ? CLUB_MEMBER_ORDER.length : ia;
      const rb = ib === -1 ? CLUB_MEMBER_ORDER.length : ib;
      return ra !== rb ? ra - rb : a.jmeno.localeCompare(b.jmeno, 'cs');
    });
    const restrictToSelf = !isAdmin && !!currentUser;
    html += ratingMembers.map(m => {
      const locked = restrictToSelf && m.jmeno !== currentUser;
      const cls = 'member-chip' + (ui.selectedMember===m.jmeno ? ' active' : '');
      const click = locked ? '' : ` onclick="ui.selectedMember='${esc(m.jmeno).replace(/'/g,"\\'")}'; renderCigarDegustaceForm();"`;
      return `<button class="${cls}"${click} ${locked ? 'disabled' : ''}>${esc(m.jmeno)}</button>`;
    }).join('');
    html += '</div>';
    if (restrictToSelf) html += `<div class="muted" style="font-size:12px;margin-top:4px;">Hodnotíš jen za sebe (${esc(currentUser)}).</div>`;
    html += '</div>';
  }

  if (rum && ui.selectedMember) {
    if (dup) {
      html += `<div class="warn-banner">${esc(ui.selectedMember)} už tenhle doutník hodnotil/a (${dup.celkem} b.). Uložením staré hodnocení přepíšeš.</div>`;
    }
    html += '<div class="field"><label>3. Hodnocení</label>';
    crit.forEach(([k,label,max]) => {
      html += `
        <div class="slider-row">
          <div class="slider-head"><span>${label} <span class="muted" style="font-weight:400;">(1–${max})</span></span><b id="cigarScoreVal-${k}">${ui.cigarScores[k]}</b></div>
          <input type="range" min="1" max="${max}" step="1" value="${ui.cigarScores[k]}" oninput="updateCigarScore('${k}', this.value)">
        </div>`;
    });
    html += '</div>';
    html += `<div class="total-box"><span class="muted">Celkem</span><span class="num">${total}</span></div>`;
    html += `<button class="btn btn-primary" onclick="submitCigarRating()">${dup ? 'Přepsat hodnocení' : 'Uložit hodnocení'}</button>`;
    html += `<div class="btn-row" style="margin-top:8px;"><button class="btn btn-ghost" onclick="backToRatingStart()">← Zpět</button></div>`;
  }
  html += '</div>';

  document.getElementById('degustaceForm').innerHTML = html;
  if (!rum) renderRatingRumPicker();
  renderRecentCigarRatings();
}

function updateCigarScore(key, val) {
  ui.cigarScores[key] = Number(val);
  document.getElementById('cigarScoreVal-'+key).textContent = val;
  const total = CIGAR_CRIT.reduce((s,[k])=>s+Number(ui.cigarScores[k]||0),0);
  const totalEl = document.querySelector('#degustaceForm .total-box .num');
  if (totalEl) totalEl.textContent = total;
}

async function submitCigarRating() {
  try {
    const rum = state.rums.find(r => r.id === ui.selectedRatingRumId);
    if (!rum || !ui.selectedMember) return;
    if (!isAdmin && currentUser && ui.selectedMember !== currentUser) {
      toast('Můžeš uložit hodnocení jen za sebe (' + currentUser + ')');
      return;
    }
    const celkem = CIGAR_CRIT.reduce((s,[k])=>s+Number(ui.cigarScores[k]||0),0);
    const body = {
      rumId: rum.id, clen: ui.selectedMember,
      vzhled: ui.cigarScores.vzhled, vune: ui.cigarScores.vune, tah: ui.cigarScores.tah,
      chut: ui.cigarScores.chut, kour: ui.cigarScores.kour, horeni: ui.cigarScores.horeni, popel: ui.cigarScores.popel,
      celkem,
      datum: new Date().toISOString().slice(0,10),
      _seq: Date.now(),
    };
    const existing = state.cigarRatings.find(r => r.rumId === rum.id && r.clen === ui.selectedMember);
    if (existing) {
      await db.collection('cigar_ratings').doc(existing.id).set(body);
      toast('Hodnocení přepsáno');
      logChange('Upraveno hodnocení doutníku', `${ui.selectedMember} → ${rum.nazev}${rum.znacka?' – '+rum.znacka:''} (${celkem})`);
    } else {
      await db.collection('cigar_ratings').add(body);
      toast('Hodnocení uloženo', 'ok');
      logChange('Přidáno hodnocení doutníku', `${ui.selectedMember} → ${rum.nazev}${rum.znacka?' – '+rum.znacka:''} (${celkem})`);
    }
    ui.selectedMember = currentUser || ui.selectedMember || null;
    ui.selectedRatingRumId = null;
    ui.cigarScores = { vzhled: 8, vune: 8, tah: 8, chut: 15, kour: 15, horeni: 15, popel: 8 };
    renderActiveDegustaceForm();

  } catch (e) {
    console.error('submitCigarRating:', e);
    toast('Uložení se nezdařilo, zkus to znovu.');
  }
}

function renderRecentCigarRatings() {
  const el = document.getElementById('recentRatings');
  el.style.display = '';
  const recent = [...state.cigarRatings].sort((a,b)=>(b._seq||0)-(a._seq||0)).slice(0,100);
  if (recent.length === 0) { el.innerHTML = ''; return; }
  el.innerHTML = '<div class="muted" style="font-size:12px;margin-bottom:6px;">Naposledy přidáno</div>' +
    '<div class="recent-list-scroll">' +
    recent.map(r => {
      const rum = state.rums.find(x=>x.id===r.rumId);
      const editable = !isGuest && (isAdmin || r.clen === currentUser);
      const cls = 'recent-item' + (editable ? ' clickable' : '');
      const click = editable ? ` onclick="editRecentCigarRating('${r.id}')"` : '';
      return `<div class="${cls}"${click}><span>${esc(r.clen)} – ${esc(rum?rum.nazev:'?')}</span><b>${r.celkem}</b></div>`;
    }).join('') +
    '</div>';
}

function editRecentCigarRating(ratingId) {
  if (isGuest) return;
  const r = state.cigarRatings.find(x => x.id === ratingId);
  if (!r) return;
  if (!isAdmin && r.clen !== currentUser) {
    toast('Můžeš upravit jen svoje hodnocení (' + currentUser + ')');
    return;
  }
  ui.selectedRatingRumId = r.rumId;
  ui.selectedMember = r.clen;
  ui.cigarScores = {
    vzhled: Number(r.vzhled)||8, vune: Number(r.vune)||8, tah: Number(r.tah)||8,
    chut: Number(r.chut)||15, kour: Number(r.kour)||15, horeni: Number(r.horeni)||15, popel: Number(r.popel)||8,
  };
  renderCigarDegustaceForm();
  document.getElementById('degustaceForm').scrollIntoView({ behavior:'smooth', block:'start' });
}

/* ---------------- PŘEHLED ZMĚN (log) ---------------- */
function currentActorLabel() {
  return currentUser || (isAdmin ? 'Admin' : 'Host');
}
async function logChange(akce, popis) {
  if (!db) return;
  try {
    await db.collection('activity_log').add({
      kdo: currentActorLabel(),
      akce,
      popis,
      cas: Date.now(),
    });
  } catch (e) { console.error('Log se nepodařilo zapsat:', e); }
}

const HISTORY_HEAD = `
  <div class="sheet-head">
    <h2 style="font-family:var(--font-display);font-weight:600;font-size:1.35rem;margin:0;">Přehled změn</h2>
    <button class="sheet-close" onclick="closeHistory()" aria-label="Zavřít">×</button>
  </div>`;

async function openHistory() {
  if (!isAdmin) return;
  const sheet = document.getElementById('historySheet');
  ui.historyRows = null;
  ui.historySearch = '';
  sheet.innerHTML = HISTORY_HEAD + `<div class="muted" style="font-size:12.5px;">Načítám…</div>`;
  document.getElementById('historyOverlay').hidden = false;
  try {
    const snap = await db.collection('activity_log').orderBy('cas', 'desc').limit(200).get();
    ui.historyRows = snap.docs.map(d => d.data());
    renderHistoryList();
  } catch (e) {
    console.error('Historie:', e);
    sheet.innerHTML = HISTORY_HEAD + `<div class="empty-note">Nepodařilo se načíst historii.</div>`;
  }
}

function renderHistoryList() {
  const sheet = document.getElementById('historySheet');
  if (!sheet || !ui.historyRows) return;
  const rows = ui.historyRows;
  const searchBar = `<input class="input" id="historySearchInput" placeholder="Hledat podle jména, akce, popisu…" value="${esc(ui.historySearch||'')}" oninput="ui.historySearch=this.value; renderHistoryList();" style="margin-bottom:10px;">`;
  if (rows.length === 0) {
    sheet.innerHTML = HISTORY_HEAD + `<div class="empty-note">Zatím žádné zaznamenané změny.</div>`;
    return;
  }
  const q = (ui.historySearch || '').trim().toLowerCase();
  const filtered = q ? rows.filter(r =>
    (r.kdo||'').toLowerCase().includes(q) ||
    (r.akce||'').toLowerCase().includes(q) ||
    (r.popis||'').toLowerCase().includes(q)
  ) : rows;
  const list = filtered.map(r => {
    const dt = new Date(r.cas);
    const when = dt.toLocaleDateString('cs-CZ') + ' ' + dt.toLocaleTimeString('cs-CZ', {hour:'2-digit', minute:'2-digit'});
    return `
      <div class="ledger-row" style="cursor:default;">
        <div class="ledger-desc">
          <div><b>${esc(r.kdo||'?')}</b> — ${esc(r.akce||'')}</div>
          <div class="ledger-date">${esc(when)}${r.popis?' · '+esc(r.popis):''}</div>
        </div>
      </div>
    `;
  }).join('');
  sheet.innerHTML = HISTORY_HEAD + searchBar +
    `<div class="muted" style="font-size:12px;margin-bottom:8px;">${q ? `Nalezeno ${filtered.length} z ${rows.length}` : `Posledních ${rows.length} změn, nejnovější nahoře.`}</div>` +
    (filtered.length === 0 ? `<div class="empty-note">Nic neodpovídá hledání.</div>` : list);
  const input = document.getElementById('historySearchInput');
  if (input) { input.focus(); const v = input.value; input.value=''; input.value=v; }
}
function closeHistory() { document.getElementById('historyOverlay').hidden = true; }

function renderNewRumSection() {
  const el = document.getElementById('newRumSection');
  if (!el) return;
  if (!hasPerm(PERM_SPRAVCI)) { el.innerHTML = ''; return; }
  const isDoutnik = ui.typ === 'doutnik';
  if (!ui.showNewRumRumy) {
    window._newRumFotoBlob = null;
    el.innerHTML = `<button class="btn btn-ghost btn-sm" onclick="ui.showNewRumRumy=true; renderNewRumSection();">+ Nov${isDoutnik?'ý doutník':'ý rum'}, který ještě není v seznamu</button>`;
    return;
  }
  el.innerHTML = `
    <div class="field"><label>Značka ${isDoutnik?'doutníku':'rumu'}</label><input class="input" id="newRumNazev" placeholder="${isDoutnik?'např. COHIBA':'např. HAVANA CLUB'}"></div>
    <div class="row2">
      <div class="field"><label>Název ${isDoutnik?'doutníku':'rumu'}</label><input class="input" id="newRumZnacka" placeholder="${isDoutnik?'Robusto':'Anejo Especial'}"></div>
      <div class="field"><label>Původ</label>${puvodSelectHtml('newRumPuvod', '')}</div>
    </div>
    <div class="field"><label>Datum ochutnání</label><input class="input" type="date" id="newRumDatum" value="${new Date().toISOString().slice(0,10)}"></div>
    <div class="row2">
      <div class="field"><label>Cena (Kč)</label><input class="input" type="number" id="newRumCena"></div>
      ${isDoutnik
        ? '<div class="field"><label>Formát</label><input class="input" id="newRumFormat" placeholder="Toro, Robusto…"></div>'
        : '<div class="field"><label>Obsah alkoholu (%)</label><input class="input" type="number" step="0.1" id="newRumAbv" placeholder="40"></div>'}
    </div>
    <div class="row2">
      ${isDoutnik
        ? `<div class="field"><label>Síla/plnost</label>${silaSelectHtml('newRumSila', '')}</div>`
        : `<div class="field"><label>Surovina</label>${surovinaSelectHtml('newRumSurovina', '')}</div>`}
      ${isDoutnik ? '' : '<div class="field"><label>Obsah cukru (g/l)</label><input class="input" type="number" step="0.1" id="newRumCukr"></div>'}
    </div>
    <div class="field">
      <label>Fotka (nepovinné)</label>
      ${fotoButtonsHtml("prepNewRumFoto(this.files[0])")}
      <div class="muted" id="newRumFotoStatus" style="font-size:11.5px;margin-top:4px;">Po výběru fotky si ještě ořízneš výřez.</div>
    </div>
    <div class="btn-row" style="margin-top:4px;">
      <button class="btn btn-primary btn-sm" onclick="createNewRum()">Přidat ${isDoutnik?'doutník':'rum'}</button>
      <button class="btn btn-ghost btn-sm" onclick="ui.showNewRumRumy=false; renderNewRumSection();">Zpět</button>
    </div>`;
}

async function createNewRum() {
  try {
    if (!hasPerm(PERM_SPRAVCI)) return;
    const nazev = document.getElementById('newRumNazev').value.trim();
    const isDoutnik = ui.typ === 'doutnik';
    if (!nazev) { toast('Zadej název'); return; }
    const znacka = document.getElementById('newRumZnacka').value.trim();
    // varování na duplicitu (stejná značka + název)
    const key = (a, b) => (a || '').trim().toLowerCase() + '|' + (b || '').trim().toLowerCase();
    const dupes = state.rums.filter(r => (r.typ || 'rum') === ui.typ && key(r.nazev, r.znacka) === key(nazev, znacka));
    if (dupes.length) {
      const lst = dupes.slice(0, 5).map(r => '• ' + r.nazev + (r.znacka ? ' – ' + r.znacka : '')).join('\n');
      if (!confirm(`${isDoutnik ? 'Doutník' : 'Rum'} „${nazev}${znacka ? ' – ' + znacka : ''}" už v katalogu je (${dupes.length}×):\n${lst}\n\nPřidat i tak?`)) return;
    }
    const puvod = readPuvod('newRumPuvod');
    const cena = document.getElementById('newRumCena').value;
    const nfVal = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
    const nfNum = (id) => { const el = document.getElementById(id); return (el && el.value) ? Number(el.value) : null; };
    const fotoBlob = window._newRumFotoBlob || null;
    window._newRumFotoBlob = null;
    const rum = { nazev, znacka, puvod, cena: cena ? Number(cena) : null, datum: nfVal('newRumDatum'), poznamka: '', typ: ui.typ, _seq: Date.now() };
    if (isDoutnik) {
      rum.format = nfVal('newRumFormat');
      rum.sila = readSila('newRumSila');
    } else {
      rum.abv = nfNum('newRumAbv');
      rum.surovina = readSurovina('newRumSurovina');
      rum.cukr = nfNum('newRumCukr');
    }
    const ref = await db.collection('rums').add(rum);
    ui.showNewRumRumy = false;
    toast(isDoutnik ? 'Doutník přidán do katalogu' : 'Rum přidán do katalogu');
    logChange(isDoutnik ? 'Přidán doutník' : 'Přidán rum', `${nazev}${znacka?' – '+znacka:''}`);
    if (fotoBlob) await uploadRumFoto(ref.id, fotoBlob, { processed: true, silent: true });

  } catch (e) {
    console.error('createNewRum:', e);
    toast('Uložení se nezdařilo, zkus to znovu.');
  }
}

async function saveRumEdit(rumId) {
  try {
    if (!hasPerm(PERM_SPRAVCI)) return;
    const rum = state.rums.find(r => r.id === rumId);
    if (!rum) return;
    const isDoutnik = (rum.typ || 'rum') === 'doutnik';
    const nazev = document.getElementById('editRumNazev').value.trim();
    if (!nazev) { toast('Značka nesmí být prázdná'); return; }
    const znacka = document.getElementById('editRumZnacka').value.trim();
    const puvod = readPuvod('editRumPuvod');
    const cenaRaw = document.getElementById('editRumCena').value;
    const val = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
    const num = (id) => { const el = document.getElementById(id); return (el && el.value) ? Number(el.value) : null; };
    const payload = { nazev, znacka, puvod, cena: cenaRaw ? Number(cenaRaw) : null, datum: val('editRumDatum') };
    if (isDoutnik) {
      payload.format = val('editRumFormat');
      payload.sila = readSila('editRumSila');
    } else {
      payload.abv = num('editRumAbv');
      payload.surovina = readSurovina('editRumSurovina');
      payload.cukr = num('editRumCukr');
    }
    await db.collection('rums').doc(rumId).update(payload);
    Object.assign(rum, payload);
    ui.editingRumId = null;
    toast('Údaje upraveny', 'ok');
    logChange(isDoutnik ? 'Upraven doutník' : 'Upraven rum', `${nazev}${znacka ? ' – ' + znacka : ''}`);
    openRumDetail(rumId);
    if (ui.tab === 'rumy') renderRumy();
  } catch (e) {
    console.error('saveRumEdit:', e);
    toast('Uložení se nezdařilo, zkus to znovu.');
  }
}

/* ---------------- Fotky k rumům/doutníkům (Firebase Storage) ---------------- */
// Odhad ohraničení obsahu na jednolitém pozadí (produktové fotky lahví na bílém/šedém).
// Slouží jen jako VÝCHOZÍ poloha ořezového rámečku v cropPhoto() — konečný ořez si
// vždy potvrzuje uživatel. Na strukturovaném pozadí vrátí null → rámeček je pak 86 % na střed.
// Pracuje na zmenšeném náhledu kvůli rychlosti.
function detectContentBbox(img) {
  const W = 200;
  const H = Math.max(1, Math.round(img.height * W / img.width));
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  try { ctx.filter = 'blur(2px)'; } catch (e) {} // potlačí JPEG šum, ať neimituje "obsah"
  ctx.drawImage(img, 0, 0, W, H);
  ctx.filter = 'none';
  let data;
  try { data = ctx.getImageData(0, 0, W, H).data; } catch (e) { return null; }

  // Pozadí odhadneme jako medián tenkého pruhu podél okrajů (odolnější vůči šumu,
  // stínu nebo mírně nerovnoměrnému nasvícení než jen 4 rohové pixely).
  const bw = Math.max(2, Math.round(Math.min(W, H) * 0.03));
  const rs = [], gs = [], bs = [];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (x < bw || x >= W - bw || y < bw || y >= H - bw) {
        const i = (y*W+x)*4;
        rs.push(data[i]); gs.push(data[i+1]); bs.push(data[i+2]);
      }
    }
  }
  const median = (arr) => { arr.sort((a,b)=>a-b); return arr[Math.floor(arr.length/2)]; };
  const br = median(rs), bg = median(gs), bb = median(bs);

  const THRESH = 20; // barevná odchylka od pozadí, od které jde o "obsah"
  const isContent = new Uint8Array(W*H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y*W+x)*4;
      const d = Math.abs(data[i]-br) + Math.abs(data[i+1]-bg) + Math.abs(data[i+2]-bb);
      isContent[y*W+x] = d > THRESH ? 1 : 0;
    }
  }

  // Řádek/sloupec počítáme jako "obsah", pokud v něm obsah je aspoň v pár procentech
  // pixelů - odolnější vůči izolovanému šumu než hledání jednotlivých pixelů.
  const MIN_FRAC = 0.035;
  let top=-1, bottom=-1, left=-1, right=-1;
  for (let y = 0; y < H; y++) {
    let s = 0; for (let x = 0; x < W; x++) s += isContent[y*W+x];
    if (s / W > MIN_FRAC) { top = y; break; }
  }
  for (let y = H-1; y >= 0; y--) {
    let s = 0; for (let x = 0; x < W; x++) s += isContent[y*W+x];
    if (s / W > MIN_FRAC) { bottom = y; break; }
  }
  for (let x = 0; x < W; x++) {
    let s = 0; for (let y = 0; y < H; y++) s += isContent[y*W+x];
    if (s / H > MIN_FRAC) { left = x; break; }
  }
  for (let x = W-1; x >= 0; x--) {
    let s = 0; for (let y = 0; y < H; y++) s += isContent[y*W+x];
    if (s / H > MIN_FRAC) { right = x; break; }
  }
  if (top < 0 || left < 0 || right <= left || bottom <= top) return null;

  const contentW = right - left, contentH = bottom - top;
  // pokud obsah zabírá už skoro celou fotku, ořez by nic nezlepšil
  if (contentW > W * 0.94 && contentH > H * 0.94) return null;
  if (contentW < W * 0.04 || contentH < H * 0.04) return null; // moc málo obsahu, raději neriskovat

  const marginFrac = 0.05;
  const mx = contentW * marginFrac, my = contentH * marginFrac;
  const sx = img.width / W, sy = img.height / H;
  const x0 = Math.max(0, (left - mx)) * sx;
  const y0 = Math.max(0, (top - my)) * sy;
  const x1 = Math.min(W, (right + mx)) * sx;
  const y1 = Math.min(H, (bottom + my)) * sy;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/* ---------------- Ruční ořez fotky ---------------- */
// cropPhoto(src): src = File/Blob (nová fotka) nebo URL string (ořez už nahrané).
// Otevře celoobrazovkový ořez, vrátí zpracovaný JPEG blob (≤800 px) nebo null (Zrušit).
let _cropState = null;
let _cropDragCleanup = null;

function _clampN(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

async function cropPhoto(src) {
  let objUrl = null, img;
  try {
    if (typeof src === 'string') {
      const resp = await fetch(src, { mode: 'cors' });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      objUrl = URL.createObjectURL(await resp.blob());
    } else {
      objUrl = URL.createObjectURL(src);
    }
    img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('load')); img.src = objUrl; });
  } catch (e) {
    if (objUrl) URL.revokeObjectURL(objUrl);
    console.error('cropPhoto load:', e);
    toast(typeof src === 'string'
      ? 'Tuhle fotku nejde znovu oříznout — vyfoť nebo vyber ji prosím znovu.'
      : 'Fotku se nepodařilo načíst.');
    return null;
  }

  const choice = await runCropUI(img);
  URL.revokeObjectURL(objUrl);
  if (choice === 'cancel') return null;

  const NW = img.naturalWidth, NH = img.naturalHeight;
  let sx = 0, sy = 0, sw = NW, sh = NH;
  if (choice.mode === 'crop') { sx = choice.box.x; sy = choice.box.y; sw = choice.box.w; sh = choice.box.h; }

  const maxDim = 800;
  let w = sw, h = sh;
  if (w > maxDim || h > maxDim) {
    if (w >= h) { h = Math.round(h * maxDim / w); w = maxDim; }
    else { w = Math.round(w * maxDim / h); h = maxDim; }
  }
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, w, h);
  return await new Promise(res => canvas.toBlob(b => res(b), 'image/jpeg', 0.74));
}

function ensureCropDom() {
  let ov = document.getElementById('cropOverlay');
  if (ov) return ov;
  ov = document.createElement('div');
  ov.id = 'cropOverlay';
  ov.className = 'crop-overlay';
  ov.hidden = true;
  ov.innerHTML = `
    <div class="crop-top">Táhni rámeček – vyber výřez fotky</div>
    <div class="crop-stage" id="cropStage">
      <div class="crop-wrap" id="cropWrap">
        <img id="cropImg" alt="">
        <div class="crop-box" id="cropBox">
          <span class="crop-handle h-nw" data-h="nw"></span>
          <span class="crop-handle h-ne" data-h="ne"></span>
          <span class="crop-handle h-sw" data-h="sw"></span>
          <span class="crop-handle h-se" data-h="se"></span>
        </div>
      </div>
    </div>
    <div class="crop-bar">
      <button class="btn btn-ghost" id="cropCancel">Zrušit</button>
      <button class="btn btn-ghost" id="cropFull">Celá fotka</button>
      <button class="btn btn-primary" id="cropApply">Použít</button>
    </div>`;
  document.body.appendChild(ov);
  return ov;
}

function _applyCropBox(boxEl, st) {
  const b = st.box;
  boxEl.style.left = b.x + 'px';
  boxEl.style.top = b.y + 'px';
  boxEl.style.width = b.w + 'px';
  boxEl.style.height = b.h + 'px';
}

function _attachCropDrag(wrap, boxEl, st) {
  let drag = null;
  const pt = (e) => { const r = wrap.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const onMove = (e) => {
    if (!drag) return;
    const p = pt(e);
    const dx = p.x - drag.p.x, dy = p.y - drag.p.y;
    const sb = drag.box;
    if (drag.type === 'move') {
      st.box = {
        x: _clampN(sb.x + dx, 0, st.RW - sb.w),
        y: _clampN(sb.y + dy, 0, st.RH - sb.h),
        w: sb.w, h: sb.h,
      };
    } else {
      let x0 = sb.x, y0 = sb.y, x1 = sb.x + sb.w, y1 = sb.y + sb.h;
      const c = drag.corner, m = st.minPx;
      if (c === 'nw') { x0 = _clampN(sb.x + dx, 0, x1 - m); y0 = _clampN(sb.y + dy, 0, y1 - m); }
      if (c === 'ne') { x1 = _clampN(x1 + dx, x0 + m, st.RW); y0 = _clampN(sb.y + dy, 0, y1 - m); }
      if (c === 'sw') { x0 = _clampN(sb.x + dx, 0, x1 - m); y1 = _clampN(y1 + dy, y0 + m, st.RH); }
      if (c === 'se') { x1 = _clampN(x1 + dx, x0 + m, st.RW); y1 = _clampN(y1 + dy, y0 + m, st.RH); }
      st.box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    _applyCropBox(boxEl, st);
  };
  const onUp = () => { drag = null; window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
  const onDown = (e) => {
    const handle = e.target.closest('.crop-handle');
    if (!handle && !e.target.closest('.crop-box')) return;
    e.preventDefault();
    drag = { type: handle ? 'resize' : 'move', corner: handle ? handle.dataset.h : null, p: pt(e), box: { ...st.box } };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };
  wrap.addEventListener('pointerdown', onDown);
  _cropDragCleanup = () => { wrap.removeEventListener('pointerdown', onDown); onUp(); };
}

function runCropUI(img) {
  return new Promise(resolve => {
    const ov = ensureCropDom();
    const stage = ov.querySelector('#cropStage');
    const wrap = ov.querySelector('#cropWrap');
    const imgEl = ov.querySelector('#cropImg');
    const boxEl = ov.querySelector('#cropBox');

    wrap.style.visibility = 'hidden';
    imgEl.src = img.src;
    ov.hidden = false;

    requestAnimationFrame(() => {
      const SW = stage.clientWidth, SH = stage.clientHeight;
      const NW = img.naturalWidth, NH = img.naturalHeight;
      const scale = Math.min(SW / NW, SH / NH) || 1;
      const RW = Math.max(1, Math.round(NW * scale)), RH = Math.max(1, Math.round(NH * scale));
      wrap.style.width = RW + 'px';
      wrap.style.height = RH + 'px';
      wrap.style.visibility = 'visible';

      const bb = detectContentBbox(img);
      let box;
      if (bb) {
        box = { x: bb.x * scale, y: bb.y * scale, w: bb.w * scale, h: bb.h * scale };
      } else {
        const mgn = 0.07;
        box = { x: RW * mgn, y: RH * mgn, w: RW * (1 - 2 * mgn), h: RH * (1 - 2 * mgn) };
      }
      const st = { box, RW, RH, scale, minPx: Math.max(30, Math.min(RW, RH) * 0.12) };
      _cropState = st;
      _applyCropBox(boxEl, st);
      _attachCropDrag(wrap, boxEl, st);
    });

    const done = (val) => {
      ov.hidden = true;
      if (_cropDragCleanup) { _cropDragCleanup(); _cropDragCleanup = null; }
      ov.querySelector('#cropCancel').onclick = null;
      ov.querySelector('#cropFull').onclick = null;
      ov.querySelector('#cropApply').onclick = null;
      resolve(val);
    };
    ov.querySelector('#cropCancel').onclick = () => done('cancel');
    ov.querySelector('#cropFull').onclick = () => done({ mode: 'full' });
    ov.querySelector('#cropApply').onclick = () => {
      const b = _cropState.box, sc = _cropState.scale;
      done({ mode: 'crop', box: {
        x: Math.max(0, Math.round(b.x / sc)),
        y: Math.max(0, Math.round(b.y / sc)),
        w: Math.round(b.w / sc),
        h: Math.round(b.h / sc),
      } });
    };
  });
}

async function recropRumFoto(rumId) {
  const rum = state.rums.find(r => r.id === rumId);
  if (!rum || !rum.foto) return;
  const blob = await cropPhoto(rum.foto);
  if (!blob) return;
  await uploadRumFoto(rumId, blob, { processed: true });
}

async function recropCigarFoto(cigarId) {
  const c = state.cigars.find(x => x.id === cigarId);
  if (!c || !c.foto) return;
  const blob = await cropPhoto(c.foto);
  if (!blob) return;
  await uploadCigarFoto(cigarId, blob, { processed: true });
}

async function prepNewRumFoto(file) {
  const s = document.getElementById('newRumFotoStatus');
  if (s) s.textContent = 'Připravuji fotku…';
  const blob = await cropPhoto(file);
  window._newRumFotoBlob = blob || null;
  if (s) s.textContent = blob ? '✓ fotka připravena' : 'fotka nevybrána';
}

async function uploadRumFoto(rumId, file, opts = {}) {
  if (!hasPerm(PERM_SPRAVCI)) return;
  if (!storage) { toast('Fotky nejsou zapnuté (chybí Firebase Storage) — appka funguje dál i bez nich.'); return; }
  let blob;
  if (opts.processed) {
    blob = file;
  } else {
    if (!file || !file.type || !file.type.startsWith('image/')) { toast('Vyber prosím obrázek'); return; }
    blob = await cropPhoto(file);
    if (!blob) return;
  }
  try {
    if (!opts.silent) toast('Nahrávám fotku (' + Math.round(blob.size / 1024) + ' kB)…');
    const path = `rum-photos/${rumId}-${Date.now()}.jpg`;
    const ref = storage.ref(path);
    await ref.put(blob, { contentType: 'image/jpeg' });
    const url = await ref.getDownloadURL();
    await db.collection('rums').doc(rumId).update({ foto: url });
    // Neceká se na zpětné doručení přes onSnapshot (může dorazit s malým zpožděním) -
    // lokální stav se opraví hned, aby se otevřený detail překreslil se správnou fotkou.
    const localRum = state.rums.find(r => r.id === rumId);
    if (localRum) localRum.foto = url;
    toast('Fotka uložena', 'ok');
    if (ui.detailRumId === rumId) openRumDetail(rumId);
    if (ui.tab === 'rumy') renderRumy();
  } catch (e) {
    console.error('uploadRumFoto:', e);
    toast('Nahrání fotky se nezdařilo, zkus to znovu.');
  }
}

async function removeRumFoto(rumId) {
  if (!hasPerm(PERM_MAZANI)) return;
  if (!confirm('Smazat fotku?')) return;
  try {
    await db.collection('rums').doc(rumId).update({ foto: firebase.firestore.FieldValue.delete() });
    const localRum = state.rums.find(r => r.id === rumId);
    if (localRum) delete localRum.foto;
    toast('Fotka smazána', 'ok');
    openRumDetail(rumId);
    if (ui.tab === 'rumy') renderRumy();
  } catch (e) {
    console.error('removeRumFoto:', e);
    toast('Uložení se nezdařilo, zkus to znovu.');
  }
}

async function uploadCigarFoto(cigarId, file, opts = {}) {
  if (!hasPerm(PERM_SPRAVCI)) return;
  if (!storage) { toast('Fotky nejsou zapnuté (chybí Firebase Storage) — appka funguje dál i bez nich.'); return; }
  let blob;
  if (opts.processed) {
    blob = file;
  } else {
    if (!file || !file.type || !file.type.startsWith('image/')) { toast('Vyber prosím obrázek'); return; }
    blob = await cropPhoto(file);
    if (!blob) return;
  }
  try {
    toast('Nahrávám fotku (' + Math.round(blob.size / 1024) + ' kB)…');
    const ref = storage.ref(`cigar-photos/${cigarId}-${Date.now()}.jpg`);
    await ref.put(blob, { contentType: 'image/jpeg' });
    const url = await ref.getDownloadURL();
    await db.collection('cigars').doc(cigarId).update({ foto: url });
    const c = state.cigars.find(x => x.id === cigarId);
    if (c) c.foto = url;
    toast('Fotka uložena', 'ok');
    if (ui.detailCigarId === cigarId) renderCigarDetail();
    if (ui.tab === 'humidor') renderHumidor();
  } catch (e) {
    console.error('uploadCigarFoto:', e);
    toast('Nahrání fotky se nezdařilo, zkus to znovu.');
  }
}

async function removeCigarFoto(cigarId) {
  if (!hasPerm(PERM_MAZANI)) return;
  if (!confirm('Smazat fotku?')) return;
  try {
    await db.collection('cigars').doc(cigarId).update({ foto: firebase.firestore.FieldValue.delete() });
    const c = state.cigars.find(x => x.id === cigarId);
    if (c) delete c.foto;
    toast('Fotka smazána', 'ok');
    renderCigarDetail();
    if (ui.tab === 'humidor') renderHumidor();
  } catch (e) {
    console.error('removeCigarFoto:', e);
    toast('Uložení se nezdařilo, zkus to znovu.');
  }
}

async function quickAddMember() {
  try {
    const name = document.getElementById('quickMemberName').value.trim();
    if (!name) return;
    if (state.members.some(m => (m.jmeno||'').trim().toLowerCase() === name.toLowerCase())) {
      toast(`Člen "${name}" už existuje`);
      return;
    }
    await db.collection('members').add({ jmeno: name, aktivni: true });
    ui.selectedMember = name;
    ui.showNewMember = false;
    toast('Člen přidán', 'ok');
    logChange('Přidán člen', name);

  } catch (e) {
    console.error('quickAddMember:', e);
    toast('Uložení se nezdařilo, zkus to znovu.');
  }
}

async function submitRating() {
  try {
    const rum = state.rums.find(r => r.id === ui.selectedRatingRumId);
    if (!rum || !ui.selectedMember) return;
    if (!isAdmin && currentUser && ui.selectedMember !== currentUser) {
      toast('Můžeš uložit hodnocení jen za sebe (' + currentUser + ')');
      return;
    }
    const crit = ['barva','aroma','chut','plnost','dojezd'];
    const celkem = crit.reduce((s,k)=>s+Number(ui.scores[k]||0),0);
    const body = {
      rumId: rum.id, clen: ui.selectedMember,
      barva: ui.scores.barva, aroma: ui.scores.aroma, chut: ui.scores.chut,
      plnost: ui.scores.plnost, dojezd: ui.scores.dojezd, celkem,
      datum: new Date().toISOString().slice(0,10),
      _seq: Date.now(),
    };
    const existing = state.ratings.find(r => r.rumId === rum.id && r.clen === ui.selectedMember);
    if (existing) {
      await db.collection('ratings').doc(existing.id).set(body);
      toast('Hodnocení přepsáno');
      logChange('Upraveno hodnocení', `${ui.selectedMember} → ${rum.nazev}${rum.znacka?' – '+rum.znacka:''} (${celkem})`);
    } else {
      await db.collection('ratings').add(body);
      toast('Hodnocení uloženo', 'ok');
      logChange('Přidáno hodnocení', `${ui.selectedMember} → ${rum.nazev}${rum.znacka?' – '+rum.znacka:''} (${celkem})`);
    }
    ui.selectedMember = currentUser || ui.selectedMember || null;
    ui.selectedRatingRumId = null;
    ui.scores = { barva: 15, aroma: 15, chut: 15, plnost: 15, dojezd: 15 };
    renderActiveDegustaceForm();

  } catch (e) {
    console.error('submitRating:', e);
    toast('Uložení se nezdařilo, zkus to znovu.');
  }
}

function renderRecentRatings() {
  const el = document.getElementById('recentRatings');
  el.style.display = '';
  const recent = [...state.ratings].sort((a,b)=>(b._seq||0)-(a._seq||0)).slice(0,100);
  if (recent.length === 0) { el.innerHTML = ''; return; }
  el.innerHTML = '<div class="muted" style="font-size:12px;margin-bottom:6px;">Naposledy přidáno</div>' +
    '<div class="recent-list-scroll">' +
    recent.map(r => {
      const rum = state.rums.find(x=>x.id===r.rumId);
      const editable = !isGuest && (isAdmin || r.clen === currentUser);
      const cls = 'recent-item' + (editable ? ' clickable' : '');
      const click = editable ? ` onclick="editRecentRating('${r.id}')"` : '';
      return `<div class="${cls}"${click}><span>${esc(r.clen)} – ${esc(rum?rum.nazev:'?')}</span><b>${r.celkem}</b></div>`;
    }).join('') +
    '</div>';
}

function editRecentRating(ratingId) {
  if (isGuest) return;
  const r = state.ratings.find(x => x.id === ratingId);
  if (!r) return;
  if (!isAdmin && r.clen !== currentUser) {
    toast('Můžeš upravit jen svoje hodnocení (' + currentUser + ')');
    return;
  }
  ui.selectedRatingRumId = r.rumId;
  ui.selectedMember = r.clen;
  ui.scores = {
    barva: Number(r.barva)||15, aroma: Number(r.aroma)||15, chut: Number(r.chut)||15,
    plnost: Number(r.plnost)||15, dojezd: Number(r.dojezd)||15
  };
  ui.showNewRum = false;
  renderDegustaceForm();
  document.getElementById('degustaceForm').scrollIntoView({ behavior:'smooth', block:'start' });
}

/* ---------------- UCET tab ---------------- */
function renderUcet() {
  const bal = currentBalance();
  const big = document.getElementById('ucetBalanceBig');
  big.textContent = Math.round(bal).toLocaleString('cs-CZ') + ' Kč';
  big.className = 'num ' + (bal < 0 ? 'neg' : 'pos');
  const addCard = document.getElementById('ucetAddCard');
  if (addCard) addCard.hidden = !hasPerm(PERM_SPRAVCI);
  if (!document.getElementById('ucetDatum').value) {
    document.getElementById('ucetDatum').value = new Date().toISOString().slice(0,10);
  }

  const sorted = [...ledgerSourceArray()].sort((a,b) => (a.datum||'').localeCompare(b.datum||'') || (a._seq||0)-(b._seq||0));
  let running = 0;
  const withBalance = sorted.map(l => { running += Number(l.castka)||0; return {...l, running}; });
  withBalance.reverse();

  const q = (ui.ucetSearch || '').trim().toLowerCase();
  const filtered = q ? withBalance.filter(l =>
    (l.popis||'').toLowerCase().includes(q) || (l.kategorie||'').toLowerCase().includes(q)
  ) : withBalance;

  document.getElementById('ledgerList').innerHTML = withBalance.length === 0
    ? '<div class="empty-note">Zatím žádné transakce.</div>'
    : (filtered.length === 0
      ? `<div class="empty-note">Nic neodpovídá hledání "${esc(ui.ucetSearch||'')}".</div>`
      : filtered.map(l => `
      <div class="ledger-row" onclick="openLedgerEdit('${l.id}')">
        <div class="ledger-desc">
          <div>${esc(l.popis)}</div>
          <div class="ledger-date">${esc(l.datum||'')} · ${esc(l.kategorie||'')}</div>
        </div>
        <div>
          <div class="ledger-amt ${l.castka<0?'neg':'pos'}">${l.castka>0?'+':''}${Math.round(l.castka).toLocaleString('cs-CZ')} Kč</div>
          <span class="ledger-bal">zůst. ${Math.round(l.running).toLocaleString('cs-CZ')}</span>
        </div>
      </div>
    `).join(''));

  updateBalanceChip();
}

/* ---------------- editace/mazání položky účtu ---------------- */
function openLedgerEdit(id) {
  const l = ledgerSourceArray().find(x => x.id === id);
  if (!l) return;
  const canEdit = hasPerm(PERM_SPRAVCI);
  const dis = canEdit ? '' : 'disabled';
  document.getElementById('ledgerEditSheet').innerHTML = `
    <div class="sheet-head">
      <h2 style="font-family:var(--font-display);font-weight:600;font-size:1.35rem;margin:0;">Upravit transakci</h2>
      <button class="sheet-close" onclick="closeLedgerEdit()" aria-label="Zavřít">×</button>
    </div>
    <div class="field"><label>Datum</label><input class="input" type="date" id="editDatum" value="${esc(l.datum||'')}" ${dis}></div>
    <div class="field"><label>Popis</label><input class="input" id="editPopis" value="${esc(l.popis||'')}" ${dis}></div>
    <div class="row2">
      <div class="field"><label>Částka (Kč, záporná = výdaj)</label><input class="input" type="number" id="editCastka" value="${l.castka!=null?l.castka:''}" ${dis}></div>
      <div class="field"><label>Kategorie</label>
        <select class="input" id="editKategorie" ${dis}>
          ${['nákup','degustace','bonus','jiné'].map(k=>`<option value="${k}" ${l.kategorie===k?'selected':''}>${k}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="btn-row" style="margin-top:14px;">
      ${canEdit ? `<button class="btn btn-primary" onclick="saveLedgerEdit('${id}')">Uložit změny</button>` : ''}
      <button class="btn btn-ghost" onclick="closeLedgerEdit()">← Zpět</button>
      ${canEdit ? `<button class="btn btn-danger" onclick="deleteLedgerEntry('${id}')">Smazat</button>` : ''}
    </div>
  `;
  document.getElementById('ledgerEditOverlay').hidden = false;
}

function closeLedgerEdit() { document.getElementById('ledgerEditOverlay').hidden = true; }

async function saveLedgerEdit(id) {
  try {
    if (!hasPerm(PERM_SPRAVCI)) return;
    const datum = document.getElementById('editDatum').value;
    const popis = document.getElementById('editPopis').value.trim();
    const castka = Number(document.getElementById('editCastka').value);
    const kategorie = document.getElementById('editKategorie').value;
    if (!popis || !castka) { toast('Vyplň popis a částku'); return; }
    await db.collection(ledgerCollectionName()).doc(id).update({ datum, popis, castka, kategorie });
    closeLedgerEdit();
    toast('Transakce upravena', 'ok');
    logChange('Upravena transakce', `${popis} (${castka} Kč)`);

  } catch (e) {
    console.error('saveLedgerEdit:', e);
    toast('Uložení se nezdařilo, zkus to znovu.');
  }
}

async function deleteLedgerEntry(id) {
  try {
    if (!hasPerm(PERM_SPRAVCI)) return;
    if (!confirm('Opravdu smazat tuto transakci?')) return;
    const l = ledgerSourceArray().find(x => x.id === id);
    await db.collection(ledgerCollectionName()).doc(id).delete();
    closeLedgerEdit();
    toast('Transakce smazána', 'ok');
    logChange('Smazána transakce', l ? `${l.popis} (${l.castka} Kč)` : id);

  } catch (e) {
    console.error('deleteLedgerEntry:', e);
    toast('Uložení se nezdařilo, zkus to znovu.');
  }
}

function updateBalanceChip() {
  const chip = document.getElementById('balanceChip');
  if (!chip) return; // odstraněno z hlavičky
  const bal = currentBalance();
  chip.className = 'balance-chip ' + (bal < 0 ? 'neg' : 'pos');
  document.getElementById('balanceChipVal').textContent = Math.round(bal).toLocaleString('cs-CZ') + ' Kč';
}

function enforceNakupSign() {
  const kat = document.getElementById('ucetKategorie').value;
  const inp = document.getElementById('ucetCastka');
  if (kat === 'nákup') {
    const val = Number(inp.value);
    if (val > 0) inp.value = -val;
  }
}

async function addLedger() {
  try {
    if (!hasPerm(PERM_SPRAVCI)) return;
    const datum = document.getElementById('ucetDatum').value;
    const popis = document.getElementById('ucetPopis').value.trim();
    let castka = Number(document.getElementById('ucetCastka').value);
    const kategorie = document.getElementById('ucetKategorie').value;
    if (!popis || !castka) { toast('Vyplň popis a částku'); return; }
    if (kategorie === 'nákup' && castka > 0) castka = -castka;
    await db.collection(ledgerCollectionName()).add({ datum, popis, castka, kategorie, _seq: Date.now() });
    document.getElementById('ucetPopis').value = '';
    document.getElementById('ucetCastka').value = '';
    toast('Transakce přidána', 'ok');
    logChange('Přidána transakce', `${popis} (${castka} Kč)`);

  } catch (e) {
    console.error('addLedger:', e);
    toast('Uložení se nezdařilo, zkus to znovu.');
  }
}

/* ---------------- WISHLIST tab ---------------- */
function toggleWishForm() {
  ui.wishFormOpen = !ui.wishFormOpen;
  const el = document.getElementById('wishForm');
  el.hidden = !ui.wishFormOpen;
  document.getElementById('wishToggleBtn').hidden = ui.wishFormOpen;
  if (ui.wishFormOpen) {
    const isDoutnik = ui.typ === 'doutnik';
    window._newWishFotoBlob = null;
    el.innerHTML = `
      <div class="field"><label>Značka ${isDoutnik?'doutníku':'rumu'}</label><input class="input" id="wishZnacka" placeholder="${isDoutnik?'např. COHIBA':'např. HAVANA CLUB'}"></div>
      <div class="row2">
        <div class="field"><label>Název ${isDoutnik?'doutníku':'rumu'}</label><input class="input" id="wishNazev" placeholder="${isDoutnik?'Robusto':'Anejo Especial'}"></div>
        <div class="field"><label>Původ</label>${puvodSelectHtml('wishPuvod', '')}</div>
      </div>
      <div class="row2">
        <div class="field"><label>Cena (Kč)</label><input class="input" type="number" id="wishCena"></div>
        ${isDoutnik
          ? '<div class="field"><label>Formát</label><input class="input" id="wishFormat" placeholder="Toro, Robusto…"></div>'
          : '<div class="field"><label>Obsah alkoholu (%)</label><input class="input" type="number" step="0.1" id="wishAbv" placeholder="40"></div>'}
      </div>
      <div class="row2">
        ${isDoutnik
          ? `<div class="field"><label>Síla/plnost</label>${silaSelectHtml('wishSila', '')}</div>`
          : `<div class="field"><label>Surovina</label>${surovinaSelectHtml('wishSurovina', '')}</div>`}
        ${isDoutnik ? '' : '<div class="field"><label>Obsah cukru (g/l)</label><input class="input" type="number" step="0.1" id="wishCukr"></div>'}
      </div>
      <div class="field"><label>Poznámka</label><textarea class="input" id="wishPoznamka"></textarea></div>
      <div class="field">
        <label>Fotka (nepovinné)</label>
        ${fotoButtonsHtml("prepNewWishFoto(this.files[0])")}
        <div class="muted" id="wishFotoStatus" style="font-size:11.5px;margin-top:4px;">Po výběru fotky si ještě ořízneš výřez.</div>
      </div>
      <div class="btn-row" style="margin-top:4px;">
        <button class="btn btn-primary btn-sm" onclick="addWish()">Přidat na wishlist</button>
        <button class="btn btn-ghost btn-sm" onclick="toggleWishForm()">Zpět</button>
      </div>
    `;
  }
}

async function prepNewWishFoto(file) {
  const s = document.getElementById('wishFotoStatus');
  if (s) s.textContent = 'Připravuji fotku…';
  const blob = await cropPhoto(file);
  window._newWishFotoBlob = blob || null;
  if (s) s.textContent = blob ? '✓ fotka připravena' : 'fotka nevybrána';
}

async function uploadWishFoto(wishId, blob) {
  if (isGuest || !storage || !blob) return;
  try {
    toast('Nahrávám fotku (' + Math.round(blob.size / 1024) + ' kB)…');
    const ref = storage.ref(`wish-photos/${wishId}-${Date.now()}.jpg`);
    await ref.put(blob, { contentType: 'image/jpeg' });
    const url = await ref.getDownloadURL();
    await db.collection('wishlist').doc(wishId).update({ foto: url });
    const w = state.wishlist.find(x => x.id === wishId);
    if (w) w.foto = url;
    toast('Fotka uložena', 'ok');
    if (ui.tab === 'wishlist') renderWishlist();
  } catch (e) {
    console.error('uploadWishFoto:', e);
    toast('Nahrání fotky se nezdařilo, zkus to znovu.');
  }
}

async function addWish() {
  try {
    if (isGuest) return;
    const znacka = document.getElementById('wishZnacka').value.trim();
    if (!znacka) { toast('Zadej značku'); return; }
    const isDoutnik = ui.typ === 'doutnik';
    const val = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
    const num = (id) => { const el = document.getElementById(id); return (el && el.value) ? Number(el.value) : null; };
    const fotoBlob = window._newWishFotoBlob || null;
    window._newWishFotoBlob = null;
    // nové položky nahoru: _seq menší než všechny stávající téhož typu
    const sameTyp = state.wishlist.filter(w => (w.typ || 'rum') === ui.typ);
    const minSeq = sameTyp.length ? Math.min(...sameTyp.map(w => w._seq || 0)) : 0;
    const item = {
      znacka,
      nazev: val('wishNazev'),
      puvod: readPuvod('wishPuvod'),
      cena: num('wishCena'),
      poznamka: val('wishPoznamka'),
      priorita: 'střední', stav: 'kandidát', typ: ui.typ,
      _seq: minSeq - 1,
    };
    if (isDoutnik) {
      item.format = val('wishFormat');
      item.sila = readSila('wishSila');
    } else {
      item.abv = num('wishAbv');
      item.surovina = readSurovina('wishSurovina');
      item.cukr = num('wishCukr');
    }
    const ref = await db.collection('wishlist').add(item);
    if (fotoBlob) await uploadWishFoto(ref.id, fotoBlob);
    toggleWishForm();
    toast('Přidáno na wishlist', 'ok');
    logChange('Přidáno na wishlist', znacka + (item.nazev ? ' – ' + item.nazev : ''));

  } catch (e) {
    console.error('addWish:', e);
    toast('Uložení se nezdařilo, zkus to znovu.');
  }
}

async function setWishStatus(id, stav) {
  try {
    const w = state.wishlist.find(x => x.id === id);
    await db.collection('wishlist').doc(id).update({ stav });
    logChange('Změněn stav wishlistu', `${w ? (w.znacka+' '+w.nazev) : id} → ${stav}`);

  } catch (e) {
    console.error('setWishStatus:', e);
    toast('Uložení se nezdařilo, zkus to znovu.');
  }
}

async function deleteWish(id) {
  try {
    if (!hasPerm(PERM_MAZANI)) return;
    if (!confirm('Opravdu smazat tuhle položku z wishlistu?')) return;
    const w = state.wishlist.find(x => x.id === id);
    await db.collection('wishlist').doc(id).delete();
    toast('Položka smazána', 'ok');
    logChange('Smazáno z wishlistu', w ? (w.znacka+' '+w.nazev) : id);

  } catch (e) {
    console.error('deleteWish:', e);
    toast('Uložení se nezdařilo, zkus to znovu.');
  }
}

async function convertWishToCatalog(id) {
  try {
    if (!hasPerm(PERM_MAZANI)) return;
    const w = state.wishlist.find(x => x.id === id);
    if (!w) return;
    const isDoutnik = (w.typ||'rum') === 'doutnik';
    const label = `${w.znacka||''} ${w.nazev||''}`.trim();
    if (!confirm(`Přesunout "${label}" do katalogu ${isDoutnik?'doutníků':'rumů'} a smazat z wishlistu?`)) return;
    // ve wishlistu je „Značka" = w.znacka (hlavní název), v katalogu = nazev
    const rum = {
      nazev: w.znacka || '', znacka: w.nazev || '', puvod: w.puvod || '',
      cena: w.cena ?? null, datum: new Date().toISOString().slice(0, 10),
      poznamka: w.poznamka || '', typ: w.typ || 'rum', _seq: Date.now(),
    };
    if (isDoutnik) {
      rum.format = w.format || '';
      rum.sila = w.sila || '';
    } else {
      rum.abv = w.abv ?? null;
      rum.surovina = w.surovina || '';
      rum.cukr = w.cukr ?? null;
    }
    if (w.foto) rum.foto = w.foto;
    await db.collection('rums').add(rum);
    await db.collection('wishlist').doc(id).delete();
    toast(isDoutnik ? 'Doutník přesunut do katalogu' : 'Rum přesunut do katalogu');
    logChange('Wishlist → katalog', label);

  } catch (e) {
    console.error('convertWishToCatalog:', e);
    toast('Uložení se nezdařilo, zkus to znovu.');
  }
}

function renderWishlist() {
  let rows = state.wishlist.filter(w => (w.typ||'rum') === ui.typ).sort((a, b) => (a._seq || 0) - (b._seq || 0));
  const list = document.getElementById('wishList');
  if (rows.length === 0) { list.innerHTML = '<div class="empty-note">Nic tu není.</div>'; initWishSortable(); return; }
  list.innerHTML = rows.map(w => {
    const subParts = [];
    if (w.abv) subParts.push(esc(String(w.abv))+'% obj.');
    if (w.format) subParts.push(esc(w.format));
    if (w.sila) subParts.push(esc(w.sila));
    if (w.puvod) subParts.push(puvodBadges(w));
    if (w.cena) subParts.push(esc(String(w.cena))+' Kč');
    if (w.surovina) subParts.push(esc(w.surovina));
    if (w.cukr!=null) subParts.push('cukr '+esc(String(w.cukr))+' g/l');
    return `
    <div class="card wish-card" data-id="${w.id}">
      <div style="display:flex; gap:8px; align-items:flex-start;">
        ${hasPerm(PERM_SPRAVCI) ? '<div class="drag-handle" style="cursor:grab; touch-action:none; user-select:none; color:var(--ink-faint); font-size:18px; line-height:1.4; padding:2px 4px 2px 0; flex-shrink:0;">⠿</div>' : ''}
        ${w.foto ? `<img src="${esc(w.foto)}" alt="" class="rum-thumb" loading="lazy" decoding="async" onerror="this.classList.add('rum-thumb-empty');this.removeAttribute('src');">` : ''}
        <div style="flex:1; min-width:0;">
          <div class="rum-name">${esc(w.znacka)} ${w.nazev?'<span class="muted" style="font-weight:400;">– '+esc(w.nazev)+'</span>':''}</div>
          <div class="rum-sub">${subParts.join(' · ')}</div>
          ${w.poznamka ? '<div class="muted" style="font-size:12.5px;margin-top:4px;">'+esc(w.poznamka)+'</div>' : ''}
          ${hasPerm(PERM_MAZANI) ? `
          <div class="btn-row" style="margin-top:10px; flex-wrap:wrap;">
            <button class="btn btn-primary btn-sm" style="flex:0 0 auto;" onclick="convertWishToCatalog('${w.id}')">✅ Koupeno → do katalogu</button>
            <button class="btn btn-danger btn-sm" style="flex:0 0 auto;" onclick="deleteWish('${w.id}')">Smazat</button>
          </div>
          ` : ''}
        </div>
      </div>
    </div>
  `;
  }).join('');
  initWishSortable();
}

let wishSortable = null;
function initWishSortable() {
  const el = document.getElementById('wishList');
  if (!el) return;
  if (wishSortable) { wishSortable.destroy(); wishSortable = null; }
  if (!hasPerm(PERM_SPRAVCI) || typeof Sortable === 'undefined') return;
  wishSortable = new Sortable(el, {
    handle: '.drag-handle',
    animation: 150,
    onEnd: saveWishOrder,
  });
}

async function saveWishOrder() {
  try {
    const el = document.getElementById('wishList');
    const ids = Array.from(el.children).map(c => c.dataset.id).filter(Boolean);
    const batch = db.batch();
    ids.forEach((id, i) => batch.update(db.collection('wishlist').doc(id), { _seq: i }));
    await batch.commit();
    logChange('Přeuspořádán wishlist', ids.length + ' položek');

  } catch (e) {
    console.error('saveWishOrder:', e);
    toast('Uložení se nezdařilo, zkus to znovu.');
  }
}

/* ---------------- HUMIDOR tab ---------------- */
function cigarKoupeno(cigar) {
  return (cigar.nakupy || []).reduce((s, n) => s + (Number(n.pocet) || 0), 0);
}

function cigarLatestCenaKs(cigar) {
  const nakupy = cigar.nakupy || [];
  if (nakupy.length === 0) return null;
  const sorted = [...nakupy].sort((a, b) => (a.datum || '').localeCompare(b.datum || ''));
  return sorted[sorted.length - 1].cena_ks || null;
}

function cigarLogSorted(cigarId) {
  return state.cigarLog.filter(l => l.cigarId === cigarId).sort((a, b) => (a.cislo || 0) - (b.cislo || 0));
}

function cigarLastSmoked(cigarId) {
  const logs = cigarLogSorted(cigarId);
  return logs.length ? logs[logs.length - 1] : null;
}

function sortedActiveMembers() {
  return state.members.filter(m => m.aktivni !== false).slice().sort((a, b) => {
    const ia = CLUB_MEMBER_ORDER.indexOf(a.jmeno), ib = CLUB_MEMBER_ORDER.indexOf(b.jmeno);
    const ra = ia === -1 ? CLUB_MEMBER_ORDER.length : ia;
    const rb = ib === -1 ? CLUB_MEMBER_ORDER.length : ib;
    return ra !== rb ? ra - rb : a.jmeno.localeCompare(b.jmeno, 'cs');
  });
}

function renderHumidor() {
  const search = (document.getElementById('cigarSearch').value || '').toLowerCase();
  const sort = document.getElementById('cigarSort').value;
  let rows = state.cigars.map(c => {
    const koupeno = cigarKoupeno(c);
    const vykoureno = state.cigarLog.filter(l => l.cigarId === c.id).length;
    return { cigar: c, koupeno, vykoureno, zbyva: koupeno - vykoureno };
  });
  if (search) {
    rows = rows.filter(({ cigar }) =>
      (cigar.vyrobce || '').toLowerCase().includes(search) ||
      (cigar.model || '').toLowerCase().includes(search)
    );
  }
  rows.sort((a, b) => {
    if (sort === 'name') return (a.cigar.vyrobce || '').localeCompare(b.cigar.vyrobce || '');
    if (sort === 'zbyva') return b.zbyva - a.zbyva;
    if (sort === 'vykoureno') return b.vykoureno - a.vykoureno;
    return (b.cigar._seq || 0) - (a.cigar._seq || 0);
  });

  const list = document.getElementById('cigarList');
  renderNewCigarSection();
  if (rows.length === 0) {
    list.innerHTML = '<div class="empty-note">Žádný doutník neodpovídá hledání.</div>';
    return;
  }
  list.innerHTML = rows.map(({ cigar, koupeno, zbyva }) => {
    const last = cigarLastSmoked(cigar.id);
    const cenaKs = cigarLatestCenaKs(cigar);
    const subBits = [];
    if (cenaKs) subBits.push(Math.round(cenaKs) + ' Kč/ks');
    if (last) subBits.push('naposledy ' + esc(last.datum || '') + ' – ' + esc(last.clen || ''));
    const zbyvaClass = zbyva <= 0 ? 'score-none' : (zbyva <= 2 ? 'score-mid' : 'score-good');
    return `
    <div class="card rum-card" onclick="openCigarDetail('${cigar.id}')">
      <div class="rum-main">
        <div class="rum-name">${esc(cigar.vyrobce)}${cigar.model ? ' <span class="muted" style="font-weight:400;font-size:0.85em;">– ' + esc(cigar.model) + '</span>' : ''}</div>
        <div class="rum-sub">${subBits.join(' · ')}</div>
      </div>
      <div class="rum-score">
        <div class="num ${zbyvaClass}">${zbyva}</div>
        <div class="cnt">z ${koupeno} ks</div>
      </div>
    </div>
  `;
  }).join('');
}

function renderNewCigarSection() {
  const el = document.getElementById('newCigarSection');
  if (!el) return;
  if (!hasPerm(PERM_SPRAVCI)) { el.innerHTML = ''; return; }
  if (!ui.showNewCigarHumidor) {
    el.innerHTML = `<button class="btn btn-ghost btn-sm" onclick="ui.showNewCigarHumidor=true; renderNewCigarSection();">+ Nový doutník, který ještě není v seznamu</button>`;
    return;
  }
  el.innerHTML = `
    <div class="field"><label>Výrobce</label><input class="input" id="newCigarVyrobce" placeholder="např. ALEC BRADLEY"></div>
    <div class="field"><label>Model / vitola</label><input class="input" id="newCigarModel" placeholder="Robusto"></div>
    <div class="row2">
      <div class="field"><label>Datum nákupu</label><input class="input" type="date" id="newCigarDatum" value="${new Date().toISOString().slice(0,10)}"></div>
      <div class="field"><label>Počet ks</label><input class="input" type="number" id="newCigarPocet" placeholder="7"></div>
    </div>
    <div class="row2">
      <div class="field"><label>Cena/ks</label><input class="input" type="number" id="newCigarCenaKs" placeholder="190"></div>
      <div class="field"><label>Cena celkem za nákup</label><input class="input" type="number" id="newCigarCenaCelkem" placeholder="1177"></div>
    </div>
    <div class="btn-row" style="margin-top:4px;">
      <button class="btn btn-primary btn-sm" onclick="createNewCigar()">Přidat doutník</button>
      <button class="btn btn-ghost btn-sm" onclick="ui.showNewCigarHumidor=false; renderNewCigarSection();">Zpět</button>
    </div>`;
}

async function createNewCigar() {
  try {
    if (!hasPerm(PERM_SPRAVCI)) return;
    const vyrobce = document.getElementById('newCigarVyrobce').value.trim();
    if (!vyrobce) { toast('Zadej výrobce'); return; }
    const model = document.getElementById('newCigarModel').value.trim();
    const datum = document.getElementById('newCigarDatum').value;
    const pocet = Number(document.getElementById('newCigarPocet').value) || 0;
    const cenaKs = Number(document.getElementById('newCigarCenaKs').value) || null;
    const cenaCelkem = Number(document.getElementById('newCigarCenaCelkem').value) || null;
    const nakupy = pocet > 0 ? [{ datum, pocet, cena_ks: cenaKs, cena_celkem: cenaCelkem }] : [];
    await db.collection('cigars').add({ vyrobce, model, nakupy, poznamka: '', _seq: Date.now() });
    ui.showNewCigarHumidor = false;
    toast('Doutník přidán do humidoru', 'ok');
    logChange('Přidán doutník', `${vyrobce}${model ? ' – ' + model : ''}`);

  } catch (e) {
    console.error('createNewCigar:', e);
    toast('Uložení se nezdařilo, zkus to znovu.');
  }
}

function openCigarDetail(cigarId) {
  ui.detailCigarId = cigarId;
  ui.cigarShowNakupForm = false;
  ui.cigarShowLogForm = false;
  ui.cigarLogMember = currentUser || null;
  ui.cigarLogDatum = null;
  ui.editingCigarLogId = null;
  renderCigarDetail();
  document.getElementById('cigarDetailOverlay').hidden = false;
}
function closeCigarDetail() { document.getElementById('cigarDetailOverlay').hidden = true; }

function cigarLogEditable(l) {
  return hasPerm(PERM_SPRAVCI);
}

function renderCigarLogRowHtml(l) {
  if (cigarLogEditable(l) && ui.editingCigarLogId === l.id) {
    const members = sortedActiveMembers().map(m => m.jmeno);
    if (!members.includes(l.clen)) members.push(l.clen);
    return `
      <div class="card" style="margin:8px 0;">
        <div class="row2">
          <div class="field"><label>Datum</label><input class="input" type="date" id="editCigarLogDatum" value="${esc(l.datum || '')}"></div>
          <div class="field"><label>Kdo</label>
            <select class="input" id="editCigarLogClen">
              ${members.map(name => `<option value="${esc(name)}" ${l.clen === name ? 'selected' : ''}>${esc(name)}</option>`).join('')}
            </select>
          </div>
        </div>
        <div class="btn-row">
          <button class="btn btn-primary btn-sm" onclick="saveCigarLogEdit('${l.id}')">Uložit</button>
          <button class="btn btn-ghost btn-sm" onclick="ui.editingCigarLogId=null; renderCigarDetail();">Zpět</button>
          <button class="btn btn-danger btn-sm" onclick="deleteCigarLogEntry('${l.id}')">Smazat</button>
        </div>
      </div>`;
  }
  const click = cigarLogEditable(l) ? ` onclick="ui.editingCigarLogId='${l.id}'; renderCigarDetail();"` : '';
  const style = cigarLogEditable(l) ? '' : ' style="cursor:default;"';
  return `<div class="ledger-row"${click}${style}><span class="stat-row-main">č. ${l.cislo} · ${esc(l.datum || '')}</span><span>${esc(l.clen || '')}</span></div>`;
}

function renderCigarLogFormHtml() {
  if (!ui.cigarShowLogForm) {
    return `<button class="btn btn-ghost btn-sm" style="margin-top:8px;" onclick="ui.cigarShowLogForm=true; if(!ui.cigarLogMember) ui.cigarLogMember=currentUser||null; renderCigarDetail();">+ Zapsat vykouření</button>`;
  }
  const members = sortedActiveMembers();
  const datumVal = ui.cigarLogDatum || new Date().toISOString().slice(0, 10);
  return `
    <div class="card" style="margin-top:8px;">
      <div class="field"><label>Kdo kouřil</label><div class="member-chips">
        ${members.map(m => `<button class="member-chip ${ui.cigarLogMember === m.jmeno ? 'active' : ''}" onclick="ui.cigarLogDatum=document.getElementById('newCigarLogDatum').value; ui.cigarLogMember='${esc(m.jmeno).replace(/'/g,"\\'")}'; renderCigarDetail();">${esc(m.jmeno)}</button>`).join('')}
      </div></div>
      <div class="field"><label>Datum</label><input class="input" type="date" id="newCigarLogDatum" value="${datumVal}"></div>
      <div class="btn-row">
        <button class="btn btn-primary btn-sm" onclick="submitCigarLog()">Zapsat</button>
        <button class="btn btn-ghost btn-sm" onclick="ui.cigarShowLogForm=false; renderCigarDetail();">Zpět</button>
      </div>
    </div>`;
}

async function submitCigarLog() {
  try {
    const cigar = state.cigars.find(c => c.id === ui.detailCigarId);
    if (!cigar || !ui.cigarLogMember) { toast('Vyber, kdo kouřil'); return; }
    const datum = document.getElementById('newCigarLogDatum').value;
    const existing = cigarLogSorted(cigar.id);
    const cislo = existing.length ? existing[existing.length - 1].cislo + 1 : 1;
    await db.collection('cigar_log').add({ cigarId: cigar.id, cislo, datum, clen: ui.cigarLogMember, _seq: Date.now() });
    ui.cigarShowLogForm = false;
    ui.cigarLogDatum = null;
    toast('Vykouření zapsáno', 'ok');
    logChange('Zapsáno vykouření doutníku', `${ui.cigarLogMember} → ${cigar.vyrobce}${cigar.model ? ' – ' + cigar.model : ''} (č. ${cislo})`);
    renderCigarDetail();

  } catch (e) {
    console.error('submitCigarLog:', e);
    toast('Uložení se nezdařilo, zkus to znovu.');
  }
}

async function saveCigarLogEdit(logId) {
  try {
    const orig = state.cigarLog.find(x => x.id === logId);
    if (orig && !cigarLogEditable(orig)) return;
    const datum = document.getElementById('editCigarLogDatum').value;
    const clen = document.getElementById('editCigarLogClen').value;
    await db.collection('cigar_log').doc(logId).update({ datum, clen });
    ui.editingCigarLogId = null;
    toast('Záznam upraven', 'ok');
    logChange('Upraven záznam kouření', `${clen} (${datum})`);
    renderCigarDetail();

  } catch (e) {
    console.error('saveCigarLogEdit:', e);
    toast('Uložení se nezdařilo, zkus to znovu.');
  }
}

async function deleteCigarLogEntry(logId) {
  try {
    const l = state.cigarLog.find(x => x.id === logId);
    if (l && !cigarLogEditable(l)) return;
    if (!confirm('Opravdu smazat tenhle záznam kouření?')) return;
    await db.collection('cigar_log').doc(logId).delete();
    ui.editingCigarLogId = null;
    toast('Záznam smazán', 'ok');
    logChange('Smazán záznam kouření', l ? `${l.clen} (č. ${l.cislo})` : logId);
    renderCigarDetail();

  } catch (e) {
    console.error('deleteCigarLogEntry:', e);
    toast('Uložení se nezdařilo, zkus to znovu.');
  }
}

function renderCigarNakupFormHtml() {
  if (!ui.cigarShowNakupForm) {
    return `<button class="btn btn-ghost btn-sm" style="margin-top:8px;" onclick="ui.cigarShowNakupForm=true; renderCigarDetail();">+ Přidat nákup (dokoupení)</button>`;
  }
  return `
    <div class="card" style="margin-top:8px;">
      <div class="row2">
        <div class="field"><label>Datum</label><input class="input" type="date" id="newCigarNakupDatum" value="${new Date().toISOString().slice(0,10)}"></div>
        <div class="field"><label>Počet ks</label><input class="input" type="number" id="newCigarNakupPocet" placeholder="7"></div>
      </div>
      <div class="row2">
        <div class="field"><label>Cena/ks</label><input class="input" type="number" id="newCigarNakupCenaKs"></div>
        <div class="field"><label>Cena celkem</label><input class="input" type="number" id="newCigarNakupCenaCelkem"></div>
      </div>
      <div class="btn-row">
        <button class="btn btn-primary btn-sm" onclick="addCigarNakup()">Přidat nákup</button>
        <button class="btn btn-ghost btn-sm" onclick="ui.cigarShowNakupForm=false; renderCigarDetail();">Zpět</button>
      </div>
    </div>`;
}

async function addCigarNakup() {
  try {
    if (!hasPerm(PERM_SPRAVCI)) return;
    const cigar = state.cigars.find(c => c.id === ui.detailCigarId);
    if (!cigar) return;
    const datum = document.getElementById('newCigarNakupDatum').value;
    const pocet = Number(document.getElementById('newCigarNakupPocet').value) || 0;
    if (!pocet) { toast('Zadej počet kusů'); return; }
    const cenaKs = Number(document.getElementById('newCigarNakupCenaKs').value) || null;
    const cenaCelkem = Number(document.getElementById('newCigarNakupCenaCelkem').value) || null;
    const nakupy = [...(cigar.nakupy || []), { datum, pocet, cena_ks: cenaKs, cena_celkem: cenaCelkem }];
    await db.collection('cigars').doc(cigar.id).update({ nakupy });
    ui.cigarShowNakupForm = false;
    toast('Nákup přidán', 'ok');
    logChange('Přidán nákup doutníků', `${cigar.vyrobce}${cigar.model ? ' – ' + cigar.model : ''} (${pocet} ks)`);
    renderCigarDetail();

  } catch (e) {
    console.error('addCigarNakup:', e);
    toast('Uložení se nezdařilo, zkus to znovu.');
  }
}

function renderCigarDetail() {
  const cigar = state.cigars.find(c => c.id === ui.detailCigarId);
  if (!cigar) { closeCigarDetail(); return; }
  const koupeno = cigarKoupeno(cigar);
  const logs = cigarLogSorted(cigar.id);
  const vykoureno = logs.length;
  const zbyva = koupeno - vykoureno;
  const cenaKs = cigarLatestCenaKs(cigar);
  const zbyvaClass = zbyva <= 0 ? 'score-none' : (zbyva <= 2 ? 'score-mid' : 'score-good');

  const html = `
    <div class="sheet-head">
      <div>
        <h2 style="font-family:var(--font-display);font-weight:600;font-size:1.6rem;margin:0;">${esc(cigar.vyrobce)}</h2>
        ${cigar.model ? `<div style="font-size:16px;font-weight:500;color:var(--ink-soft);margin-top:3px;">${esc(cigar.model)}</div>` : ''}
      </div>
      <button class="sheet-close" onclick="closeCigarDetail()" aria-label="Zavřít">×</button>
    </div>
    ${cigar.foto ? `<img src="${esc(cigar.foto)}" alt="Fotka: ${esc(cigar.vyrobce)}" class="rum-foto" loading="lazy" decoding="async" onerror="this.style.display='none';">` : ''}
    <div style="text-align:center; margin: 10px 0 18px;">
      <div class="num ${zbyvaClass}" style="font-family:var(--font-display);font-weight:700;font-size:2.2rem;">${zbyva}</div>
      <div class="muted" style="font-size:12px;">zbývá ks z ${koupeno} nakoupených${cenaKs ? ' · ' + Math.round(cenaKs) + ' Kč/ks' : ''}</div>
    </div>

    <div class="stat-section-title" style="margin-top:4px;">Nákupy</div>
    ${cigar.nakupy && cigar.nakupy.length ? cigar.nakupy.map(n => `
      <div class="stat-row">
        <span class="stat-row-main">${esc(n.datum || '')} · ${esc(String(n.pocet || 0))} ks</span>
        <span class="stat-row-sub">${n.cena_celkem ? esc(String(n.cena_celkem)) + ' Kč celkem' : ''}${n.cena_ks ? ' (' + esc(String(n.cena_ks)) + ' Kč/ks)' : ''}</span>
      </div>
    `).join('') : '<div class="empty-note" style="padding:14px 0;">Zatím žádný nákup.</div>'}
    ${hasPerm(PERM_SPRAVCI) ? renderCigarNakupFormHtml() : ''}

    <div class="stat-section-title">Kouření</div>
    ${logs.length ? logs.map(l => renderCigarLogRowHtml(l)).join('') : '<div class="empty-note" style="padding:14px 0;">Zatím nikdo nekouřil.</div>'}
    ${isGuest ? '' : renderCigarLogFormHtml()}

    ${hasPerm(PERM_SPRAVCI) ? `
    <div class="muted" style="font-size:12px;margin-top:16px;margin-bottom:2px;">${cigar.foto ? 'Změnit fotku' : 'Přidat fotku'}</div>
    ${fotoButtonsHtml(`uploadCigarFoto('${cigar.id}', this.files[0])`)}
    ${cigar.foto ? `<div class="btn-row" style="margin-top:6px;">
      <button class="btn btn-ghost btn-sm" onclick="recropCigarFoto('${cigar.id}')">✂️ Oříznout</button>
      <button class="btn btn-ghost btn-sm" onclick="removeCigarFoto('${cigar.id}')">Smazat fotku</button>
    </div>` : ''}
    ` : ''}

    <div class="btn-row" style="margin-top:18px;">
      <button class="btn btn-ghost" onclick="closeCigarDetail()">← Zpět</button>
    </div>
    ${hasPerm(PERM_SPRAVCI) ? `
    <div class="btn-row" style="margin-top:8px;">
      <button class="btn btn-danger btn-sm" onclick="deleteCigar('${cigar.id}')">Smazat doutník</button>
    </div>
    ` : ''}
  `;
  document.getElementById('cigarDetailSheet').innerHTML = html;
}

async function deleteCigar(cigarId) {
  try {
    if (!hasPerm(PERM_SPRAVCI)) return;
    const cigar = state.cigars.find(c => c.id === cigarId);
    if (!cigar) return;
    const relatedLog = state.cigarLog.filter(l => l.cigarId === cigarId);
    const warn = relatedLog.length
      ? `Opravdu smazat doutník "${cigar.vyrobce}${cigar.model ? ' – ' + cigar.model : ''}"? Smaže se i všech ${relatedLog.length} záznamů o kouření.`
      : `Opravdu smazat doutník "${cigar.vyrobce}${cigar.model ? ' – ' + cigar.model : ''}"?`;
    if (!confirm(warn)) return;
    const batch = db.batch();
    batch.delete(db.collection('cigars').doc(cigarId));
    relatedLog.forEach(l => batch.delete(db.collection('cigar_log').doc(l.id)));
    await batch.commit();
    closeCigarDetail();
    toast('Doutník smazán', 'ok');
    logChange('Smazán doutník', `${cigar.vyrobce}${cigar.model ? ' – ' + cigar.model : ''}${relatedLog.length ? ' (+' + relatedLog.length + ' záznamů)' : ''}`);

  } catch (e) {
    console.error('deleteCigar:', e);
    toast('Uložení se nezdařilo, zkus to znovu.');
  }
}

/* ---------------- TERMINY tab ---------------- */
const TERMIN_MEMBER_ORDER = ['Libor', 'Tomáš', 'Tonda', 'Broněk', 'Jirka', 'Mirek'];

function sortedTerminUcastnici() {
  return state.terminUcastnici.slice().sort((a, b) => {
    const ia = TERMIN_MEMBER_ORDER.indexOf(a.jmeno), ib = TERMIN_MEMBER_ORDER.indexOf(b.jmeno);
    const ra = ia === -1 ? TERMIN_MEMBER_ORDER.length : ia;
    const rb = ib === -1 ? TERMIN_MEMBER_ORDER.length : ib;
    return ra !== rb ? ra - rb : (a.jmeno || '').localeCompare(b.jmeno || '', 'cs');
  });
}

function formatDatumCz(iso) {
  if (!iso) return '';
  const DNY = ['Ne', 'Po', 'Út', 'St', 'Čt', 'Pá', 'So'];
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return iso;
  return `${DNY[d.getDay()]} ${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;
}

function icsAddOneDayUtc(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

function downloadTerminIcs(koloId) {
  const kolo = state.terminKola.find(k => k.id === koloId);
  if (!kolo || !kolo.vybrano) { toast('Termín ještě není vybraný'); return; }
  const dtStart = kolo.vybrano.replace(/-/g, '');
  const dtEnd = icsAddOneDayUtc(kolo.vybrano).replace(/-/g, '');
  const dtStamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const isDoutnik = ui.typ === 'doutnik';
  const summary = isDoutnik ? 'Degustace doutníků' : 'Degustace rumů';
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Degustacni klub//cs',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    'UID:termin-' + koloId + '@degustacniklub',
    'DTSTAMP:' + dtStamp,
    'DTSTART;VALUE=DATE:' + dtStart,
    'DTEND;VALUE=DATE:' + dtEnd,
    'SUMMARY:' + summary,
    'DESCRIPTION:Domluvený termín degustace v appce Degustační klub. Přesný čas si dohodněte s klubem\\, tady je jen datum.',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `degustace-${kolo.vybrano}.ics`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function terminRespClass(val) {
  if (val === 'A') return 'resp-a';
  if (val === 'N') return 'resp-n';
  if (val) return 'resp-maybe';
  return 'resp-empty';
}

function terminRespLabel(jmeno, val) {
  if (!val) return jmeno + ': –';
  if (val === 'A' || val === 'N') return jmeno + ': ' + val;
  return jmeno + ': ' + val;
}

function koloSummary(kolo) {
  const datumy = [...(kolo.datumy || [])].sort();
  if (datumy.length === 0) return '';
  return datumy.length === 1 ? formatDatumCz(datumy[0]) : formatDatumCz(datumy[0]) + ' – ' + formatDatumCz(datumy[datumy.length - 1]);
}

function renderTerminy() {
  const list = document.getElementById('koloList');
  const rows = [...state.terminKola].sort((a, b) => (b._seq || 0) - (a._seq || 0));
  renderNewKoloSection();
  renderTerminUcastniciSection();
  if (rows.length === 0) {
    list.innerHTML = '<div class="empty-note">Zatím žádné kolo domlouvání termínu.</div>';
    return;
  }
  list.innerHTML = rows.map(k => {
    const statusHtml = k.vybrano
      ? `<span class="origin-badge" style="background:var(--good-soft);color:var(--good);border-color:var(--good);">✅ ${esc(formatDatumCz(k.vybrano))}</span>`
      : `<span class="origin-badge">⏳ bez rozhodnutí</span>`;
    return `
    <div class="card rum-card" onclick="openKoloDetail('${k.id}')">
      <div class="rum-main">
        <div class="rum-name">${esc(koloSummary(k))}</div>
        <div class="rum-sub">${(k.datumy || []).length} termínů ke zvážení</div>
      </div>
      <div style="display:flex; align-items:center; gap:6px;">
        ${statusHtml}
        ${k.vybrano ? `<button class="btn btn-ghost btn-sm" style="flex-shrink:0;" onclick="event.stopPropagation(); downloadTerminIcs('${k.id}')" title="Přidat do kalendáře" aria-label="Přidat termín do kalendáře">📅</button>` : ''}
      </div>
    </div>
  `;
  }).join('');
}

function renderNewKoloSection() {
  const el = document.getElementById('newKoloSection');
  const slot = document.getElementById('newKoloBtnSlot');
  if (!el) return;
  if (!hasPerm(PERM_SPRAVCI)) { el.innerHTML = ''; el.style.display = 'none'; if (slot) slot.innerHTML = ''; return; }
  if (!ui.showNewKoloTerminy) {
    if (slot) slot.innerHTML = `<button class="btn btn-ghost btn-sm" style="white-space:nowrap;" onclick="ui.showNewKoloTerminy=true; ui.newKoloDatumy=['','']; renderNewKoloSection();">+ Nové kolo</button>`;
    el.innerHTML = '';
    el.style.display = 'none';
    return;
  }
  if (slot) slot.innerHTML = '';
  el.style.display = '';
  el.innerHTML = `
    <div class="field"><label>Navrhované termíny</label>
      ${ui.newKoloDatumy.map((d, i) => `<input class="input" type="date" style="margin-bottom:6px;" value="${esc(d)}" oninput="ui.newKoloDatumy[${i}]=this.value;">`).join('')}
    </div>
    <div class="btn-row" style="margin-top:2px;">
      <button class="btn btn-ghost btn-sm" onclick="ui.newKoloDatumy.push(''); renderNewKoloSection();">+ Přidat další datum</button>
    </div>
    <div class="btn-row" style="margin-top:8px;">
      <button class="btn btn-primary btn-sm" onclick="createNewKolo()">Vytvořit kolo</button>
      <button class="btn btn-ghost btn-sm" onclick="ui.showNewKoloTerminy=false; renderNewKoloSection();">Zpět</button>
    </div>`;
}

async function createNewKolo() {
  try {
    if (!hasPerm(PERM_SPRAVCI)) return;
    const datumy = [...new Set(ui.newKoloDatumy.filter(d => d))].sort();
    if (datumy.length === 0) { toast('Zadej aspoň jeden termín'); return; }
    await db.collection('termin_kola').add({ datumy, odpovedi: {}, vybrano: null, poznamka: '', _seq: Date.now() });
    ui.showNewKoloTerminy = false;
    toast('Kolo vytvořeno');
    logChange('Vytvořeno kolo termínů', datumy.join(', '));

  } catch (e) {
    console.error('createNewKolo:', e);
    toast('Uložení se nezdařilo, zkus to znovu.');
  }
}

function renderTerminUcastniciSection() {
  const el = document.getElementById('terminUcastniciSection');
  if (!el) return;
  if (isGuest) { el.innerHTML = ''; return; }
  const ucastnici = sortedTerminUcastnici();
  let html = `<div class="rum-name" style="margin-bottom:8px;">Účastníci domlouvání</div>`;
  html += `<div class="member-chips">${ucastnici.map(u => `<span class="member-chip">${esc(u.jmeno)}</span>`).join('')}</div>`;
  if (hasPerm(PERM_SPRAVCI)) {
    if (!ui.showTerminUcastnikForm) {
      html += `<button class="btn btn-ghost btn-sm" style="margin-top:10px;" onclick="ui.showTerminUcastnikForm=true; renderTerminUcastniciSection();">+ Přidat účastníka</button>`;
    } else {
      html += `
        <div style="display:flex; gap:8px; margin-top:10px;">
          <input class="input" id="newTerminUcastnikJmeno" placeholder="Jméno">
          <button class="btn btn-primary btn-sm" onclick="addTerminUcastnik()" style="flex-shrink:0;">Přidat</button>
        </div>
        <div class="btn-row" style="margin-top:8px;"><button class="btn btn-ghost btn-sm" onclick="ui.showTerminUcastnikForm=false; renderTerminUcastniciSection();">Zpět</button></div>
      `;
    }
  }
  el.innerHTML = html;
}

async function addTerminUcastnik() {
  try {
    if (!hasPerm(PERM_SPRAVCI)) return;
    const jmeno = document.getElementById('newTerminUcastnikJmeno').value.trim();
    if (!jmeno) return;
    await db.collection('termin_ucastnici').add({ jmeno });
    ui.showTerminUcastnikForm = false;
    toast('Účastník přidán', 'ok');
    logChange('Přidán účastník termínů', jmeno);

  } catch (e) {
    console.error('addTerminUcastnik:', e);
    toast('Uložení se nezdařilo, zkus to znovu.');
  }
}

function openKoloDetail(koloId) {
  ui.detailKoloId = koloId;
  renderKoloDetail();
  document.getElementById('koloDetailOverlay').hidden = false;
}
function closeKoloDetail() { document.getElementById('koloDetailOverlay').hidden = true; }

async function toggleTerminResponse(koloId, jmeno, datum) {
  try {
    if (isGuest) return;
    const kolo = state.terminKola.find(k => k.id === koloId);
    if (!kolo) return;
    const current = (kolo.odpovedi && kolo.odpovedi[jmeno]) ? kolo.odpovedi[jmeno][datum] : undefined;
    const cycle = { undefined: 'A', '': 'A', 'A': 'N', 'N': '?', '?': null };
    const next = Object.prototype.hasOwnProperty.call(cycle, current) ? cycle[current] : 'A';
    const path = `odpovedi.${jmeno}.${datum}`;
    await db.collection('termin_kola').doc(koloId).update({ [path]: next });

  } catch (e) {
    console.error('toggleTerminResponse:', e);
    toast('Uložení se nezdařilo, zkus to znovu.');
  }
}

async function setKoloVybrano(koloId, datum) {
  try {
    if (!hasPerm(PERM_SPRAVCI)) return;
    await db.collection('termin_kola').doc(koloId).update({ vybrano: datum });
    if (datum) {
      try { await syncUcastFromKolo(koloId, datum); } catch (e) { console.error('Sync účasti z termínu selhal:', e); }
    }
    toast(datum ? 'Termín vybrán' : 'Výběr zrušen');
    const kolo = state.terminKola.find(k => k.id === koloId);
    logChange(datum ? 'Vybrán termín' : 'Zrušen vybraný termín', datum ? formatDatumCz(datum) : (kolo ? koloSummary(kolo) : koloId));

  } catch (e) {
    console.error('setKoloVybrano:', e);
    toast('Uložení se nezdařilo, zkus to znovu.');
  }
}

async function addKoloDatum(koloId) {
  try {
    if (!hasPerm(PERM_SPRAVCI)) return;
    const input = document.getElementById('newKoloDetailDatum');
    const datum = input.value;
    if (!datum) { toast('Vyber datum'); return; }
    const kolo = state.terminKola.find(k => k.id === koloId);
    const datumy = [...new Set([...(kolo && kolo.datumy || []), datum])].sort();
    await db.collection('termin_kola').doc(koloId).update({ datumy });
    input.value = '';

  } catch (e) {
    console.error('addKoloDatum:', e);
    toast('Uložení se nezdařilo, zkus to znovu.');
  }
}

async function removeKoloDatum(koloId, datum) {
  try {
    if (!confirm('Odebrat tenhle termín z nabídky?')) return;
    const kolo = state.terminKola.find(k => k.id === koloId);
    const updates = { datumy: firebase.firestore.FieldValue.arrayRemove(datum) };
    if (kolo && kolo.vybrano === datum) updates.vybrano = null;
    await db.collection('termin_kola').doc(koloId).update(updates);

  } catch (e) {
    console.error('removeKoloDatum:', e);
    toast('Uložení se nezdařilo, zkus to znovu.');
  }
}

async function deleteKolo(koloId) {
  try {
    if (!hasPerm(PERM_SPRAVCI)) return;
    if (!confirm('Opravdu smazat celé tohle kolo domlouvání termínu?')) return;
    await db.collection('termin_kola').doc(koloId).delete();
    closeKoloDetail();
    toast('Kolo smazáno', 'ok');
    logChange('Smazáno kolo termínů', koloId);

  } catch (e) {
    console.error('deleteKolo:', e);
    toast('Uložení se nezdařilo, zkus to znovu.');
  }
}

function renderKoloDetail() {
  const kolo = state.terminKola.find(k => k.id === ui.detailKoloId);
  if (!kolo) { closeKoloDetail(); return; }
  const ucastnici = sortedTerminUcastnici();
  const datumy = [...(kolo.datumy || [])].sort();
  // jednorázově srovnat i uložené pořadí datumů (starší kola mohla mít termín přidaný na konec)
  if (hasPerm(PERM_SPRAVCI) && db && JSON.stringify(datumy) !== JSON.stringify(kolo.datumy || [])) {
    db.collection('termin_kola').doc(kolo.id).update({ datumy }).catch(() => {});
  }

  const html = `
    <div class="sheet-head">
      <h2 style="font-family:var(--font-display);font-weight:600;font-size:1.5rem;margin:0;">Kolo termínů</h2>
      <button class="sheet-close" onclick="closeKoloDetail()" aria-label="Zavřít">×</button>
    </div>
    ${kolo.vybrano ? `
    <div class="card" style="margin-bottom:10px; background:var(--good-soft); border-color:var(--good);">
      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">
        <span>✅ Vybraný termín: <b>${esc(formatDatumCz(kolo.vybrano))}</b></span>
        <button class="btn btn-ghost btn-sm" onclick="downloadTerminIcs('${kolo.id}')">📅 Do kalendáře</button>
      </div>
    </div>
    ` : ''}
    ${datumy.map(datum => {
      const isVybrano = kolo.vybrano === datum;
      const chips = ucastnici.map(u => {
        const val = (kolo.odpovedi && kolo.odpovedi[u.jmeno]) ? kolo.odpovedi[u.jmeno][datum] : null;
        const cls = terminRespClass(val);
        const click = isGuest ? '' : ` onclick="toggleTerminResponse('${kolo.id}','${esc(u.jmeno).replace(/'/g,"\\'")}','${datum}')"`;
        return `<button class="member-chip termin-chip ${cls}"${click}>${esc(terminRespLabel(u.jmeno, val))}</button>`;
      }).join('');
      return `
      <div class="card" style="margin-bottom:8px;${isVybrano ? 'border-color:var(--good);' : ''}">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
          <b>${esc(formatDatumCz(datum))}</b>
          ${isGuest ? (isVybrano ? '<span class="origin-badge" style="background:var(--good-soft);color:var(--good);border-color:var(--good);">✅ vybráno</span>' : '') : `
            <div style="display:flex; gap:6px;">
              ${hasPerm(PERM_SPRAVCI)
                ? (isVybrano
                    ? `<button class="btn btn-ghost btn-sm" onclick="setKoloVybrano('${kolo.id}', null)">✅ vybráno (zrušit)</button>`
                    : `<button class="btn btn-ghost btn-sm" onclick="setKoloVybrano('${kolo.id}', '${datum}')">Vybrat</button>`)
                : (isVybrano ? '<span class="origin-badge" style="background:var(--good-soft);color:var(--good);border-color:var(--good);">✅ vybráno</span>' : '')}
              <button class="btn btn-danger btn-sm" onclick="removeKoloDatum('${kolo.id}', '${datum}')">×</button>
            </div>
          `}
        </div>
        <div class="member-chips" style="margin-top:8px;">${chips}</div>
      </div>
    `;
    }).join('')}
    ${hasPerm(PERM_SPRAVCI) ? `
    <div class="field" style="margin-top:4px;">
      <label>Přidat další navrhovaný termín</label>
      <div style="display:flex; gap:8px;">
        <input class="input" type="date" id="newKoloDetailDatum">
        <button class="btn btn-primary btn-sm" onclick="addKoloDatum('${kolo.id}')" style="flex-shrink:0;">Přidat</button>
      </div>
    </div>
    ` : ''}
    <div class="btn-row" style="margin-top:18px;">
      <button class="btn btn-ghost" onclick="closeKoloDetail()">← Zpět</button>
    </div>
    ${hasPerm(PERM_SPRAVCI) ? `
    <div class="btn-row" style="margin-top:8px;">
      <button class="btn btn-danger" onclick="deleteKolo('${kolo.id}')">Smazat kolo</button>
    </div>
    ` : ''}
  `;
  document.getElementById('koloDetailSheet').innerHTML = html;
}

/* ---------------- UCAST tab ---------------- */
const UCAST_KNOWN_PEOPLE = ['Libor', 'Tomáš', 'Tonda', 'Broněk', 'Jirka', 'Mirek', 'Michal'];

function sortedUcasti() {
  return state.ucasti.slice().sort((a, b) => (b.datum || '').localeCompare(a.datum || ''));
}

function renderUcast() {
  const list = document.getElementById('ucastList');
  renderNewUcastSection();
  const rows = sortedUcasti();
  if (rows.length === 0) {
    list.innerHTML = '<div class="empty-note">Zatím žádná evidovaná účast.</div>';
    return;
  }
  list.innerHTML = rows.map(u => {
    const lidi = u.ucastnici || [];
    const zdrojBadge = u.zdrojKoloId ? `<span class="origin-badge">🗓️ z termínu</span>` : '';
    return `
    <div class="card rum-card" onclick="openUcastDetail('${u.id}')">
      <div class="rum-main">
        <div class="rum-name">${esc(formatDatumCz(u.datum))}${u.misto ? ' · ' + esc(u.misto) : ''}</div>
        <div class="rum-sub">${lidi.length} účastníků${lidi.length ? ': ' + esc(lidi.join(', ')) : ''}</div>
      </div>
      <div>${zdrojBadge}</div>
    </div>
  `;
  }).join('');
}

function renderNewUcastSection() {
  const el = document.getElementById('newUcastSection');
  if (!el) return;
  if (!hasPerm(PERM_SPRAVCI)) { el.innerHTML = ''; return; }
  if (!ui.showNewUcast) {
    el.innerHTML = `<button class="btn btn-ghost btn-sm" onclick="ui.showNewUcast=true; ui.newUcastDatum=''; ui.newUcastMisto=''; ui.newUcastLidi=[]; ui.newUcastDalsi=''; renderNewUcastSection();">+ Nová účast</button>`;
    return;
  }
  el.innerHTML = `
    <div class="field"><label>Datum</label>
      <input class="input" type="date" value="${esc(ui.newUcastDatum)}" oninput="ui.newUcastDatum=this.value;">
    </div>
    <div class="field"><label>Místo</label>
      <input class="input" list="ucastMistoOptions" value="${esc(ui.newUcastMisto)}" oninput="ui.newUcastMisto=this.value;" placeholder="Ostrožská Lhota / Staré Město">
      <datalist id="ucastMistoOptions"><option value="Ostrožská Lhota"><option value="Staré Město"></datalist>
    </div>
    <div class="field"><label>Účastníci</label>
      <div class="member-chips">
        ${UCAST_KNOWN_PEOPLE.map(jm => `<button type="button" class="member-chip ${ui.newUcastLidi.includes(jm) ? 'active' : ''}" onclick="toggleNewUcastOsoba('${jm}')">${esc(jm)}</button>`).join('')}
      </div>
    </div>
    <div class="field"><label>Další (host, oddělit čárkou)</label>
      <input class="input" value="${esc(ui.newUcastDalsi)}" oninput="ui.newUcastDalsi=this.value;" placeholder="např. Petr">
    </div>
    <div class="btn-row" style="margin-top:8px;">
      <button class="btn btn-primary btn-sm" onclick="createNewUcast()">Uložit účast</button>
      <button class="btn btn-ghost btn-sm" onclick="ui.showNewUcast=false; renderNewUcastSection();">Zpět</button>
    </div>
  `;
}

function toggleNewUcastOsoba(jmeno) {
  const i = ui.newUcastLidi.indexOf(jmeno);
  if (i === -1) ui.newUcastLidi.push(jmeno); else ui.newUcastLidi.splice(i, 1);
  renderNewUcastSection();
}

async function createNewUcast() {
  try {
    if (!hasPerm(PERM_SPRAVCI)) return;
    if (!ui.newUcastDatum) { toast('Vyber datum'); return; }
    const dalsi = ui.newUcastDalsi.split(',').map(s => s.trim()).filter(Boolean);
    const ucastnici = [...ui.newUcastLidi, ...dalsi];
    await db.collection('ucast').add({
      datum: ui.newUcastDatum, misto: ui.newUcastMisto || '', ucastnici, poznamka: '', zdrojKoloId: null, _seq: Date.now(),
    });
    ui.showNewUcast = false;
    toast('Účast uložena', 'ok');
    logChange('Přidána účast', formatDatumCz(ui.newUcastDatum) + (ui.newUcastMisto ? ' · ' + ui.newUcastMisto : ''));

  } catch (e) {
    console.error('createNewUcast:', e);
    toast('Uložení se nezdařilo, zkus to znovu.');
  }
}

function openUcastDetail(ucastId) {
  ui.detailUcastId = ucastId;
  renderUcastDetail();
  document.getElementById('ucastDetailOverlay').hidden = false;
}
function closeUcastDetail() { document.getElementById('ucastDetailOverlay').hidden = true; }

async function updateUcastField(ucastId, field, value) {
  try {
    if (!hasPerm(PERM_SPRAVCI)) return;
    if (isGuest) return;
    await db.collection('ucast').doc(ucastId).update({ [field]: value });
    logChange('Upravena účast', field + ': ' + value);

  } catch (e) {
    console.error('updateUcastField:', e);
    toast('Uložení se nezdařilo, zkus to znovu.');
  }
}

async function toggleUcastOsoba(ucastId, jmeno) {
  try {
    if (!hasPerm(PERM_SPRAVCI)) return;
    if (isGuest) return;
    const u = state.ucasti.find(x => x.id === ucastId);
    if (!u) return;
    const has = (u.ucastnici || []).includes(jmeno);
    await db.collection('ucast').doc(ucastId).update({
      ucastnici: has ? firebase.firestore.FieldValue.arrayRemove(jmeno) : firebase.firestore.FieldValue.arrayUnion(jmeno)
    });

  } catch (e) {
    console.error('toggleUcastOsoba:', e);
    toast('Uložení se nezdařilo, zkus to znovu.');
  }
}

async function addUcastDalsiOsoba(ucastId) {
  try {
    if (!hasPerm(PERM_SPRAVCI)) return;
    const input = document.getElementById('ucastDalsiOsoba');
    const jmeno = input.value.trim();
    if (!jmeno) return;
    await db.collection('ucast').doc(ucastId).update({ ucastnici: firebase.firestore.FieldValue.arrayUnion(jmeno) });
    input.value = '';

  } catch (e) {
    console.error('addUcastDalsiOsoba:', e);
    toast('Uložení se nezdařilo, zkus to znovu.');
  }
}

async function deleteUcast(ucastId) {
  try {
    if (!hasPerm(PERM_SPRAVCI)) return;
    if (!confirm('Opravdu smazat tento záznam účasti?')) return;
    await db.collection('ucast').doc(ucastId).delete();
    closeUcastDetail();
    toast('Účast smazána', 'ok');
    logChange('Smazána účast', ucastId);

  } catch (e) {
    console.error('deleteUcast:', e);
    toast('Uložení se nezdařilo, zkus to znovu.');
  }
}

function renderUcastDetail() {
  const u = state.ucasti.find(x => x.id === ui.detailUcastId);
  if (!u) { closeUcastDetail(); return; }
  const lidi = u.ucastnici || [];
  const extraLidi = lidi.filter(j => !UCAST_KNOWN_PEOPLE.includes(j));
  const canEdit = hasPerm(PERM_SPRAVCI);
  const chips = UCAST_KNOWN_PEOPLE.map(jm => {
    const active = lidi.includes(jm);
    const click = canEdit ? ` onclick="toggleUcastOsoba('${u.id}','${jm}')"` : '';
    return `<button class="member-chip ${active ? 'active' : ''}"${click}>${esc(jm)}</button>`;
  }).join('') + extraLidi.map(jm => {
    const safe = jm.replace(/'/g, "\\'");
    const click = canEdit ? ` onclick="toggleUcastOsoba('${u.id}','${esc(safe)}')"` : '';
    return `<button class="member-chip active"${click}>${esc(jm)}</button>`;
  }).join('');

  const html = `
    <div class="sheet-head">
      <h2 style="font-family:var(--font-display);font-weight:600;font-size:1.5rem;margin:0;">Účast</h2>
      <button class="sheet-close" onclick="closeUcastDetail()" aria-label="Zavřít">×</button>
    </div>
    ${u.zdrojKoloId ? `<div class="origin-badge" style="margin-bottom:10px;">🗓️ vytvořeno automaticky z termínu</div>` : ''}
    <div class="field"><label>Datum</label>
      <input class="input" type="date" value="${esc(u.datum||'')}" ${canEdit?'':'disabled'} onchange="updateUcastField('${u.id}','datum',this.value)">
    </div>
    <div class="field"><label>Místo</label>
      <input class="input" list="ucastMistoOptions" value="${esc(u.misto||'')}" ${canEdit?'':'disabled'} onchange="updateUcastField('${u.id}','misto',this.value)" placeholder="Ostrožská Lhota / Staré Město">
      <datalist id="ucastMistoOptions"><option value="Ostrožská Lhota"><option value="Staré Město"></datalist>
    </div>
    <div class="field"><label>Účastníci</label>
      <div class="member-chips">${chips}</div>
      ${canEdit ? `
      <div style="display:flex; gap:8px; margin-top:8px;">
        <input class="input" id="ucastDalsiOsoba" placeholder="Přidat jiného hosta">
        <button class="btn btn-ghost btn-sm" style="flex-shrink:0;" onclick="addUcastDalsiOsoba('${u.id}')">Přidat</button>
      </div>
      ` : ''}
    </div>
    <div class="field"><label>Poznámka</label>
      <textarea class="input" rows="2" ${canEdit?'':'disabled'} onchange="updateUcastField('${u.id}','poznamka',this.value)">${esc(u.poznamka||'')}</textarea>
    </div>
    <div class="btn-row" style="margin-top:18px;">
      <button class="btn btn-ghost" onclick="closeUcastDetail()">← Zpět</button>
    </div>
    ${hasPerm(PERM_SPRAVCI) ? `
    <div class="btn-row" style="margin-top:8px;">
      <button class="btn btn-danger" onclick="deleteUcast('${u.id}')">Smazat záznam</button>
    </div>
    ` : ''}
  `;
  document.getElementById('ucastDetailSheet').innerHTML = html;
}

async function syncUcastFromKolo(koloId, datum) {
  try {
    if (!datum) return;
    const kolo = state.terminKola.find(k => k.id === koloId);
    const ucastnici = [];
    if (kolo && kolo.odpovedi) {
      Object.keys(kolo.odpovedi).forEach(jmeno => {
        if ((kolo.odpovedi[jmeno] || {})[datum] === 'A') ucastnici.push(jmeno);
      });
    }
    const existingSnap = await db.collection('ucast').where('zdrojKoloId', '==', koloId).limit(1).get();
    if (!existingSnap.empty) {
      await existingSnap.docs[0].ref.update({ datum, ucastnici });
    } else {
      await db.collection('ucast').add({ datum, misto: '', ucastnici, poznamka: '', zdrojKoloId: koloId, _seq: Date.now() });
    }

  } catch (e) {
    console.error('syncUcastFromKolo:', e);
    toast('Uložení se nezdařilo, zkus to znovu.');
  }
}

/* ---------------- STATISTIKA tab ---------------- */
function statTile(val, lbl, small) {
  return `<div class="stat-tile"><div class="val${small?' small':''}">${val}</div><div class="lbl">${lbl}</div></div>`;
}

/* --- pomocné výpočty pro statistiky (čisté funkce) --- */

// Nejlepší položka za každý rok (min. minPerYear hodnocení v daném roce).
// Nej produkt roku – rok bere z pole `datum` u produktu (datum ochutnání).
// Fallback: nejčastější rok z dat jednotlivých hodnocení. Skóre = průměr klubu.
function statBestOfYear(rums, ratings, minPerYear, topN) {
  topN = topN || 3;
  const agg = {};
  ratings.forEach(r => { (agg[r.rumId] = agg[r.rumId] || []).push(Number(r.celkem) || 0); });
  const yearFromRatings = (rumId) => {
    const c = {};
    ratings.forEach(r => {
      if (r.rumId !== rumId) return;
      const y = (r.datum || '').slice(0, 4);
      if (/^\d{4}$/.test(y)) c[y] = (c[y] || 0) + 1;
    });
    return Object.keys(c).sort((a, b) => c[b] - c[a])[0] || '';
  };
  const byYear = {};
  rums.forEach(rum => {
    let y = /^\d{4}/.test(rum.datum || '') ? rum.datum.slice(0, 4) : yearFromRatings(rum.id);
    if (!/^\d{4}$/.test(y)) return;
    const arr = agg[rum.id];
    if (!arr || arr.length < minPerYear) return;
    (byYear[y] = byYear[y] || []).push({ id: rum.id, avg: arr.reduce((s, v) => s + v, 0) / arr.length, count: arr.length });
  });
  return Object.keys(byYear).sort((a, b) => b.localeCompare(a))
    .map(y => ({ rok: y, top: byYear[y].sort((a, b) => b.avg - a.avg).slice(0, topN) }))
    .filter(y => y.top.length);
}

// Shoda vkusu: pro každou dvojici jmen korelace (Pearson) jejich bodů přes položky,
// které hodnotili oba; jen dvojice s ≥ minCommon společnými. Vrací % (−100…100).
function statPairCloseness(ratings, memberNames, minCommon) {
  const byRum = {};
  ratings.forEach(r => {
    if (!memberNames.includes(r.clen)) return;
    (byRum[r.rumId] = byRum[r.rumId] || {})[r.clen] = Number(r.celkem) || 0;
  });
  const out = [];
  for (let i = 0; i < memberNames.length; i++) {
    for (let j = i + 1; j < memberNames.length; j++) {
      const a = memberNames[i], b = memberNames[j];
      const xs = [], ys = [];
      Object.keys(byRum).forEach(id => {
        const m = byRum[id];
        if (m[a] != null && m[b] != null) { xs.push(m[a]); ys.push(m[b]); }
      });
      const n = xs.length;
      if (n < minCommon) continue;
      let sx = 0, sy = 0, sxy = 0, sx2 = 0, sy2 = 0;
      for (let k = 0; k < n; k++) { sx += xs[k]; sy += ys[k]; sxy += xs[k] * ys[k]; sx2 += xs[k] * xs[k]; sy2 += ys[k] * ys[k]; }
      const den = Math.sqrt((n * sx2 - sx * sx) * (n * sy2 - sy * sy));
      const r = den ? (n * sxy - sx * sy) / den : 0;
      out.push({ a, b, common: n, closeness: Math.round(r * 100) });
    }
  }
  return out.sort((x, y) => y.closeness - x.closeness);
}

// Rozpor v hodnocení jedné položky: položky s ≥ minRaters hodnoteními.
function statDisagreement(ratings, minRaters) {
  const byRum = {};
  ratings.forEach(r => { (byRum[r.rumId] = byRum[r.rumId] || []).push(Number(r.celkem) || 0); });
  return Object.keys(byRum).map(id => {
    const arr = byRum[id];
    if (arr.length < minRaters) return null;
    const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
    const sd = Math.sqrt(arr.reduce((s, v) => s + (v - mean) * (v - mean), 0) / arr.length);
    return { id, count: arr.length, min: Math.min(...arr), max: Math.max(...arr), spread: Math.max(...arr) - Math.min(...arr), sd };
  }).filter(Boolean).sort((a, b) => b.spread - a.spread || b.sd - a.sd);
}

// Průměr podle výrobce (pole nazev); jen výrobci s ≥ minRatings hodnoceními.
function statByProducer(rumsSrc, ratings, minRatings) {
  const g = {};
  rumsSrc.forEach(r => {
    const k = r.nazev || 'Neuvedeno';
    (g[k] = g[k] || { items: 0, sum: 0, n: 0 }).items++;
  });
  const rumById = {};
  rumsSrc.forEach(r => { rumById[r.id] = r; });
  ratings.forEach(r => {
    const rum = rumById[r.rumId];
    const k = rum ? (rum.nazev || 'Neuvedeno') : 'Neuvedeno';
    g[k] = g[k] || { items: 0, sum: 0, n: 0 };
    g[k].sum += Number(r.celkem) || 0; g[k].n++;
  });
  return Object.keys(g).map(k => ({ vyrobce: k, items: g[k].items, count: g[k].n, avg: g[k].n ? g[k].sum / g[k].n : 0 }))
    .filter(x => x.count >= minRatings).sort((a, b) => b.avg - a.avg);
}

// Poměr cena / průměrné skóre (Kč za bod), vzestupně (nejlepší poměr první).
function statValueForMoney(rumsSrc, ratings) {
  const byRum = {};
  ratings.forEach(r => { (byRum[r.rumId] = byRum[r.rumId] || []).push(Number(r.celkem) || 0); });
  return rumsSrc.filter(r => r.cena && byRum[r.id] && byRum[r.id].length).map(r => {
    const arr = byRum[r.id];
    const avg = arr.reduce((s, v) => s + v, 0) / arr.length;
    return { id: r.id, cena: Number(r.cena), avg, count: arr.length, kcPerBod: Number(r.cena) / avg };
  }).sort((a, b) => a.kcPerBod - b.kcPerBod);
}

// Kumulativní průměr člena po měsících (hladší než měsíční průměr).
function statMemberTimeline(ratings, memberNames, minRatings) {
  const dated = ratings.filter(r => /^\d{4}-\d{2}/.test(r.datum || ''));
  const months = [...new Set(dated.map(r => r.datum.slice(0, 7)))].sort();
  const series = [];
  memberNames.forEach(name => {
    const mine = dated.filter(r => r.clen === name).sort((a, b) => a.datum.localeCompare(b.datum));
    if (mine.length < minRatings) return;
    let sum = 0, n = 0, k = 0;
    const pts = months.map(mo => {
      while (k < mine.length && mine[k].datum.slice(0, 7) <= mo) { sum += Number(mine[k].celkem) || 0; n++; k++; }
      return n ? Math.round((sum / n) * 10) / 10 : null;
    });
    series.push({ name, pts });
  });
  return { months, series };
}

function renderStatistika() {
  const memberSel = document.getElementById('statMemberFilter');
  const originSel = document.getElementById('statOriginFilter');
  if (!memberSel || !originSel) return;

  const isDoutnik = ui.typ === 'doutnik';
  const rumsSrc = state.rums.filter(r => (r.typ||'rum') === ui.typ);
  const ratingsSrc = isDoutnik ? state.cigarRatings : state.ratings;
  const wordJedn = isDoutnik ? 'doutník' : 'rum';
  const wordMnoz = isDoutnik ? 'doutníků' : 'rumů';

  const activeMembers = [...state.members].filter(m=>m.aktivni!==false).sort((a,b) => {
    const ia = CLUB_MEMBER_ORDER.indexOf(a.jmeno), ib = CLUB_MEMBER_ORDER.indexOf(b.jmeno);
    const ra = ia === -1 ? CLUB_MEMBER_ORDER.length : ia;
    const rb = ib === -1 ? CLUB_MEMBER_ORDER.length : ib;
    return ra !== rb ? ra - rb : a.jmeno.localeCompare(b.jmeno, 'cs');
  });
  if (!activeMembers.some(m => m.jmeno === ui.statMember)) ui.statMember = 'vse';
  memberSel.innerHTML = '<option value="vse">Kdo: Všichni</option>' +
    activeMembers.map(m => `<option value="${esc(m.jmeno)}" ${ui.statMember===m.jmeno?'selected':''}>${esc(m.jmeno)}</option>`).join('');

  const origins = [...new Set(rumsSrc.flatMap(r=>puvodList(r)))].sort((a,b)=>a.localeCompare(b,'cs'));
  if (ui.statOrigin !== 'vse' && !origins.includes(ui.statOrigin)) ui.statOrigin = 'vse';
  originSel.innerHTML = '<option value="vse">Všechny země</option>' +
    origins.map(o => `<option value="${esc(o)}" ${ui.statOrigin===o?'selected':''}>Jen ${esc(o)}</option>`).join('');

  const rumIdsByOrigin = ui.statOrigin === 'vse' ? null : new Set(rumsSrc.filter(r=>puvodList(r).includes(ui.statOrigin)).map(r=>r.id));
  const originRatings = rumIdsByOrigin ? ratingsSrc.filter(r=>rumIdsByOrigin.has(r.rumId)) : ratingsSrc;
  const filteredRatings = ui.statMember === 'vse' ? originRatings : originRatings.filter(r=>r.clen===ui.statMember);

  const rumLabel = (id) => { const rum = rumsSrc.find(x=>x.id===id); return rum ? esc(rum.nazev)+(rum.znacka?' – '+esc(rum.znacka):'') : '?'; };

  const totalCount = filteredRatings.length;
  const avgScore = totalCount ? (filteredRatings.reduce((s,r)=>s+Number(r.celkem||0),0)/totalCount).toFixed(1) : '–';
  const distinctRums = new Set(filteredRatings.map(r=>r.rumId)).size;
  let best = null, worst = null;
  filteredRatings.forEach(r => {
    if (!best || r.celkem > best.celkem) best = r;
    if (!worst || r.celkem < worst.celkem) worst = r;
  });

  let html = '';
  if (currentUser) {
    const mine = ratingsSrc.filter(r => r.clen === currentUser);
    html += '<div class="stat-section-title">Moje statistika</div>';
    if (mine.length === 0) {
      html += `<div class="empty-note">Zatím jsi nic neohodnotil${isDoutnik?'':'a'}.</div>`;
    } else {
      const myAvg = (mine.reduce((s,r)=>s+Number(r.celkem||0),0)/mine.length).toFixed(1);
      const myDistinct = new Set(mine.map(r=>r.rumId)).size;
      const myFavorite = mine.reduce((b,r) => (!b || r.celkem > b.celkem) ? r : b, null);
      html += '<div class="stat-grid">';
      html += statTile(mine.length, 'mých hodnocení');
      html += statTile(myAvg, 'můj průměr', true);
      html += statTile(myDistinct, (isDoutnik?wordMnoz:wordMnoz) + ' ochutnáno', true);
      html += '</div>';
      if (myFavorite) html += `<div class="muted" style="font-size:12px;margin-top:8px;">Můj oblíbený ${wordJedn}: <b>${rumLabel(myFavorite.rumId)}</b> (${myFavorite.celkem} b.)</div>`;
    }
    html += '<div class="stat-section-title">Klub celkem</div>';
  }

  html += '<div class="stat-grid">';
  html += statTile(totalCount, 'hodnocení');
  html += statTile(avgScore, 'průměr skóre');
  html += statTile(distinctRums, wordMnoz + ' ochutnáno');
  html += statTile(best ? best.celkem : '–', 'nejlepší skóre', true);
  html += statTile(worst ? worst.celkem : '–', 'nejhorší skóre', true);
  html += '</div>';
  if (best) html += `<div class="muted" style="font-size:12px;margin-top:8px;">Nejlépe hodnoceno: <b>${rumLabel(best.rumId)}</b> (${esc(best.clen)}, ${best.celkem} b.)</div>`;
  if (worst && worst !== best) html += `<div class="muted" style="font-size:12px;margin-top:2px;">Nejhůře hodnoceno: <b>${rumLabel(worst.rumId)}</b> (${esc(worst.clen)}, ${worst.celkem} b.)</div>`;

  // --- Nejlepší za rok ---
  const nyni = String(new Date().getFullYear());
  const roky_rums = rumIdsByOrigin ? rumsSrc.filter(r => rumIdsByOrigin.has(r.id)) : rumsSrc;
  const roky = statBestOfYear(roky_rums, originRatings, 2, 3).slice(0, 3);
  const bezData = roky_rums.filter(r => !/^\d{4}/.test(r.datum || '')).length;
  html += `<div class="stat-section-title">Nej ${wordJedn} roku</div>`;
  html += roky.length ? roky.map(y =>
    `<div class="stat-year-head">${y.rok === nyni ? '★ ' : ''}${y.rok}</div>` +
    y.top.map((t, i) =>
      `<div class="stat-row"><span class="stat-row-main"><span class="rank-badge rank-${i + 1}">${i + 1}.</span>${rumLabel(t.id)}</span><span class="stat-row-sub">Ø ${t.avg.toFixed(1)} · ${t.count} hodn.</span></div>`
    ).join('')
  ).join('') : `<div class="empty-note">Zatím málo dat – ${wordMnoz} chybí datum ochutnání.</div>`;
  if (bezData) html += `<div class="muted" style="font-size:11.5px;margin-top:6px;">${bezData} ${wordMnoz} bez data ochutnání se do žebříčku nepočítá. Doplň v Info → „Doplnit datum ochutnání".</div>`;

  // --- Nejlepší poměr cena/kvalita ---
  const valRanked = roky_rums.map(r => {
    const st = isDoutnik ? cigarStats(r.id) : rumStats(r.id);
    return (Number(r.cena) > 0 && st && st.count >= 2)
      ? { id: r.id, cena: Number(r.cena), avg: st.celkem }
      : null;
  }).filter(Boolean).sort((a, b) => (b.avg / b.cena) - (a.avg / a.cena)).slice(0, 6);
  if (valRanked.length) {
    html += `<div class="stat-section-title">Nejlepší poměr cena / hodnocení</div>`;
    html += valRanked.map((v, i) =>
      `<div class="stat-row"><span class="stat-row-main"><span class="rank-badge rank-${i + 1}">${i + 1}.</span>${rumLabel(v.id)}</span><span class="stat-row-sub">Ø ${v.avg.toFixed(1)} · ${v.cena} Kč</span></div>`
    ).join('');
    const bezCeny = roky_rums.filter(r => !(Number(r.cena) > 0)).length;
    if (bezCeny) html += `<div class="muted" style="font-size:11.5px;margin-top:6px;">${bezCeny} ${wordMnoz} bez ceny se nepočítá. Doplň v Info → „Doplnit ceny".</div>`;
  }

  html += '<div class="stat-section-title">Žebříček členů</div>';
  const memberRows = activeMembers.map(m => {
    const rs = originRatings.filter(r=>r.clen===m.jmeno);
    const avg = rs.length ? (rs.reduce((s,r)=>s+Number(r.celkem||0),0)/rs.length).toFixed(1) : '–';
    return { jmeno: m.jmeno, count: rs.length, avg };
  }).sort((a,b) => b.count - a.count);
  html += memberRows.length ? memberRows.map(m =>
    `<div class="stat-row"><span class="stat-row-main">${esc(m.jmeno)}</span><span class="stat-row-sub">${m.count} hodn. · průměr ${m.avg}</span></div>`
  ).join('') : '<div class="empty-note">Zatím žádná data.</div>';

  // --- Shoda vkusu mezi členy ---
  const memberNames = activeMembers.map(m => m.jmeno);
  let pary = statPairCloseness(originRatings, memberNames, 5);
  if (ui.statMember !== 'vse') pary = pary.filter(p => p.a === ui.statMember || p.b === ui.statMember);
  html += '<div class="stat-section-title">Shoda vkusu' + (ui.statMember !== 'vse' ? ` — ${esc(ui.statMember)} ↔ ostatní` : '') + '</div>';
  if (pary.length) {
    html += pary.map((p, i) => {
      const partner = ui.statMember !== 'vse' ? (p.a === ui.statMember ? p.b : p.a) : `${p.a} ↔ ${p.b}`;
      const extreme = i === 0 ? ' style="color:var(--good);"' : (i === pary.length - 1 && pary.length > 2 ? ' style="color:var(--warn);"' : '');
      return `<div class="stat-row"><span class="stat-row-main"${extreme}>${esc(partner)}</span><span class="stat-row-sub">${p.closeness} % · ${p.common} společných</span></div>`;
    }).join('');
    html += `<div class="chart-note">Kolik % platí „co jeden ohodnotí líp, druhý taky" (i když jeden boduje obecně přísněji). Jen ${wordMnoz}, které hodnotili oba (min. 5).</div>`;
  } else {
    html += `<div class="empty-note">Zatím málo společných hodnocení (min. 5 na dvojici).</div>`;
  }

  // --- Osobní TOP 10 / 5 nejhorších ---
  html += '<div class="stat-section-title">Osobní žebříček</div>';
  if (ui.statMember !== 'vse') {
    const mine = originRatings.filter(r => r.clen === ui.statMember && rumsSrc.some(x => x.id === r.rumId))
      .map(r => ({ id: r.rumId, celkem: Number(r.celkem) || 0, datum: r.datum || '' }))
      .sort((a, b) => b.celkem - a.celkem || b.datum.localeCompare(a.datum));
    if (mine.length) {
      const rowP = (r, i) => `<div class="stat-row"><span class="stat-row-main"><span class="rank-badge rank-${i + 1}">${i + 1}.</span>${rumLabel(r.id)}</span><span class="stat-row-sub">${r.celkem} b.</span></div>`;
      html += `<div class="stat-year-head">${esc(ui.statMember)} — nejlepší</div>`;
      html += mine.slice(0, 3).map((r, i) => rowP(r, i)).join('');
      if (mine.length > 3) {
        html += `<div class="stat-year-head">${esc(ui.statMember)} — nejhorší</div>`;
        html += mine.slice(-3).reverse().map((r, i) => rowP(r, i)).join('');
      }
    } else {
      html += '<div class="empty-note">Tento člen zatím nic neohodnotil.</div>';
    }
  } else {
    const rows = memberNames.map(name => {
      const mine = originRatings.filter(r => r.clen === name).sort((a, b) => Number(b.celkem) - Number(a.celkem));
      if (!mine.length) return '';
      const top = mine[0], bot = mine[mine.length - 1];
      const sub = mine.length > 1
        ? `▲ ${rumLabel(top.rumId)} (${top.celkem}) · ▼ ${rumLabel(bot.rumId)} (${bot.celkem})`
        : `▲ ${rumLabel(top.rumId)} (${top.celkem})`;
      return `<div class="stat-row" style="display:block;"><div class="stat-row-main" style="white-space:normal;">${esc(name)}</div><div class="stat-row-sub" style="margin-top:2px;">${sub}</div></div>`;
    }).filter(Boolean);
    html += rows.length ? rows.join('') : '<div class="empty-note">Zatím žádná data.</div>';
    html += '<div class="chart-note">Vyber člena nahoře pro jeho 3 nejlepší a 3 nejhorší.</div>';
  }

  // Nejlépe/nejhůře hodnocené = vždy za celý klub (průměr všech), aby to nebylo totéž co Osobní žebříček.
  const byRum = {};
  originRatings.forEach(r => { (byRum[r.rumId] = byRum[r.rumId] || []).push(Number(r.celkem)||0); });
  const rumAgg = Object.keys(byRum).map(id => ({ id, count: byRum[id].length, avg: byRum[id].reduce((s,v)=>s+v,0)/byRum[id].length }));
  const renderRumRankRow = (r, i) => `<div class="stat-row"><span class="stat-row-main"><span class="rank-badge rank-${i + 1}">${i + 1}.</span>${rumLabel(r.id)}</span><span class="stat-row-sub">Ø ${r.avg.toFixed(1)} · ${r.count}×</span></div>`;

  const topRated = [...rumAgg].filter(r=>r.count>=2).sort((a,b)=>b.avg-a.avg).slice(0,5);
  html += '<div class="stat-section-title">Nejlépe hodnocené v klubu</div>';
  html += topRated.length ? topRated.map(renderRumRankRow).join('') : `<div class="empty-note">Zatím málo dat (min. 2 hodnocení na ${wordJedn}).</div>`;

  const bottomRated = [...rumAgg].filter(r=>r.count>=2).sort((a,b)=>a.avg-b.avg).slice(0,5);
  html += '<div class="stat-section-title">Nejhůře hodnocené v klubu</div>';
  html += bottomRated.length ? bottomRated.map(renderRumRankRow).join('') : `<div class="empty-note">Zatím málo dat (min. 2 hodnocení na ${wordJedn}).</div>`;


  // --- Největší rozpory v hodnocení (napříč členy, filtr člena se neuplatní) ---
  const rozpory = statDisagreement(originRatings, 3).slice(0, 8);
  html += '<div class="stat-section-title">Největší rozpory v hodnocení</div>';
  html += rozpory.length ? rozpory.map(d =>
    `<div class="stat-row"><span class="stat-row-main">${rumLabel(d.id)}</span><span class="stat-row-sub">min ${d.min} / max ${d.max} · ${d.count} hodn.</span></div>`
  ).join('') : `<div class="empty-note">Zatím málo dat (min. 3 hodnocení na ${wordJedn}).</div>`;

  html += '<div class="stat-section-title">Podle původu</div>';
  const origGroups = {};
  const keysFor = (rum) => { const l = rum ? puvodList(rum) : []; return l.length ? l : ['Neuvedeno']; };
  rumsSrc.forEach(r => {
    keysFor(r).forEach(key => {
      if (!origGroups[key]) origGroups[key] = { rums: 0, count: 0, sum: 0 };
      origGroups[key].rums++;
    });
  });
  ratingsSrc.forEach(r => {
    const rum = rumsSrc.find(x=>x.id===r.rumId);
    keysFor(rum).forEach(key => {
      if (!origGroups[key]) origGroups[key] = { rums: 0, count: 0, sum: 0 };
      origGroups[key].count++;
      origGroups[key].sum += Number(r.celkem||0);
    });
  });
  const origRows = Object.keys(origGroups).map(k => ({
    puvod: k, rums: origGroups[k].rums, count: origGroups[k].count,
    avg: origGroups[k].count ? (origGroups[k].sum/origGroups[k].count).toFixed(1) : '–'
  })).sort((a,b) => b.rums - a.rums);
  html += origRows.length ? origRows.map(o =>
    `<div class="stat-row"><span class="stat-row-main">${esc(o.puvod)}</span><span class="stat-row-sub">${o.rums} ${wordMnoz} · ${o.count} hodn. · průměr ${o.avg}</span></div>`
  ).join('') : '<div class="empty-note">Zatím žádná data.</div>';
  if (origRows.some(o => o.puvod !== 'Neuvedeno') && rumsSrc.some(r => puvodList(r).length > 1)) {
    html += '<div class="chart-note">Blendy z více zemí se počítají u každé z nich.</div>';
  }

  // --- Podle výrobce ---
  const vyrobci = statByProducer(rumsSrc, originRatings, 2).slice(0, 15);
  html += '<div class="stat-section-title">Podle výrobce</div>';
  html += vyrobci.length ? vyrobci.map(v =>
    `<div class="stat-row"><span class="stat-row-main">${esc(v.vyrobce)}</span><span class="stat-row-sub">${v.items} ${v.items === 1 ? 'položka' : (v.items < 5 ? 'položky' : 'položek')} · ${v.count} hodn. · průměr ${v.avg.toFixed(1)}</span></div>`
  ).join('') : '<div class="empty-note">Zatím málo dat (min. 2 hodnocení na výrobce).</div>';

  // --- Cena / hodnocení (žebříček) ---
  if (!isGuest) {
    const value = statValueForMoney(rumsSrc, originRatings);
    html += '<div class="stat-section-title">Nejlepší poměr cena / hodnocení</div>';
    if (value.length) {
      const rowV = (v) => `<div class="stat-row"><span class="stat-row-main">${rumLabel(v.id)}</span><span class="stat-row-sub">${Math.round(v.kcPerBod)} Kč/bod · ${v.cena} Kč · Ø ${v.avg.toFixed(1)}</span></div>`;
      html += value.slice(0, 10).map(rowV).join('');
      if (value.length > 12) {
        html += '<div class="chart-note">Nejhorší poměr</div>';
        html += value.slice(-5).reverse().map(rowV).join('');
      }
      html += '<div class="chart-note">Méně Kč/bod = lepší koupě. Jen položky s vyplněnou cenou.</div>';
    } else {
      html += '<div class="empty-note">Zatím žádná položka s cenou i hodnocením.</div>';
    }
  }

  html += '<div class="stat-section-title">Účast na degustacích</div>';
  const totalUcast = state.ucasti.length;
  if (totalUcast === 0) {
    html += '<div class="empty-note">Zatím žádná evidovaná účast.</div>';
  } else {
    const avgLidi = (state.ucasti.reduce((s,u)=>s+(u.ucastnici||[]).length,0) / totalUcast).toFixed(1);
    const ucastCounts = {};
    state.ucasti.forEach(u => (u.ucastnici||[]).forEach(jm => { ucastCounts[jm] = (ucastCounts[jm]||0) + 1; }));
    const ucastRows = Object.keys(ucastCounts).map(jm => ({
      jmeno: jm, count: ucastCounts[jm], pct: Math.round(ucastCounts[jm] / totalUcast * 100),
    })).sort((a,b) => b.count - a.count || a.jmeno.localeCompare(b.jmeno, 'cs'));
    const mistoCounts = {};
    state.ucasti.forEach(u => { const k = u.misto || 'Neuvedeno'; mistoCounts[k] = (mistoCounts[k]||0) + 1; });
    const mistoRows = Object.keys(mistoCounts).map(k => ({ misto: k, count: mistoCounts[k] })).sort((a,b) => b.count - a.count);
    const nejlepsi = ucastRows[0];

    html += '<div class="stat-grid">';
    html += statTile(totalUcast, 'degustací evidováno');
    html += statTile(avgLidi, 'průměr účastníků', true);
    html += statTile(nejlepsi ? `${esc(nejlepsi.jmeno)}` : '–', 'nejlepší docházka', true);
    html += statTile(mistoRows[0] ? esc(mistoRows[0].misto) : '–', 'nejčastější místo', true);
    html += '</div>';

    html += '<div class="stat-section-title">Žebříček docházky</div>';
    html += ucastRows.map(r =>
      `<div class="stat-row"><span class="stat-row-main">${esc(r.jmeno)}</span><span class="stat-row-sub">${r.count}× · ${r.pct}&nbsp;% degustací</span></div>`
    ).join('');

    html += '<div class="stat-section-title">Podle místa</div>';
    html += mistoRows.map(m =>
      `<div class="stat-row"><span class="stat-row-main">${esc(m.misto)}</span><span class="stat-row-sub">${m.count}×</span></div>`
    ).join('');
  }

  if (!isGuest) {
    const pricedRums = rumsSrc.filter(r=>r.cena);
    const avgPrice = pricedRums.length ? Math.round(pricedRums.reduce((s,r)=>s+Number(r.cena||0),0)/pricedRums.length) : null;
    const spentNakup = ledgerSourceArray().filter(l=>l.kategorie==='nákup').reduce((s,l)=>s+Math.abs(Number(l.castka)||0),0);
    html += '<div class="stat-section-title">Katalog &amp; účet</div>';
    html += '<div class="stat-grid">';
    html += statTile(rumsSrc.length, wordMnoz + ' v katalogu');
    html += statTile(avgPrice!=null ? avgPrice+' Kč' : '–', 'průměrná cena', true);
    if (!isDoutnik) {
      const abvRums = rumsSrc.filter(r=>r.abv);
      const avgAbv = abvRums.length ? (abvRums.reduce((s,r)=>s+Number(r.abv||0),0)/abvRums.length).toFixed(1) : null;
      html += statTile(avgAbv!=null ? avgAbv+' %' : '–', 'průměrný obsah alk.', true);
    }
    html += statTile(Math.round(currentBalance())+' Kč', 'zůstatek účtu', true);
    html += statTile(Math.round(spentNakup)+' Kč', 'utraceno za nákup', true);
    html += '</div>';
  }

  if (!isGuest) {
    html += '<div class="stat-section-title">Cena vs. hodnocení</div>';
    html += `<div class="chart-card"><div class="chart-wrap"><canvas id="chartPriceQuality"></canvas></div><div class="chart-note" id="chartPriceQualityNote"></div></div>`;
  }

  html += '<div class="stat-section-title">Vývoj hodnocení členů v čase</div>';
  html += `<div class="chart-card"><div class="chart-wrap"><canvas id="chartMemberTimeline"></canvas></div><div class="chart-note" id="chartMemberTimelineNote"></div></div>`;

  document.getElementById('statContent').innerHTML = html;

  if (!isGuest) renderPriceQualityChart(rumsSrc, originRatings, rumIdsByOrigin, rumLabel);
  renderMemberTimelineChart(originRatings, activeMembers.map(m => m.jmeno));
}

function renderMemberTimelineChart(originRatings, memberNames) {
  const canvas = document.getElementById('chartMemberTimeline');
  if (!canvas) return;
  const noteEl = document.getElementById('chartMemberTimelineNote');
  if (_chartMemberTimeline) { _chartMemberTimeline.destroy(); _chartMemberTimeline = null; }

  const { months, series } = statMemberTimeline(originRatings, memberNames, 5);
  const wrap = canvas.closest('.chart-card').querySelector('.chart-wrap');

  if (typeof Chart === 'undefined') { wrap.style.display = 'none'; noteEl.textContent = 'Graf se nenačetl (Chart.js není k dispozici).'; return; }
  if (months.length < 2 || series.length === 0) {
    wrap.style.display = 'none';
    noteEl.textContent = 'Zatím málo dat (potřeba aspoň 5 hodnocení od člena a víc než jeden měsíc).';
    return;
  }
  wrap.style.display = '';
  noteEl.textContent = 'Průběžný průměr každého člena — jak se v čase vyvíjí jeho bodování (0–100).';

  const seriesVars = ['--series-1', '--series-2', '--series-3', '--series-4', '--series-5', '--series-6'];
  const textColor = cssVarVal('--ink-soft');
  const gridColor = cssVarVal('--line');

  _chartMemberTimeline = new Chart(canvas, {
    type: 'line',
    data: {
      labels: months,
      datasets: series.map((s, i) => {
        const color = cssVarVal(seriesVars[i % seriesVars.length]);
        return {
          label: s.name, data: s.pts, borderColor: color, backgroundColor: color + '22',
          borderWidth: 2, pointRadius: 2, pointHoverRadius: 5, tension: 0.25, spanGaps: true,
        };
      }),
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'nearest', intersect: false },
      scales: {
        x: { grid: { color: gridColor }, ticks: { color: textColor, maxTicksLimit: 8 } },
        y: { min: 0, max: 100, grid: { color: gridColor }, ticks: { color: textColor, stepSize: 20 } },
      },
      plugins: { legend: { position: 'bottom', labels: { color: textColor, usePointStyle: true } } },
    },
  });
}

function renderPriceQualityChart(rumsSrc, originRatings, rumIdsByOrigin, rumLabel) {
  const canvas = document.getElementById('chartPriceQuality');
  if (!canvas) return;
  const noteEl = document.getElementById('chartPriceQualityNote');
  if (typeof Chart === 'undefined') { canvas.closest('.chart-card').querySelector('.chart-wrap').style.display = 'none'; noteEl.textContent = 'Graf se nenačetl (Chart.js není k dispozici).'; return; }
  const pricedRums = rumIdsByOrigin ? rumsSrc.filter(r => rumIdsByOrigin.has(r.id)) : rumsSrc;
  const points = pricedRums.filter(r => r.cena).map(r => {
    const rs = originRatings.filter(x => x.rumId === r.id);
    if (!rs.length) return null;
    const avg = rs.reduce((s, x) => s + Number(x.celkem || 0), 0) / rs.length;
    return { x: Number(r.cena), y: Math.round(avg * 10) / 10, nazev: rumLabel(r.id) };
  }).filter(Boolean);

  if (_chartPriceQuality) { _chartPriceQuality.destroy(); _chartPriceQuality = null; }

  if (points.length < 2) {
    canvas.closest('.chart-card').querySelector('.chart-wrap').style.display = 'none';
    noteEl.textContent = 'Zatím málo dat (potřeba cena i hodnocení u aspoň 2 položek).';
    return;
  }
  canvas.closest('.chart-card').querySelector('.chart-wrap').style.display = '';
  noteEl.textContent = 'Každá tečka je jedna položka katalogu — vlevo nahoře jsou ty s nejlepším poměrem cena/kvalita.';

  const seriesColor = cssVarVal('--series-1');
  const gridColor = cssVarVal('--line');
  const textColor = cssVarVal('--ink-soft');

  _chartPriceQuality = new Chart(canvas, {
    type: 'scatter',
    data: {
      datasets: [{
        data: points,
        backgroundColor: seriesColor + 'cc',
        borderColor: seriesColor,
        pointRadius: 5,
        pointHoverRadius: 7,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { title: { display: true, text: 'cena (Kč)', color: textColor }, grid: { color: gridColor }, ticks: { color: textColor } },
        y: { title: { display: true, text: 'průměrné skóre', color: textColor }, grid: { color: gridColor }, ticks: { color: textColor } },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => { const p = ctx.raw; return `${p.nazev}: ${p.x} Kč, Ø ${p.y} b.`; }
          }
        }
      }
    }
  });
}

/* ---------------- INFO tab ---------------- */
function renderInfo() {
  const el = document.getElementById('infoContent');
  if (!el) return;
  let html = `
    <div class="card">
      <div class="rum-name">O aplikaci</div>
      <div class="muted" style="font-size:13px;margin-top:6px;">Degustační klub – appka pro evidenci rumů a doutníků, degustační hodnocení, účet klubu a wishlist. Data se ukládají do sdílené databáze a appka funguje v prohlížeči, i na mobilu.</div>
    </div>
    <div class="card" style="margin-top:12px;">
      <div class="rum-name">Návod k záložkám</div>
      <div class="stat-row"><span class="stat-row-main">🥃 Rumy · 🚬 Doutníky</span><span class="stat-row-sub">katalog a žebříček (přepínač nahoře)</span></div>
      <div class="stat-row"><span class="stat-row-main">➕ Hodnocení</span><span class="stat-row-sub">zadání nové ochutnávky</span></div>
      <div class="stat-row"><span class="stat-row-main">💰 Účet</span><span class="stat-row-sub">zůstatek a transakce klubu</span></div>
      <div class="stat-row"><span class="stat-row-main">⭐ Wishlist</span><span class="stat-row-sub">tipy na příští nákup</span></div>
      <div class="stat-row"><span class="stat-row-main">🚬 Humidor</span><span class="stat-row-sub">evidence a kouření doutníků</span></div>
      <div class="stat-row"><span class="stat-row-main">🗓️ Termíny</span><span class="stat-row-sub">domlouvání dalších degustací</span></div>
      <div class="stat-row"><span class="stat-row-main">📊 Statistika</span><span class="stat-row-sub">přehledy a žebříčky</span></div>
      <div class="stat-row"><span class="stat-row-main">🙋 Účast</span><span class="stat-row-sub">docházka na degustace</span></div>
      <div class="stat-row"><span class="stat-row-main">👥 Klub</span><span class="stat-row-sub">členové klubu</span></div>
      <div class="stat-row"><span class="stat-row-main">ℹ️ Info</span><span class="stat-row-sub">tenhle návod, export dat a nastavení</span></div>
    </div>
    <div class="card" style="margin-top:12px;">
      <div class="rum-name">Zamykání PINu</div>
      <div class="muted" style="font-size:13px;margin-top:6px;">Po 3 špatně zadaných PINech za sebou se přihlášení na 15 minut zamkne (platí i po zavření appky nebo telefonu). Chrání to jen proti náhodnému zkoušení kódů, nejde o skutečné zabezpečení.</div>
    </div>
  `;
  if (isAdmin) {
    html += `
    <div class="card" style="margin-top:12px;">
      <div class="rum-name">PINy</div>
      <div class="muted" style="font-size:13px;margin-top:6px;">PINy jsou uložené zahašované, ve zdroji stránky nejsou čitelné. Seznam si drž bokem (heslový manažer / záloha). Změna PINu: v konzoli prohlížeče <code>await pinHash("novy-pin")</code> a výsledek vlož do <code>index.html</code>.</div>
    </div>
    `;
  }
  el.innerHTML = html;

  renderInfoTools();
}

// Nástroje v Info – seskládané podle důležitosti a role.
function renderInfoTools() {
  const box = document.getElementById('infoAdminTools');
  if (!box) return;
  const spravce = hasPerm(PERM_SPRAVCI);
  const mazani = hasPerm(PERM_MAZANI);
  let h = '';

  if (isAdmin || mazani) {
    h += `<div class="stat-section-title" style="margin-top:16px;">Zálohy a obnova</div>`;
    if (isAdmin) {
      h += `<div class="muted" style="font-size:12px;margin-bottom:8px;">Databáze i fotky se zálohují automaticky každou noc na GitHub.</div>
      <button class="btn btn-ghost tools-btn" onclick="downloadLatestBackup()">⬇️ Stáhnout poslední noční zálohu (JSON)</button>
      <a class="btn btn-ghost tools-btn" href="https://github.com/Degustace-DaR/klub-app/archive/refs/heads/main.zip" target="_blank" rel="noopener">📦 Stáhnout vše (ZIP: kód + JSON + fotky)</a>`;
    }
    if (mazani) {
      h += `<button class="btn btn-ghost tools-btn" onclick="triggerImportDatabase()">📥 Obnovit databázi ze zálohy (JSON)</button>
      <div class="muted" style="font-size:11px;margin-top:4px;">Přepíše VŠECHNA data v aktuálně otevřené appce. Používej pro obnovu ze zálohy nebo naplnění testovací appky – nikdy „jen tak" v ostré.</div>`;
    }
  }

  if (spravce) {
    h += `<div class="stat-section-title" style="margin-top:18px;">Doplnění údajů</div>
      <div id="datumBackfillSection"></div>
      <div id="cenaBackfillSection"></div>`;
  }

  if (spravce) {
    h += `<div class="stat-section-title" style="margin-top:18px;">Export dat</div>
      <button class="btn btn-ghost tools-btn" onclick="exportToExcel()">⬇️ Exportovat všechno do Excelu</button>`;
  }
  if (isAdmin) {
    h += `<button class="btn btn-ghost tools-btn" onclick="exportDatabase()">🗄️ Ruční export databáze (JSON)</button>`;
  }

  if (isAdmin) {
    h += `<div class="stat-section-title" style="margin-top:18px;">Údržba a kontrola</div>
      <button class="btn btn-ghost tools-btn" onclick="openHistory()">📋 Přehled změn</button>
      <div id="puvodCleanupSection" style="margin-top:8px;"></div>
      <div id="nameCleanupSection" style="margin-top:8px;"></div>`;
  }

  h += `<div class="stat-section-title" style="margin-top:18px;">Appka</div>
    <button class="btn btn-ghost tools-btn" onclick="lockApp()">🔒 Zamknout appku (znovu vyžádat PIN)</button>
    <input type="file" id="importDbFileInput" accept="application/json,.json" hidden onchange="importDatabaseFile(this)">`;

  box.innerHTML = h;
  renderPuvodCleanupSection();
  renderNameCleanupSection();
  renderDatumBackfillSection();
  renderCenaBackfillSection();
}

// Hromadné doplnění ceny u produktů, co ji nemají (podle přepínače Rum/Doutník).
function renderCenaBackfillSection() {
  const el = document.getElementById('cenaBackfillSection');
  if (!el) return;
  if (!hasPerm(PERM_SPRAVCI)) { el.innerHTML = ''; return; }
  const isDoutnik = ui.typ === 'doutnik';
  const word = isDoutnik ? 'doutníků' : 'rumů';
  const noPrice = state.rums.filter(r => (r.typ || 'rum') === ui.typ && !(Number(r.cena) > 0));
  if (!ui.showCenaBackfill) {
    el.innerHTML = `<button class="btn btn-ghost tools-btn" onclick="ui.showCenaBackfill=true; renderCenaBackfillSection();">💰 Doplnit ceny – chybí u ${noPrice.length} ${word}</button>`;
    return;
  }
  if (!noPrice.length) {
    el.innerHTML = `<div class="muted" style="font-size:13px;">Všechny ${word} mají cenu. 🎉 (přepínač nahoře přepne na druhý druh)</div>
      <button class="btn btn-ghost btn-sm" style="margin-top:6px;" onclick="ui.showCenaBackfill=false; renderCenaBackfillSection();">Zpět</button>`;
    return;
  }
  const shown = noPrice.slice(0, 80);
  el.innerHTML = `
    <div class="muted" style="font-size:12px;margin-bottom:8px;">Chybí u ${noPrice.length} ${word} (režim ${isDoutnik ? 'Doutník' : 'Rum'}). Ukládá se hned.</div>
    <div class="picker-list">
      ${shown.map(r => `
        <div class="picker-item" style="display:flex; gap:8px; align-items:center;">
          <span style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(r.nazev)}${r.znacka ? ' – ' + esc(r.znacka) : ''}</span>
          <input class="input" type="number" inputmode="numeric" placeholder="Kč" style="width:96px; flex-shrink:0;" onchange="setRumCena('${r.id}', this.value)">
        </div>`).join('')}
    </div>
    ${noPrice.length > shown.length ? `<div class="muted" style="font-size:11px;margin-top:6px;">Zobrazeno ${shown.length} z ${noPrice.length} – po uložení otevři znovu pro další.</div>` : ''}
    <button class="btn btn-ghost btn-sm" style="margin-top:8px;" onclick="ui.showCenaBackfill=false; renderCenaBackfillSection();">Zavřít</button>`;
}

async function setRumCena(id, cenaRaw) {
  try {
    if (!hasPerm(PERM_SPRAVCI)) return;
    const cena = Number(cenaRaw);
    if (!(cena > 0)) return;
    await db.collection('rums').doc(id).update({ cena });
    const r = state.rums.find(x => x.id === id);
    if (r) r.cena = cena;
    toast('Cena uložena', 'ok');
  } catch (e) {
    console.error('setRumCena:', e);
    toast('Uložení se nezdařilo, zkus to znovu.');
  }
}

// Hromadné doplnění „datum ochutnání" u produktů, co ho nemají (podle přepínače Rum/Doutník).
function renderDatumBackfillSection() {
  const el = document.getElementById('datumBackfillSection');
  if (!el) return;
  if (!hasPerm(PERM_SPRAVCI)) { el.innerHTML = ''; return; }
  const isDoutnik = ui.typ === 'doutnik';
  const word = isDoutnik ? 'doutníků' : 'rumů';
  const undated = state.rums.filter(r => (r.typ || 'rum') === ui.typ && !/^\d{4}-\d{2}-\d{2}/.test(r.datum || ''));
  if (!ui.showDatumBackfill) {
    el.innerHTML = `<button class="btn btn-ghost tools-btn" onclick="ui.showDatumBackfill=true; renderDatumBackfillSection();">🗓️ Doplnit datum ochutnání – chybí u ${undated.length} ${word}</button>`;
    return;
  }
  if (!undated.length) {
    el.innerHTML = `<div class="muted" style="font-size:13px;">Všechny ${word} mají datum ochutnání. 🎉 (přepínač nahoře přepne na druhý druh)</div>
      <button class="btn btn-ghost btn-sm" style="margin-top:6px;" onclick="ui.showDatumBackfill=false; renderDatumBackfillSection();">Zpět</button>`;
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  const shown = undated.slice(0, 80);
  el.innerHTML = `
    <div class="muted" style="font-size:12px;margin-bottom:6px;">Chybí u ${undated.length} ${word} (režim ${isDoutnik ? 'Doutník' : 'Rum'}). Nastav datum a průběžně se ukládá.</div>
    <div style="display:flex; gap:8px; align-items:center; margin-bottom:10px;">
      <input class="input" type="date" id="datumBulkInput" value="${today}" style="flex:1;">
      <button class="btn btn-ghost btn-sm" style="flex-shrink:0;" onclick="bulkSetRumDatum()">Nastavit všem níže</button>
    </div>
    <div class="picker-list">
      ${shown.map(r => `
        <div class="picker-item" style="display:flex; gap:8px; align-items:center;">
          <span style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${esc(r.nazev)}${r.znacka ? ' – ' + esc(r.znacka) : ''}</span>
          <input class="input" type="date" style="width:148px; flex-shrink:0;" onchange="setRumDatum('${r.id}', this.value)">
        </div>`).join('')}
    </div>
    ${undated.length > shown.length ? `<div class="muted" style="font-size:11px;margin-top:6px;">Zobrazeno ${shown.length} z ${undated.length} – po uložení otevři znovu pro další.</div>` : ''}
    <button class="btn btn-ghost btn-sm" style="margin-top:8px;" onclick="ui.showDatumBackfill=false; renderDatumBackfillSection();">Zavřít</button>`;
}

async function setRumDatum(id, datum) {
  try {
    if (!hasPerm(PERM_SPRAVCI) || !datum) return;
    await db.collection('rums').doc(id).update({ datum });
    const r = state.rums.find(x => x.id === id);
    if (r) r.datum = datum;
    toast('Datum uloženo', 'ok');
  } catch (e) {
    console.error('setRumDatum:', e);
    toast('Uložení se nezdařilo, zkus to znovu.');
  }
}

async function bulkSetRumDatum() {
  try {
    if (!hasPerm(PERM_SPRAVCI)) return;
    const datum = document.getElementById('datumBulkInput')?.value;
    if (!datum) return;
    const isDoutnik = ui.typ === 'doutnik';
    const word = isDoutnik ? 'doutníků' : 'rumů';
    const undated = state.rums
      .filter(r => (r.typ || 'rum') === ui.typ && !/^\d{4}-\d{2}-\d{2}/.test(r.datum || ''))
      .slice(0, 80);
    if (!undated.length) return;
    if (!confirm(`Nastavit datum ${datum} u ${undated.length} ${word}?`)) return;
    const batch = db.batch();
    undated.forEach(r => batch.update(db.collection('rums').doc(r.id), { datum }));
    await batch.commit();
    undated.forEach(r => { const x = state.rums.find(y => y.id === r.id); if (x) x.datum = datum; });
    toast(`Datum nastaveno u ${undated.length} položek`, 'ok');
    logChange('Hromadně doplněno datum ochutnání', `${undated.length}× ${word} → ${datum}`);
    renderDatumBackfillSection();
  } catch (e) {
    console.error('bulkSetRumDatum:', e);
    toast('Uložení se nezdařilo, zkus to znovu.');
  }
}

/* ---------------- KLUB tab ---------------- */
async function addMember() {
  try {
    if (!hasPerm(PERM_SPRAVCI)) return;
    const name = document.getElementById('newMemberName').value.trim();
    if (!name) return;
    if (state.members.some(m => (m.jmeno||'').trim().toLowerCase() === name.toLowerCase())) {
      toast(`Člen "${name}" už existuje`);
      return;
    }
    await db.collection('members').add({ jmeno: name, aktivni: true });
    document.getElementById('newMemberName').value = '';
    toast('Člen přidán', 'ok');
    logChange('Přidán člen', name);

  } catch (e) {
    console.error('addMember:', e);
    toast('Uložení se nezdařilo, zkus to znovu.');
  }
}

const CLUB_MEMBER_ORDER = ['Broněk','Libor','Jirka','Tonda','Tomáš','Mirek','Host 1','Host 2'];
function renderKlub() {
  const list = document.getElementById('memberList');
  const sortedMembers = [...state.members].sort((a,b) => {
    const ia = CLUB_MEMBER_ORDER.indexOf(a.jmeno), ib = CLUB_MEMBER_ORDER.indexOf(b.jmeno);
    const ra = ia === -1 ? CLUB_MEMBER_ORDER.length : ia;
    const rb = ib === -1 ? CLUB_MEMBER_ORDER.length : ib;
    if (ra !== rb) return ra - rb;
    return (a.jmeno||'').localeCompare(b.jmeno||'');
  });
  list.innerHTML = sortedMembers.map(m => {
    const rs = state.ratings.filter(r => r.clen === m.jmeno);
    const avg = rs.length ? (rs.reduce((s,r)=>s+Number(r.celkem||0),0)/rs.length).toFixed(1) : '–';
    return `
      <div class="card member-card">
        <div>
          <div class="rum-name">${esc(m.jmeno)}</div>
          <div class="member-stats">${rs.length} hodnocení · průměr ${avg}</div>
        </div>
      </div>
    `;
  }).join('');

  const addCard = document.getElementById('addMemberCard');
  if (addCard) addCard.hidden = !hasPerm(PERM_SPRAVCI);
}

/* ---------------- Sjednocení názvů původu (admin) ---------------- */
function levenshtein(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

function findPuvodGroups() {
  const counts = {};
  state.rums.forEach(r => { puvodList(r).forEach(p => { counts[p] = (counts[p] || 0) + 1; }); });
  const names = Object.keys(counts);
  const parent = {};
  names.forEach(n => parent[n] = n);
  function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
  function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i], b = names[j];
      if (a.toLowerCase() === b.toLowerCase()) { union(a, b); continue; }
      if (a.length < 4 || b.length < 4) continue;
      if (levenshtein(a, b) <= 2) union(a, b);
    }
  }
  const groups = {};
  names.forEach(n => { const r = find(n); (groups[r] = groups[r] || []).push(n); });
  return Object.values(groups).filter(g => g.length > 1).map(g => ({
    variants: g.map(v => ({ jmeno: v, count: counts[v] })).sort((a, b) => b.count - a.count),
  }));
}

function checkPuvodDuplicates() {
  ui.puvodGroups = findPuvodGroups();
  ui.showPuvodCleanup = true;
  ui.puvodCanon = {};
  ui.puvodChecked = {};
  ui.puvodGroups.forEach((g, gi) => {
    ui.puvodCanon[gi] = g.variants[0].jmeno;
    g.variants.forEach(v => { ui.puvodChecked[gi + '_' + v.jmeno] = true; });
  });
  renderPuvodCleanupSection();
}

function renderPuvodCleanupSection() {
  const el = document.getElementById('puvodCleanupSection');
  if (!el) return;
  if (!isAdmin) { el.innerHTML = ''; return; }
  if (!ui.showPuvodCleanup) {
    el.innerHTML = `<button class="btn btn-ghost" onclick="checkPuvodDuplicates()">🔎 Zkontrolovat podobné názvy původu</button>`;
    return;
  }
  if (!ui.puvodGroups || ui.puvodGroups.length === 0) {
    el.innerHTML = `
      <div class="card muted" style="font-size:13px;">Žádné podobné názvy původu nenalezeny.</div>
      <button class="btn btn-ghost btn-sm" style="margin-top:8px;" onclick="ui.showPuvodCleanup=false; renderPuvodCleanupSection();">Zpět</button>`;
    return;
  }
  let html = `<div class="rum-name" style="margin-bottom:8px;">Možné duplicity v původu (${ui.puvodGroups.length})</div>`;
  html += ui.puvodGroups.map((g, gi) => {
    const rowsHtml = g.variants.map(v => {
      const key = gi + '_' + v.jmeno;
      const checked = ui.puvodChecked[key] ? 'checked' : '';
      return `
        <label style="display:flex; align-items:center; gap:8px; padding:4px 0;">
          <input type="checkbox" ${checked} onchange="ui.puvodChecked['${key}']=this.checked;">
          <span style="flex:1;">${esc(v.jmeno)}</span>
          <span class="muted" style="font-size:12px;">${v.count}× rum</span>
        </label>`;
    }).join('');
    return `
      <div class="card" style="margin-bottom:8px;">
        ${rowsHtml}
        <div class="field" style="margin-top:8px;"><label>Sjednotit na</label>
          <input class="input" value="${esc(ui.puvodCanon[gi])}" oninput="ui.puvodCanon[${gi}]=this.value;">
        </div>
        <button class="btn btn-primary btn-sm" style="margin-top:8px;" onclick="mergePuvodGroup(${gi})">Sloučit vybrané</button>
      </div>`;
  }).join('');
  html += `<button class="btn btn-ghost btn-sm" onclick="ui.showPuvodCleanup=false; ui.puvodGroups=null; renderPuvodCleanupSection();">Zavřít</button>`;
  el.innerHTML = html;
}

function findNameGroups() {
  const items = state.rums
    .filter(r => (r.typ||'rum') === ui.typ)
    .map(r => ({ id: r.id, label: `${r.znacka||''} ${r.nazev||''}`.trim() }))
    .filter(x => x.label);
  const parent = {};
  items.forEach((_, i) => parent[i] = i);
  function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
  function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i].label, b = items[j].label;
      if (a.toLowerCase() === b.toLowerCase()) { union(i, j); continue; }
      if (a.length < 4 || b.length < 4) continue;
      if (levenshtein(a, b) <= 2) union(i, j);
    }
  }
  const groups = {};
  items.forEach((it, i) => { const r = find(i); (groups[r] = groups[r] || []).push(it); });
  return Object.values(groups).filter(g => g.length > 1);
}

function checkNameDuplicates() {
  ui.nameGroups = findNameGroups();
  ui.showNameCleanup = true;
  renderNameCleanupSection();
}

function renderNameCleanupSection() {
  const el = document.getElementById('nameCleanupSection');
  if (!el) return;
  if (!isAdmin) { el.innerHTML = ''; return; }
  const isDoutnik = ui.typ === 'doutnik';
  const label = isDoutnik ? 'doutníky' : 'rumy';
  if (!ui.showNameCleanup) {
    el.innerHTML = `<button class="btn btn-ghost" onclick="checkNameDuplicates()">🔎 Zkontrolovat podobné ${label}</button>`;
    return;
  }
  if (!ui.nameGroups || ui.nameGroups.length === 0) {
    el.innerHTML = `
      <div class="card muted" style="font-size:13px;">Žádné podobné ${label} nenalezeny.</div>
      <button class="btn btn-ghost btn-sm" style="margin-top:8px;" onclick="ui.showNameCleanup=false; renderNameCleanupSection();">Zpět</button>`;
    return;
  }
  let html = `<div class="rum-name" style="margin-bottom:8px;">Možné duplicity (${ui.nameGroups.length}) — klikni na záznam pro detail, zkontroluj a případně jeden smaž</div>`;
  html += ui.nameGroups.map(g => `
    <div class="card" style="margin-bottom:8px;">
      ${g.map(it => {
        const stats = isDoutnik ? cigarStats(it.id) : rumStats(it.id);
        return `<div class="ledger-row" style="cursor:pointer;" onclick="openRumDetail('${it.id}')">
          <span class="stat-row-main">${esc(it.label)}</span>
          <span class="muted" style="font-size:12px;">${stats ? stats.count+' hodn.' : 'bez hodnocení'}</span>
        </div>`;
      }).join('')}
    </div>`).join('');
  html += `<button class="btn btn-ghost btn-sm" onclick="ui.showNameCleanup=false; ui.nameGroups=null; renderNameCleanupSection();">Zavřít</button>`;
  el.innerHTML = html;
}

async function mergePuvodGroup(gi) {
  try {
    if (!isAdmin) return;
    const group = ui.puvodGroups[gi];
    if (!group) return;
    const canon = (ui.puvodCanon[gi] || '').trim();
    if (!canon) { toast('Zadej cílový název'); return; }
    const variantsToMerge = group.variants.filter(v => ui.puvodChecked[gi + '_' + v.jmeno] && v.jmeno !== canon).map(v => v.jmeno);
    if (variantsToMerge.length === 0) { toast('Nic ke sloučení (odškrtnuto, nebo už sjednoceno)'); return; }
    const affected = state.rums.filter(r => puvodList(r).some(p => variantsToMerge.includes(p)));
    if (affected.length === 0) { toast('Žádné rumy k úpravě'); return; }
    if (!confirm(`Sjednotit "${variantsToMerge.join('", "')}" → "${canon}" u ${affected.length} rumů?`)) return;
    const batch = db.batch();
    affected.forEach(r => {
      const nove = [...new Set(puvodList(r).map(p => variantsToMerge.includes(p) ? canon : p))].join(', ');
      batch.update(db.collection('rums').doc(r.id), { puvod: nove });
      r.puvod = nove;
    });
    await batch.commit();
    toast('Sjednoceno');
    logChange('Sjednocen původ', `${variantsToMerge.join(', ')} → ${canon} (${affected.length}×)`);
    checkPuvodDuplicates();

  } catch (e) {
    console.error('mergePuvodGroup:', e);
    toast('Uložení se nezdařilo, zkus to znovu.');
  }
}


/* ---------------- EXPORT DO EXCELU ---------------- */
async function exportToExcel() {
  if (!hasPerm(PERM_SPRAVCI)) return;
  if (typeof XLSX === 'undefined') { toast('Export se nepodařilo načíst, zkus obnovit stránku'); return; }
  const wb = XLSX.utils.book_new();
  const addSheet = (name, rows) => {
    const clean = rows.map(r => { const { id, ...rest } = r; return { id, ...rest }; });
    const ws = XLSX.utils.json_to_sheet(clean);
    XLSX.utils.book_append_sheet(wb, ws, name);
  };
  addSheet('Clenove', state.members);
  addSheet('Rumy_katalog', state.rums.filter(r => (r.typ||'rum') === 'rum'));
  addSheet('Hodnoceni', state.ratings);
  addSheet('Ucet', state.ledger);
  addSheet('Wishlist_rumy', state.wishlist.filter(w => (w.typ||'rum') === 'rum'));
  addSheet('Doutniky_katalog', state.rums.filter(r => (r.typ||'rum') === 'doutnik'));
  addSheet('Hodnoceni_doutniky', state.cigarRatings);
  addSheet('Ucet_doutniky', state.ledgerDoutniky);
  addSheet('Wishlist_doutniky', state.wishlist.filter(w => (w.typ||'rum') === 'doutnik'));
  addSheet('Humidor_doutniky', state.cigars.flatMap(c => (c.nakupy && c.nakupy.length ? c.nakupy : [{}]).map(n => ({
    vyrobce: c.vyrobce || '', model: c.model || '', datum: n.datum || '', pocet: n.pocet || '', cena_ks: n.cena_ks || '', cena_celkem: n.cena_celkem || '',
  }))));
  addSheet('Humidor_koureni', state.cigarLog.map(l => {
    const c = state.cigars.find(x => x.id === l.cigarId);
    return { vyrobce: c ? c.vyrobce : '', model: c ? c.model : '', cislo: l.cislo, datum: l.datum || '', clen: l.clen || '' };
  }));
  addSheet('Terminy', state.terminKola.flatMap(k => {
    const datumy = [...(k.datumy || [])].sort();
    const rozsah = datumy.length ? (datumy[0] + ' – ' + datumy[datumy.length-1]) : '';
    const out = [];
    datumy.forEach(datum => {
      Object.keys(k.odpovedi || {}).forEach(jmeno => {
        out.push({ kolo: rozsah, datum, jmeno, odpoved: (k.odpovedi[jmeno] || {})[datum] || '', vybrano: k.vybrano === datum ? 'ano' : '' });
      });
    });
    return out;
  }));
  addSheet('Ucast', sortedUcasti().map(u => ({
    datum: u.datum || '', misto: u.misto || '', ucastnici: (u.ucastnici || []).join(', '), pocet: (u.ucastnici || []).length,
    zdroj: u.zdrojKoloId ? 'z termínu' : '', poznamka: u.poznamka || '',
  })));
  try {
    const snap = await db.collection('activity_log').orderBy('cas', 'desc').get();
    const logRows = snap.docs.map(d => {
      const l = d.data();
      return { datum_cas: l.cas ? new Date(l.cas).toLocaleString('cs-CZ') : '', kdo: l.kdo || '', akce: l.akce || '', popis: l.popis || '' };
    });
    addSheet('Historie_zmen', logRows);
  } catch (e) { console.error('Export historie se nepodařil:', e); }
  const datum = new Date().toISOString().slice(0,10);
  XLSX.writeFile(wb, `rum-klub-export-${datum}.xlsx`);
  toast('Export stažen');
}

/* ---------------- EXPORT / IMPORT CELÉ DATABÁZE (JSON) — pro přenos dat do testovací appky ---------------- */
const DB_EXPORT_COLLECTIONS = ['members','rums','ratings','ledger','wishlist','cigars','cigar_log','cigar_ratings','ledger_doutniky','termin_ucastnici','termin_kola','ucast','activity_log'];
const DB_SEED_FLAG_DOCS = ['seed','seed_humidor','seed_terminy','seed_ucast','seed_doutniky','seed_ledger_doutniky'];

async function exportDatabase() {
  if (!isAdmin) return;
  if (!db) { toast('Appka není připojená k databázi'); return; }
  toast('Exportuji databázi…');
  try {
    const collections = {};
    let total = 0;
    for (const col of DB_EXPORT_COLLECTIONS) {
      const snap = await db.collection(col).get();
      collections[col] = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      total += collections[col].length;
    }
    const payload = {
      _export: 'rum-klub-db',
      _version: 1,
      _exportedAt: new Date().toISOString(),
      _sourceProject: (firebase.app().options || {}).projectId || '',
      collections,
    };
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0,16).replace(/[:T]/g,'-');
    a.href = url;
    a.download = `export-databaze_${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast(`Export hotov (${total} dokumentů) – soubor se stahuje`);
    if (payload._sourceProject === 'degustace-dar') {
      try {
        await db.doc('meta/last_db_export').set({ at: new Date().toISOString() });
      } catch (e2) { /* nekritické, jen si appka nezapamatuje datum poslední zálohy */ }
    }
  } catch (e) {
    console.error('Export databáze selhal:', e);
    toast('Export databáze selhal: ' + (e.message || e));
  }
}

// Stáhne poslední noční zálohu (soubor z GitHubu) do počítače – kopie mimo GitHub.
const BACKUP_REPO = 'Degustace-DaR/klub-app';
async function downloadLatestBackup() {
  if (!isAdmin) return;
  toast('Hledám poslední zálohu na GitHubu…');
  try {
    const list = await fetch(`https://api.github.com/repos/${BACKUP_REPO}/contents/backups/db`)
      .then(r => (r.ok ? r.json() : []));
    const files = (Array.isArray(list) ? list : [])
      .filter(f => /^klub-\d{4}-\d{2}-\d{2}\.json$/.test(f.name || ''))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!files.length) {
      toast('Zatím žádná noční záloha – spusť na GitHubu „Akce → Záloha databáze".');
      return;
    }
    const newest = files[files.length - 1];
    const blob = await fetch(`backups/db/${newest.name}`, { cache: 'no-store' })
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = newest.name.replace(/^klub-/, 'klub-zaloha-');
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
    toast('Stahuje se ' + newest.name, 'ok');
  } catch (e) {
    console.error('downloadLatestBackup:', e);
    toast('Zálohu se nepodařilo stáhnout (GitHub nedostupný?).');
  }
}

function triggerImportDatabase() {
  if (!hasPerm(PERM_MAZANI)) return;
  const input = document.getElementById('importDbFileInput');
  if (input) input.click();
}

async function importDatabaseFile(fileInput) {
  if (!hasPerm(PERM_MAZANI)) return;
  const file = fileInput.files && fileInput.files[0];
  fileInput.value = '';
  if (!file) return;
  if (!db) { toast('Appka není připojená k databázi'); return; }
  let payload;
  try {
    payload = JSON.parse(await file.text());
  } catch (e) {
    toast('Soubor se nepodařilo přečíst jako JSON');
    return;
  }
  if (!payload || payload._export !== 'rum-klub-db' || !payload.collections) {
    toast('Tohle nevypadá jako export z téhle appky – import zrušen');
    return;
  }
  const entries = Object.entries(payload.collections);
  const total = entries.reduce((s, [, docs]) => s + docs.length, 0);
  const counts = entries.map(([k, docs]) => `${k}: ${docs.length}`).join(', ');
  const proj = (firebase.app().options || {}).projectId || '?';
  const warn = `POZOR: tímto se PŘEPÍŠOU všechna data v aktuálně připojené databázi (projekt "${proj}").\n\nNahraje se ${total} dokumentů:\n${counts}\n\nExport pořízen: ${payload._exportedAt || '?'}\nZdrojový projekt exportu: ${payload._sourceProject || '?'}\n\nOpravdu pokračovat?`;
  if (!confirm(warn)) return;
  if (!confirm('Ještě jednou pro jistotu: opravdu chceš přepsat data v projektu "' + proj + '"? Tohle se nedá vrátit zpět.')) return;
  toast('Importuji databázi…');
  try {
    for (const [col, docs] of entries) {
      let batch = db.batch();
      let n = 0;
      for (const docData of docs) {
        const { id, ...fields } = docData;
        if (!id) continue;
        batch.set(db.collection(col).doc(id), fields);
        n++;
        if (n % 400 === 0) { await batch.commit(); batch = db.batch(); }
      }
      await batch.commit();
    }
    const metaBatch = db.batch();
    DB_SEED_FLAG_DOCS.forEach(name => {
      metaBatch.set(db.doc('meta/' + name), { done: true, at: new Date().toISOString(), note: 'nastaveno importem databáze' });
    });
    await metaBatch.commit();
    logChange('Import databáze', `${total} dokumentů, export z ${payload._exportedAt || '?'} (${payload._sourceProject || '?'})`);
    toast(`Import hotov (${total} dokumentů) – appka se za chvíli obnoví`);
    setTimeout(() => location.reload(), 1200);
  } catch (e) {
    console.error('Import databáze selhal:', e);
    toast('Import databáze selhal: ' + (e.message || e));
  }
}

function fromSnap(snap) { return snap.docs.map(d => ({ id: d.id, ...d.data() })); }

async function maybeSeed() {
  if (typeof SEED === 'undefined') return;  // ostrá appka seed-data.js nenačítá
  const seedRef = db.doc('meta/seed');
  const snap = await seedRef.get();
  if (snap.exists) return;
  const jobs = [];
  SEED.members.forEach(m => jobs.push(db.collection('members').doc(m.id).set(m)));
  SEED.rums.forEach((r,i) => jobs.push(db.collection('rums').doc(r.id).set({...r, _seq: i})));
  SEED.ratings.forEach((r,i) => jobs.push(db.collection('ratings').doc(r.id).set({...r, _seq: i})));
  SEED.ledger.forEach((l,i) => jobs.push(db.collection('ledger').doc(l.id).set({...l, _seq: i})));
  SEED.wishlist.forEach((w,i) => jobs.push(db.collection('wishlist').doc(w.id).set({...w, _seq: i})));
  await Promise.all(jobs);
  await seedRef.set({ done: true, at: new Date().toISOString() });
}


async function maybeSeedHumidor() {
  if (typeof SEED_HUMIDOR === 'undefined') return;  // ostrá appka seed-data.js nenačítá
  const seedRef = db.doc('meta/seed_humidor');
  const snap = await seedRef.get();
  if (snap.exists) return;
  const jobs = [];
  SEED_HUMIDOR.cigars.forEach((c,i) => jobs.push(db.collection('cigars').doc(c.id).set({ vyrobce: c.vyrobce, model: c.model, nakupy: c.nakupy, poznamka: c.poznamka||'', _seq: i })));
  SEED_HUMIDOR.log.forEach((l,i) => jobs.push(db.collection('cigar_log').doc(l.id).set({ cigarId: l.cigarId, cislo: l.cislo, datum: l.datum, clen: l.clen, _seq: i })));
  await Promise.all(jobs);
  await seedRef.set({ done: true, at: new Date().toISOString() });
}


async function maybeSeedTerminy() {
  if (typeof SEED_TERMINY === 'undefined') return;  // ostrá appka seed-data.js nenačítá
  const seedRef = db.doc('meta/seed_terminy');
  const snap = await seedRef.get();
  if (snap.exists) return;
  const jobs = [];
  SEED_TERMINY.members.forEach((jmeno, i) => jobs.push(db.collection('termin_ucastnici').add({ jmeno })));
  SEED_TERMINY.kola.forEach(k => jobs.push(db.collection('termin_kola').doc(k.id).set({ datumy: k.datumy, odpovedi: k.odpovedi, vybrano: k.vybrano, poznamka: k.poznamka || '', _seq: k._seq })));
  await Promise.all(jobs);
  await seedRef.set({ done: true, at: new Date().toISOString() });
}

const TERMIN_NAME_MIGRATION = {
  'Krchňáček': 'Libor', 'Váverka': 'Tomáš', 'Kříž': 'Tonda',
  'Zámečník': 'Broněk', 'Eibensteiner': 'Jirka', 'Mlýnský': 'Mirek',
};


async function maybeSeedUcast() {
  if (typeof SEED_UCAST === 'undefined') return;  // ostrá appka seed-data.js nenačítá
  const seedRef = db.doc('meta/seed_ucast');
  const snap = await seedRef.get();
  if (snap.exists) return;
  const jobs = [];
  SEED_UCAST.forEach(u => jobs.push(db.collection('ucast').add({
    cislo: u.cislo, datum: u.datum, misto: u.misto, ucastnici: u.ucastnici, poznamka: '', zdrojKoloId: null, _seq: u._seq,
  })));
  await Promise.all(jobs);
  await seedRef.set({ done: true, at: new Date().toISOString() });
}


async function maybeSeedDoutniky() {
  if (typeof SEED_DOUTNIKY === 'undefined') return;  // ostrá appka seed-data.js nenačítá
  const seedRef = db.doc('meta/seed_doutniky');
  const snap = await seedRef.get();
  if (snap.exists) return;
  const jobs = [];
  SEED_DOUTNIKY.rums.forEach((r,i) => jobs.push(db.collection('rums').doc(r.id).set({ nazev: r.nazev, znacka: r.znacka, puvod: r.puvod, cena: r.cena, cukr: r.cukr, poznamka: r.poznamka, typ: 'doutnik', _seq: i })));
  SEED_DOUTNIKY.ratings.forEach((r,i) => jobs.push(db.collection('cigar_ratings').doc(r.id).set({
    rumId: r.rumId, clen: r.clen, vzhled: r.vzhled, vune: r.vune, tah: r.tah, chut: r.chut, kour: r.kour, horeni: r.horeni, popel: r.popel, celkem: r.celkem, datum: r.datum, _seq: i,
  })));
  await Promise.all(jobs);
  await seedRef.set({ done: true, at: new Date().toISOString() });
}


async function maybeSeedLedgerDoutniky() {
  if (typeof SEED_LEDGER_DOUTNIKY === 'undefined') return;  // ostrá appka seed-data.js nenačítá
  const seedRef = db.doc('meta/seed_ledger_doutniky');
  const snap = await seedRef.get();
  if (snap.exists) return;
  const jobs = [];
  SEED_LEDGER_DOUTNIKY.forEach((l,i) => jobs.push(db.collection('ledger_doutniky').doc(l.id).set({ datum: l.datum, popis: l.popis, castka: l.castka, kategorie: l.kategorie, _seq: i })));
  await Promise.all(jobs);
  await seedRef.set({ done: true, at: new Date().toISOString() });
}

async function migrateTerminyNames() {
  const ucastSnap = await db.collection('termin_ucastnici').get();
  const kolaSnap = await db.collection('termin_kola').get();
  const batch = db.batch();
  let changed = false;
  ucastSnap.docs.forEach(d => {
    const noveJmeno = TERMIN_NAME_MIGRATION[d.data().jmeno];
    if (noveJmeno) { batch.update(d.ref, { jmeno: noveJmeno }); changed = true; }
  });
  kolaSnap.docs.forEach(d => {
    const odpovedi = d.data().odpovedi || {};
    const novaOdpovedi = {};
    let kChanged = false;
    Object.keys(odpovedi).forEach(jmeno => {
      const noveJmeno = TERMIN_NAME_MIGRATION[jmeno] || jmeno;
      if (noveJmeno !== jmeno) kChanged = true;
      novaOdpovedi[noveJmeno] = odpovedi[jmeno];
    });
    if (kChanged) { batch.update(d.ref, { odpovedi: novaOdpovedi }); changed = true; }
  });
  if (changed) await batch.commit();
}

function subscribeAll() {
  db.collection('members').onSnapshot(snap => { state.members = fromSnap(snap); rerenderActive(); },
    () => toast('Chyba při načítání členů'));
  db.collection('rums').onSnapshot(snap => { state.rums = fromSnap(snap); rerenderActive(); },
    () => toast('Chyba při načítání rumů'));
  db.collection('ratings').onSnapshot(snap => { state.ratings = fromSnap(snap); rerenderActive(); },
    () => toast('Chyba při načítání hodnocení'));
  db.collection('ledger').onSnapshot(snap => { state.ledger = fromSnap(snap); updateBalanceChip(); rerenderActive(); },
    () => toast('Chyba při načítání účtu'));
  db.collection('wishlist').onSnapshot(snap => { state.wishlist = fromSnap(snap); rerenderActive(); },
    () => toast('Chyba při načítání wishlistu'));
  db.collection('cigar_ratings').onSnapshot(snap => { state.cigarRatings = fromSnap(snap); rerenderActive(); },
    () => toast('Chyba při načítání hodnocení doutníků'));
  db.collection('ledger_doutniky').onSnapshot(snap => { state.ledgerDoutniky = fromSnap(snap); updateBalanceChip(); rerenderActive(); },
    () => toast('Chyba při načítání účtu doutníků'));
  db.collection('cigars').onSnapshot(snap => { state.cigars = fromSnap(snap); rerenderActive(); if (!document.getElementById('cigarDetailOverlay').hidden) renderCigarDetail(); },
    () => toast('Chyba při načítání humidoru'));
  db.collection('cigar_log').onSnapshot(snap => { state.cigarLog = fromSnap(snap); rerenderActive(); if (!document.getElementById('cigarDetailOverlay').hidden) renderCigarDetail(); },
    () => toast('Chyba při načítání kouření'));
  db.collection('termin_ucastnici').onSnapshot(snap => { state.terminUcastnici = fromSnap(snap); rerenderActive(); },
    () => toast('Chyba při načítání účastníků termínů'));
  db.collection('termin_kola').onSnapshot(snap => { state.terminKola = fromSnap(snap); rerenderActive(); if (!document.getElementById('koloDetailOverlay').hidden) renderKoloDetail(); },
    () => toast('Chyba při načítání termínů'));
  db.collection('ucast').onSnapshot(snap => { state.ucasti = fromSnap(snap); rerenderActive(); if (!document.getElementById('ucastDetailOverlay').hidden) renderUcastDetail(); },
    () => toast('Chyba při načítání účasti'));
}

function rerenderActive() {
  if (ui.tab === 'rumy') renderRumy();
  else if (ui.tab === 'degustace') renderActiveDegustaceForm();
  else if (ui.tab === 'ucet') renderUcet();
  else if (ui.tab === 'wishlist') renderWishlist();
  else if (ui.tab === 'humidor') renderHumidor();
  else if (ui.tab === 'terminy') renderTerminy();
  else if (ui.tab === 'ucast') renderUcast();
  else if (ui.tab === 'statistika') renderStatistika();
  else if (ui.tab === 'info') renderInfo();
  else if (ui.tab === 'klub') renderKlub();
}


async function init() {
  if (!FIREBASE_CONFIG.apiKey || FIREBASE_CONFIG.apiKey.indexOf('SEM_VLOZ') === 0) {
    document.getElementById('offlineNote').hidden = false;
    document.getElementById('offlineNote').innerHTML =
      '<div class="big">🥃⚙️</div><div>Appka ještě není nastavená.<br>Otevři soubor <code>index.html</code> a do <code>FIREBASE_CONFIG</code> na začátku &lt;script&gt; vlož údaje ze svého Firebase projektu (návod je v README-NASAZENI.md).</div>';
    updateSyncIndicator();
    return;
  }
  try {
    firebase.initializeApp(FIREBASE_CONFIG);
    // App Check (reCAPTCHA Enterprise) – hned po initu, před ostatními službami.
    try {
      if (typeof APP_CHECK_KEY === 'string' && APP_CHECK_KEY && firebase.appCheck) {
        firebase.appCheck().activate(
          new firebase.appCheck.ReCaptchaEnterpriseProvider(APP_CHECK_KEY),
          true,
        );
      }
    } catch (acErr) {
      console.warn('App Check se nezapnul (appka funguje dál):', acErr);
    }
    try {
      await firebase.auth().signInAnonymously();
    } catch (authErr) {
      console.error('Anonymní přihlášení selhalo (zkontroluj, že je v Firebase konzoli zapnuté Authentication -> Sign-in method -> Anonymous):', authErr);
    }
    db = firebase.firestore();
    try {
      await db.enablePersistence({ synchronizeTabs: true });
    } catch (persistErr) {
      // 'failed-precondition' = appka otevřená ve víc panelech, 'unimplemented' = prohlížeč to neumí — appka funguje dál, jen bez offline režimu
      console.warn('Offline režim se nezapnul:', persistErr && persistErr.code);
    }
    instrumentWrites();
    try {
      storage = firebase.storage();
    } catch (storageErr) {
      // Storage nemusí být v projektu zapnutý — appka funguje dál, jen bez fotek
      console.warn('Firebase Storage se nepodařilo inicializovat (fotky nebudou fungovat):', storageErr);
      storage = null;
    }
  } catch (e) {
    console.error('Firebase se nepodařilo inicializovat:', e);
    db = null;
  }
  if (!db) {
    document.getElementById('offlineNote').hidden = false;
    updateSyncIndicator();
    return;
  }
  updateSyncIndicator();
  try {
    await maybeSeed();
  } catch(e) { /* seeding races are harmless; ignore */ console.error('Seed:', e); }
  try {
    await maybeSeedHumidor();
  } catch(e) { console.error('Seed humidor:', e); }
  try {
    await maybeSeedTerminy();
  } catch(e) { console.error('Seed terminy:', e); }
  try {
    await migrateTerminyNames();
  } catch(e) { console.error('Migrace jmen termínů:', e); }
  try {
    await maybeSeedUcast();
  } catch(e) { console.error('Seed účast:', e); }
  try {
    await maybeSeedDoutniky();
  } catch(e) { console.error('Seed doutníky:', e); }
  try {
    await maybeSeedLedgerDoutniky();
  } catch(e) { console.error('Seed účet doutníky:', e); }
  subscribeAll();
}

/* ---------------- PIN zámek ---------------- */
function applyGuestRestrictions() {
  if (!isGuest) return;
  ['degustace','ucet'].forEach(tab => {
    document.querySelectorAll(`[data-tab="${tab}"]`).forEach(btn => { btn.hidden = true; });
  });
  const addMemberCard = document.getElementById('addMemberCard');
  if (addMemberCard) addMemberCard.hidden = true;
  const wishToggleBtn = document.getElementById('wishToggleBtn');
  if (wishToggleBtn) wishToggleBtn.hidden = true;
}

// Nástroje v Info se skládají v renderInfoTools() podle role; tady už nic netřeba.
function applyAdminFeatures() {}

function startApp() {
  if (currentUser) ui.selectedMember = currentUser;
  updateSyncIndicator();
  syncTypUI();
  renderRumy();
  applyGuestRestrictions();
  applyAdminFeatures();
  init();
}

function saveSession(role, user) {
  try { localStorage.setItem('rumklub_session', JSON.stringify({ role, user })); } catch(e) {}
}

const PIN_LOCKOUT_KEY = 'rumklub_pin_lockout';
const PIN_LOCKOUT_MAX_ATTEMPTS = 3;
const PIN_LOCKOUT_MS = 15 * 60 * 1000;

function getPinLockout() {
  try { return JSON.parse(localStorage.getItem(PIN_LOCKOUT_KEY) || 'null') || { count: 0, lockUntil: 0 }; }
  catch(e) { return { count: 0, lockUntil: 0 }; }
}
function savePinLockout(st) {
  try { localStorage.setItem(PIN_LOCKOUT_KEY, JSON.stringify(st)); } catch(e) {}
}
function clearPinLockout() {
  try { localStorage.removeItem(PIN_LOCKOUT_KEY); } catch(e) {}
}
function pinLockRemainingMs() {
  return Math.max(0, (getPinLockout().lockUntil || 0) - Date.now());
}
function formatRemaining(ms) {
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m} min${s > 0 ? ' ' + s + ' s' : ''}` : `${s} s`;
}

function updatePinLockUI() {
  const remaining = pinLockRemainingMs();
  const err = document.getElementById('pinError');
  const input = document.getElementById('pinInput');
  const btn = document.getElementById('pinUnlockBtn');
  if (remaining > 0) {
    err.textContent = `Příliš mnoho pokusů. Zkus to znovu za ${formatRemaining(remaining)}.`;
    if (input) input.disabled = true;
    if (btn) btn.disabled = true;
    if (!window._pinLockTimer) {
      window._pinLockTimer = setInterval(() => {
        if (pinLockRemainingMs() <= 0) {
          clearInterval(window._pinLockTimer);
          window._pinLockTimer = null;
          clearPinLockout();
          err.textContent = '';
          if (input) { input.disabled = false; input.focus(); }
          if (btn) btn.disabled = false;
        } else {
          updatePinLockUI();
        }
      }, 1000);
    }
    return true;
  }
  if (input) input.disabled = false;
  if (btn) btn.disabled = false;
  return false;
}

// SHA-256(pin + PIN_SALT) v hex – stejně se počítají uložené hashe v index.html.
async function pinHash(pin) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(pin) + PIN_SALT));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function checkPin() {
  const err = document.getElementById('pinError');
  if (updatePinLockUI()) { document.getElementById('pinInput').value = ''; return; }
  const val = document.getElementById('pinInput').value.trim();
  const h = val ? await pinHash(val) : '';
  const memberName = h ? Object.keys(MEMBER_PIN_HASHES).find(name => MEMBER_PIN_HASHES[name] === h) : null;
  if (h && h === APP_PIN_HASH) {
    isGuest = false; isAdmin = true; currentUser = null;
    saveSession('admin', null);
  } else if (memberName) {
    isGuest = false; isAdmin = false; currentUser = memberName;
    saveSession('member', memberName);
  } else if (h && h === GUEST_PIN_HASH) {
    isGuest = true; isAdmin = false; currentUser = null;
    saveSession('guest', null);
  } else {
    const st = getPinLockout();
    st.count = (st.count || 0) + 1;
    if (st.count >= PIN_LOCKOUT_MAX_ATTEMPTS) {
      st.lockUntil = Date.now() + PIN_LOCKOUT_MS;
      st.count = 0;
      savePinLockout(st);
      updatePinLockUI();
    } else {
      savePinLockout(st);
      err.textContent = `Špatný PIN, zkus to znovu. (${PIN_LOCKOUT_MAX_ATTEMPTS - st.count} ${PIN_LOCKOUT_MAX_ATTEMPTS - st.count === 1 ? 'pokus' : 'pokusy'} do zamčení)`;
    }
    document.getElementById('pinInput').value = '';
    document.getElementById('pinInput').focus();
    return;
  }
  clearPinLockout();
  document.getElementById('pinGate').hidden = true;
  startApp();
}

function lockApp() {
  try { localStorage.removeItem('rumklub_session'); localStorage.removeItem('rumklub_pin_ok'); } catch(e) {}
  location.reload();
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW registrace selhala:', e));
  });
}

document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  const _fy = document.getElementById('footYear'); if (_fy) _fy.textContent = new Date().getFullYear();
  const gate = document.getElementById('pinGate');
  const pinInput = document.getElementById('pinInput');
  pinInput.addEventListener('keydown', e => { if (e.key === 'Enter') checkPin(); });
  let session = null;
  try {
    const raw = localStorage.getItem('rumklub_session');
    if (raw) session = JSON.parse(raw);
    else if (localStorage.getItem('rumklub_pin_ok') === '1') session = { role: 'admin', user: null }; // starší appka před osobními kódy
  } catch(e) {}
  if (session && (session.role === 'admin' || session.role === 'member' || session.role === 'guest')) {
    isAdmin = session.role === 'admin';
    isGuest = session.role === 'guest';
    currentUser = session.role === 'member' ? session.user : null;
    gate.hidden = true;
    startApp();
  } else {
    gate.hidden = false;
    if (!updatePinLockUI()) pinInput.focus();
  }
});
