# build-range-maps.R
#
# Genere une carte de repartition PNG (heatmap d'abondance annuelle) pour chaque
# espece Cornell S&T disponible. Extent : Europe (par defaut) ou Monde selon config.
#
# Sortie :
#   data/range/{sciname}.png     Image 800x600 avec heatmap + fond de carte gris
#   data/range-index.json        Manifest { sci: {w: width, h: height, bbox: [w,s,e,n]} }
#
# Cache raster Cornell partage avec les autres scripts (180 GB deja telecharge).
# Reprend automatiquement si interrompu (skip PNG deja generes).
#
# Usage :
#   Rscript tools/ebirdst/build-range-maps.R              # tout, extent Europe
#   Rscript tools/ebirdst/build-range-maps.R world        # extent monde
#   Rscript tools/ebirdst/build-range-maps.R demo         # ~5 especes pour test client

suppressPackageStartupMessages({
  library(ebirdst)
  library(sf)
  library(terra)
  library(dplyr)
  library(jsonlite)
})

# Force flush stdout apres cat -> live progression via Tee-Object
.cat_orig <- cat
cat <- function(...) { .cat_orig(...); flush.console() }

Sys.setenv(EBIRDST_KEY = "obfvm9uetmhe")

# ---------- Config ----------
args <- commandArgs(trailingOnly = TRUE)
mode <- if (length(args) >= 1) tolower(args[1]) else "europe"

# Extent choisi (bbox en lat/lng WGS84)
BBOX <- if (mode == "world") c(-180, -60, 180, 85)
        else if (mode == "demo") c(-25, 30, 45, 72)      # Europe
        else                    c(-25, 30, 45, 72)       # Europe par defaut

# Dimensions PNG cible
PNG_W <- 800
PNG_H <- 600

# Especes cibles
DEMO_SPECIES <- c("euroba1", "tibpar", "eutspa", "commur", "eurmag1")  # 5 especes pour test

# ---------- Chemins ----------
ROOT <- normalizePath(file.path(dirname(sys.frame(1)$ofile), "..", ".."))
OUT_DIR <- file.path(ROOT, "data", "range")
MANIFEST <- file.path(ROOT, "data", "range-index.json")
if (!dir.exists(OUT_DIR)) dir.create(OUT_DIR, recursive = TRUE)

cat("Mode:", mode, "\n")
cat("Extent:", paste(BBOX, collapse=","), "\n")
cat("Output:", OUT_DIR, "\n\n")

# ---------- Palette heatmap style Merlin / eBird ----------
# Vert clair -> jaune -> orange -> rouge fonce, transparent pour 0
pal <- colorRampPalette(c(
  "#eaf5e0",  # tres pale (rare)
  "#a8d873",
  "#f5c518",
  "#f39a3d",
  "#e04a20",
  "#7c1d0d"   # tres fonce (tres abondant)
))(100)

# ---------- Liste especes disponibles ----------
runs <- ebirdst_runs
if (mode == "demo") {
  runs <- runs[runs$species_code %in% DEMO_SPECIES, ]
  cat("Mode DEMO :", nrow(runs), "especes selectionnees\n")
} else {
  # Filtre : especes avec fit relative_abundance
  runs <- runs[!is.na(runs$has_seasonal_definition), ]
  cat("Especes totales Cornell :", nrow(runs), "\n")
}

# ---------- Skip especes deja generees ----------
existing <- list.files(OUT_DIR, pattern = "\\.png$")
existing_ids <- sub("\\.png$", "", existing)
todo <- runs[!runs$species_code %in% existing_ids, ]
cat("Deja generees :", length(existing_ids), " ; Restantes :", nrow(todo), "\n\n")

# ---------- Boucle principale ----------
manifest <- if (file.exists(MANIFEST)) jsonlite::fromJSON(MANIFEST, simplifyVector = FALSE) else list()
start_ts <- Sys.time()
success <- 0
failed <- 0

for (i in seq_len(nrow(todo))) {
  sp <- todo[i, ]
  code <- sp$species_code
  sci <- sp$scientific_name
  pct <- sprintf("%d/%d", i, nrow(todo))

  cat(pct, code, "-", sci, "... ")

  ok <- tryCatch({
    # Telechargement (skip si cache local dispo)
    ebirdst_download_status(code, download_ranges = FALSE,
                            pattern = "abundance_seasonal_mean_9km",
                            force = FALSE, show_progress = FALSE)

    # Charge raster annuel (moyenne annuelle 9km)
    r <- load_raster(code, product = "abundance", period = "seasonal",
                     metric = "mean", resolution = "9km")

    # Prend le layer "resident" ou moyenne des saisons si migrateur
    layer_names <- names(r)
    if ("resident" %in% layer_names) {
      raster <- r[["resident"]]
    } else {
      # Migrateur : moyenne breeding + nonbreeding si dispos, sinon toutes les saisons
      seasons_present <- intersect(c("breeding","nonbreeding","prebreeding_migration","postbreeding_migration"), layer_names)
      if (length(seasons_present) == 0) seasons_present <- layer_names
      raster <- mean(r[[seasons_present]], na.rm = TRUE)
    }

    # Reprojette en lat/lng et crop au BBOX
    raster_ll <- project(raster, "EPSG:4326", method = "average")
    e <- ext(BBOX[1], BBOX[3], BBOX[2], BBOX[4])
    raster_cropped <- crop(raster_ll, e, snap = "out")

    # Resample sur la resolution cible PNG_W x PNG_H
    target <- rast(nrows = PNG_H, ncols = PNG_W, extent = e, crs = "EPSG:4326")
    raster_final <- resample(raster_cropped, target, method = "average")

    # Rendu PNG avec palette et fond transparent pour zero
    vals <- values(raster_final)
    vals[is.na(vals) | vals <= 0] <- NA
    if (all(is.na(vals))) stop("no data in bbox")

    # Normalisation log pour ecraser les outliers d'abondance
    vmax <- max(vals, na.rm = TRUE)
    vals_norm <- log1p(vals) / log1p(vmax)
    vals_norm[is.na(vals_norm)] <- NA

    # Cree un vecteur de couleurs
    color_idx <- pmax(1, pmin(100, round(vals_norm * 99) + 1))
    colors <- rep(NA_character_, length(color_idx))
    valid <- !is.na(color_idx)
    colors[valid] <- pal[color_idx[valid]]

    # Ecrit le PNG
    png_path <- file.path(OUT_DIR, paste0(code, ".png"))
    png(png_path, width = PNG_W, height = PNG_H, bg = "transparent")
    par(mar = c(0,0,0,0))
    plot(rast(matrix(1, PNG_H, PNG_W)), col = "transparent", axes = FALSE, legend = FALSE)
    # Reconstitue le raster de couleurs
    image_matrix <- matrix(colors, nrow = PNG_H, ncol = PNG_W, byrow = TRUE)
    rasterImage(image_matrix, 1, 1, PNG_W, PNG_H, interpolate = FALSE)
    dev.off()

    manifest[[sci]] <- list(
      code = code,
      w = PNG_W, h = PNG_H,
      bbox = as.numeric(BBOX)
    )
    TRUE
  }, error = function(e) {
    cat("ERR:", conditionMessage(e), "\n")
    return(FALSE)
  })

  if (isTRUE(ok)) {
    success <- success + 1
    elapsed_min <- as.numeric(difftime(Sys.time(), start_ts, units = "mins"))
    rate <- i / elapsed_min
    eta_min <- (nrow(todo) - i) / rate
    cat(sprintf("OK (%.1fmin elapsed, ETA %.1fmin)\n", elapsed_min, eta_min))
  } else {
    failed <- failed + 1
  }

  # Sauve le manifest tous les 20 pour ne pas tout perdre en cas de crash
  if (i %% 20 == 0) {
    jsonlite::write_json(manifest, MANIFEST, auto_unbox = TRUE, pretty = FALSE)
  }
}

# Sauve manifest final
jsonlite::write_json(manifest, MANIFEST, auto_unbox = TRUE, pretty = FALSE)

cat("\n=== Termine ===\n")
cat("Succes :", success, " ; Echecs :", failed, "\n")
cat("Total PNG :", length(list.files(OUT_DIR, pattern="\\.png$")), "\n")
cat("Manifest :", MANIFEST, "\n")
