#!/usr/bin/env node
/*
  cleanup-ebirdcache.mjs

  Supprime les docs ebirdCache trop vieux (>90 jours) pour eviter que la
  collection grossisse a l'infini et sature le quota Firestore free (1 GB).

  Le cache eBird est un partage entre membres : quand qqun appelle l'API eBird
  (bar chart, obs recentes...), la reponse est sauvegardee sous /leagues/{lg}/
  ebirdCache/{urlHash}. Les autres membres beneficient du cache. Mais les
  entrees ne sont jamais nettoyees -> collection qui gonfle.

  A relancer 1x/mois (ou tous les 3-6 mois selon usage).

  Setup : meme que backup-firestore.mjs (firebase-admin-key.json + npm install
  firebase-admin dans tools/config/).

  Usage :
    node tools/build/cleanup-ebirdcache.mjs            # dry-run par defaut (aucune suppression)
    node tools/build/cleanup-ebirdcache.mjs --delete   # vraie suppression
*/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, '..', '..');
const KEY_PATH = path.join(ROOT, 'tools', 'config', 'firebase-admin-key.json');
const MAX_AGE_DAYS = 90;
const DRY_RUN = !process.argv.includes('--delete');

if (!fs.existsSync(KEY_PATH)) {
  console.error(`ERREUR : cle Admin SDK manquante a ${KEY_PATH}`);
  console.error(`Suit le setup de backup-firestore.mjs pour la creer.`);
  process.exit(1);
}

let initializeApp, cert, getFirestore;
try {
  ({ initializeApp, cert } = await import('firebase-admin/app'));
  ({ getFirestore } = await import('firebase-admin/firestore'));
} catch (e) {
  console.error(`ERREUR firebase-admin : ${e.message}`);
  console.error(`Lance : npm install firebase-admin`);
  process.exit(1);
}

const serviceAccount = JSON.parse(fs.readFileSync(KEY_PATH, 'utf-8'));
initializeApp({ credential: cert(serviceAccount) });
const db = getFirestore();

const cutoffDate = new Date(Date.now() - MAX_AGE_DAYS * 86400000);
console.log(`Mode : ${DRY_RUN ? 'DRY-RUN (aucune suppression)' : '⚠️  SUPPRESSION REELLE'}`);
console.log(`Cutoff : docs plus vieux que ${cutoffDate.toISOString()} (${MAX_AGE_DAYS} jours)\n`);

// Iterate sur toutes les ligues (Cas de test : plusieurs ligues actives)
const leagues = await db.collection('leagues').listDocuments();
let grandTotal = 0, grandDeleted = 0;

for (const lgRef of leagues) {
  const lgId = lgRef.id;
  const cacheRef = lgRef.collection('ebirdCache');

  // Diagnostic : recupere les 5 docs les plus vieux + les 5 plus recents
  const oldest = await cacheRef.orderBy('updatedAt', 'asc').limit(5).get();
  const newest = await cacheRef.orderBy('updatedAt', 'desc').limit(5).get();
  if (!oldest.empty) {
    const oldestTs = oldest.docs[0].data().updatedAt?.toDate?.();
    const newestTs = newest.docs[0].data().updatedAt?.toDate?.();
    const oldestDays = oldestTs ? Math.round((Date.now() - oldestTs.getTime()) / 86400000) : '?';
    const newestDays = newestTs ? Math.round((Date.now() - newestTs.getTime()) / 86400000) : '?';
    console.log(`  [diag ${lgId}] doc le plus vieux : ${oldestDays}j, plus recent : ${newestDays}j`);
  }

  // Query par lots de 500 (limite Firestore)
  let totalScanned = 0, totalDeleted = 0;
  let hasMore = true;

  while (hasMore) {
    const snap = await cacheRef
      .where('updatedAt', '<', cutoffDate)
      .limit(500)
      .get();
    if (snap.empty) { hasMore = false; break; }

    totalScanned += snap.size;
    if (DRY_RUN) {
      totalDeleted += snap.size;
      hasMore = snap.size === 500;   // if full batch, might be more
    } else {
      const batch = db.batch();
      snap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
      totalDeleted += snap.size;
      hasMore = snap.size === 500;
    }
  }

  // Total actuel restant apres cleanup (pour info)
  const remainingSnap = await cacheRef.count().get();
  const remaining = remainingSnap.data().count;

  const verb = DRY_RUN ? 'seraient supprimes' : 'supprimes';
  console.log(`  leagues/${lgId}/ebirdCache : ${totalDeleted} ${verb}, ${remaining} conserves`);
  grandTotal += (totalDeleted + remaining);
  grandDeleted += totalDeleted;
}

console.log(`\n=== ${DRY_RUN ? 'DRY-RUN' : 'Termine'} ===`);
console.log(`Total ligues : ${leagues.length}`);
console.log(`Docs ${DRY_RUN ? 'candidats a suppression' : 'supprimes'} : ${grandDeleted}`);
if (DRY_RUN && grandDeleted > 0) {
  console.log(`\nRelance avec --delete pour supprimer pour de vrai :`);
  console.log(`  node tools/build/cleanup-ebirdcache.mjs --delete`);
}
