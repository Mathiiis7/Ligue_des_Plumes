# build-migration-weekly.R
#
# Genere 52 PNG hebdomadaires par espece migratrice FR pour la feature
# "migration animee". Cible : voir la vague de migration semaine par semaine.
#
# Sortie :
#   data/range-weekly/{code}/w{01..52}.webp   WebP LOSSLESS indexed + alpha
#   data/range-weekly-index.json              Manifest { sci: {code, w, h, bbox, weeks:[]} }
#
# Optimisations appliquees (empilees, max compression sans perte visuelle) :
# - PNG_W = 350, PNG_H calcule par espece via bbox adaptatif (gain -40pct vs fixe)
# - BBOX adaptatif : trim des bords transparents + padding 2 degres + filtre p1
#   -> chaque espece a un bbox pile a son aire de repartition, pas de vide inutile
# - 26 frames au lieu de 52 (1 sur 2) : -50pct stockage, fluidite quasi imperceptible
# - Skip semaines vides : aucune donnee ce week -> pas de fichier (allege ~15-30%)
# - Quantize 128 couleurs (100 palette + variantes alpha) via magick
# - PNG-8 indexed + oxipng lossless : le meilleur ratio mesure sur ce type d'image
#   (WebP lossy testee mais PIRE que PNG-8 pour heatmap avec grosses zones alpha)
# - Skip complet des especes deja traitees (via manifest)
# Cible : ~300-500 KB par espece = ~90-150 MB total pour 304 sp
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

# BBOX ADAPTATIF par espece calcule dans la boucle (voir "BBOX adaptatif par espece"
# plus bas). Ce fallback est utilise seulement pour le mode demo/sp au cas ou le
# trim echoue. En pratique jamais utilise.
BBOX <- c(-25, -35, 55, 75)

# Codes Cornell des migrateurs FR classiques pour le mode demo
DEMO_CODES <- c(
  "barswa",     # Hirondelle rustique - Barn Swallow
  "whistorks1", # Cigogne blanche - White Stork
  "banswa",     # Hirondelle de rivage - Bank/Sand Martin
  "eubeat1",    # Guepier d'Europe - European Bee-eater
  "eurhoo"      # Huppe fasciee - Eurasian Hoopoe
)

# Dimensions PNG : largeur cible fixe, hauteur calculee par espece depuis son bbox
# adaptatif (voir boucle principale). Gain estime -40pct vs bbox fixe.
PNG_W <- 350L
cat(sprintf("PNG_W cible : %d (H calcule par espece via bbox adaptatif)\n", PNG_W))

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
# ranks : vecteur de percentiles (0-1) longueur png_w*png_h, NA pour transparent
# path : chemin de sortie ; png_w/png_h : dimensions (par espece, adaptatif)
# Retourne TRUE si PNG ecrit (contient au moins un pixel non-vide), FALSE sinon (semaine vide)
write_optimized_png <- function(ranks, path, png_w, png_h) {
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
  rgba <- array(0, dim = c(png_h, png_w, 4))
  rgba[,,1] <- matrix(R_ch, png_h, png_w, byrow = TRUE) / 255
  rgba[,,2] <- matrix(G_ch, png_h, png_w, byrow = TRUE) / 255
  rgba[,,3] <- matrix(B_ch, png_h, png_w, byrow = TRUE) / 255
  rgba[,,4] <- matrix(A_ch, png_h, png_w, byrow = TRUE) / 255

  # Format WebP LOSSLESS pour zero perte de qualite (l'input est deja quantize a
  # 128 couleurs, donc lossless preserve tout exactement). Fallback PNG si magick
  # indispo.
  is_webp <- endsWith(path, ".webp")
  if (HAS_MAGICK) {
    img <- magick::image_read(rgba)
    img <- magick::image_quantize(img, max = 128, colorspace = "rgb", dither = FALSE)
    if (is_webp) {
      # WebP lossy quality 90 : imperceptible sur palette 128 couleurs, -30% vs
      # lossless. method 6 = compression max (slower encode, better ratio).
      magick::image_write(img, path = path, format = "webp", quality = 90,
                          defines = c("webp:method" = "6"))
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

    # ---- BBOX adaptatif par espece ----
    # 1) Reduction : max des 52 weeks par pixel -> masque "presence quelconque annuelle"
    r_max <- terra::app(r, fun = function(x) { m <- max(x, na.rm = TRUE); if(is.infinite(m)) NA_real_ else m })
    # 2) Filtre : garde uniquement pixels au-dessus du 1er percentile (evite les points
    #    outliers/GPS-error qui gonfleraient artificiellement le bbox)
    vals_max <- terra::values(r_max)
    pos_vals <- vals_max[!is.na(vals_max) & vals_max > 0]
    if (length(pos_vals) == 0) stop("no positive data")
    p1_threshold <- as.numeric(quantile(pos_vals, 0.01))
    r_max[r_max <= p1_threshold] <- NA
    # 3) Trim les bords tout-transparents pour obtenir le bbox natif
    r_trimmed <- terra::trim(r_max)
    if (is.null(r_trimmed)) stop("trim returned null")
    e_ll <- terra::ext(r_trimmed)
    # 4) Padding 2 degres + clamp world extent
    pad <- 2
    sp_bbox <- c(
      max(-180, e_ll$xmin - pad),
      max(-60,  e_ll$ymin - pad),
      min( 180, e_ll$xmax + pad),
      min(  85, e_ll$ymax + pad)
    )
    # 5) Compute PNG dims from Mercator aspect
    bbox_ll <- ext(sp_bbox[1], sp_bbox[3], sp_bbox[2], sp_bbox[4])
    bbox_merc <- project(as.polygons(bbox_ll, crs = "EPSG:4326"), "EPSG:3857")
    e_merc <- ext(bbox_merc)
    aspect_sp <- as.numeric((e_merc$xmax - e_merc$xmin) / (e_merc$ymax - e_merc$ymin))
    sp_png_w <- PNG_W
    sp_png_h <- as.integer(round(sp_png_w / aspect_sp))
    # Clamp dimensions raisonnables (evite ratios extremes qui casseraient le layout)
    sp_png_h <- max(200L, min(sp_png_h, 900L))

    # Reprojection et resample sur la grille cible
    r_merc <- project(r, "EPSG:3857", method = "average")
    r_cropped <- crop(r_merc, e_merc, snap = "out")
    target <- rast(nrows = sp_png_h, ncols = sp_png_w, extent = e_merc, crs = "EPSG:3857")
    r_final <- resample(r_cropped, target, method = "average")

    # Normalisation percentile GLOBALE sur les 52 weeks (cle de la vague migration)
    all_vals <- values(r_final)
    all_vals[all_vals <= 0] <- NA
    valid_global <- !is.na(all_vals)
    if (!any(valid_global)) stop("no data in adaptive bbox")
    global_ranks <- rep(NA_real_, length(all_vals))
    global_ranks[valid_global] <- (rank(all_vals[valid_global], ties.method = "average") - 1) /
                                  max(1, sum(valid_global) - 1)

    n_px_layer <- sp_png_w * sp_png_h
    ranks_mat <- matrix(global_ranks, nrow = n_px_layer, ncol = n_weeks)

    # Sous-echantillonnage 1 week sur 2 : 26 frames au lieu de 52 (-50pct stockage,
    # perte de fluidite quasi imperceptible sur une animation d'anim migration).
    weeks_written <- integer(0)
    week_seq <- seq(1L, n_weeks, by = 2L)   # 1, 3, 5, ..., 51
    for (w in week_seq) {
      week_ranks <- ranks_mat[, w]
      png_path <- file.path(sp_dir, sprintf("w%02d.png", w))
      wrote <- write_optimized_png(week_ranks, png_path, sp_png_w, sp_png_h)
      if (wrote) {
        weeks_written <- c(weeks_written, w)
      } else if (file.exists(png_path)) {
        # Nettoie un ancien PNG vide de rebuild precedent
        file.remove(png_path)
      }
    }

    manifest[[sci]] <- list(
      code = code,
      w = sp_png_w, h = sp_png_h,
      bbox = as.numeric(sp_bbox),
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
    # Poids moyen + bbox adaptatif pour tracer les gains
    sp_size_kb <- round(sum(file.info(list.files(sp_dir, full.names = TRUE))$size, na.rm = TRUE) / 1024)
    entry <- manifest[[sci]]
    cat(sprintf("OK %d wk, %dx%d, %d KB (%.1fmin, ETA %.1fmin)\n",
                n_w, entry$w, entry$h, sp_size_kb, elapsed_min, eta_min))
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
