# build-habitat-clc-test.R
# Test croisement Cornell S&T abundance x Corine Land Cover 2018 pour UNE espece x UN pays.
# But : valider la methode et le rendu avant de scaler sur 300 especes x 5 pays.
#
# Espece test : Rollier d'Europe (eurrol1)
# Pays test  : France (FR)
#
# Approche :
#   1. Charger CLC 2018 (LAEA EPSG:3035, 100m)
#   2. Charger S&T abundance Rollier (Sinusoidal, 3km)
#   3. Charger frontieres France (rnaturalearth ou builtin)
#   4. Reprojeter S&T vers LAEA (CRS commun)
#   5. Cropper CLC et S&T a l'emprise France
#   6. Pour chaque classe CLC (44) :
#      - Masque binaire CLC == class
#      - Aggreger a la resolution S&T (fun=mean = fraction du pixel occupee)
#      - Multiplier par abundance S&T
#      - Sommer (contribution totale de cette classe)
#   7. Normaliser en % + trier
#   8. Afficher top 15
#
# Attendu : oliveraies, vignes, garrigues, cultures complexes dominantes.

suppressMessages({
  library(terra)
  library(sf)
  library(ebirdst)
})

t0 <- Sys.time()
cat("=== build-habitat-clc-test.R  --  Rollier d'Europe x France ===\n\n")

# --- 1) Charger CLC ---
CLC_PATH <- "C:/Users/mathi/Documents/Projets/clc/extracted/u2018_clc2018_v2020_20u1_raster100m/DATA/U2018_CLC2018_V2020_20u1.tif"
cat("[1] Chargement CLC 2018...\n")
clc <- rast(CLC_PATH)
cat("    CRS :", crs(clc, describe=TRUE)$name, "\n")
cat("    Resolution :", res(clc), "m\n")
cat("    Dimensions :", ncol(clc), "x", nrow(clc), "cellules\n\n")

# --- 2) Charger S&T Rollier ---
cat("[2] Chargement S&T abundance Rollier...\n")
species_code <- "eurrol1"
st_path <- file.path(ebirdst_data_dir(), "2023", species_code, "seasonal", paste0(species_code, "_abundance_full-year_mean_3km_2023.tif"))
if (!file.exists(st_path)) stop("Fichier S&T introuvable : ", st_path)
st <- rast(st_path)
cat("    CRS :", crs(st, describe=TRUE)$name, "\n")
cat("    Resolution :", res(st), "m\n")
cat("    Dimensions :", ncol(st), "x", nrow(st), "cellules\n\n")

# --- 3) Charger frontieres France ---
cat("[3] Chargement frontieres FR...\n")
# On utilise Natural Earth via rnaturalearth (souvent deja installe avec sf)
if (requireNamespace("rnaturalearth", quietly=TRUE)) {
  fr_shp <- rnaturalearth::ne_countries(country="France", scale=50, returnclass="sf")
  # Garder seulement la France metropolitaine (exclure DOM-TOM)
  fr_shp <- st_crop(fr_shp, xmin=-5.5, ymin=41, xmax=10, ymax=51.5)
} else {
  stop("Installe rnaturalearth : install.packages('rnaturalearth')")
}
fr_vect <- vect(fr_shp)
cat("    Frontieres FR chargees\n\n")

# --- 4) Reprojeter S&T vers LAEA (CRS de CLC) ---
cat("[4] Reprojection S&T -> LAEA (EPSG:3035)...\n")
st_laea <- project(st, crs(clc), method="bilinear")
cat("    Done\n\n")

# --- 5) Cropper CLC et S&T sur France ---
cat("[5] Crop sur emprise France...\n")
fr_vect_laea <- project(fr_vect, crs(clc))
clc_fr <- crop(clc, fr_vect_laea, mask=TRUE)
st_fr <- crop(st_laea, fr_vect_laea, mask=TRUE)
# Aligner grille S&T sur celle de CLC en resamplant
st_fr <- resample(st_fr, clc_fr, method="bilinear")
cat("    CLC FR :", ncol(clc_fr), "x", nrow(clc_fr), "cellules\n")
cat("    S&T FR :", ncol(st_fr), "x", nrow(st_fr), "cellules (resamplees a 100m)\n\n")

# Filtrer les cellules d'abondance > seuil (evite le bruit)
st_fr_mask <- st_fr
st_fr_mask[st_fr < 0.001] <- NA
cat("    Cellules S&T avec abundance >= 0.001 :", sum(!is.na(values(st_fr_mask))), "\n\n")

# --- 6) Calculer contribution de chaque classe CLC ---
cat("[6] Calcul contribution par classe CLC (44 classes)...\n")

# Legende CLC
legend <- data.frame(
  id = 1:44,
  code = c(111,112,121,122,123,124,131,132,133,141,142,211,212,213,221,222,223,231,241,242,243,244,311,312,313,321,322,323,324,331,332,333,334,335,411,412,421,422,423,511,512,521,522,523),
  name = c("Continuous urban fabric","Discontinuous urban fabric","Industrial or commercial units",
    "Road and rail networks","Port areas","Airports","Mineral extraction sites","Dump sites",
    "Construction sites","Green urban areas","Sport and leisure facilities",
    "Non-irrigated arable land","Permanently irrigated land","Rice fields","Vineyards",
    "Fruit trees and berry plantations","Olive groves","Pastures",
    "Annual crops associated with permanent crops","Complex cultivation patterns",
    "Land principally occupied by agriculture with significant areas of natural vegetation",
    "Agro-forestry areas","Broad-leaved forest","Coniferous forest","Mixed forest",
    "Natural grasslands","Moors and heathland","Sclerophyllous vegetation",
    "Transitional woodland-shrub","Beaches dunes sands","Bare rocks","Sparsely vegetated areas",
    "Burnt areas","Glaciers and perpetual snow","Inland marshes","Peat bogs","Salt marshes",
    "Salines","Intertidal flats","Water courses","Water bodies","Coastal lagoons","Estuaries",
    "Sea and ocean")
)

# Contribution pondree par abondance
contributions <- numeric(44)
names(contributions) <- legend$id

# Pour chaque cellule CLC (a 100m), on a une classe (1-44). On multiplie par l'abondance
# S&T au meme endroit. Approche vectorisee : recuperer les valeurs des 2 rasters, groupby.
clc_vals <- values(clc_fr)
st_vals <- values(st_fr_mask)

# Nettoyer NA
valid <- !is.na(clc_vals) & !is.na(st_vals) & clc_vals >= 1 & clc_vals <= 44 & st_vals > 0
clc_vals <- clc_vals[valid]
st_vals <- st_vals[valid]

cat("    Cellules valides (CLC + S&T > 0) :", length(clc_vals), "\n")

# Aggregation : sum d'abundance par classe
for (i in 1:44) {
  mask <- (clc_vals == i)
  if (any(mask)) contributions[i] <- sum(st_vals[mask])
}

# Normaliser
total <- sum(contributions)
if (total == 0) stop("Total contribution = 0, probleme dans le pipeline")
pct <- contributions / total * 100

# --- 7) Trier et afficher ---
cat("\n[7] Distribution habitat FR :\n")
cat("-----------------------------------------------------------\n")
res_df <- data.frame(
  id = legend$id,
  code = legend$code,
  name = legend$name,
  pct = round(pct, 2)
)
res_df <- res_df[order(-res_df$pct), ]

# Afficher tout ce qui est >= 0.5% (evite le bruit) + total "Autres"
above <- res_df[res_df$pct >= 0.5, ]
below <- res_df[res_df$pct < 0.5, ]

for (i in 1:nrow(above)) {
  cat(sprintf("  %5.2f%%  [%3d] %s\n", above$pct[i], above$code[i], above$name[i]))
}
if (nrow(below) > 0) {
  cat(sprintf("  %5.2f%%  Autres (%d classes < 0.5%%)\n", sum(below$pct), nrow(below)))
}

# --- 8) Statistiques ---
cat("\n[8] Verifications :\n")
cat("    Total % (doit etre 100) :", round(sum(pct), 2), "%\n")
cat("    Nb classes >= 0.5%% :", nrow(above), "\n")
cat("    Nb classes >= 2%% :", sum(res_df$pct >= 2), "\n")

t1 <- Sys.time()
cat("\nDuree totale :", round(as.numeric(t1 - t0, units="secs"), 1), "s\n")
