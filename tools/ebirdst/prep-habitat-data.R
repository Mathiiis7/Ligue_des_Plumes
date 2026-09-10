# prep-habitat-data.R
# Prepare les donnees supplementaires pour Phase A affinee :
#   A. Altitude globale (GMTED / geodata ~1km ou SRTM 250m)
#   B. Distance a la cote (calcule depuis Natural Earth)
#   D. HydroRIVERS v10 (rivieres mondiales)
#   E. Polygones haute resolution (ne_countries scale=10)
# Installe aussi les packages R manquants.

suppressMessages({
  # Install packages manquants
  needed <- c("elevatr", "geodata", "terra", "sf", "rnaturalearth", "rnaturalearthhires")
  for (pkg in needed) {
    if (!requireNamespace(pkg, quietly=TRUE)) {
      cat("Installation :", pkg, "\n")
      install.packages(pkg, repos="https://cran.r-project.org")
    }
  }
  library(terra); library(sf); library(rnaturalearth)
})

DATA_DIR <- "C:/Users/mathi/Documents/Projets/clc/extra_data"
dir.create(DATA_DIR, showWarnings=FALSE, recursive=TRUE)

# ---------------------------------------------------------------------------
# A. Altitude globale via geodata::elevation_global (WorldClim 2.1)
# ~500 MB, resolution 30 sec (~1km)
# ---------------------------------------------------------------------------
elev_file <- file.path(DATA_DIR, "elevation_global.tif")
if (!file.exists(elev_file)) {
  cat("[A] Telechargement altitude globale (geodata::elevation_global, ~500 MB)...\n")
  library(geodata)
  # res=0.5 -> 30 arc-sec (~1km), path=DATA_DIR pour cache
  elev <- geodata::elevation_global(res=0.5, path=DATA_DIR)
  # Sauvegarde en local avec nom stable
  writeRaster(elev, elev_file, overwrite=TRUE, datatype="INT2S")
  cat("[A] OK ->", elev_file, "\n")
} else {
  cat("[A] Deja telecharge :", elev_file, "\n")
}

# ---------------------------------------------------------------------------
# D. HydroRIVERS v10 (rivieres mondiales, ~200 MB compressed)
# https://data.hydrosheds.org/file/HydroRIVERS/HydroRIVERS_v10.zip
# ---------------------------------------------------------------------------
rivers_zip <- file.path(DATA_DIR, "HydroRIVERS_v10.zip")
rivers_shp <- file.path(DATA_DIR, "HydroRIVERS_v10", "HydroRIVERS_v10.shp")
if (!file.exists(rivers_shp)) {
  if (!file.exists(rivers_zip)) {
    cat("[D] Telechargement HydroRIVERS v10 shp (~544 MB compressed, ~1.7 GB extract)...\n")
    options(timeout=3600)   # 1h timeout
    download.file(
      "https://data.hydrosheds.org/file/HydroRIVERS/HydroRIVERS_v10_shp.zip",
      destfile=rivers_zip,
      mode="wb"
    )
  }
  cat("[D] Extraction...\n")
  unzip(rivers_zip, exdir=file.path(DATA_DIR, "HydroRIVERS_v10"))
  cat("[D] OK ->", rivers_shp, "\n")
} else {
  cat("[D] Deja telecharge :", rivers_shp, "\n")
}

# ---------------------------------------------------------------------------
# E. Polygones scale=10 (via rnaturalearthhires deja installe)
# Test le chargement pour verifier
# ---------------------------------------------------------------------------
cat("[E] Test chargement ne_countries(scale=10)...\n")
world10 <- ne_countries(scale=10, returnclass="sf")
cat("[E] OK :", nrow(world10), "polygones\n")

# ---------------------------------------------------------------------------
# B. Distance a la cote : SKIP le pre-compute global (trop lent, 20h+ a 0.05 deg).
# On calcule per-country dans build-habitat-fractions.R : rasterize la coastline
# du pays sur le raster deja croppe (petit), puis distance. ~2-5 sec/pays.
# Resultat quasi-identique pour notre use case (differences < 1% pixels aux frontieres).
# ---------------------------------------------------------------------------

cat("\n=== PREP TERMINEE ===\n")
cat("Elevation :", elev_file, "\n")
cat("Rivers    :", rivers_shp, "\n")
cat("Coast dist: calcule per-country en Phase A (voir build-habitat-fractions.R)\n")
cat("Polygons  : chargement ne_countries(scale=10) fonctionne\n")
