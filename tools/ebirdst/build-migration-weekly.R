# build-migration-weekly.R
#
# Genere 52 PNG hebdomadaires par espece migratrice FR pour la feature
# "migration animee". Cible : voir la vague de migration semaine par semaine.
#
# Sortie :
#   data/range-weekly/{code}/w{01..52}.webp   WebP LOSSLESS indexed + alpha
#   data/range-weekly-index.json              Manifest { sci: {code, w, h, bbox, weeks:[]} }
#
# Configuration qualite max (stockage sur repo separe Ligue_des_Plumes_data, plus
# de contrainte poids sur main) :
# - PNG_W = 500 (nettete sur retina), PNG_H calcule par espece via bbox adaptatif
# - BBOX adaptatif par espece : trim transparent + padding 3 degres + filtre p1
# - Alpha cutoff rank < 0.02 : elimine bruit de fond en gardant la dynamique
# - 52 frames complets : fluidite max animation
# - Skip semaines vides : aucune donnee -> pas de fichier
# - Quantize 128 couleurs (palette + alpha) via magick
# - PNG-8 indexed + oxipng lossless : meilleur ratio sur heatmap avec alpha
#   (WebP lossy testee mais PIRE que PNG-8 pour ce type d'image)
# - Skip complet des especes deja traitees via manifest
# Estimation : ~1500-2000 KB par espece = ~500-600 MB total pour 304 sp
# (aucun impact sur main repo, tout dans Ligue_des_Plumes_data)
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
PNG_W <- 500L
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

    # ---- BBOX adaptatif par espece (en Mercator direct) ----
    # Les rasters Cornell sont en projection Sinusoidale (metres). On reprojette
    # d'abord en Mercator, puis on trim la, ce qui donne le bbox directement dans
    # la CRS de rendu final (evite les conversions CRS piegees).
    r_merc <- project(r, "EPSG:3857", method = "average")
    # 1) Reduction : max des 52 weeks par pixel -> masque "presence quelconque".
    #    IMPORTANT : utilise max(r) natif terra (code C++) au lieu de terra::app avec
    #    fonction R (qui appelle R par pixel = 100x plus lent).
    r_max_merc <- max(r_merc, na.rm = TRUE)
    # 2) Filtre : garde uniquement pixels au-dessus du 1er percentile (vire outliers)
    vals_max <- terra::values(r_max_merc, mat = FALSE)
    pos_vals <- vals_max[!is.na(vals_max) & vals_max > 0]
    if (length(pos_vals) == 0) stop("no positive data")
    p1_threshold <- as.numeric(quantile(pos_vals, 0.01))
    r_max_merc[r_max_merc <= p1_threshold] <- NA
    # 3) Trim les bords tout-transparents
    r_trimmed <- terra::trim(r_max_merc)
    if (is.null(r_trimmed)) stop("trim returned null")
    e_merc <- terra::ext(r_trimmed)
    # 4) Padding fixe en metres Mercator (~350km = ~3 degres a l'equateur) + clamp
    #    au bbox monde en Mercator (evite les singularites aux poles).
    pad_m <- 350000
    world_x <- 20037508
    world_y_max <-  18500000    # ~85 degres N en Mercator
    world_y_min <-  -8399737    # ~-60 degres S en Mercator
    e_merc <- terra::ext(
      max(-world_x,     e_merc$xmin - pad_m),
      min( world_x,     e_merc$xmax + pad_m),
      max( world_y_min, e_merc$ymin - pad_m),
      min( world_y_max, e_merc$ymax + pad_m)
    )
    # 5) Convertit le bbox en WGS84 pour le manifest (client Leaflet utilise lat/lng)
    poly_ll <- terra::project(terra::as.polygons(e_merc, crs = "EPSG:3857"), "EPSG:4326")
    e_ll <- terra::ext(poly_ll)
    sp_bbox <- c(e_ll$xmin, e_ll$ymin, e_ll$xmax, e_ll$ymax)
    # 6) Dimensions PNG depuis aspect Mercator (aucune distorsion)
    merc_w <- as.numeric(e_merc$xmax - e_merc$xmin)
    merc_h <- as.numeric(e_merc$ymax - e_merc$ymin)
    aspect_sp <- merc_w / merc_h
    sp_png_w <- PNG_W
    sp_png_h <- as.integer(round(sp_png_w / aspect_sp))
    sp_png_h <- max(200L, min(sp_png_h, 900L))

    # Crop et resample sur la grille cible
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
    # Alpha cutoff : les 2% de pixels les plus faibles deviennent transparents
    # (elimine le bruit de fond, garde une bonne dynamique). Seuil bas car stockage
    # plus une contrainte, on privilegie la richesse d'info.
    global_ranks[global_ranks < 0.02] <- NA

    n_px_layer <- sp_png_w * sp_png_h
    ranks_mat <- matrix(global_ranks, nrow = n_px_layer, ncol = n_weeks)

    # 52 frames complets (stockage sur repo separe, plus de contrainte poids repo main).
    # Fluidite max de l'animation migration.
    weeks_written <- integer(0)
    for (w in seq_len(n_weeks)) {
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
