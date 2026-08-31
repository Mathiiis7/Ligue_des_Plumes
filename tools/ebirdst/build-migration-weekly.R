# build-migration-weekly.R
#
# Genere 52 PNG hebdomadaires par espece migratrice FR (feature "migration animee").
# Cible : voir la vague de migration semaine par semaine (ex : Cigogne blanche
# arrive en semaine 10, culmine 14, redescend 34-36). Le client fera une timeline
# scroll ou un loop animation par-dessus.
#
# Sortie :
#   data/range-weekly/{code}/w{01..52}.png    PNGs 1200 x auto (Europe extent)
#   data/range-weekly-index.json              Manifest { sci: {code, w, h, bbox, weeks:[]} }
#
# Design cles :
# - Extent EUROPE (pas monde) : migration = phenomene europeen, PNG lourd sinon.
# - Normalisation percentile GLOBALE sur les 52 semaines de l'espece (pas par
#   semaine). C'est ce qui capture la vague : les semaines vides sont vides, les
#   pics d'abondance sont rouges. Une normalisation per-week ferait paraitre tous
#   les weeks "pleins" et masquerait le signal migration.
# - Skip PNGs deja generes (resume trivial si interrompu).
#
# Selection especes :
# - Reprend REAL_RARITY FR (data/generated/real-rarity.generated.js ou app.js inline)
# - Filtre : garde uniquement les migrateurs Cornell (raster contient
#   breeding + nonbreeding OU prebreeding_migration, PAS resident seul).
# - Estimation : ~80-120 especes FR concernees.
#
# Volume prevu : ~100 sp * 52 = ~5000 PNGs. Rendu ~5-10s/PNG en R + download
# ratser weekly = plusieurs heures. Parfait pour tourner la nuit.
#
# Usage :
#   Rscript tools/ebirdst/build-migration-weekly.R              # tout, extent Europe
#   Rscript tools/ebirdst/build-migration-weekly.R demo         # 3 especes emblematiques test
#   Rscript tools/ebirdst/build-migration-weekly.R sp <code>    # une espece specifique par code Cornell

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

# ---------- Config ----------
args <- commandArgs(trailingOnly = TRUE)
mode <- if (length(args) >= 1) tolower(args[1]) else "all"
single_code <- if (mode == "sp" && length(args) >= 2) args[2] else NULL

# Europe extent (WGS84 lat/lng) : couvre l'aire de migration ouest-palearctique
# jusqu'a l'Afrique subsaharienne (les migrateurs FR passent tous par ici).
BBOX <- c(-25, -10, 45, 72)

# Especes emblematiques pour le mode demo (migrateurs bien connus)
DEMO_CODES <- c(
  "whiste2",   # White Stork - Cigogne blanche
  "barswa",    # Barn Swallow - Hirondelle rustique
  "commar",    # Common Martin (Sand Martin) - Hirondelle de rivage
  "eurhoo",    # Eurasian Hoopoe - Huppe fasciee
  "beeeat1"    # European Bee-eater - Guepier d'Europe
)

# Dimensions PNG : aspect Mercator du bbox Europe
suppressWarnings({
  bbox_ll_tmp <- terra::ext(BBOX[1], BBOX[3], BBOX[2], BBOX[4])
  bbox_merc_tmp <- terra::project(terra::as.polygons(bbox_ll_tmp, crs = "EPSG:4326"), "EPSG:3857")
  e_merc_tmp <- terra::ext(bbox_merc_tmp)
})
merc_w <- e_merc_tmp$xmax - e_merc_tmp$xmin
merc_h <- e_merc_tmp$ymax - e_merc_tmp$ymin
merc_aspect <- as.numeric(merc_w / merc_h)
# Un peu plus petit que build-range-maps.R : 52 PNGs par sp, on optimise le poids
PNG_W <- 900
PNG_H <- round(PNG_W / merc_aspect)
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
cat("Extent:", paste(BBOX, collapse=","), "(Europe + Afrique du N)\n")
cat("Output:", OUT_DIR, "\n\n")

# ---------- Palette (identique a build-range-maps.R) ----------
pal <- colorRampPalette(c(
  "#3ea86b", "#a8d155", "#f5c518", "#f0733a", "#a11408"
))(100)
pal_rgb <- col2rgb(pal)

# ---------- Selection especes ----------
# Charge REAL_RARITY FR depuis le fichier genere (post-filtre fantomes = 627 sp)
rarity_file <- file.path(ROOT, "data", "generated", "real-rarity.generated.js")
if (!file.exists(rarity_file)) stop("Fichier rarete FR introuvable : ", rarity_file)
rarity_txt <- readLines(rarity_file, warn = FALSE)
rarity_json_str <- sub("^const \\w+\\s*=\\s*", "", paste(rarity_txt, collapse = "\n"))
rarity_json_str <- sub(";\\s*$", "", rarity_json_str)
fr_species <- jsonlite::fromJSON(rarity_json_str)
fr_sci <- names(fr_species)
cat("Especes FR (post-filtre fantomes) :", length(fr_sci), "\n")

runs <- ebirdst_runs
# Normalise pour matching (lowercase, espaces simples)
runs$sci_lc <- tolower(runs$scientific_name)
matched <- runs[runs$sci_lc %in% tolower(fr_sci), ]
cat("Especes FR presentes chez Cornell :", nrow(matched), "\n")

# Detecte les migrateurs : has_nonresident_seasons = TRUE si le raster peut fournir
# des layers autres que resident. On regarde les colonnes breeding_quality et
# nonbreeding_quality dans ebirdst_runs (>= 1 = donnees dispos pour cette saison).
# Si les deux sont >= 1 ET resident_quality est absent/0 -> migrateur clair.
is_migrator <- function(row) {
  b <- suppressWarnings(as.numeric(row$breeding_quality))
  nb <- suppressWarnings(as.numeric(row$nonbreeding_quality))
  r <- suppressWarnings(as.numeric(row$resident_quality))
  if (is.na(r)) r <- 0
  if (is.na(b)) b <- 0
  if (is.na(nb)) nb <- 0
  # Considere migrateur si breeding ET nonbreeding sont dispos ET resident est faible
  return(b >= 1 && nb >= 1 && r == 0)
}
matched$is_migrator <- vapply(seq_len(nrow(matched)), function(i) is_migrator(matched[i, ]), logical(1))
migrators <- matched[matched$is_migrator, ]
cat("Migrateurs detectes :", nrow(migrators), "\n\n")

if (mode == "demo") {
  migrators <- runs[runs$species_code %in% DEMO_CODES, ]
  cat("Mode DEMO :", nrow(migrators), "especes\n")
} else if (mode == "sp") {
  migrators <- runs[runs$species_code == single_code, ]
  if (nrow(migrators) == 0) stop("Code Cornell introuvable : ", single_code)
  cat("Mode single sp :", single_code, "\n")
}

# ---------- Skip especes deja entierement generees ----------
count_pngs <- function(code) {
  d <- file.path(OUT_DIR, code)
  if (!dir.exists(d)) return(0L)
  length(list.files(d, pattern = "^w\\d{2}\\.png$"))
}
migrators$done_weeks <- vapply(migrators$species_code, count_pngs, integer(1))
migrators <- migrators[migrators$done_weeks < 52, ]
cat("A traiter :", nrow(migrators), "especes (les completes a 52/52 sont skip)\n\n")

# ---------- Manifest ----------
manifest <- if (file.exists(MANIFEST)) jsonlite::fromJSON(MANIFEST, simplifyVector = FALSE) else list()

# ---------- Boucle principale ----------
start_ts <- Sys.time()
success <- 0
failed <- 0

for (i in seq_len(nrow(migrators))) {
  sp <- migrators[i, ]
  code <- sp$species_code
  sci <- sp$scientific_name
  pct <- sprintf("%d/%d", i, nrow(migrators))

  cat(pct, code, "-", sci, "(", sp$done_weeks, "/52 deja fait) ... ")

  sp_dir <- file.path(OUT_DIR, code)
  if (!dir.exists(sp_dir)) dir.create(sp_dir, recursive = TRUE)

  ok <- tryCatch({
    # Telechargement raster hebdomadaire (skip si cache local dispo)
    ebirdst_download_status(code, download_ranges = FALSE,
                            pattern = "abundance_median_9km",
                            force = FALSE, show_progress = FALSE)

    # Charge stack 52 weeks (median plutot que mean : moins bruite)
    r <- load_raster(code, product = "abundance", period = "weekly",
                     metric = "median", resolution = "9km")
    n_weeks <- terra::nlyr(r)
    if (n_weeks < 52) cat("[", n_weeks, " weeks only] ", sep="")

    # Reprojette une seule fois toute la stack en Web Mercator
    bbox_ll <- ext(BBOX[1], BBOX[3], BBOX[2], BBOX[4])
    bbox_merc <- project(as.polygons(bbox_ll, crs = "EPSG:4326"), "EPSG:3857")
    e_merc <- ext(bbox_merc)
    r_merc <- project(r, "EPSG:3857", method = "average")
    r_cropped <- crop(r_merc, e_merc, snap = "out")
    target <- rast(nrows = PNG_H, ncols = PNG_W, extent = e_merc, crs = "EPSG:3857")
    r_final <- resample(r_cropped, target, method = "average")

    # ---- Normalisation percentile GLOBALE sur les 52 weeks ----
    # C'est le coeur du script : les ranks sont calcules sur TOUTES les valeurs
    # non-nulles de toutes les semaines confondues. Une cellule x semaine y qui
    # est au 90eme percentile de la distribution GLOBALE de l'espece apparait
    # rouge, meme si dans SA semaine locale d'autres cellules seraient plus
    # rouges. Resultat : la semaine de pic est visuellement dominante, les
    # semaines creuses restent vides. C'est la vague migration.
    all_vals <- values(r_final)
    all_vals[all_vals <= 0] <- NA
    valid_global <- !is.na(all_vals)
    if (!any(valid_global)) stop("no data in europe bbox")
    global_ranks <- rep(NA_real_, length(all_vals))
    global_ranks[valid_global] <- (rank(all_vals[valid_global], ties.method = "average") - 1) /
                                  max(1, sum(valid_global) - 1)
    # Reshape en matrice (n_pixels_par_layer x n_weeks)
    n_px_layer <- PNG_W * PNG_H
    ranks_mat <- matrix(global_ranks, nrow = n_px_layer, ncol = n_weeks)

    weeks_written <- integer(0)
    for (w in seq_len(n_weeks)) {
      week_ranks <- ranks_mat[, w]
      # Skip si aucun pixel non-vide cette semaine (sauve un PNG transparent quand meme
      # pour eviter les trous dans la timeline, mais tres leger)
      color_idx <- pmax(1, pmin(100, round(week_ranks * 99) + 1))
      R_ch <- integer(n_px_layer); G_ch <- integer(n_px_layer)
      B_ch <- integer(n_px_layer); A_ch <- integer(n_px_layer)
      valid <- !is.na(color_idx) & !is.na(week_ranks)
      if (any(valid)) {
        R_ch[valid] <- pal_rgb[1, color_idx[valid]]
        G_ch[valid] <- pal_rgb[2, color_idx[valid]]
        B_ch[valid] <- pal_rgb[3, color_idx[valid]]
        # Alpha : plancher 120 (un peu plus bas que build-range-maps car les semaines
        # basses d'un migrateur doivent apparaitre subtiles, pas plaquees).
        A_ch[valid] <- as.integer(pmin(255, pmax(120, week_ranks[valid] * 135 + 120)))
      }
      rgba_array <- array(0, dim = c(PNG_H, PNG_W, 4))
      rgba_array[,,1] <- matrix(R_ch, PNG_H, PNG_W, byrow = TRUE) / 255
      rgba_array[,,2] <- matrix(G_ch, PNG_H, PNG_W, byrow = TRUE) / 255
      rgba_array[,,3] <- matrix(B_ch, PNG_H, PNG_W, byrow = TRUE) / 255
      rgba_array[,,4] <- matrix(A_ch, PNG_H, PNG_W, byrow = TRUE) / 255
      png_path <- file.path(sp_dir, sprintf("w%02d.png", w))
      png::writePNG(rgba_array, png_path)
      weeks_written <- c(weeks_written, w)
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
    elapsed_min <- as.numeric(difftime(Sys.time(), start_ts, units = "mins"))
    rate <- i / elapsed_min
    eta_min <- (nrow(migrators) - i) / rate
    cat(sprintf("OK (%.1fmin elapsed, ETA %.1fmin)\n", elapsed_min, eta_min))
  } else {
    failed <- failed + 1
  }

  # Sauve manifest tous les 5 (52 PNGs par sp, on flush plus souvent que build-range-maps)
  if (i %% 5 == 0) {
    jsonlite::write_json(manifest, MANIFEST, auto_unbox = TRUE, pretty = FALSE)
  }
}

jsonlite::write_json(manifest, MANIFEST, auto_unbox = TRUE, pretty = FALSE)

cat("\n=== Termine ===\n")
cat("Succes :", success, " ; Echecs :", failed, "\n")
n_dirs <- length(list.dirs(OUT_DIR, recursive = FALSE))
n_pngs <- length(list.files(OUT_DIR, pattern = "\\.png$", recursive = TRUE))
cat("Dossiers especes :", n_dirs, " ; Total PNGs :", n_pngs, "\n")
cat("Manifest :", MANIFEST, "\n")
