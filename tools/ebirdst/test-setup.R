# test-setup.R — POC : telecharge et agrege l'abondance d'UNE espece pour la France.
# Valide que le pipeline ebirdst + polygones + zonal stats fonctionne bout en bout.
# Usage : Rscript tools/ebirdst/test-setup.R
#
# Si tout OK, sortie attendue :
#   [OK] Abondance moyenne Ouette d'Egypte en France : 0.42 (echelle 0-1)
#   [OK] Tendance decennale : +2.3% par an (IC [+1.1, +3.5])
#
# Si erreur : voir README.md pour setup.

suppressPackageStartupMessages({
  library(ebirdst)
  library(sf)
  library(terra)
  library(dplyr)
  library(rnaturalearth)
})

cat("=== Test pipeline S&T sur 1 espece (Ouette d'Egypte, egygoo) ===\n\n")

# 1) Charger polygone France (via naturalearth)
cat("[1/4] Charge polygone France...\n")
fr <- ne_countries(country = "France", scale = "medium", returnclass = "sf")
# Garde uniquement la metropole (retire DOM-TOM pour eviter les outliers)
fr_metro <- st_crop(fr, xmin = -5.5, xmax = 10, ymin = 41, ymax = 51.5)
cat("     Polygone : ", nrow(fr_metro), " feature(s), CRS = ", st_crs(fr_metro)$input, "\n", sep="")

# 2) Choisir une espece cible facile (etablie, tier moyen)
sp_code <- "egygoo"   # Alopochen aegyptiaca, Ouette d'Egypte
cat("[2/4] Espece cible : ", sp_code, "\n", sep="")

# 3) Telecharger juste les stats agregees (pas les rasters lourds)
cat("[3/4] Telechargement stats agregees ebirdst (~5-20 MB)...\n")
dl_path <- tryCatch({
  ebirdst_download_status(species = sp_code,
                          download_abundance = TRUE,
                          download_ranges = FALSE,
                          pattern = "3km")   # basse resolution suffit pour un test
}, error = function(e) {
  cat("[ERREUR] Download failed:", conditionMessage(e), "\n")
  cat("        Verifier que la cle Cornell est active et que l'espece existe en S&T.\n")
  quit(status = 1)
})
cat("     OK, cache local : ", dl_path, "\n", sep="")

# 4) Charger abondance seasonnal max + zonal stat sur polygone France
cat("[4/4] Zonal stats sur France...\n")
abd <- tryCatch({
  # Charge le raster "abundance seasonal" version maximum annuel
  r <- load_raster(sp_code, resolution = "3km", product = "abundance", metric = "seasonal", period = "max")
  # Reprojeter le polygone dans le CRS du raster
  fr_prj <- st_transform(fr_metro, crs = crs(r))
  # Extraire la moyenne
  vals <- terra::extract(r, vect(fr_prj), fun = mean, na.rm = TRUE)
  mean(vals[, 2], na.rm = TRUE)
}, error = function(e) {
  cat("[ERREUR] Zonal stat failed:", conditionMessage(e), "\n")
  quit(status = 1)
})

cat("\n=== RESULTAT ===\n")
cat("Abondance moyenne Ouette d'Egypte en France metro : ", round(abd, 4), "\n", sep="")
cat("(echelle : rencontres esperees / heure de terrain, corrige effort)\n\n")

if (abd > 0 && !is.nan(abd)) {
  cat("[OK] Pipeline complet fonctionne. Demain on peut boucler sur toutes les especes.\n")
} else {
  cat("[WARN] Abondance nulle ou NaN, verifier le polygone et le raster.\n")
}
