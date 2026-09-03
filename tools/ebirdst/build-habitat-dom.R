# build-habitat-dom.R
# Ajoute les DOM-TOM francais manquants dans Natural Earth
# (Martinique, Guadeloupe, Reunion, Guyane, Mayotte) via bboxes hardcodees + CGLC.

suppressMessages({
  library(terra)
  library(sf)
  library(jsonlite)
  library(ebirdst)
})

CGLC_PATH <- "C:/Users/mathi/Documents/Projets/clc/cglc/PROBAV_LC100_global_v3.0.1_2019-nrt_Discrete-Classification-map_EPSG-4326.tif"
CACHE_DIR <- "C:/Users/mathi/Documents/Projets/clc/cache"
OUT_DIR <- "C:/Users/mathi/Documents/Projets/Ligue_des_Plumes/data/countries"
EBIRDST_DIR <- "C:/Users/mathi/AppData/Roaming/R/data/R/ebirdst/2023"

DOMS <- list(
  MQ = list(name="Martinique", bbox=c(-61.30, 14.35, -60.75, 14.95)),
  GP = list(name="Guadeloupe", bbox=c(-61.90, 15.80, -60.95, 16.55)),
  RE = list(name="La Reunion", bbox=c(55.20, -21.42, 55.85, -20.85)),
  GF = list(name="Guyane francaise", bbox=c(-54.60, 2.05, -51.55, 5.85)),
  YT = list(name="Mayotte", bbox=c(44.95, -13.05, 45.35, -12.60))
)

CGLC_L1_MAP <- list(
  artif = c(50),
  agri = c(40),
  forest_seminat = c(20,30,60,70,100,111,112,113,114,115,116,121,122,123,124,125,126),
  wetland = c(90),
  water = c(80,200)
)
l1_of_code <- function(code) {
  for (l1 in names(CGLC_L1_MAP)) if (code %in% CGLC_L1_MAP[[l1]]) return(l1)
  return("other")
}

# Phase A pour chaque DOM
cat("=== Phase A DOM-TOM ===\n")
for (cc in names(DOMS)) {
  cache_file <- file.path(CACHE_DIR, paste0(cc, "_habitat_agg.tif"))
  bb <- DOMS[[cc]]$bbox
  cvect <- vect(cbind(c(bb[1],bb[3],bb[3],bb[1]), c(bb[2],bb[2],bb[4],bb[4])), type="polygons", crs="EPSG:4326")

  lc <- rast(CGLC_PATH)
  lc_crop <- crop(lc, cvect)
  agg_fact <- max(2, round(0.027 / mean(res(lc_crop))))
  lc_agg <- aggregate(lc_crop, fact=agg_fact, fun="modal", na.rm=TRUE)

  writeRaster(lc_agg, cache_file, overwrite=TRUE, datatype="INT2U")
  cat(sprintf("  [%s] %s : %dx%d cells\n", cc, DOMS[[cc]]$name, ncol(lc_agg), nrow(lc_agg)))
}

# Phase B pour chaque DOM
cat("\n=== Phase B DOM-TOM ===\n")
runs <- ebirdst_runs
runs$sci_lc <- tolower(runs$scientific_name)
downloaded_codes <- list.dirs(EBIRDST_DIR, recursive=FALSE, full.names=FALSE)
downloaded_codes <- downloaded_codes[downloaded_codes != ""]

for (cc in names(DOMS)) {
  cache_file <- file.path(CACHE_DIR, paste0(cc, "_habitat_agg.tif"))
  habitat <- rast(cache_file)
  results <- list()
  n_ok <- 0

  for (code in downloaded_codes) {
    sci <- runs$sci_lc[match(code, runs$species_code)]
    if (is.na(sci)) next
    st_path <- file.path(EBIRDST_DIR, code, "seasonal",
                         paste0(code, "_abundance_full-year_mean_3km_2023.tif"))
    if (!file.exists(st_path)) next

    st <- tryCatch(rast(st_path), error=function(e) NULL)
    if (is.null(st)) next
    st_proj <- tryCatch(project(st, habitat, method="bilinear"), error=function(e) NULL)
    if (is.null(st_proj)) next

    h_vals <- values(habitat)
    s_vals <- values(st_proj)
    valid <- !is.na(h_vals) & !is.na(s_vals) & s_vals > 0
    h_vals <- h_vals[valid]
    s_vals <- s_vals[valid]
    if (length(h_vals) == 0 || sum(s_vals) < 1e-6) next

    contrib <- tapply(s_vals, h_vals, sum)
    total <- sum(contrib)
    pct <- contrib / total * 100
    pct <- pct[pct >= 0.1]
    if (length(pct) == 0) next
    pct <- sort(pct, decreasing=TRUE)

    l3 <- as.list(round(pct, 2))
    l1_agg <- tapply(pct, sapply(as.numeric(names(pct)), l1_of_code), sum)
    l1 <- as.list(round(l1_agg, 2))

    results[[sci]] <- list(d="cglc", L1=l1, L3=l3)
    n_ok <- n_ok + 1
  }

  out_file <- file.path(OUT_DIR, tolower(cc), "habitat_by_species.json")
  dir.create(dirname(out_file), showWarnings=FALSE, recursive=TRUE)
  writeLines(toJSON(results, auto_unbox=TRUE, digits=2, pretty=FALSE), out_file)
  fsize <- file.info(out_file)$size / 1024
  cat(sprintf("  [%s] %s : %d especes, %.0f KB\n", cc, DOMS[[cc]]$name, n_ok, fsize))
}

cat("\nOK\n")
