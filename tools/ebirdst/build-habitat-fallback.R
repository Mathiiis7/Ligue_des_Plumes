# build-habitat-fallback.R
# Reprise du build habitat pour ajouter les 2425 especes qui n'avaient pas de TIF
# abundance_full-year_mean_3km : on utilise fallback chain
#   1. abundance_full-year_mean_3km_2023.tif   (deja fait)
#   2. abundance_seasonal_mean_3km_2023.tif    (multi-band, moyenne des saisons)
#   3. abundance_median_3km_2023.tif           (weekly 52 bands, mean)
#   4. abundance_seasonal_mean_9km_2023.tif    (resolution moindre mais dispo)
#   5. abundance_median_9km_2023.tif

suppressMessages({
  library(terra)
  library(sf)
  library(jsonlite)
  library(ebirdst)
})

CACHE_DIR <- "C:/Users/mathi/Documents/Projets/clc/cache"
OUT_DIR <- "C:/Users/mathi/Documents/Projets/Ligue_des_Plumes/data/countries"
EBIRDST_DIR <- "C:/Users/mathi/AppData/Roaming/R/data/R/ebirdst/2023"

EEA_COUNTRIES <- c("FR","DE","ES","IT","GB","PT","BE","NL","LU","IE","AT","CH",
                   "PL","CZ","SK","HU","RO","BG","SI","HR","BA","RS","AL","MK",
                   "GR","CY","MT","SE","NO","FI","DK","IS","EE","LV","LT","TR","LI")

CLC_ID_TO_CODE <- c(111,112,121,122,123,124,131,132,133,141,142,
                    211,212,213,221,222,223,231,241,242,243,244,
                    311,312,313,321,322,323,324,331,332,333,334,335,
                    411,412,421,422,423,
                    511,512,521,522,523)

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
l1_of <- function(code, use_clc) {
  m <- if (use_clc) CLC_L1_MAP else CGLC_L1_MAP
  for (l1 in names(m)) if (code %in% m[[l1]]) return(l1)
  return("other")
}

# --- Fallback chain pour trouver un raster S&T utilisable ---
load_st <- function(species_code) {
  d <- file.path(EBIRDST_DIR, species_code)
  candidates <- c(
    file.path(d, "seasonal", paste0(species_code, "_abundance_full-year_mean_3km_2023.tif")),
    file.path(d, "seasonal", paste0(species_code, "_abundance_seasonal_mean_3km_2023.tif")),
    file.path(d, "seasonal", paste0(species_code, "_abundance_seasonal_mean_9km_2023.tif")),
    file.path(d, "weekly", paste0(species_code, "_abundance_median_3km_2023.tif")),
    file.path(d, "weekly", paste0(species_code, "_abundance_median_9km_2023.tif")),
    file.path(d, "seasonal", paste0(species_code, "_abundance_seasonal_max_3km_2023.tif"))
  )
  for (path in candidates) {
    if (file.exists(path)) {
      st <- tryCatch(rast(path), error=function(e) NULL)
      if (is.null(st)) next
      # Si multi-band, prendre la moyenne (ignore NA)
      if (nlyr(st) > 1) st <- mean(st, na.rm=TRUE)
      return(st)
    }
  }
  return(NULL)
}

# --- Chargement etat actuel ---
cat("Chargement especes deja traitees + cache...\n")
runs <- ebirdst_runs
runs$sci_lc <- tolower(runs$scientific_name)
downloaded_codes <- list.dirs(EBIRDST_DIR, recursive=FALSE, full.names=FALSE)
downloaded_codes <- downloaded_codes[downloaded_codes != ""]

# Load existing JSONs to merge
existing <- list()
for (cc_dir in list.dirs(OUT_DIR, recursive=FALSE)) {
  cc <- toupper(basename(cc_dir))
  f <- file.path(cc_dir, "habitat_by_species.json")
  if (file.exists(f)) {
    existing[[cc]] <- fromJSON(readLines(f, warn=FALSE), simplifyVector=FALSE)
  }
}
cat("  Existing JSON pays :", length(existing), "\n")

# Load habitat cache : iterate sur les .tif du cache (pas sur existing qui peut etre vide)
habitat_cache <- list()
for (f in list.files(CACHE_DIR, pattern="_habitat_agg\\.tif$", full.names=TRUE)) {
  cc <- toupper(sub("_habitat_agg\\.tif$", "", basename(f)))
  habitat_cache[[cc]] <- rast(f)
  if (is.null(existing[[cc]])) existing[[cc]] <- list()
}
cat("  Habitat rasters loaded :", length(habitat_cache), "\n")

# --- Determiner especes non-traitees ---
# Pour chaque code, on va essayer meme si deja dans quelques JSONs (nouveau fallback = plus de pays)
# En pratique, seules les especes AVEC nouveau raster S&T fallback vont apporter de nouvelles entrees

n_ok <- 0; n_added <- 0
t0 <- Sys.time()

for (i in seq_along(downloaded_codes)) {
  code <- downloaded_codes[i]
  sci <- runs$sci_lc[match(code, runs$species_code)]
  if (is.na(sci)) next

  st <- load_st(code)
  if (is.null(st)) next
  n_ok <- n_ok + 1

  for (cc in names(habitat_cache)) {
    # Ne skip pas si deja existe : on refait pour appliquer method="near"
    habitat <- habitat_cache[[cc]]
    st_proj <- tryCatch(project(st, habitat, method="near"), error=function(e) NULL)
    if (is.null(st_proj)) next

    h_vals <- values(habitat)
    s_vals <- values(st_proj)
    valid <- !is.na(h_vals) & !is.na(s_vals) & s_vals > 0
    h_vals <- h_vals[valid]; s_vals <- s_vals[valid]
    if (length(h_vals) == 0 || sum(s_vals) < 1e-6) next

    use_clc <- cc %in% EEA_COUNTRIES
    codes_ <- if (use_clc) CLC_ID_TO_CODE[h_vals] else h_vals

    contrib <- tapply(s_vals, codes_, sum)
    total <- sum(contrib)
    pct <- contrib / total * 100
    pct <- pct[pct >= 0.1]
    if (length(pct) == 0) next
    pct <- sort(pct, decreasing=TRUE)

    l3 <- as.list(round(pct, 2))
    l1_agg <- tapply(pct, sapply(as.numeric(names(pct)), l1_of, use_clc=use_clc), sum)
    l1 <- as.list(round(l1_agg, 2))

    existing[[cc]][[sci]] <- list(d=if (use_clc) "clc" else "cglc", L1=l1, L3=l3)
    n_added <- n_added + 1
  }

  if (i %% 100 == 0) {
    elapsed <- as.numeric(Sys.time() - t0, units="secs")
    eta <- elapsed / i * (length(downloaded_codes) - i) / 60
    cat(sprintf("  [%d/%d] %s (%s) - %d nouv. entries, ETA %.0f min\n",
        i, length(downloaded_codes), code, sci, n_added, eta))
  }
}

cat(sprintf("\nAjoute : %d entries, %d especes fetch-ok\n", n_added, n_ok))
cat(sprintf("Duree : %.1f min\n", as.numeric(Sys.time() - t0, units="mins")))

# --- Re-ecrire JSONs mis a jour ---
cat("\nReecriture JSONs enrichis...\n")
for (cc in names(existing)) {
  data <- existing[[cc]]
  if (length(data) == 0) next
  out_file <- file.path(OUT_DIR, tolower(cc), "habitat_by_species.json")
  dir.create(dirname(out_file), showWarnings=FALSE, recursive=TRUE)
  writeLines(toJSON(data, auto_unbox=TRUE, digits=2, pretty=FALSE), out_file)
}
cat("Termine.\n")
