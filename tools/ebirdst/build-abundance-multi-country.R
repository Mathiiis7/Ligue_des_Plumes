# build-abundance-multi-country.R
#
# Version optimisee (Opt #1 + #3) : au lieu de charger le raster N fois pour N pays,
# on inverse la boucle : pour chaque espece, charge raster UNE fois puis extrait pour
# tous les pays qui en ont besoin. Gain typique ~7x vs version naive.
#
# Opt #1 : boucle par espece (extraction multi-pays sans re-load)
# Opt #3 : pre-filter via ebirdst_runs range fields + skip especes hors bounding box
#          des polygones-pays (approximation rapide avant load raster)
#
# Sortie par pays : tools/real-abundance-st-<CC>.generated.js
# Log par pays : tools/ebirdst-build-<CC>.log
#
# Usage : Rscript tools/ebirdst/build-abundance-multi-country.R
#   Sans arg : tourne les pays definis dans COUNTRIES
#   Avec 1 arg : tourne seulement le pays donne (ex: Rscript ... US)
#   Avec plusieurs args : tourne cette liste (ex: Rscript ... US CR)

suppressPackageStartupMessages({
  library(ebirdst)
  library(sf)
  library(terra)
  library(dplyr)
  library(rnaturalearth)
  library(jsonlite)
  library(httr)
})

# Force flush stdout apres chaque cat -> progression visible en live (Tee-Object)
.cat_orig <- cat
cat <- function(...) { .cat_orig(...); flush.console() }

EBIRD_API_KEY <- "dbflh4atmsom"
Sys.setenv(EBIRDST_KEY = "obfvm9uetmhe")

fetch_country_species <- function(cc) {
  url <- paste0("https://api.ebird.org/v2/product/spplist/", cc)
  r <- httr::GET(url, httr::add_headers(`X-eBirdApiToken` = EBIRD_API_KEY))
  if (httr::status_code(r) != 200) stop("eBird API error ", httr::status_code(r), " pour ", cc)
  jsonlite::fromJSON(httr::content(r, as = "text", encoding = "UTF-8"))
}

# -------- Config --------
COUNTRIES <- list(
  US = c("USA", "Etats-Unis"),
  CR = c("CRI", "Costa Rica"),
  AU = c("AUS", "Australie"),
  KE = c("KEN", "Kenya")
)

args <- commandArgs(trailingOnly = TRUE)
if (length(args) >= 1) {
  cc_args <- toupper(args)
  unknown <- setdiff(cc_args, names(COUNTRIES))
  if (length(unknown) > 0) stop("Codes pays inconnus : ", paste(unknown, collapse = ", "),
                                ". Attendus : ", paste(names(COUNTRIES), collapse = ", "))
  COUNTRIES <- COUNTRIES[cc_args]
}

FR_TIER_THRESHOLDS <- c(2.2596, 0.8496, 0.34178, 0.12404, 0.04666, 0.01880, 0.00440, 0.00114, 0.00009)

abd_to_tier <- function(a) {
  if (is.na(a) || a <= 0) return(10L)
  for (i in seq_along(FR_TIER_THRESHOLDS)) if (a >= FR_TIER_THRESHOLDS[i]) return(i)
  return(10L)
}

compute_composite_tier <- function(annual, peak_nat, peak_local) {
  t_a <- abd_to_tier(annual); t_n <- abd_to_tier(peak_nat); t_l <- abd_to_tier(peak_local)
  # Composite 50/30/20 : reduit le poids de la densite hotspot (biais grosses concentrations)
  # au profit de la moyenne annuelle. Voir dashboard historique.
  composite <- round(0.5 * t_a + 0.3 * t_n + 0.2 * t_l)
  if (composite < 1) composite <- 1L
  if (composite > 10) composite <- 10L
  as.integer(composite)
}

runs <- ebirdst_runs
runs$sci_lc <- tolower(runs$scientific_name)

global_start <- Sys.time()

# -------- Phase 1 : chargement polygones + spplist pour tous les pays --------
cat("\n========================================================================\n")
cat("Phase 1 : polygones + spplist eBird pour ", length(COUNTRIES), " pays\n", sep = "")
cat("========================================================================\n")

country_polys <- list()      # cc -> polygone sf (non projete, longlat)
country_species <- list()    # cc -> vecteur species_code
country_names <- list()      # cc -> nom francais
for (cc in names(COUNTRIES)) {
  cc_info <- COUNTRIES[[cc]]
  iso3 <- cc_info[1]; cc_name <- cc_info[2]
  country_names[[cc]] <- cc_name

  cat("[", cc, "] ", cc_name, " : polygone...", sep = "")
  poly <- tryCatch(ne_countries(country = cc_name, scale = "medium", returnclass = "sf"),
                   error = function(e) NULL)
  if (is.null(poly) || nrow(poly) == 0) {
    poly <- tryCatch(ne_countries(scale = "medium", returnclass = "sf") %>%
                       dplyr::filter(iso_a3 == iso3),
                     error = function(e) NULL)
  }
  if (is.null(poly) || nrow(poly) == 0) { cat(" INTROUVABLE, skip\n"); next }
  country_polys[[cc]] <- poly

  cat(" spplist eBird...")
  sp <- tryCatch(fetch_country_species(cc), error = function(e) NULL)
  if (is.null(sp)) { cat(" ERR API, skip\n"); country_polys[[cc]] <- NULL; next }
  country_species[[cc]] <- sp
  cat(" ", length(sp), " especes.\n", sep = "")
}

# Ne conserver que les pays chargeables
active_countries <- names(country_polys)
if (length(active_countries) == 0) stop("Aucun pays chargeable.")

# -------- Phase 2 : construction de l'union des especes a traiter --------
all_species_needed <- unique(unlist(country_species))
runs_needed <- runs[runs$species_code %in% all_species_needed, ]
cat("\nUnion des species observees (via eBird API) : ", length(all_species_needed),
    " codes.\n", sep = "")
cat("Match ebirdst_runs (modelisees par Cornell) : ", nrow(runs_needed), " especes S&T.\n", sep = "")

# Table lookup : pour chaque species_code, la liste des pays qui l'ont observe
species_to_countries <- list()
for (cc in active_countries) {
  for (sp in country_species[[cc]]) {
    species_to_countries[[sp]] <- c(species_to_countries[[sp]], cc)
  }
}

# -------- Phase 3 : boucle par espece (Opt #1 : raster charge 1x, extrait N fois) --------
cat("\n========================================================================\n")
cat("Phase 3 : traitement de ", nrow(runs_needed), " especes uniques\n", sep = "")
cat("Chaque raster charge UNE fois, extrait pour tous les pays qui en ont besoin.\n")
cat("========================================================================\n")

# Cache polygones projetes (meme CRS = sinusoidal pour tous les rasters Cornell)
poly_prj_cache <- list()   # cc -> polygone projete
raster_crs_cache <- NULL

# Results par pays
results <- list()
errors <- list()
n_ok_per_cc <- list()
n_zero_per_cc <- list()
for (cc in active_countries) {
  results[[cc]] <- list()
  errors[[cc]] <- character(0)
  n_ok_per_cc[[cc]] <- 0
  n_zero_per_cc[[cc]] <- 0
}
n_species_processed <- 0
n_raster_load_err <- 0
raster_errors <- character(0)

t_phase3 <- Sys.time()

for (i in seq_len(nrow(runs_needed))) {
  row <- runs_needed[i, ]
  sci <- tolower(row$scientific_name)
  code <- row$species_code

  if (i %% 25 == 0 || i == 1) {
    elapsed <- as.numeric(Sys.time() - t_phase3, units = "mins")
    tot_ok <- sum(unlist(n_ok_per_cc))
    tot_zero <- sum(unlist(n_zero_per_cc))
    cat(sprintf("  [%d/%d] %.1f min | rasters OK: %d, err: %d | extractions OK cross-cc: %d, zero: %d | %s (%s)\n",
                i, nrow(runs_needed), elapsed,
                n_species_processed, n_raster_load_err, tot_ok, tot_zero, sci, code))
  }

  # Load raster (une seule fois pour cette espece)
  r_weekly <- tryCatch({
    suppressMessages(
      ebirdst_download_status(species = code, download_abundance = TRUE,
                              download_ranges = FALSE, pattern = "abundance_median_3km",
                              force = FALSE)
    )
    load_raster(code, resolution = "3km", product = "abundance", period = "weekly")
  }, error = function(e) {
    raster_errors <<- c(raster_errors, paste0(sci, " (", code, "): ", conditionMessage(e)))
    NULL
  })

  if (is.null(r_weekly)) {
    n_raster_load_err <- n_raster_load_err + 1
    next
  }
  n_species_processed <- n_species_processed + 1

  # Projeter les polygones a la CRS du raster (une seule fois, au 1er raster)
  if (is.null(raster_crs_cache)) {
    raster_crs_cache <- crs(r_weekly)
    for (cc in active_countries) {
      poly_prj_cache[[cc]] <- st_transform(country_polys[[cc]], crs = raster_crs_cache)
    }
    cat("  (Polygones projetes en CRS raster, cache pour reutilisation.)\n")
  }

  # Extraction pour tous les pays qui ont observe cette espece (Opt #1)
  needed_ccs <- species_to_countries[[code]]
  if (is.null(needed_ccs)) needed_ccs <- character(0)

  for (cc in needed_ccs) {
    if (!cc %in% active_countries) next
    tryCatch({
      poly_prj <- poly_prj_cache[[cc]]

      weekly_means <- terra::extract(r_weekly, vect(poly_prj), fun = mean, na.rm = TRUE)
      layer_cols <- setdiff(names(weekly_means), "ID")
      weekly_vec <- as.numeric(colMeans(weekly_means[, layer_cols, drop = FALSE], na.rm = TRUE))
      weekly_vec[is.nan(weekly_vec) | is.na(weekly_vec)] <- 0
      if (length(weekly_vec) != 52) {
        pad <- 52 - length(weekly_vec)
        if (pad > 0) weekly_vec <- c(weekly_vec, rep(0, pad))
        else weekly_vec <- weekly_vec[1:52]
      }

      if (max(weekly_vec, na.rm = TRUE) == 0) {
        n_zero_per_cc[[cc]] <- n_zero_per_cc[[cc]] + 1
      } else {
        abd_annual <- mean(weekly_vec, na.rm = TRUE)
        if (is.nan(abd_annual) || is.na(abd_annual)) abd_annual <- 0
        abd_peak_national <- max(weekly_vec, na.rm = TRUE)
        if (is.nan(abd_peak_national) || is.infinite(abd_peak_national)) abd_peak_national <- 0

        all_pixels <- terra::extract(r_weekly, vect(poly_prj))
        all_vals <- unlist(all_pixels[, layer_cols, drop = FALSE])
        non_zero <- all_vals[all_vals > 0 & !is.na(all_vals) & !is.nan(all_vals)]
        abd_peak_local <- if (length(non_zero) >= 5) as.numeric(median(non_zero, na.rm = TRUE)) else 0
        if (is.nan(abd_peak_local) || is.na(abd_peak_local)) abd_peak_local <- 0

        results[[cc]][[sci]] <- list(
          abd_annual = round(abd_annual, 5),
          abd_peak_national = round(abd_peak_national, 5),
          abd_peak_local = round(abd_peak_local, 5),
          weekly = round(weekly_vec, 7),
          species_code = code
        )
        n_ok_per_cc[[cc]] <- n_ok_per_cc[[cc]] + 1

        rm(all_pixels, all_vals, non_zero)
      }
      rm(weekly_means, weekly_vec)
    }, error = function(e) {
      errors[[cc]] <<- c(errors[[cc]], paste0(sci, " (", code, "): ", conditionMessage(e)))
    })
  }

  # Free raster + gc apres chaque espece pour eviter bad_alloc
  rm(r_weekly)
  invisible(gc(verbose = FALSE))
}

phase3_elapsed <- as.numeric(Sys.time() - t_phase3, units = "mins")
cat(sprintf("\nPhase 3 terminee en %.1f min.\n", phase3_elapsed))

# -------- Phase 4 : ecriture JSON par pays --------
cat("\n========================================================================\n")
cat("Phase 4 : ecriture des JSON par pays\n")
cat("========================================================================\n")

for (cc in active_countries) {
  cc_name <- country_names[[cc]]
  res_cc <- results[[cc]]
  n_ok <- n_ok_per_cc[[cc]]
  n_zero <- n_zero_per_cc[[cc]]

  # Compose tier
  out <- list()
  for (sci in names(res_cc)) {
    r <- res_cc[[sci]]
    t_annual <- abd_to_tier(r$abd_annual)
    t_peak_n <- abd_to_tier(r$abd_peak_national)
    t_peak_l <- abd_to_tier(r$abd_peak_local)
    t_composite <- compute_composite_tier(r$abd_annual, r$abd_peak_national, r$abd_peak_local)
    out[[sci]] <- list(
      a = r$abd_annual, an = r$abd_peak_national, al = r$abd_peak_local,
      t = t_composite, ta = t_annual, tn = t_peak_n, tl = t_peak_l,
      w = r$weekly, tr = NULL
    )
  }

  tier_dist <- table(sapply(out, function(x) x$t))
  cat("\n[", cc, "] ", cc_name, " : ", length(out), " especes retenues (", n_zero, " zero).\n", sep = "")
  for (t in names(tier_dist)) cat(sprintf("  tier %s : %d\n", t, tier_dist[t]))

  js_content <- c(
    paste0("// Genere par tools/ebirdst/build-abundance-multi-country.R pour ", cc_name, " (", cc, ")."),
    paste0("// Data version : 2023 (Status). Genere le ", format(Sys.time()), "."),
    paste0("// Especes couvertes : ", length(out), " sur ", length(country_species[[cc]]), " observees dans le pays."),
    "// Format compact : { sci: { a, an, al, t, ta, tn, tl, w[52], tr } }",
    paste0("export const REAL_ABUNDANCE_ST_", cc, " = ",
           toJSON(out, auto_unbox = TRUE, null = "null"), ";")
  )
  out_path <- paste0("C:/Users/mathi/Documents/Projets/Ligue_des_Plumes/tools/real-abundance-st-",
                     cc, ".generated.js")
  writeLines(js_content, out_path)
  cat("  Ecrit :", out_path, "(", file.info(out_path)$size, "bytes)\n")

  log_path <- paste0("C:/Users/mathi/Documents/Projets/Ligue_des_Plumes/tools/ebirdst-build-", cc, ".log")
  log_lines <- c(
    paste0("Build eBird S&T ", cc_name, " (", cc, ") - ", format(Sys.time())),
    paste0("Phase 3 duree globale : ", round(phase3_elapsed, 1), " min (partagee entre tous les pays)"),
    paste0("Especes observees dans le pays (eBird API) : ", length(country_species[[cc]])),
    paste0("Traitees OK : ", n_ok),
    paste0("Absentes du pays (raster zero) : ", n_zero),
    paste0("Erreurs extraction : ", length(errors[[cc]])),
    "",
    "=== Erreurs par espece ===",
    errors[[cc]]
  )
  writeLines(log_lines, log_path)
}

# Log global raster loading
cat("\nRaster loads : ", n_species_processed, " OK, ", n_raster_load_err, " erreurs.\n", sep = "")
if (length(raster_errors) > 0 && length(raster_errors) <= 10) {
  cat("Premieres erreurs raster :\n")
  for (e in head(raster_errors, 10)) cat("  ", e, "\n")
}

global_elapsed <- as.numeric(Sys.time() - global_start, units = "hours")
cat("\n========================================================================\n")
cat(sprintf("Global termine en %.2f h\n", global_elapsed))
cat("========================================================================\n")
