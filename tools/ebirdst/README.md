# eBird Status & Trends — Migration prep

Ce dossier prepare la migration de `REAL_RARITY` / `REAL_FREQ_MONTHLY` /
`REAL_RARITY_ME_EBIRD` vers **eBird Status & Trends** (produit Cornell Lab
of Ornithology), qui utilise des modeles ML pour donner une abondance
scientifiquement calibree per-especes per-region, avec correction du biais
observateur et tendances decennales.

## Prerequis (a faire AVANT le run de demain)

### 1. R installe (tu l'as deja)
Verifier avec :
```bash
Rscript --version
```

### 2. Package `ebirdst`
Ouvrir R (interactive ou Rscript) :
```r
install.packages("ebirdst", repos = "https://cran.r-project.org")
```

Deps automatiques : `terra`, `sf`, `dplyr`, `stringr`, `httr` (~50 MB).

### 3. Cle Cornell (tu l'as deja, expire 26/01/2027)
La cle Status & Trends est differente de la cle eBird API v2.
Doit etre fournie une fois via variable d'environnement `EBIRDST_KEY`,
ou sauvee dans `~/.Renviron` pour persistence :

Option persistente (une fois pour toutes) :
```r
# Dans R:
usethis::edit_r_environ()
# Ajouter cette ligne dans le fichier ouvert :
EBIRDST_KEY=<ta-cle-cornell>
# Sauver, redemarrer R
```

Ou temporaire par session :
```bash
export EBIRDST_KEY=<ta-cle-cornell>
Rscript tools/ebirdst/test-setup.R
```

## Fichiers du dossier

| Fichier | Role |
|---|---|
| `setup.R` | Install ebirdst + verifie la cle Cornell |
| `test-setup.R` | POC : telecharge stats agregees d'UNE espece pour valider le setup complet |
| `build-abundance-by-country.R` | (a ecrire demain) Genere `tools/real-abundance-st.generated.js` avec abondance + trends par espece par pays |
| `country-polygons.R` | Utilitaire pour recuperer les polygones pays via `rnaturalearth` |

## Workflow prevu pour demain

1. Verifier le setup via `Rscript tools/ebirdst/test-setup.R` (doit sortir "OK species X abundance = 0.42 checklists/hour in FR")
2. Etendre `build-abundance-by-country.R` pour boucler sur ~500 especes FR + ME + autres pays
3. Extraire abondance moyenne + tendance decennale par espece par pays
4. Convertir abondance en tier 1-9 via seuils calibres
5. Ecrire `tools/real-abundance-st.generated.js` (nouveau fichier)
6. Modifier `index.html` : remplacer `REAL_RARITY`, `REAL_RARITY_ME_EBIRD` par le nouveau dict unified
7. Adapter `rarityForCountry()` pour lire la nouvelle source
8. Ajouter `trendForCountry()` et fleche visuelle sur les fiches especes
9. Test complet + push

Duree estimee : 3-4h dev + 30-60 min compute R.

## Coverage attendue

| Pays | Especes S&T dispo | Fallback bar chart |
|---|---|---|
| FR | ~450-500 / ~700 | Endemiques, accidentelles rares |
| ME | ~350-400 / ~350 | Peu de fallback |
| ES / IT / GR / HR | ~400-450 | Peu de fallback |
| MA | ~250-300 | Beaucoup pour endemiques nord-africaines |

Pour les especes sans donnees S&T (rare), on garde le fallback bar chart eBird
(deja en place). Aucune regression, juste des donnees plus precises la ou dispo.
