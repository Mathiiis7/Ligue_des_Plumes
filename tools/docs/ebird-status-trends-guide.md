# Guide : intégrer eBird Status & Trends

But : obtenir des cartes d'abondance haute résolution (débiaisées) par espèce × département × mois, pour améliorer la rareté géographique dans l'app.

Prévu pour session du **2026-08-01**.

---

## 1. Setup R + ebirdst (~15 min)

### 1.1 Installer R

- **Windows** : télécharger depuis [cran.r-project.org/bin/windows/base](https://cran.r-project.org/bin/windows/base/) → installer avec les options par défaut.
- Optionnel mais recommandé : installer **RStudio Desktop** (gratuit) depuis [posit.co/download/rstudio-desktop](https://posit.co/download/rstudio-desktop/) - IDE pour R, bien plus confortable que la console pure.

### 1.2 Installer le package ebirdst

Ouvrir R (ou RStudio) et taper :

```r
install.packages("ebirdst")
install.packages("terra")   # dépendance pour lire les rasters GeoTIFF
install.packages("dplyr")   # manipulation tabulaire
install.packages("sf")      # géo vectoriel (départements FR)
```

Test que ça marche :

```r
library(ebirdst)
packageVersion("ebirdst")   # devrait afficher 3.x.x ou plus récent
```

---

## 2. Clé d'accès Cornell (~5 min, gratuit)

eBird Status & Trends nécessite une **access key** distincte de la clé API v2.

- Aller sur [science.ebird.org/en/status-and-trends/download-data](https://science.ebird.org/en/status-and-trends/download-data)
- "Request an Access Key" → formulaire (nom, email, brève description usage : "hobby web app comparing life lists among friends")
- Réponse par email en général sous 24 h
- Une fois la clé reçue, dans R :

```r
set_ebirdst_access_key("TA_CLE_ICI")
```

La clé est stockée dans `~/.Renviron`, persistante entre sessions.

---

## 3. Trouver la liste des espèces couvertes en France

Toutes les espèces mondiales ne sont pas modélisées (~2 000 sur ~11 000). Il faut identifier lesquelles.

```r
library(ebirdst)
library(dplyr)
runs <- ebirdst_runs
# Espèces avec des données de "abundance" (le champ qui nous intéresse)
avail <- runs %>% filter(has_seasonal_abundance == TRUE)
nrow(avail)   # nombre total d'espèces avec abondance
head(avail[, c("species_code", "common_name", "scientific_name")])
```

Pour filtrer sur celles observées en France : croiser avec la liste `Object.keys(FR_NAMES)` de l'app. Deux options :

- Charger le JSON de `tools/rarity-data-ebird.json` (contient tous nos sci names)
- Ou juste filtrer `ebirdst_runs` par pays via des tests visuels après téléchargement

Estimation : **~500-700 espèces** téléchargeables et utiles pour l'app.

---

## 4. Télécharger les données par espèce

**⚠️ Attention taille** : chaque espèce = 100-500 MB en résolution native (`low_res`). En résolution `hr` (high resolution), plusieurs GB.

Configuration recommandée pour notre usage :

```r
# Dossier de stockage local (pas dans le repo, gitignoré)
options(ebirdst_data_dir = "C:/ebird-status-trends-data")
```

Téléchargement d'une espèce test (Pic épeiche pour tester) :

```r
# 'lr' = low resolution (~3km), suffisant pour agrégat départemental
dl <- ebirdst_download_status("dowo1", pattern = "abundance_seasonal_lr")
```

Puis pour toutes les espèces cibles (loop) :

```r
sci_list <- readLines("liste_sci_names.txt")   # à préparer depuis FR_NAMES
codes <- ebirdst_runs %>%
  filter(scientific_name %in% sci_list) %>%
  pull(species_code)

for (code in codes) {
  tryCatch(
    ebirdst_download_status(code, pattern = "abundance_seasonal_lr"),
    error = function(e) message("Skip ", code, " : ", e$message)
  )
}
```

**Temps estimé** : 1 espèce ≈ 30 s à 2 min de download selon serveur. 500 espèces × 1 min moyen = **~8 h de download**. Fais tourner la nuit.

---

## 5. Extraire l'abondance par département FR × mois

Une fois les données locales, on agrège :

```r
library(sf)
library(terra)

# Charger les contours des 96 départements FR depuis IGN ou geoJSON
# (fichier statique à mettre dans le repo une fois)
depts <- st_read("data/departements-france.geojson")
# Colonne "code" = code INSEE ex "83", "75" - on convertira vers FR-PAC-83 etc.

# Pour chaque espèce, calculer l'abondance moyenne par département × semaine
abundance_by_dept <- function(sp_code) {
  rast <- load_raster(sp_code, resolution = "3km", period = "seasonal")
  # rast = SpatRaster 4 saisons ou 52 semaines selon dispo
  # Zonal stats : moyenne par polygone dept
  ext <- terra::extract(rast, terra::vect(depts), fun = mean, na.rm = TRUE)
  # Réorganiser en { dept_code: [12 valeurs mensuelles] }
  ...
}
```

Sortie finale : un JSON compact
```json
{
  "picus viridis": {
    "FR-PAC-83": [0.45, 0.42, 0.38, ...],   // 12 valeurs mois
    "FR-BRE-29": [0.61, 0.58, ...],
    ...
  }
}
```

**Estimation taille** : 600 espèces × 96 dept × 12 mois × 4 octets = 2.8 MB brut. Gzippé ≈ 700 KB. Léger, embeddable.

---

## 6. Intégration dans l'app

Une fois le JSON généré, côté client :

1. Ajouter `SPECIES_DEPT_ABUNDANCE` inline dans `index.html` (ou fichier séparé lazy-loaded)
2. Nouvelle fonction `abundanceAt(sci, deptCode, month)` avec cascade dept > région (moyenne des dept enfants) > national (moyenne toutes régions) > fallback bar chart actuel
3. **Décision d'usage** :
   - Cartes seulement (couleur/filtres) → poids classement reste national (équité)
   - OU aussi pour classement (débat à faire)

---

## Récap effort

| Étape | Temps | Actionnable par |
|---|---|---|
| Setup R + packages | 15 min | Mathis |
| Clé Cornell | 5 min form + 24 h attente | Mathis |
| Script extraction + test | 2-3 h | Claude |
| Téléchargement données | 8 h (nuit) | Machine seule |
| Agrégation dept × mois | 1 h | Claude |
| Intégration client | 2 h | Claude |
| **Total humain actif** | **~30 min de setup + qq clics** | |
| **Total wall-clock** | **~2 jours (attente clé + nuit de DL)** | |

---

## Alternatives si trop lourd

- **Skip download complet** : ne prendre que les espèces "problématiques" (celles avec forte variance régionale attendue : puffins, aigles alpins, méditerranéennes). ~100 espèces = 1 h de DL.
- **Utiliser directement les couches d'abondance en tiles** : eBird héberge des cartes web tiles de leurs modèles. Moins précis mais zéro download.

---

## Documentation officielle utile

- [ebirdst package tutorial](https://ebird.github.io/ebirdst/)
- [Status & Trends FAQ](https://science.ebird.org/en/status-and-trends/faq)
- [Data license](https://science.ebird.org/en/status-and-trends/citations) - free for non-commercial + attribution obligatoire
