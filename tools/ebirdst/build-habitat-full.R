# build-habitat-full.R
# Pipeline production habitat : CLC (Europe) + CGLC (monde) x Cornell S&T
#
# ARCHITECTURE OPTIMISEE :
#   Phase A : Pre-aggreger CLC + CGLC a 3km par pays via fun="modal" (classe dominante).
#             Ultra rapide (une passe C native au lieu de 44 iterations en R).
#             Cache disque par pays (~few MB chacun).
#   Phase B : Pour chaque espece x pays : reprojeter S&T sur grille 3km cached,
#             pour chaque cellule additionner S&T_abundance au compteur de sa classe.
#             ~100ms par (espece, pays).
#
# Trade-off vs approche "fractions" : perd la composition intra-pixel 3km,
# ne garde que la classe dominante. Statistiquement equivalent quand on
# agrege sur beaucoup de cellules S&T (loi des grands nombres).

suppressMessages({
  library(terra)
  library(sf)
  library(jsonlite)
})

t0 <- Sys.time()

CLC_PATH  <- "C:/Users/mathi/Documents/Projets/clc/extracted/u2018_clc2018_v2020_20u1_raster100m/DATA/U2018_CLC2018_V2020_20u1.tif"
CGLC_PATH <- "C:/Users/mathi/Documents/Projets/clc/cglc/PROBAV_LC100_global_v3.0.1_2019-nrt_Discrete-Classification-map_EPSG-4326.tif"
CACHE_DIR <- "C:/Users/mathi/Documents/Projets/clc/cache"

dir.create(CACHE_DIR, showWarnings=FALSE, recursive=TRUE)

# CLC 44 IDs (dans le raster : 1-44) + codes officiels
CLC_ID_TO_CODE <- c(111,112,121,122,123,124,131,132,133,141,142,
                    211,212,213,221,222,223,231,241,242,243,244,
                    311,312,313,321,322,323,324,331,332,333,334,335,
                    411,412,421,422,423,
                    511,512,521,522,523)

EEA_COUNTRIES <- c("FR","DE","ES","IT","GB","PT","BE","NL","LU","IE","AT","CH",
                   "PL","CZ","SK","HU","RO","BG","SI","HR","BA","RS","AL","MK",
                   "GR","CY","MT","SE","NO","FI","DK","IS","EE","LV","LT","TR","LI")

# ALL_COUNTRIES sera peuple depuis world_sf apres son chargement
ALL_COUNTRIES <- NULL

# Bboxes pour restreindre pays a leurs territoires principaux
COUNTRY_BBOX <- list(
  FR = c(-5.5, 41, 10, 51.5),
  PT = c(-10, 36, -6, 42.5),
  ES = c(-10, 35, 5, 44),
  US = c(-125, 24, -66, 50)
)

# --- Charger frontieres ---
cat("[SETUP] Chargement frontieres pays...\n")
world_sf <- rnaturalearth::ne_countries(scale=50, returnclass="sf")

# Prendre tous les pays du monde avec un code ISO valide (2 lettres)
ALL_COUNTRIES <- unique(world_sf$iso_a2_eh[
  !is.na(world_sf$iso_a2_eh) &
  world_sf$iso_a2_eh != "-99" &
  nchar(world_sf$iso_a2_eh) == 2
])
cat(sprintf("[SETUP] %d pays du monde a traiter\n", length(ALL_COUNTRIES)))

# --- Phase A : pre-agg par pays ---
cat("\n=== PHASE A : agg CLC/CGLC a 3km par pays (mode dominant) ===\n")

phase_a_country <- function(cc) {
  cache_file <- file.path(CACHE_DIR, paste0(cc, "_habitat_agg.tif"))
  if (file.exists(cache_file)) return(TRUE)

  country_sf <- world_sf[world_sf$iso_a2_eh == cc, ]
  if (nrow(country_sf) == 0) return(FALSE)
  if (!is.null(COUNTRY_BBOX[[cc]])) {
    bb <- COUNTRY_BBOX[[cc]]
    country_sf <- st_crop(country_sf, xmin=bb[1], ymin=bb[2], xmax=bb[3], ymax=bb[4])
  }
  country_vect <- vect(country_sf)

  use_clc <- cc %in% EEA_COUNTRIES

  ts <- Sys.time()
  if (use_clc) {
    cvect <- project(country_vect, "EPSG:3035")
    lc <- rast(CLC_PATH)
    lc_crop <- crop(lc, cvect)
    agg_fact <- 30   # 100m -> 3km
  } else {
    cvect <- country_vect
    lc <- rast(CGLC_PATH)
    lc_crop <- crop(lc, cvect)
    # CGLC en EPSG:4326 (deg), on target 3km ≈ 0.027 deg
    agg_fact <- max(2, round(0.027 / mean(res(lc_crop))))
  }

  cat(sprintf(" (source %dx%d, fact=%d)", ncol(lc_crop), nrow(lc_crop), agg_fact))

  # AGGREGATE EN 1 PASSE avec fun="modal" (classe dominante)
  # 300x plus rapide que 44 iterations avec fractions
  lc_agg <- aggregate(lc_crop, fact=agg_fact, fun="modal", na.rm=TRUE)

  # Masquer aux vraies limites du pays (post-agg pour ne pas polluer)
  lc_agg <- mask(lc_agg, cvect)

  writeRaster(lc_agg, cache_file, overwrite=TRUE, datatype="INT2U")
  dur <- as.numeric(Sys.time() - ts, units="secs")
  cat(sprintf(" -> %dx%d cells, %.0f sec\n", ncol(lc_agg), nrow(lc_agg), dur))
  return(TRUE)
}

for (cc in ALL_COUNTRIES) {
  cat(sprintf("  [%s]", cc))
  tryCatch(phase_a_country(cc), error = function(e) cat(" ERREUR:", e$message, "\n"))
}

cat(sprintf("\nPhase A terminee en %.1f min\n", as.numeric(Sys.time() - t0, units="mins")))

# =============================================================================
# PHASE B : croisement espece x pays
# =============================================================================
cat("\n=== PHASE B : croisement especes x pays ===\n")

EBIRDST_DIR <- "C:/Users/mathi/AppData/Roaming/R/data/R/ebirdst/2023"
OUT_DIR <- "C:/Users/mathi/Documents/Projets/Ligue_des_Plumes/data/countries"

# Chargement mapping code_ebird -> sci_name via ebirdst_runs
library(ebirdst)
runs <- ebirdst_runs
runs$sci_lc <- tolower(runs$scientific_name)

# Liste des especes deja telechargees
downloaded_codes <- list.dirs(EBIRDST_DIR, recursive=FALSE, full.names=FALSE)
downloaded_codes <- downloaded_codes[downloaded_codes != ""]
cat(sprintf("\nEspeces S&T disponibles : %d\n", length(downloaded_codes)))

# Mapping L3 -> L1 super-category
CLC_L1_MAP <- list(
  artif = c(111,112,121,122,123,124,131,132,133,141,142),
  agri = c(211,212,213,221,222,223,231,241,242,243,244),
  forest_seminat = c(311,312,313,321,322,323,324,331,332,333,334,335),
  wetland = c(411,412,421,422,423),
  water = c(511,512,521,522,523)
)
CGLC_L1_MAP <- list(
  artif = c(50),
  agri = c(40),
  forest_seminat = c(20,30,60,70,100,111,112,113,114,115,116,121,122,123,124,125,126),
  wetland = c(90),
  water = c(80,200)
)
l1_of_code <- function(code, use_clc) {
  m <- if (use_clc) CLC_L1_MAP else CGLC_L1_MAP
  for (l1 in names(m)) {
    if (code %in% m[[l1]]) return(l1)
  }
  return("other")
}

phase_b_species_country <- function(species_code, cc, habitat_cache) {
  st_path <- file.path(EBIRDST_DIR, species_code, "seasonal",
                       paste0(species_code, "_abundance_full-year_mean_3km_2023.tif"))
  if (!file.exists(st_path)) return(NULL)
  st <- rast(st_path)
  habitat <- habitat_cache[[cc]]
  if (is.null(habitat)) return(NULL)

  st_proj <- project(st, habitat, method="bilinear")
  h_vals <- values(habitat)
  s_vals <- values(st_proj)

  valid <- !is.na(h_vals) & !is.na(s_vals) & s_vals > 0
  h_vals <- h_vals[valid]
  s_vals <- s_vals[valid]

  if (length(h_vals) == 0 || sum(s_vals) < 1e-6) return(NULL)

  use_clc <- cc %in% EEA_COUNTRIES
  if (use_clc) valid_codes <- CLC_ID_TO_CODE[h_vals]
  else valid_codes <- h_vals

  contrib <- tapply(s_vals, valid_codes, sum)
  total <- sum(contrib)
  pct <- contrib / total * 100

  # Filtrer >= 0.1% (bruit) puis trier
  pct <- pct[pct >= 0.1]
  if (length(pct) == 0) return(NULL)
  pct <- sort(pct, decreasing=TRUE)

  # L3 : garder toutes classes >= 0.5%
  l3 <- as.list(round(pct, 2))

  # L1 : agréger par super-catégorie
  l1_agg <- tapply(pct, sapply(as.numeric(names(pct)), l1_of_code, use_clc=use_clc), sum)
  l1 <- as.list(round(l1_agg, 2))

  list(dataset = if (use_clc) "clc" else "cglc", L1 = l1, L3 = l3)
}

# --- Boucle principale : charger tous les habitats caches, puis parcourir especes ---
cat("\nChargement des rasters habitat en cache...\n")
habitat_cache <- list()
for (cc in ALL_COUNTRIES) {
  cache_file <- file.path(CACHE_DIR, paste0(cc, "_habitat_agg.tif"))
  if (file.exists(cache_file)) {
    habitat_cache[[cc]] <- rast(cache_file)
  }
}
cat(sprintf("  %d rasters charges\n", length(habitat_cache)))

# JSON sortie par pays
results_by_country <- list()
for (cc in names(habitat_cache)) results_by_country[[cc]] <- list()

cat(sprintf("\nCroisement %d especes x %d pays...\n", length(downloaded_codes), length(habitat_cache)))

tick_start <- Sys.time()
n_ok <- 0
n_skip <- 0
for (i in seq_along(downloaded_codes)) {
  code <- downloaded_codes[i]
  sci <- runs$sci_lc[match(code, runs$species_code)]
  if (is.na(sci)) { n_skip <- n_skip + 1; next }

  for (cc in names(habitat_cache)) {
    res <- tryCatch(phase_b_species_country(code, cc, habitat_cache), error=function(e) NULL)
    if (!is.null(res)) {
      results_by_country[[cc]][[sci]] <- list(d=res$dataset, L1=res$L1, L3=res$L3)
      n_ok <- n_ok + 1
    }
  }

  if (i %% 50 == 0) {
    elapsed <- as.numeric(Sys.time() - tick_start, units="secs")
    eta <- elapsed / i * (length(downloaded_codes) - i) / 60
    cat(sprintf("  [%d/%d] %s (%s) - %d entries, ETA %.1f min\n",
                i, length(downloaded_codes), code, sci, n_ok, eta))
  }
}

cat(sprintf("\nCroisement termine : %d entries, %d skips\n", n_ok, n_skip))
cat(sprintf("Duree Phase B : %.1f min\n", as.numeric(Sys.time() - tick_start, units="mins")))

# --- Ecriture JSON par pays ---
cat("\nEcriture JSON par pays...\n")
for (cc in names(results_by_country)) {
  data <- results_by_country[[cc]]
  if (length(data) == 0) next
  out_file <- file.path(OUT_DIR, tolower(cc), "habitat_by_species.json")
  dir.create(dirname(out_file), showWarnings=FALSE, recursive=TRUE)
  writeLines(toJSON(data, auto_unbox=TRUE, digits=2, pretty=FALSE), out_file)
  fsize <- file.info(out_file)$size / 1024
  cat(sprintf("  %s : %d especes, %.0f KB\n", cc, length(data), fsize))
}

cat(sprintf("\nTOTAL : %.1f min\n", as.numeric(Sys.time() - t0, units="mins")))

