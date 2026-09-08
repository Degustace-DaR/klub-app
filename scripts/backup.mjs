// Denní záloha databáze (Firestore) a fotek (Storage) projektu Firebase.
// Spouští ji GitHub Action (.github/workflows/backup.yml) jednou denně.
//
// Výstup:
//   backups/db/klub-RRRR-MM-DD.json   – všechny kolekce ve stejném formátu,
//                                       jaký umí naimportovat samotná appka
//                                       (Info → Import databáze)
//   backups/photos/...                – zrcadlo souborů z Firebase Storage
//
// Potřebuje proměnnou prostředí FIREBASE_SA_KEY = obsah servisního klíče (JSON).
// Volitelně STORAGE_BUCKET, když se název bucketu liší od <projekt>.firebasestorage.app.

import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { getStorage } from 'firebase-admin/storage';
import { mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const saRaw = process.env.FIREBASE_SA_KEY;
if (!saRaw) {
  console.error('Chybí FIREBASE_SA_KEY (secret v nastavení repa → Actions).');
  process.exit(1);
}
const sa = JSON.parse(saRaw);
const projectId = sa.project_id;
const bucketName = process.env.STORAGE_BUCKET || `${projectId}.firebasestorage.app`;

initializeApp({ credential: cert(sa), storageBucket: bucketName });
const db = getFirestore();

// Stejný seznam jako v appce (app.js: DB_EXPORT_COLLECTIONS) + meta.
const COLLECTIONS = [
  'members', 'rums', 'ratings', 'ledger', 'wishlist',
  'cigars', 'cigar_log', 'cigar_ratings', 'ledger_doutniky',
  'termin_ucastnici', 'termin_kola', 'ucast', 'activity_log', 'meta',
];

const today = new Date().toISOString().slice(0, 10);

// Firestore Timestamp / GeoPoint apod. → prostý JSON.
function clean(v) {
  if (v instanceof Timestamp) return v.toDate().toISOString();
  if (Array.isArray(v)) return v.map(clean);
  if (v && typeof v === 'object') {
    if (typeof v._seconds === 'number' && typeof v._nanoseconds === 'number') {
      return new Date(v._seconds * 1000 + Math.round(v._nanoseconds / 1e6)).toISOString();
    }
    const o = {};
    for (const k of Object.keys(v)) o[k] = clean(v[k]);
    return o;
  }
  return v;
}

/* ---------- Firestore ---------- */
const collections = {};
let total = 0;
for (const col of COLLECTIONS) {
  const snap = await db.collection(col).get();
  collections[col] = snap.docs.map((d) => ({ id: d.id, ...clean(d.data()) }));
  total += collections[col].length;
}

const payload = {
  _export: 'rum-klub-db',
  _version: 1,
  _exportedAt: new Date().toISOString(),
  _sourceProject: projectId,
  _source: 'github-action-backup',
  collections,
};

await mkdir('backups/db', { recursive: true });
const dbFile = `backups/db/klub-${today}.json`;
await writeFile(dbFile, JSON.stringify(payload, null, 1));
console.log(
  `DB → ${dbFile}  (${total} dokumentů: ` +
    Object.entries(collections).map(([k, a]) => `${k} ${a.length}`).join(', ') +
    ')',
);

/* ---------- Storage (fotky) ---------- */
try {
  const [files] = await getStorage().bucket().getFiles();
  const seen = new Set();
  let n = 0;
  let bytes = 0;
  for (const f of files) {
    if (f.name.endsWith('/')) continue;
    const dest = join('backups/photos', f.name);
    seen.add(dest);
    await mkdir(dirname(dest), { recursive: true });
    await f.download({ destination: dest });
    n += 1;
    bytes += Number(f.metadata?.size || 0);
  }
  // smaž lokální kopie, které už ve Storage nejsou
  const walk = async (dir) => {
    let items;
    try {
      items = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of items) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (!seen.has(p)) {
        await rm(p);
        console.log(`  odstraněno (už není ve Storage): ${p}`);
      }
    }
  };
  await walk('backups/photos');
  console.log(`Storage → backups/photos/  (${n} souborů, ${(bytes / 1024 / 1024).toFixed(1)} MB)`);
} catch (e) {
  console.warn('Storage záloha přeskočena:', e.message);
}

/* ---------- prořez: nech 30 posledních denních + vždy 1. den v měsíci ---------- */
const cutoff = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
for (const f of await readdir('backups/db')) {
  const m = f.match(/^klub-(\d{4}-\d{2}-\d{2})\.json$/);
  if (m && m[1] < cutoff && !m[1].endsWith('-01')) {
    await rm(join('backups/db', f));
    console.log(`prořez: smazáno ${f}`);
  }
}

console.log('Hotovo.');
