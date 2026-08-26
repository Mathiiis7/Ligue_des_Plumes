# build-abundance-by-country.R
#
# Version 2 (26/08/2026) : extraction composite 3 metriques + weekly.
#
# Pour chaque espece FR de l'app, on extrait de S&T (rasters hebdomadaires) :
#   - abd_annual : moyenne annuelle nationale (mean pixels x 52 semaines)
#     -> reflete la difficulte d'observation au hasard
#   - abd_peak_national : pic saisonnier national (max sur 52 semaines de mean(pixels_FR))
#     -> reflete la difficulte a la meilleure periode
#   - abd_peak_local : pic local (q95 des pixels x semaines non-nuls)
#     -> reflete la difficulte au meilleur hotspot en meilleure saison
#   - abd_weekly : array de 52 moyennes hebdomadaires (pour histogramme fiche)
#
# Cache ebirdst deja peuple par l'ancienne version (rasters cached), le rerun ne
# retelecharge que si version data change ou fichier absent. Compute pur ~10-20 min.
#
# Usage : Rscript tools/ebirdst/build-abundance-by-country.R

suppressPackageStartupMessages({
  library(ebirdst)
  library(sf)
  library(terra)
  library(dplyr)
  library(rnaturalearth)
  library(jsonlite)
})

t_start <- Sys.time()
cat("=== build-abundance-by-country.R v2 (composite 3 metriques + weekly) ===\n")
cat("Start :", format(t_start), "\n\n")

# -------- 1) Charger la liste des especes FR depuis index.html --------
cat("[1] Charge liste especes FR depuis index.html...\n")
html <- readLines("C:/Users/mathi/Documents/Ligue_des_Plumes/index.html", warn = FALSE)
html_str <- paste(html, collapse = "\n")
fr_line <- regmatches(html_str, regexpr('const FR_NAMES = \\{[^\\n]+?\\}', html_str, perl = TRUE))
if (length(fr_line) == 0) stop("FR_NAMES not found in index.html")
sci_matches <- regmatches(fr_line, gregexpr('"([a-z]+ [a-z]+)":"[^"]*"', fr_line, perl = TRUE))[[1]]
fr_sci <- unique(gsub('^"([a-z]+ [a-z]+)":".*$', '\\1', sci_matches, perl = TRUE))
cat("    ", length(fr_sci), " sci names extraits.\n", sep = "")

# -------- 2) Join sur ebirdst_runs -> species_code --------
cat("[2] Join sci -> species_code S&T...\n")
runs <- ebirdst_runs
runs$sci_lc <- tolower(runs$scientific_name)
map <- data.frame(sci = fr_sci, sci_lc = tolower(fr_sci), stringsAsFactors = FALSE)
map <- merge(map, runs[, c("sci_lc", "species_code", "common_name", "is_resident", "has_trends", "trends_region")],
             by = "sci_lc", all.x = TRUE)
n_matched <- sum(!is.na(map$species_code))
cat("    ", n_matched, "/", length(fr_sci), " matchees dans S&T.\n", sep = "")

# -------- 3) Polygone France metro (une fois) --------
cat("[3] Polygone France metro...\n")
fr_poly <- ne_countries(country = "France", scale = "medium", returnclass = "sf")
fr_metro <- st_crop(fr_poly, xmin = -5.5, xmax = 10, ymin = 41, ymax = 51.5)
cat("    OK.\n")

# -------- 4) Boucle par espece : extraction 3 metriques + weekly --------
cat("[4] Traitement (", n_matched, " especes)...\n", sep = "")
results <- list()
errors <- character(0)
n_ok <- 0; n_err <- 0
sp_to_process <- map[!is.na(map$species_code), ]
n_total <- nrow(sp_to_process)
fr_prj_cache <- NULL

for (i in seq_len(n_total)) {
  row <- sp_to_process[i, ]
  sci <- row$sci
  code <- row$species_code

  if (i %% 25 == 0 || i == 1) {
    elapsed <- as.numeric(Sys.time() - t_start, units = "mins")
    cat(sprintf("    [%d/%d] %.1f min, %d OK, %d err, %s (%s)\n",
                i, n_total, elapsed, n_ok, n_err, sci, code))
  }

  tryCatch({
    # 4a) Download (skip si cache)
    suppressMessages(
      ebirdst_download_status(species = code, download_abundance = TRUE,
                              download_ranges = FALSE, pattern = "3km", force = FALSE)
    )
    # 4b) Weekly raster : 52 layers hebdomadaires
    r_weekly <- load_raster(code, resolution = "3km", product = "abundance",
                            period = "weekly")
    if (is.null(fr_prj_cache)) {
      fr_prj_cache <<- st_transform(fr_metro, crs = crs(r_weekly))
    }

    # 4c) Zonal stat sur France : moyenne par semaine + tous les pixels par semaine
    #     terra::extract avec fun=mean donne 1 valeur par layer -> mean par semaine
    weekly_means <- terra::extract(r_weekly, vect(fr_prj_cache), fun = mean, na.rm = TRUE)
    layer_cols <- setdiff(names(weekly_means), "ID")
    weekly_vec <- as.numeric(weekly_means[1, layer_cols])
    weekly_vec[is.nan(weekly_vec) | is.na(weekly_vec)] <- 0
    if (length(weekly_vec) != 52) {
      # eBird utilise 52 semaines par convention ; si moins, on pad avec 0 pour l'output
      pad <- 52 - length(weekly_vec)
      if (pad > 0) weekly_vec <- c(weekly_vec, rep(0, pad))
      else weekly_vec <- weekly_vec[1:52]
    }

    # 4d) Metrique 1 : moyenne annuelle nationale = mean(52 semaines de mean-pixels)
    abd_annual <- mean(weekly_vec, na.rm = TRUE)
    if (is.nan(abd_annual) || is.na(abd_annual)) abd_annual <- 0

    # 4e) Metrique 2 : pic saisonnier national = max des 52 semaines
    abd_peak_national <- max(weekly_vec, na.rm = TRUE)
    if (is.nan(abd_peak_national) || is.infinite(abd_peak_national)) abd_peak_national <- 0

    # 4f) Metrique 3 : pic local = q95 des pixels x semaines non-nuls
    #     Extrait TOUS les pixels de la France pour toutes les semaines (memoire OK, ~5k pixels x 52)
    all_pixels <- terra::extract(r_weekly, vect(fr_prj_cache))
    all_vals <- unlist(all_pixels[, layer_cols, drop = FALSE])
    non_zero <- all_vals[all_vals > 0 & !is.na(all_vals) & !is.nan(all_vals)]
    abd_peak_local <- if (length(non_zero) >= 5) as.numeric(quantile(non_zero, 0.95, na.rm = TRUE)) else 0
    if (is.nan(abd_peak_local) || is.na(abd_peak_local)) abd_peak_local <- 0

    # 4g) Trend decennale si dispo (rare pour especes europeennes, presque toujours NA)
    trend <- NA_real_
    if (isTRUE(row$has_trends)) {
      trend <- tryCatch({
        suppressMessages(ebirdst_download_trends(species = code, force = FALSE))
        t_data <- load_trends(code)
        t_sf <- st_as_sf(t_data, coords = c("longitude", "latitude"), crs = 4326)
        t_fr <- t_sf[lengths(st_intersects(t_sf, fr_metro)) > 0, ]
        if (nrow(t_fr) == 0) NA_real_
        else mean(t_fr$abd_ppy_median, na.rm = TRUE)
      }, error = function(e) NA_real_)
    }

    results[[sci]] <- list(
      abd_annual = round(abd_annual, 5),
      abd_peak_national = round(abd_peak_national, 5),
      abd_peak_local = round(abd_peak_local, 5),
      weekly = round(weekly_vec, 5),
      trend = if (is.na(trend)) NA_real_ else round(trend, 4),
      species_code = code
    )
    n_ok <- n_ok + 1
  }, error = function(e) {
    errors <<- c(errors, paste0(sci, " (", code, "): ", conditionMessage(e)))
    n_err <<- n_err + 1
  })
}

cat("\n[4] Termine. OK :", n_ok, "  Erreurs :", n_err, "\n")
if (n_err > 0) {
  cat("    Premieres erreurs :\n")
  for (e in head(errors, 10)) cat("      ", e, "\n")
}

# -------- 5) Calibrage des seuils tier (Option 1 : nouveaux seuils) --------
cat("[5] Calibrage seuils tier (Option 1 + tier 10)...\n")
# On observe la distribution d'abondance annuelle pour caler les seuils :
# Option 1 seuils cibles :
#   tier 1 (Tres commun)     : freq >= ~25% des sorties eBird
#   tier 2 (Commun)          : 15-25%
#   tier 3 (Assez commun)    : 8-15%
#   tier 4 (Peu commun)      : 4-8%
#   tier 5 (Localise)        : 2-4%
#   tier 6 (Assez rare)      : 0.7-2%
#   tier 7 (Rare)            : 0.15-0.7%
#   tier 8 (Tres rare)       : 0.03-0.15%
#   tier 9 (Exceptionnel)    : 0.005-0.03%
#   tier 10 (Fantome)        : < 0.005%
# Note : les seuils "freq %" du bar chart eBird ne s'appliquent pas directement a
# l'abondance S&T (indiv/heure), il faut caler empiriquement les valeurs S&T
# equivalentes via quantiles sur la distribution reelle.
abd_vec <- sapply(results, function(x) x$abd_annual)
abd_pos <- abd_vec[abd_vec > 0]
# Distribution cible d'especes par tier (approximative pour Option 1) :
#   t1: 4%, t2: 5%, t3: 7%, t4: 10%, t5: 11%, t6: 12%, t7: 16%, t8: 14%, t9: 12%, t10: 9%
# On prend les quantiles correspondants (cumulatif descendant depuis top) :
qs <- quantile(log1p(abd_pos),
               probs = c(0.96, 0.91, 0.84, 0.74, 0.63, 0.51, 0.35, 0.21, 0.09),
               na.rm = TRUE)
thresholds <- exp(qs) - 1
names(thresholds) <- paste0("tier", 1:9)
cat("    Seuils calibres :\n")
for (i in seq_along(thresholds)) {
  cat(sprintf("      tier %d si abd >= %.5f\n", i, thresholds[i]))
}
abd_to_tier <- function(a) {
  if (is.na(a) || a <= 0) return(10L)
  for (i in seq_along(thresholds)) {
    if (a >= thresholds[i]) return(i)
  }
  return(10L)
}

# -------- 6) Composite tier = 40% annual + 30% pic_national + 30% pic_local --------
cat("[6] Calcul du tier composite (40/30/30)...\n")
compute_composite_tier <- function(annual, peak_nat, peak_local) {
  t_a <- abd_to_tier(annual)
  t_n <- abd_to_tier(peak_nat)
  t_l <- abd_to_tier(peak_local)
  composite <- round(0.4 * t_a + 0.3 * t_n + 0.3 * t_l)
  if (composite < 1) composite <- 1L
  if (composite > 10) composite <- 10L
  return(as.integer(composite))
}

# -------- 7) Ecrire JSON output --------
cat("[7] Ecriture JSON...\n")
out <- list()
for (sci in names(results)) {
  r <- results[[sci]]
  t_annual  <- abd_to_tier(r$abd_annual)
  t_peak_n  <- abd_to_tier(r$abd_peak_national)
  t_peak_l  <- abd_to_tier(r$abd_peak_local)
  t_composite <- compute_composite_tier(r$abd_annual, r$abd_peak_national, r$abd_peak_local)
  out[[sci]] <- list(
    a    = r$abd_annual,          # abondance moyenne annuelle
    an   = r$abd_peak_national,   # pic saisonnier national
    al   = r$abd_peak_local,      # pic local
    t    = t_composite,           # tier composite (celui utilise dans l'app)
    ta   = t_annual,              # sous-tier annuel (fiche : sous-section detail)
    tn   = t_peak_n,              # sous-tier pic national
    tl   = t_peak_l,              # sous-tier pic local
    w    = r$weekly,              # 52 valeurs hebdo (pour histogramme fiche)
    tr   = if (is.na(r$trend)) NULL else r$trend
  )
}

# Distribution du tier composite
tier_dist <- table(sapply(out, function(x) x$t))
cat("    Distribution du tier composite :\n")
for (t in names(tier_dist)) cat(sprintf("      tier %s : %d especes\n", t, tier_dist[t]))

# Ecriture
js_content <- c(
  "// Genere par tools/ebirdst/build-abundance-by-country.R v2 depuis eBird S&T (Cornell).",
  paste0("// Data version : 2023 (Status), 2022 (Trends). Genere le ", format(Sys.time()), "."),
  paste0("// Especes couvertes : ", length(out), " sur ", length(fr_sci), " FR."),
  "// Format compact : { sci: {",
  "//   a: abd moyenne annuelle (indiv/heure),",
  "//   an: pic saisonnier national,",
  "//   al: pic local (q95 pixels non-nuls),",
  "//   t: tier composite 1-10 (celui utilise dans l'app),",
  "//   ta: tier moyenne annuelle | tn: tier pic national | tl: tier pic local (pour fiche detail),",
  "//   w: [52 valeurs hebdo] (pour histogramme fiche),",
  "//   tr: tendance %/an (null generalement)",
  "// } }",
  "// Merge dans index.html avec REAL_RARITY (bar chart) via _tierFromSTvsBarChart (regle +/-1 tier).",
  paste0("export const REAL_ABUNDANCE_ST_FR = ", toJSON(out, auto_unbox = TRUE, null = "null"), ";")
)
out_path <- "C:/Users/mathi/Documents/Ligue_des_Plumes/tools/real-abundance-st.generated.js"
writeLines(js_content, out_path)
cat("    Ecrit :", out_path, "(", file.info(out_path)$size, " bytes)\n")

# Log
log_path <- "C:/Users/mathi/Documents/Ligue_des_Plumes/tools/ebirdst-build.log"
elapsed_min <- as.numeric(Sys.time() - t_start, units = "mins")
log_lines <- c(
  paste0("Build eBird S&T FR v2 (composite) - ", format(Sys.time())),
  paste0("Duree : ", round(elapsed_min, 1), " min"),
  paste0("Especes totales FR : ", length(fr_sci)),
  paste0("Matchees S&T : ", n_matched),
  paste0("Traitees OK : ", n_ok),
  paste0("Erreurs : ", n_err),
  paste0("Seuils tier : ", paste(round(thresholds, 5), collapse = ", ")),
  "",
  "=== Erreurs par espece ===",
  errors
)
writeLines(log_lines, log_path)
cat("    Log :", log_path, "\n\n=== Termine en", round(elapsed_min, 1), "min ===\n")
