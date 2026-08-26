# build-abundance-by-country.R
#
# Boucle sur toutes les especes FR de l'app, download les rasters ebirdst
# Status & Trends, calcule abondance moyenne + tendance decennale pour chaque
# espece sur le polygone France metro, ecrit un JSON pret a injecter dans
# index.html.
#
# Robuste : chaque espece dans un tryCatch. Si download/traitement echoue,
# on log et on passe a la suivante. Le script continue meme si 30% des
# especes echouent. Reprise possible : le cache ebirdst est persistent,
# rerun ne redownload pas les fichiers deja presents.
#
# Usage :
#   Rscript tools/ebirdst/build-abundance-by-country.R
#
# Ou en background pour laisser tourner la nuit :
#   Start-Job -ScriptBlock { & "C:\Program Files\R\R-4.6.1\bin\Rscript.exe"
#                            "C:\...\build-abundance-by-country.R" > log.txt 2>&1 }
#
# Output :
#   tools/real-abundance-st.generated.js
#   tools/ebirdst-build.log (compte de succes/echec par espece)
#
# Duree estimee : 30-60 min (network dependant, ~10 GB de cache local total)

suppressPackageStartupMessages({
  library(ebirdst)
  library(sf)
  library(terra)
  library(dplyr)
  library(rnaturalearth)
})

t_start <- Sys.time()
cat("=== build-abundance-by-country.R ===\n")
cat("Start :", format(t_start), "\n\n")

# -------- 1) Charger la liste des especes FR depuis index.html --------
cat("[1] Charge liste especes FR depuis index.html...\n")
html <- readLines("C:/Users/mathi/Documents/Ligue_des_Plumes/index.html", warn = FALSE)
html_str <- paste(html, collapse = "\n")

# Extraire le dict FR_NAMES par regex
fr_line <- regmatches(html_str, regexpr('const FR_NAMES = \\{[^\\n]+?\\}', html_str, perl = TRUE))
if (length(fr_line) == 0) stop("FR_NAMES not found in index.html")
# Parse le dict JSON manuellement (extraction sci names uniquement)
sci_matches <- regmatches(fr_line, gregexpr('"([a-z]+ [a-z]+)":"[^"]*"', fr_line, perl = TRUE))[[1]]
fr_sci <- gsub('^"([a-z]+ [a-z]+)":".*$', '\\1', sci_matches, perl = TRUE)
fr_sci <- unique(fr_sci)
cat("    ", length(fr_sci), " sci names extraits de FR_NAMES.\n", sep = "")

# -------- 2) Join sur ebirdst_runs pour mapper sci -> species_code --------
cat("[2] Join sci names -> species_code S&T...\n")
runs <- ebirdst_runs
runs$sci_lc <- tolower(runs$scientific_name)
map <- data.frame(sci = fr_sci, sci_lc = tolower(fr_sci), stringsAsFactors = FALSE)
map <- merge(map, runs[, c("sci_lc", "species_code", "common_name", "is_resident", "has_trends", "trends_region")],
             by = "sci_lc", all.x = TRUE)
n_matched <- sum(!is.na(map$species_code))
cat("    ", n_matched, "/", length(fr_sci), " especes trouvees dans S&T (les autres tombent en fallback bar chart eBird).\n", sep = "")

# -------- 3) Charger polygone France metro (une seule fois) --------
cat("[3] Charge polygone France metro...\n")
fr_poly <- ne_countries(country = "France", scale = "medium", returnclass = "sf")
fr_metro <- st_crop(fr_poly, xmin = -5.5, xmax = 10, ymin = 41, ymax = 51.5)
cat("    Polygone charge (1 feature).\n")

# Reference CRS (celle des rasters S&T) — on reprojette la France une seule fois plus tard.
CRS_ST <- "EPSG:8857"   # Equal Earth Greenwich

# -------- 4) Boucle traitement par espece --------
cat("[4] Traitement des especes S&T (", n_matched, " a faire)...\n", sep = "")
results <- list()   # sci -> list(abundance, trend, has_trend)
errors <- character(0)
n_ok <- 0; n_err <- 0

sp_to_process <- map[!is.na(map$species_code), ]
n_total <- nrow(sp_to_process)

fr_prj_cache <- NULL   # sera reprojectee au 1er raster charge

for (i in seq_len(n_total)) {
  row <- sp_to_process[i, ]
  sci <- row$sci
  code <- row$species_code

  # Progress toutes les 25 especes
  if (i %% 25 == 0 || i == 1) {
    elapsed <- as.numeric(Sys.time() - t_start, units = "mins")
    cat(sprintf("    [%d/%d] %.1f min elapsed, %d OK, %d err, current: %s (%s)\n",
                i, n_total, elapsed, n_ok, n_err, sci, code))
  }

  tryCatch({
    # 4a) Download raster abondance saisonnal max (skip si deja cache)
    suppressMessages(
      ebirdst_download_status(species = code,
                              download_abundance = TRUE,
                              download_ranges = FALSE,
                              pattern = "3km",
                              force = FALSE)
    )
    # 4b) Charger le raster (seasonal max pour couvrir residents ET migrateurs)
    r <- load_raster(code, resolution = "3km", product = "abundance",
                     period = "seasonal", metric = "max")
    # 4c) Reproject France polygon une seule fois
    if (is.null(fr_prj_cache)) {
      fr_prj_cache <<- st_transform(fr_metro, crs = crs(r))
    }
    # 4d) Zonal stat : moyenne des pixels dans le polygone France
    vals <- terra::extract(r, vect(fr_prj_cache), fun = mean, na.rm = TRUE)
    layer_cols <- setdiff(names(vals), "ID")
    abd <- mean(unlist(vals[, layer_cols, drop = FALSE]), na.rm = TRUE)
    if (is.nan(abd) || is.na(abd)) abd <- 0

    # 4e) Tendance decennale si dispo pour cette espece
    trend <- NA_real_
    has_tr <- isTRUE(row$has_trends)
    if (has_tr) {
      trend <- tryCatch({
        suppressMessages(
          ebirdst_download_trends(species = code, force = FALSE)
        )
        t_data <- load_trends(code)
        # Filtrer pixels France (via reprojection puis st_intersects)
        t_sf <- st_as_sf(t_data, coords = c("longitude", "latitude"), crs = 4326)
        t_fr <- t_sf[lengths(st_intersects(t_sf, fr_metro)) > 0, ]
        if (nrow(t_fr) == 0) NA_real_
        else mean(t_fr$abd_ppy_median, na.rm = TRUE)   # % changement par annee, median
      }, error = function(e) NA_real_)
    }

    results[[sci]] <- list(abundance = round(abd, 5),
                           trend = if (is.na(trend)) NA_real_ else round(trend, 4),
                           species_code = code)
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

# -------- 5) Calibrer les seuils abondance -> tier 1-9 --------
cat("[5] Calibrage des seuils tier...\n")
# On veut une distribution similaire a REAL_RARITY actuel : ~2% tier 1, ~3% tier 2, ..., ~20% tier 9
# Approche : quantiles de log(1+abundance) pour repartir uniformement.
abd_vec <- sapply(results, function(x) x$abundance)
abd_pos <- abd_vec[abd_vec > 0]
# Seuils definis en observant la distribution : plus rare = abundance plus faible.
# Tier 1 = tres commun = top 5% abundance ; tier 9 = exceptionnel = bottom 5%
qs <- quantile(log1p(abd_pos), probs = c(0.95, 0.85, 0.72, 0.58, 0.42, 0.28, 0.15, 0.05), na.rm = TRUE)
thresholds <- exp(qs) - 1
names(thresholds) <- paste0("tier", 1:8)
cat("    Seuils log(1+abd) :\n")
for (i in seq_along(thresholds)) {
  cat(sprintf("      tier %d si abd >= %.5f\n", i, thresholds[i]))
}
abd_to_tier <- function(a) {
  if (is.na(a) || a <= 0) return(9L)
  for (i in seq_along(thresholds)) {
    if (a >= thresholds[i]) return(i)
  }
  return(9L)
}

# -------- 6) Ecrire JSON output --------
cat("[6] Ecriture du JSON output...\n")
out <- list()
for (sci in names(results)) {
  r <- results[[sci]]
  out[[sci]] <- list(
    a = r$abundance,               # abondance brute S&T (individus/heure)
    t = abd_to_tier(r$abundance),  # tier 1-9 derive
    tr = if (is.na(r$trend)) NULL else r$trend   # tendance % par an (median)
  )
}

# Distribution des tiers
tier_dist <- table(sapply(out, function(x) x$t))
cat("    Distribution des tiers :\n")
for (t in names(tier_dist)) cat(sprintf("      tier %s : %d especes\n", t, tier_dist[t]))

# Construction du contenu JS
js_lines <- c(
  "// Genere par tools/ebirdst/build-abundance-by-country.R depuis eBird S&T (Cornell).",
  paste0("// Data version : 2023 (Status), 2022 (Trends). Genere le ", format(Sys.time()), "."),
  paste0("// Especes couvertes : ", length(out), " sur ", length(fr_sci), " FR."),
  "// Format : { sci: { a: abondance (indiv/heure), t: tier 1-9, tr: tendance %/an ou null } }",
  "// A merger avec REAL_RARITY (fallback bar chart) pour les especes hors couverture S&T.",
  paste0("export const REAL_ABUNDANCE_ST_FR = ", jsonlite::toJSON(out, auto_unbox = TRUE, null = "null"), ";")
)
if (!requireNamespace("jsonlite", quietly = TRUE)) {
  install.packages("jsonlite", repos = "https://cran.r-project.org")
  library(jsonlite)
}
out_path <- "C:/Users/mathi/Documents/Ligue_des_Plumes/tools/real-abundance-st.generated.js"
writeLines(js_lines, out_path)
cat("    Ecrit :", out_path, "(", file.info(out_path)$size, " bytes)\n")

# Log final
log_path <- "C:/Users/mathi/Documents/Ligue_des_Plumes/tools/ebirdst-build.log"
elapsed_min <- as.numeric(Sys.time() - t_start, units = "mins")
log_lines <- c(
  paste0("Build eBird S&T abundance FR - ", format(Sys.time())),
  paste0("Duree totale : ", round(elapsed_min, 1), " min"),
  paste0("Especes totales FR : ", length(fr_sci)),
  paste0("Especes matchees S&T : ", n_matched),
  paste0("Traitees avec succes : ", n_ok),
  paste0("Erreurs : ", n_err),
  "",
  "=== Erreurs par espece ===",
  errors
)
writeLines(log_lines, log_path)
cat("    Log :", log_path, "\n")

cat("\n=== Termine en", round(elapsed_min, 1), "min ===\n")
cat("Prochaine etape (session Claude) : integrer real-abundance-st.generated.js dans index.html\n")
