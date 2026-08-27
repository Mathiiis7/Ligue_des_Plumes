# build-abundance-multi-country.R
#
# Version multi-pays : boucle sur les 10 pays du perimetre initial et genere
# pour chaque un fichier real-abundance-st-<CC>.generated.js contenant :
#   - a  : abondance moyenne annuelle (indiv/heure) dans le polygone du pays
#   - an : pic saisonnier national
#   - al : mediane des pixels-semaines non-nuls (densite typique hotspot)
#   - t  : tier composite 1-10
#   - ta/tn/tl : sous-tiers pour la sous-section detail
#   - w  : 52 valeurs hebdomadaires (histogramme fiche)
#
# Cornell S&T couvre inegalement les pays :
#   - Excellente : US, CA, UK, AU
#   - Bonne : ES, IT, PT, FR, DE
#   - Partielle : CR, KE, ME
# Species non couvertes en S&T sont naturellement omises (map = NULL).
#
# Sortie par pays : tools/real-abundance-st-<CC>.generated.js
# Log par pays : tools/ebirdst-build-<CC>.log
#
# Usage : Rscript tools/ebirdst/build-abundance-multi-country.R
#   Sans arg : tourne les 10 pays (FR skip car deja fait)
#   Avec arg : tourne seulement le pays donne (ex: Rscript ... ES)

suppressPackageStartupMessages({
  library(ebirdst)
  library(sf)
  library(terra)
  library(dplyr)
  library(rnaturalearth)
  library(jsonlite)
  library(httr)
})

# eBird API key (Mathis, meme que dans index.html - non secret, quota 10k requetes/jour)
EBIRD_API_KEY <- "dbflh4atmsom"

# Cornell eBird S&T access key (expire 26/01/2027). Set en dur car .Renviron
# n'est pas toujours lu correctement en Rscript.exe (Windows).
Sys.setenv(EBIRDST_KEY = "obfvm9uetmhe")

# Fetch la liste des especes observees dans un pays via eBird API v2
# Retourne un vecteur de species_code eBird
fetch_country_species <- function(cc) {
  url <- paste0("https://api.ebird.org/v2/product/spplist/", cc)
  r <- httr::GET(url, httr::add_headers(`X-eBirdApiToken` = EBIRD_API_KEY))
  if (httr::status_code(r) != 200) {
    stop("eBird API error ", httr::status_code(r), " pour ", cc)
  }
  codes <- jsonlite::fromJSON(httr::content(r, as = "text", encoding = "UTF-8"))
  cat("    eBird API : ", length(codes), " especes observees dans ", cc, "\n", sep = "")
  return(codes)
}

# -------- Config --------
COUNTRIES <- list(
  # code = c(ISO3 pour ne_countries, nom francais)
  # Skip : ME, ES, IT, GB, PT deja generes le 2026-08-27 (fichiers real-abundance-st-XX.generated.js).
  # Le 1er run overnight a plante sur US (std::bad_alloc, RAM saturee). Ce run 2 reprend
  # avec gc() explicite apres chaque espece pour eviter la saturation.
  US = c("USA", "Etats-Unis"),
  CR = c("CRI", "Costa Rica"),
  AU = c("AUS", "Australie"),
  KE = c("KEN", "Kenya")
)
# Pour re-tourner ME/ES/IT/GB/PT/FR, ajouter au dict ou passer en argument :
#   Rscript ... ES

# Argument optionnel : un seul pays
args <- commandArgs(trailingOnly = TRUE)
if (length(args) >= 1) {
  cc_arg <- toupper(args[1])
  if (!cc_arg %in% names(COUNTRIES)) stop("Code pays inconnu : ", cc_arg, ". Attendus : ", paste(names(COUNTRIES), collapse = ", "))
  COUNTRIES <- COUNTRIES[cc_arg]
}

# Seuils tier calibres sur la distribution FR (Option A : identique partout).
# On applique les memes seuils pour tous les pays -> tier 1 = "commun partout, facile"
# quel que soit le pays. Coherent visuellement pour l'utilisateur.
FR_TIER_THRESHOLDS <- c(2.2596, 0.8496, 0.34178, 0.12404, 0.04666, 0.01880, 0.00440, 0.00114, 0.00009)

abd_to_tier <- function(a) {
  if (is.na(a) || a <= 0) return(10L)
  for (i in seq_along(FR_TIER_THRESHOLDS)) if (a >= FR_TIER_THRESHOLDS[i]) return(i)
  return(10L)
}

compute_composite_tier <- function(annual, peak_nat, peak_local) {
  t_a <- abd_to_tier(annual)
  t_n <- abd_to_tier(peak_nat)
  t_l <- abd_to_tier(peak_local)
  composite <- round(0.4 * t_a + 0.3 * t_n + 0.3 * t_l)
  if (composite < 1) composite <- 1L
  if (composite > 10) composite <- 10L
  return(as.integer(composite))
}

# -------- Boucle pays --------
runs <- ebirdst_runs
runs$sci_lc <- tolower(runs$scientific_name)

global_start <- Sys.time()

for (cc in names(COUNTRIES)) {
  cc_info <- COUNTRIES[[cc]]
  iso3 <- cc_info[1]
  cc_name <- cc_info[2]

  t_start <- Sys.time()
  cat("\n\n========================================================================\n")
  cat("[", cc, "] ", cc_name, " (ISO3 : ", iso3, ")\n", sep = "")
  cat("========================================================================\n")
  cat("Start :", format(t_start), "\n\n")

  # 1) Polygone pays
  cat("[1] Polygone pays...\n")
  country_poly <- tryCatch(
    ne_countries(country = cc_name, scale = "medium", returnclass = "sf"),
    error = function(e) NULL
  )
  if (is.null(country_poly) || nrow(country_poly) == 0) {
    # Try by ISO3
    country_poly <- tryCatch(
      ne_countries(scale = "medium", returnclass = "sf") %>% dplyr::filter(iso_a3 == iso3),
      error = function(e) NULL
    )
  }
  if (is.null(country_poly) || nrow(country_poly) == 0) {
    cat("    ERREUR : polygone introuvable pour", cc_name, "-> skip\n")
    next
  }
  cat("    OK.\n")

  # 2) Species candidates : filter par eBird API spplist du pays.
  # Reduit drastiquement le nombre d'especes a traiter (500-2000 par pays au lieu de 2981)
  # et evite les downloads inutiles de rasters US-only pour un pays africain.
  cat("[2] Fetch species list eBird API pour", cc, "...\n")
  country_species <- tryCatch(fetch_country_species(cc), error = function(e) {
    cat("    ERREUR API :", conditionMessage(e), "\n")
    return(NULL)
  })
  if (is.null(country_species)) {
    cat("    Skip pays.\n"); next
  }
  runs_country <- runs[runs$species_code %in% country_species, ]
  cat("    Match ebirdst_runs :", nrow(runs_country), "especes S&T pour ce pays.\n")

  # 3) Boucle par espece
  results <- list()
  errors <- character(0)
  n_ok <- 0; n_err <- 0; n_zero <- 0
  poly_prj_cache <- NULL

  for (i in seq_len(nrow(runs_country))) {
    row <- runs_country[i, ]
    sci <- tolower(row$scientific_name)
    code <- row$species_code

    if (i %% 50 == 0 || i == 1) {
      elapsed <- as.numeric(Sys.time() - t_start, units = "mins")
      cat(sprintf("    [%d/%d] %.1f min, %d OK, %d zero, %d err, %s (%s)\n",
                  i, nrow(runs_country), elapsed, n_ok, n_zero, n_err, sci, code))
    }

    tryCatch({
      # Verbose : logge la premiere espece pour debug
      if (i <= 3) cat("      DEBUG species", i, ":", sci, code, "\n")
      # Download raster si cache absent (Cornell key)
      suppressMessages(
        ebirdst_download_status(species = code, download_abundance = TRUE,
                                download_ranges = FALSE, pattern = "3km", force = FALSE)
      )
      # Weekly raster : 52 layers hebdo. Peut echouer si Cornell n'a pas la data 3km
      # (essaie 9km en fallback). Si les 2 echouent -> compte comme erreur.
      r_weekly <- tryCatch(
        load_raster(code, resolution = "3km", product = "abundance", period = "weekly"),
        error = function(e) tryCatch(
          load_raster(code, resolution = "9km", product = "abundance", period = "weekly"),
          error = function(e2) NULL
        )
      )
      if (is.null(r_weekly)) {
        n_err <- n_err + 1
        errors <- c(errors, paste0(sci, " (", code, "): raster load failed at 3km + 9km"))
      } else {
        if (is.null(poly_prj_cache)) {
          poly_prj_cache <- st_transform(country_poly, crs = crs(r_weekly))
        }

        # Zonal stat : moyenne hebdo dans le pays
        weekly_means <- terra::extract(r_weekly, vect(poly_prj_cache), fun = mean, na.rm = TRUE)
        layer_cols <- setdiff(names(weekly_means), "ID")
        # Multi-lignes possible pour US (polygone multi-partie) : on prend la moyenne des mean
        weekly_vec <- as.numeric(colMeans(weekly_means[, layer_cols, drop = FALSE], na.rm = TRUE))
        weekly_vec[is.nan(weekly_vec) | is.na(weekly_vec)] <- 0
        if (length(weekly_vec) != 52) {
          pad <- 52 - length(weekly_vec)
          if (pad > 0) weekly_vec <- c(weekly_vec, rep(0, pad))
          else weekly_vec <- weekly_vec[1:52]
        }

        # Skip espece absente du pays (all zero)
        if (max(weekly_vec, na.rm = TRUE) == 0) {
          n_zero <- n_zero + 1
        } else {
          abd_annual <- mean(weekly_vec, na.rm = TRUE)
          if (is.nan(abd_annual) || is.na(abd_annual)) abd_annual <- 0
          abd_peak_national <- max(weekly_vec, na.rm = TRUE)
          if (is.nan(abd_peak_national) || is.infinite(abd_peak_national)) abd_peak_national <- 0

          # Peak local : mediane des pixels-semaines non-nuls (robuste)
          all_pixels <- terra::extract(r_weekly, vect(poly_prj_cache))
          all_vals <- unlist(all_pixels[, layer_cols, drop = FALSE])
          non_zero <- all_vals[all_vals > 0 & !is.na(all_vals) & !is.nan(all_vals)]
          abd_peak_local <- if (length(non_zero) >= 5) as.numeric(median(non_zero, na.rm = TRUE)) else 0
          if (is.nan(abd_peak_local) || is.na(abd_peak_local)) abd_peak_local <- 0

          results[[sci]] <- list(
            abd_annual = round(abd_annual, 5),
            abd_peak_national = round(abd_peak_national, 5),
            abd_peak_local = round(abd_peak_local, 5),
            weekly = round(weekly_vec, 7),
            species_code = code
          )
          n_ok <- n_ok + 1
        }
      }
    }, error = function(e) {
      msg <- paste0(sci, " (", code, "): ", conditionMessage(e))
      errors <<- c(errors, msg)
      n_err <<- n_err + 1
      if (n_err <= 5) cat("      ERR:", msg, "\n")
    })

    # Liberer explicitement la RAM apres chaque espece. Sans ca, les rasters
    # s'accumulent et saturent : le 1er run a plante sur US avec std::bad_alloc.
    # rm() sur les variables locales + gc() force le garbage collector.
    if (exists("r_weekly")) rm(r_weekly)
    if (exists("weekly_means")) rm(weekly_means)
    if (exists("all_pixels")) rm(all_pixels)
    if (exists("all_vals")) rm(all_vals)
    if (exists("non_zero")) rm(non_zero)
    invisible(gc(verbose = FALSE))
  }

  cat("\n[3] Termine. OK :", n_ok, "  Zero (absente du pays) :", n_zero, "  Erreurs :", n_err, "\n")

  # 4) Compose tier + ecrit JSON
  out <- list()
  for (sci in names(results)) {
    r <- results[[sci]]
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

  # Distribution tier
  tier_dist <- table(sapply(out, function(x) x$t))
  cat("    Distribution tier composite :\n")
  for (t in names(tier_dist)) cat(sprintf("      tier %s : %d especes\n", t, tier_dist[t]))

  # Ecriture
  js_content <- c(
    paste0("// Genere par tools/ebirdst/build-abundance-multi-country.R pour ", cc_name, " (", cc, ")."),
    paste0("// Data version : 2023 (Status). Genere le ", format(Sys.time()), "."),
    paste0("// Especes couvertes : ", length(out), " sur ", nrow(runs_country), " observees dans le pays."),
    "// Format compact : { sci: { a, an, al, t, ta, tn, tl, w[52], tr } }",
    paste0("export const REAL_ABUNDANCE_ST_", cc, " = ", toJSON(out, auto_unbox = TRUE, null = "null"), ";")
  )
  out_path <- paste0("C:/Users/mathi/Documents/Ligue_des_Plumes/tools/real-abundance-st-", cc, ".generated.js")
  writeLines(js_content, out_path)
  cat("    Ecrit :", out_path, "(", file.info(out_path)$size, "bytes)\n")

  # Log
  log_path <- paste0("C:/Users/mathi/Documents/Ligue_des_Plumes/tools/ebirdst-build-", cc, ".log")
  elapsed_min <- as.numeric(Sys.time() - t_start, units = "mins")
  log_lines <- c(
    paste0("Build eBird S&T ", cc_name, " (", cc, ") - ", format(Sys.time())),
    paste0("Duree : ", round(elapsed_min, 1), " min"),
    paste0("Especes candidates (apres filter eBird API) : ", nrow(runs_country)),
    paste0("Traitees OK : ", n_ok),
    paste0("Absentes du pays : ", n_zero),
    paste0("Erreurs : ", n_err),
    "",
    "=== Erreurs par espece ===",
    errors
  )
  writeLines(log_lines, log_path)
  cat("    Log :", log_path, "\n[", cc, "] Termine en", round(elapsed_min, 1), "min.\n")

  # Reset cache pour prochain pays
  poly_prj_cache <- NULL
}

global_elapsed <- as.numeric(Sys.time() - global_start, units = "hours")
cat("\n\n========================================================================\n")
cat("Global termine en", round(global_elapsed, 2), "h\n")
cat("========================================================================\n")
