# La Ligue des Plumes

Webapp de comparaison de listes d'observations d'oiseaux entre amis, basée sur les données eBird / Cornell Status & Trends / xeno-canto / Avonet.

Deployée sur GitHub Pages : [mathiiis7.github.io/Ligue_des_Plumes](https://mathiiis7.github.io/Ligue_des_Plumes/)

## Structure du projet

```
Ligue_des_Plumes/
├── index.html              structure HTML (squelette + link CSS + script)
├── styles.css              toute la CSS de l'app
├── app.js                  module JS principal (Firebase + logique métier)
├── service-worker.js       PWA cache stale-while-revalidate
├── manifest.json           PWA manifest (nom, icône, thème)
├── logo.png                icône PWA
│
├── assets/
│   └── icons/              23 icônes de trophées (aigle, roi, kimono, etc.)
│
├── data/                   toutes les données statiques servies au client
│   ├── avonet_traits.json  traits écologiques + morphologiques de 10 584 espèces
│   ├── range-index.json    manifest cartes de répartition Cornell S&T
│   ├── range/              PNGs heatmap d'abondance par espèce
│   ├── generated/          data intermédiaire (gitignored, générée par tools/build/)
│   └── countries/          data par pays
│       ├── fr/
│       │   ├── abundance_st_by_region.json
│       │   ├── abundance_dept.json
│       │   ├── abundance_dept_mean.json
│       │   └── freq_by_region.json
│       ├── es/, gb/, it/, me/, pt/  (même structure minimale)
│
└── tools/
    ├── build/              scripts Node.js de build data (18 scripts .mjs)
    ├── config/             firestore.rules + geojson français
    ├── docs/               guides markdown
    ├── ebirdst/            scripts R pour Cornell Status & Trends
    │                       (build-abundance-by-region-multi.R, build-range-maps.R)
    ├── logs/               logs de builds passés (gitignored)
    ├── ebird-barcharts-raw/ barcharts bruts eBird (gitignored)
    └── createur-badge.html  outil perso génération badge
```

## Sources de données

- **eBird API v2** : liste d'espèces par région, catégorie exotique
- **eBird bar chart** : fréquence d'observation mensuelle par région (via scraping cookie session)
- **Cornell Status & Trends (via R package ebirdst)** : abondance moyenne annuelle + weekly par pixel 9km
- **xeno-canto API v3** : sons (chants + cris) par espèce
- **Avonet dataset** (Tobias et al. 2022) : traits écologiques et morphologiques
- **GBIF species API** : statut IUCN mondial
- **IUCN Red List France** (données locales) : statut national

## Commandes utiles

```bash
# Regenerer la donnée par pays (nécessite cookie eBird actif)
EBIRD_COOKIE="..." node tools/build/download-bar-charts-regional.mjs

# Regenerer abundance Cornell par pays (nécessite clé ebirdst)
Rscript tools/ebirdst/build-abundance-by-region-multi.R

# Regenerer cartes de répartition Cornell (mode world = tout, demo = 3 espèces)
Rscript tools/ebirdst/build-range-maps.R
Rscript tools/ebirdst/build-range-maps.R demo

# Regenerer traits Avonet
node tools/build/build-avonet-traits.mjs

# Regenerer IUCN redlist mondial
node tools/build/enrich-redlist-global-full.mjs
```

## Architecture technique

- **Front pur** : aucun backend, tout est statique + Firebase pour l'auth et la synchro utilisateur
- **Service Worker** : cache stale-while-revalidate pour rechargements instantanés
- **PWA** : installable sur écran d'accueil (mobile + desktop)
- **Lazy loading** : les grosses data (freq régionale, avonet traits, range maps) sont fetch à la demande

## Dashboard interne

Documentation vivante de tout ce qui existe / à faire : [dashboard](https://claude.ai/code/artifact/437344f3-b6f8-404d-aa00-c40e010402ba)
