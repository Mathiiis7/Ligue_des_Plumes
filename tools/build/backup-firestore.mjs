#!/usr/bin/env node
/*
  backup-firestore.mjs

  Export complet de toutes les collections Firestore vers un fichier JSON
  horodate. Utilise le Firebase Admin SDK avec un service account key (a
  telecharger depuis Firebase Console).

  Sortie :
    tools/backups/firestore-YYYY-MM-DD-HHMM.json

  Setup (une seule fois) :
    1) Firebase Console -> Parametres du projet -> Comptes de service -> Generer
       une nouvelle cle privee -> telecharge le JSON.
    2) Renomme-le en `firebase-admin-key.json` et pose-le dans tools/config/
       (ce fichier est deja dans .gitignore, tu peux pas le pousser par erreur).
    3) Installe la dep : `npm install firebase-admin` a la racine du repo.

  Usage :
    node tools/build/backup-firestore.mjs

  Recommande : lance-le manuellement 1x/semaine ou avant chaque grosse operation
  (migration Firestore, refonte rules, etc.). Garde les 5 derniers backups en
  local + 1 copie dans un cloud (Google Drive, Dropbox...).
*/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, '..', '..');
const KEY_PATH = path.join(ROOT, 'tools', 'config', 'firebase-admin-key.json');
const OUT_DIR = path.join(ROOT, 'tools', 'backups');

if (!fs.existsSync(KEY_PATH)) {
  console.error(`ERREUR : cle Admin SDK manquante`);
  console.error(`Attendue a : ${KEY_PATH}`);
  console.error(`\nSetup :`);
  console.error(`  1) Firebase Console -> Parametres du projet -> Comptes de service`);
  console.error(`  2) Bouton "Generer une nouvelle cle privee" -> telecharge le JSON`);
  console.error(`  3) Sauve-le sous : ${KEY_PATH}`);
  console.error(`\nCe fichier est deja dans .gitignore, aucun risque de push public.`);
  process.exit(1);
}

let initializeApp, cert, getFirestore;
try {
  ({ initializeApp, cert } = await import('firebase-admin/app'));
  ({ getFirestore } = await import('firebase-admin/firestore'));
} catch (e) {
  console.error(`ERREUR : firebase-admin non installe ou import ESM foire`);
  console.error(`Lance a la racine du repo :`);
  console.error(`  npm install firebase-admin`);
  console.error(`Detail : ${e.message}`);
  process.exit(1);
}

const serviceAccount = JSON.parse(fs.readFileSync(KEY_PATH, 'utf-8'));
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// Serialise les Timestamps Firestore + refs proprement en JSON
function serialize(v) {
  if (v === null || v === undefined) return v;
  if (v && typeof v.toDate === 'function') return { _type: 'timestamp', iso: v.toDate().toISOString() };
  if (v instanceof Date) return { _type: 'date', iso: v.toISOString() };
  if (Array.isArray(v)) return v.map(serialize);
  if (typeof v === 'object' && v.constructor === Object) {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = serialize(val);
    return out;
  }
  return v;
}

// Recurse dans les sous-collections. listCollections() est LENT (~100ms par doc)
// donc on ne l'appelle QUE sur les docs qu'on sait etre des containers (leagues/{lg}).
// Les leaf docs (chat, photos, comments...) sont dumped sans check subs.
const CONTAINER_COLLECTIONS = new Set(['leagues']);
async function dumpCollection(collRef, path, depth = 0) {
  // Recupere les docs explicites via .get() (rapide, une seule query) au lieu de
  // listDocuments() qui necessite 1 get() par doc pour recuperer les fields.
  const snap = await collRef.get();
  const docs = {};
  let subCount = 0;
  const isContainer = CONTAINER_COLLECTIONS.has(collRef.id);

  // Pour les containers (leagues), on utilise listDocuments pour recuperer aussi les implicites
  let docList;
  if (isContainer) {
    const refs = await collRef.listDocuments();
    docList = [];
    for (const r of refs) {
      const s = await r.get();
      docList.push({ ref: r, snap: s });
    }
  } else {
    docList = snap.docs.map(d => ({ ref: d.ref, snap: d }));
  }

  for (const { ref, snap: dSnap } of docList) {
    const data = dSnap.exists ? serialize(dSnap.data()) : null;
    docs[ref.id] = { _data: data };
    if (!dSnap.exists) docs[ref.id]._implicit = true;
    // Sous-collections : seulement pour les docs containers (evite 100ms x N leaf docs)
    if (isContainer) {
      const subs = await ref.listCollections();
      if (subs.length > 0) {
        docs[ref.id]._subs = {};
        for (const sub of subs) {
          const subDump = await dumpCollection(sub, `${path}/${ref.id}/${sub.id}`, depth + 1);
          docs[ref.id]._subs[sub.id] = subDump;
          subCount += Object.keys(subDump).length;
        }
      }
    }
  }
  const details = subCount > 0
    ? `${docList.length} docs + ${subCount} sub-docs`
    : `${docList.length} docs`;
  console.log(`  ${path} : ${details}`);
  return docs;
}

console.log('Backup Firestore en cours...\n');
const start = Date.now();
const collections = await db.listCollections();
console.log(`Collections racine : ${collections.map(c => c.id).join(', ')}\n`);

const backup = {
  _meta: {
    projectId: serviceAccount.project_id,
    backupAt: new Date().toISOString(),
    version: 1,
  },
  data: {},
};

for (const coll of collections) {
  backup.data[coll.id] = await dumpCollection(coll, coll.id);
}

const stamp = new Date().toISOString().replace(/T/, '-').replace(/:/g, '').slice(0, 15);
const outFile = path.join(OUT_DIR, `firestore-${stamp}.json`);
fs.writeFileSync(outFile, JSON.stringify(backup, null, 2));

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
const sizeMB = (fs.statSync(outFile).size / 1024 / 1024).toFixed(2);
console.log(`\n=== Backup termine ===`);
console.log(`Fichier : ${outFile}`);
console.log(`Poids   : ${sizeMB} MB`);
console.log(`Duree   : ${elapsed}s`);
console.log(`\nGarde ce fichier en lieu sur (Google Drive, Dropbox, disque externe).`);
