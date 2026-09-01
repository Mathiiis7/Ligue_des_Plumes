# build-migration-weekly.R
#
# Genere 52 PNG hebdomadaires par espece migratrice FR pour la feature
# "migration animee". Cible : voir la vague de migration semaine par semaine.
#
# Sortie :
#   data/range-weekly/{code}/w{01..52}.webp   WebP LOSSLESS indexed + alpha
#   data/range-weekly-index.json              Manifest { sci: {code, w, h, bbox, weeks:[]} }
#
# Optimisations appliquees :
# - PNG_W = 500 (au lieu de 900) : les images sont pour anim, pas pour zoom pixel
# - Skip semaines vides : aucune donnee ce week -> pas de fichier (allege ~15-30%)
# - Quantize 128 couleurs (100 palette + variantes alpha) via magick
# - WebP LOSSLESS (method=6) : -30-40% vs PNG optimise SANS perte de qualite
#   (l'input est deja quantize a 128 couleurs, lossless preserve tout)
# - Fallback PNG optimise via oxipng si magick indispo
# - Skip complet des especes deja traitees (via manifest)
#
# Normalisation percentile GLOBALE sur les 52 weeks (cle du signal migration :
# semaines vides restent vides, pics d'abondance sont rouges).
#
# Usage :
#   Rscript tools/ebirdst/build-migration-weekly.R              # tout, extent Europe
#   Rscript tools/ebirdst/build-migration-weekly.R demo         # ~5 especes test
#   Rscript tools/ebirdst/build-migration-weekly.R sp <code>    # une espece
#   Rscript tools/ebirdst/build-migration-weekly.R rebuild      # force re-render

suppressPackageStartupMessages({
  library(ebirdst)
  library(sf)
  library(terra)
  library(dplyr)
  library(jsonlite)
})

.cat_orig <- cat
cat <- function(...) { .cat_orig(...); flush.console() }

Sys.setenv(EBIRDST_KEY = "obfvm9uetmhe")

# ---------- Detection outils optim ----------
HAS_MAGICK <- requireNamespace("magick", quietly = TRUE)
if (!HAS_MAGICK) {
  message("[info] Package 'magick' absent -> installe pour PNG indexed 8-bit (gros gain poids)")
  try(install.packages("magick", repos = "https://cloud.r-project.org"), silent = TRUE)
  HAS_MAGICK <- requireNamespace("magick", quietly = TRUE)
}
if (HAS_MAGICK) suppressPackageStartupMessages(library(magick))

find_oxipng <- function() {
  bin <- Sys.which("oxipng")
  if (nzchar(bin)) return(bin)
  bin <- Sys.which("optipng")
  if (nzchar(bin)) return(bin)
  return("")
}
OPT_BIN <- find_oxipng()
if (nzchar(OPT_BIN)) {
  cat("[info] Post-compression PNG activee via ", basename(OPT_BIN), "\n", sep="")
} else {
  cat("[info] Ni oxipng ni optipng trouves -> pas de post-compression (install optionnel)\n")
}
cat("[info] Palette indexed 8-bit : ", if (HAS_MAGICK) "OUI (magick)" else "NON (fallback RGBA)", "\n", sep="")

# ---------- Config ----------
args <- commandArgs(trailingOnly = TRUE)
mode <- if (length(args) >= 1) tolower(args[1]) else "all"
single_code <- if (mode == "sp" && length(args) >= 2) args[2] else NULL
FORCE_REBUILD <- mode == "rebuild"

# Europe + Afrique du N + Afrique subsaharienne (couvre migrateurs FR jusqu'au Sahel)
BBOX <- c(-25, -10, 45, 72)

# Codes Cornell des migrateurs FR classiques pour le mode demo
DEMO_CODES <- c(
  "barswa",     # Hirondelle rustique - Barn Swallow
  "whistorks1", # Cigogne blanche - White Stork
  "banswa",     # Hirondelle de rivage - Bank/Sand Martin
  "eubeat1",    # Guepier d'Europe - European Bee-eater
  "eurhoo"      # Huppe fasciee - Eurasian Hoopoe
)

# Dimensions PNG : aspect Mercator bbox Europe. PNG_W reduit pour anim.
suppressWarnings({
  bbox_ll_tmp <- terra::ext(BBOX[1], BBOX[3], BBOX[2], BBOX[4])
  bbox_merc_tmp <- terra::project(terra::as.polygons(bbox_ll_tmp, crs = "EPSG:4326"), "EPSG:3857")
  e_merc_tmp <- terra::ext(bbox_merc_tmp)
})
merc_w <- e_merc_tmp$xmax - e_merc_tmp$xmin
merc_h <- e_merc_tmp$ymax - e_merc_tmp$ymin
merc_aspect <- as.numeric(merc_w / merc_h)
PNG_W <- 500L
PNG_H <- as.integer(round(PNG_W / merc_aspect))
cat(sprintf("Aspect Mercator Europe : %.2f -> PNG %d x %d\n", merc_aspect, PNG_W, PNG_H))

# ---------- Chemins ----------
get_script_dir <- function() {
  cmd_args <- commandArgs(trailingOnly = FALSE)
  file_arg <- cmd_args[grep("^--file=", cmd_args)]
  if (length(file_arg) > 0) return(normalizePath(dirname(sub("^--file=", "", file_arg[1]))))
  return(getwd())
}
ROOT <- normalizePath(file.path(get_script_dir(), "..", ".."))
OUT_DIR <- file.path(ROOT, "data", "range-weekly")
MANIFEST <- file.path(ROOT, "data", "range-weekly-index.json")
if (!dir.exists(OUT_DIR)) dir.create(OUT_DIR, recursive = TRUE)

cat("Mode:", mode, "\n")
cat("Extent:", paste(BBOX, collapse=","), "\n")
cat("Output:", OUT_DIR, "\n\n")

# ---------- Palette (identique aux autres scripts) ----------
pal_hex <- colorRampPalette(c(
  "#3ea86b", "#a8d155", "#f5c518", "#f0733a", "#a11408"
))(100)
pal_rgb <- col2rgb(pal_hex)

# ---------- Selection especes FR ----------
rarity_file <- file.path(ROOT, "data", "generated", "real-rarity.generated.js")
if (!file.exists(rarity_file)) stop("Fichier rarete FR introuvable : ", rarity_file)
rarity_txt <- readLines(rarity_file, warn = FALSE)
rarity_json_str <- sub("^const \\w+\\s*=\\s*", "", paste(rarity_txt, collapse = "\n"))
rarity_json_str <- sub(";\\s*$", "", rarity_json_str)
fr_species <- jsonlite::fromJSON(rarity_json_str)
fr_sci <- names(fr_species)
cat("Especes FR (post-filtre fantomes) :", length(fr_sci), "\n")

runs <- ebirdst_runs
runs$sci_lc <- tolower(runs$scientific_name)
matched <- runs[runs$sci_lc %in% tolower(fr_sci), ]
cat("Especes FR presentes chez Cornell :", nrow(matched), "\n")

is_migrator <- function(row) {
  b  <- suppressWarnings(as.numeric(row$breeding_quality))
  nb <- suppressWarnings(as.numeric(row$nonbreeding_quality))
  r  <- suppressWarnings(as.numeric(row$resident_quality))
  if (is.na(r))  r  <- 0
  if (is.na(b))  b  <- 0
  if (is.na(nb)) nb <- 0
  return(b >= 1 && nb >= 1 && r == 0)
}
matched$is_migrator <- vapply(seq_len(nrow(matched)), function(i) is_migrator(matched[i, ]), logical(1))
migrators <- matched[matched$is_migrator, ]
cat("Migrateurs detectes :", nrow(migrators), "\n\n")

if (mode == "demo") {
  migrators <- runs[runs$species_code %in% DEMO_CODES, ]
  cat("Mode DEMO :", nrow(migrators), "especes trouvees sur", length(DEMO_CODES), "codes\n")
} else if (mode == "sp") {
  migrators <- runs[runs$species_code == single_code, ]
  if (nrow(migrators) == 0) stop("Code Cornell introuvable : ", single_code)
  cat("Mode single sp :", single_code, "\n")
}

# ---------- Manifest ----------
manifest <- if (file.exists(MANIFEST)) jsonlite::fromJSON(MANIFEST, simplifyVector = FALSE) else list()

# Skip especes deja dans le manifest, sauf si FORCE_REBUILD
if (!FORCE_REBUILD && mode == "all") {
  before <- nrow(migrators)
  done_sci <- names(manifest)
  migrators <- migrators[!migrators$scientific_name %in% done_sci, ]
  cat("Deja dans manifest :", before - nrow(migrators), " ; a traiter :", nrow(migrators), "\n\n")
}

# ---------- Ecrit un PNG optimise ----------
# ranks : vecteur de percentiles (0-1) longueur PNG_W * PNG_H, NA pour transparent
# path : chemin de sortie
# Retourne TRUE si PNG ecrit (contient au moins un pixel non-vide), FALSE sinon (semaine vide)
write_optimized_png <- function(ranks, path) {
  valid <- !is.na(ranks)
  if (!any(valid)) return(FALSE)   # skip semaine totalement vide
  n_px <- length(ranks)
  color_idx <- pmax(1L, pmin(100L, as.integer(round(ranks * 99) + 1)))

  R_ch <- integer(n_px); G_ch <- integer(n_px); B_ch <- integer(n_px); A_ch <- integer(n_px)
  R_ch[valid] <- pal_rgb[1, color_idx[valid]]
  G_ch[valid] <- pal_rgb[2, color_idx[valid]]
  B_ch[valid] <- pal_rgb[3, color_idx[valid]]
  # Alpha plancher 120 pour lisibilite sur OSM, boost jusqu'a 255 sur les pics
  A_ch[valid] <- as.integer(pmin(255L, pmax(120L, as.integer(ranks[valid] * 135) + 120L)))

  # Array [H, W, 4]
  rgba <- array(0, dim = c(PNG_H, PNG_W, 4))
  rgba[,,1] <- matrix(R_ch, PNG_H, PNG_W, byrow = TRUE) / 255
  rgba[,,2] <- matrix(G_ch, PNG_H, PNG_W, byrow = TRUE) / 255
  rgba[,,3] <- matrix(B_ch, PNG_H, PNG_W, byrow = TRUE) / 255
  rgba[,,4] <- matrix(A_ch, PNG_H, PNG_W, byrow = TRUE) / 255

  # Format WebP LOSSLESS pour zero perte de qualite (l'input est deja quantize a
  # 128 couleurs, donc lossless preserve tout exactement). Fallback PNG si magick
  # indispo.
  is_webp <- endsWith(path, ".webp")
  if (HAS_MAGICK) {
    img <- magick::image_read(rgba)
    img <- magick::image_quantize(img, max = 128, colorspace = "rgb", dither = FALSE)
    if (is_webp) {
      # method 6 = qualite max, lossless = zero perte.
      magick::image_write(img, path = path, format = "webp",
                          defines = c("webp:lossless" = "true", "webp:method" = "6"))
    } else {
      magick::image_write(img, path = path, format = "png", depth = 8)
    }
    magick::image_destroy(img)
  } else {
    if (!requireNamespace("png", quietly = TRUE)) install.packages("png", repos = "https://cloud.r-project.org")
    png::writePNG(rgba, sub("\\.webp$", ".png", path))
  }

  # Post-compression oxipng/optipng : PNG uniquement (WebP lossless est deja optim au max)
  if (!is_webp && nzchar(OPT_BIN)) {
    args_opt <- if (grepl("oxipng", OPT_BIN)) c("-o", "4", "--strip", "safe", path)
                else                           c("-o5", "-strip", "all", path)
    tryCatch(
      system2(OPT_BIN, args_opt, stdout = FALSE, stderr = FALSE),
      error = function(e) NULL
    )
  }
  TRUE
}

# ---------- Boucle principale ----------
start_ts <- Sys.time()
success <- 0
failed <- 0

for (i in seq_len(nrow(migrators))) {
  sp <- migrators[i, ]
  code <- sp$species_code
  sci <- sp$scientific_name
  pct <- sprintf("%d/%d", i, nrow(migrators))

  cat(pct, code, "-", sci, "... ")

  sp_dir <- file.path(OUT_DIR, code)
  if (!dir.exists(sp_dir)) dir.create(sp_dir, recursive = TRUE)

  ok <- tryCatch({
    # DL raster hebdo (median = plus lisse que mean, meme cache)
    ebirdst_download_status(code, download_ranges = FALSE,
                            pattern = "abundance_median_9km",
                            force = FALSE, show_progress = FALSE)

    r <- load_raster(code, product = "abundance", period = "weekly",
                     metric = "median", resolution = "9km")
    n_weeks <- terra::nlyr(r)

    # Reprojection unique de toute la stack en Web Mercator
    bbox_ll <- ext(BBOX[1], BBOX[3], BBOX[2], BBOX[4])
    bbox_merc <- project(as.polygons(bbox_ll, crs = "EPSG:4326"), "EPSG:3857")
    e_merc <- ext(bbox_merc)
    r_merc <- project(r, "EPSG:3857", method = "average")
    r_cropped <- crop(r_merc, e_merc, snap = "out")
    target <- rast(nrows = PNG_H, ncols = PNG_W, extent = e_merc, crs = "EPSG:3857")
    r_final <- resample(r_cropped, target, method = "average")

    # Normalisation percentile GLOBALE sur les 52 weeks (cle de la vague migration)
    all_vals <- values(r_final)
    all_vals[all_vals <= 0] <- NA
    valid_global <- !is.na(all_vals)
    if (!any(valid_global)) stop("no data in europe bbox")
    global_ranks <- rep(NA_real_, length(all_vals))
    global_ranks[valid_global] <- (rank(all_vals[valid_global], ties.method = "average") - 1) /
                                  max(1, sum(valid_global) - 1)

    n_px_layer <- PNG_W * PNG_H
    ranks_mat <- matrix(global_ranks, nrow = n_px_layer, ncol = n_weeks)

    weeks_written <- integer(0)
    for (w in seq_len(n_weeks)) {
      week_ranks <- ranks_mat[, w]
      png_path <- file.path(sp_dir, sprintf("w%02d.webp", w))
      wrote <- write_optimized_png(week_ranks, png_path)
      if (wrote) {
        weeks_written <- c(weeks_written, w)
      } else if (file.exists(png_path)) {
        # Nettoie un ancien PNG vide de rebuild precedent
        file.remove(png_path)
      }
    }

    manifest[[sci]] <- list(
      code = code,
      w = PNG_W, h = PNG_H,
      bbox = as.numeric(BBOX),
      weeks = weeks_written
    )
    TRUE
  }, error = function(e) {
    cat("ERR:", conditionMessage(e), "\n")
    return(FALSE)
  })

  if (isTRUE(ok)) {
    success <- success + 1
    n_w <- length(manifest[[sci]]$weeks)
    elapsed_min <- as.numeric(difftime(Sys.time(), start_ts, units = "mins"))
    rate <- i / elapsed_min
    eta_min <- (nrow(migrators) - i) / rate
    # Poids moyen du dossier espece pour reporter le gain d'optim
    sp_size_kb <- round(sum(file.info(list.files(sp_dir, full.names = TRUE))$size, na.rm = TRUE) / 1024)
    cat(sprintf("OK %d weeks, %d KB (%.1fmin, ETA %.1fmin)\n",
                n_w, sp_size_kb, elapsed_min, eta_min))
  } else {
    failed <- failed + 1
  }

  # Flush manifest tous les 5
  if (i %% 5 == 0) {
    jsonlite::write_json(manifest, MANIFEST, auto_unbox = TRUE, pretty = FALSE)
  }
}

jsonlite::write_json(manifest, MANIFEST, auto_unbox = TRUE, pretty = FALSE)

cat("\n=== Termine ===\n")
cat("Succes :", success, " ; Echecs :", failed, "\n")
n_dirs <- length(list.dirs(OUT_DIR, recursive = FALSE))
n_pngs <- length(list.files(OUT_DIR, pattern = "\\.(png|webp)$", recursive = TRUE))
total_mb <- round(sum(file.info(list.files(OUT_DIR, pattern="\\.(png|webp)$", recursive=TRUE, full.names=TRUE))$size, na.rm=TRUE) / 1024 / 1024, 1)
cat("Dossiers especes :", n_dirs, " ; Total PNGs :", n_pngs, " ; Poids :", total_mb, "MB\n")
cat("Manifest :", MANIFEST, "\n")
