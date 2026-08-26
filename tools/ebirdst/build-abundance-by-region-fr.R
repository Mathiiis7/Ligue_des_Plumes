# build-abundance-by-region-fr.R
#
# Extrait le S&T weekly (52 valeurs hebdomadaires) PAR REGION FR (13 regions metropole).
# Complement de build-abundance-by-country.R (qui produit le weekly national).
#
# Objectif : dans "Cibles de la semaine" avec une region selectionnee, on trie par la
# vraie densite S&T de cette semaine DANS CETTE REGION. Actuellement le tri est
# national avec un booster regional mensuel (bar chart), ce qui garde un biais national.
#
# Reuse : rasters caches par le run principal, force=FALSE. Pas de retelechargement.
# Compute pur : ~15-25 min (13 zonal stats par espece x 456 especes).
#
# Sortie : tools/real-abundance-st-by-region-fr.generated.js
#   Format compact : { region_code: { sci: { w: [52 valeurs] } } }
#   Especes avec w[52] entierement 0 sont omises (filtre saison + spatial).
#
# Usage : Rscript tools/ebirdst/build-abundance-by-region-fr.R
# ATTENTION : lancer APRES que build-abundance-by-country.R soit termine (partage
# le cache raster, mais on evite les acces concurrents sur meme fichier).

suppressPackageStartupMessages({
  library(ebirdst)
  library(sf)
  library(terra)
  library(dplyr)
  library(rnaturalearth)
  library(jsonlite)
})

t_start <- Sys.time()
cat("=== build-abundance-by-region-fr.R (weekly par region FR) ===\n")
cat("Start :", format(t_start), "\n\n")

# -------- 1) Liste especes FR (meme methode que le script national) --------
cat("[1] Charge liste especes FR depuis index.html...\n")
html <- readLines("C:/Users/mathi/Documents/Ligue_des_Plumes/index.html", warn = FALSE)
html_str <- paste(html, collapse = "\n")
fr_line <- regmatches(html_str, regexpr('const FR_NAMES = \\{[^\\n]+?\\}', html_str, perl = TRUE))
if (length(fr_line) == 0) stop("FR_NAMES not found in index.html")
sci_matches <- regmatches(fr_line, gregexpr('"([a-z]+ [a-z]+)":"[^"]*"', fr_line, perl = TRUE))[[1]]
fr_sci <- unique(gsub('^"([a-z]+ [a-z]+)":".*$', '\\1', sci_matches, perl = TRUE))
cat("    ", length(fr_sci), " sci names extraits.\n", sep = "")

# -------- 2) Join sci -> species_code S&T --------
cat("[2] Join sci -> species_code S&T...\n")
runs <- ebirdst_runs
runs$sci_lc <- tolower(runs$scientific_name)
map <- data.frame(sci = fr_sci, sci_lc = tolower(fr_sci), stringsAsFactors = FALSE)
map <- merge(map, runs[, c("sci_lc", "species_code")], by = "sci_lc", all.x = TRUE)
sp_to_process <- map[!is.na(map$species_code), ]
n_total <- nrow(sp_to_process)
cat("    ", n_total, "/", length(fr_sci), " matchees S&T.\n", sep = "")

# -------- 3) Polygones 13 regions FR (ISO 3166-2) --------
cat("[3] Polygones 13 regions FR (ne_states)...\n")
# ne_states retourne les regions administratives niveau 1 (regions FR depuis 2016).
# Colonne iso_3166_2 = code style "FR-IDF", "FR-PAC" etc. On garde uniquement metropole
# (13 regions) : les DROM (FR-GUA, FR-MAR, etc) ne sont pas dans notre app.
metro_codes <- c("FR-ARA","FR-BFC","FR-BRE","FR-COR","FR-CVL","FR-GES",
                 "FR-HDF","FR-IDF","FR-NAQ","FR-NOR","FR-OCC","FR-PAC","FR-PDL")
regions_all <- ne_states(country = "France", returnclass = "sf")
regions <- regions_all[regions_all$iso_3166_2 %in% metro_codes, ]
# Ordre stable + verification
regions <- regions[match(metro_codes, regions$iso_3166_2), ]
missing_reg <- metro_codes[is.na(regions$iso_3166_2)]
if (length(missing_reg) > 0) stop("Regions manquantes dans ne_states : ", paste(missing_reg, collapse = ", "))
cat("    ", nrow(regions), " regions chargees : ", paste(regions$iso_3166_2, collapse = ", "), "\n", sep = "")

# -------- 4) Boucle par espece : extraction weekly x 13 regions --------
cat("[4] Traitement (", n_total, " especes)...\n", sep = "")
# Structure : results[[region_code]][[sci]] = c(52 valeurs hebdo)
results <- setNames(vector("list", length(metro_codes)), metro_codes)
for (rc in metro_codes) results[[rc]] <- list()
errors <- character(0)
n_ok <- 0; n_err <- 0
regions_prj_cache <- NULL

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
    # 4a) Skip download si cache present (rasters deja telecharges par script national)
    suppressMessages(
      ebirdst_download_status(species = code, download_abundance = TRUE,
                              download_ranges = FALSE, pattern = "3km", force = FALSE)
    )
    r_weekly <- load_raster(code, resolution = "3km", product = "abundance",
                            period = "weekly")

    # 4b) Projete les 13 regions une seule fois (au premier tour, CRS S&T = sinusoidal)
    if (is.null(regions_prj_cache)) {
      regions_prj_cache <<- st_transform(regions, crs = crs(r_weekly))
    }

    # 4c) Zonal stat mean par region -> matrice 13 x 52 (une ligne par polygone)
    ext <- terra::extract(r_weekly, vect(regions_prj_cache), fun = mean, na.rm = TRUE)
    layer_cols <- setdiff(names(ext), "ID")

    for (ri in seq_len(nrow(regions))) {
      rc <- metro_codes[ri]
      w_vec <- as.numeric(ext[ri, layer_cols])
      w_vec[is.nan(w_vec) | is.na(w_vec)] <- 0
      if (length(w_vec) != 52) {
        pad <- 52 - length(w_vec)
        if (pad > 0) w_vec <- c(w_vec, rep(0, pad))
        else w_vec <- w_vec[1:52]
      }
      # Filtre : ne stocke que si au moins une semaine > 0 (economie ~30% JSON)
      if (max(w_vec) > 0) {
        # 6 decimales : capte les variations meme pour especes localisees, mais evite le
        # ballonnement du JSON (7 decimales = ~15% plus gros pour peu de gain regional).
        results[[rc]][[sci]] <- round(w_vec, 6)
      }
    }
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

# -------- 5) Ecriture JSON --------
cat("[5] Ecriture JSON...\n")
# Chaque region est un objet { sci: [52 valeurs] } -> transforme en {w: [52]} pour
# rester coherent avec REAL_ABUNDANCE_ST_FR (champ w).
out <- setNames(vector("list", length(metro_codes)), metro_codes)
n_entries_total <- 0
for (rc in metro_codes) {
  sp_list <- results[[rc]]
  out[[rc]] <- setNames(
    lapply(sp_list, function(w) list(w = w)),
    names(sp_list)
  )
  n_entries_total <- n_entries_total + length(sp_list)
}

# On ecrit directement en JSON pur dans data/ pour lazy-load HTTP par l'app.
# Format compact : { region_code: { sci: { w: [52 valeurs hebdo] } } }.
# Especes sans donnee dans une region (weekly all-zero) omises.
# Utilise dans renderTargets() pour tri temporel-spatial precis quand region selectionnee.
out_path <- "C:/Users/mathi/Documents/Ligue_des_Plumes/data/abundance_st_by_region_fr.json"
writeLines(toJSON(out, auto_unbox = TRUE, null = "null"), out_path)
cat("    Ecrit :", out_path, "(", file.info(out_path)$size, " bytes)\n")

# Log
log_path <- "C:/Users/mathi/Documents/Ligue_des_Plumes/tools/ebirdst-build-region.log"
elapsed_min <- as.numeric(Sys.time() - t_start, units = "mins")
log_lines <- c(
  paste0("Build eBird S&T weekly par region FR - ", format(Sys.time())),
  paste0("Duree : ", round(elapsed_min, 1), " min"),
  paste0("Especes traitees OK : ", n_ok, "/", n_total),
  paste0("Erreurs : ", n_err),
  paste0("Entrees especes-region totales : ", n_entries_total),
  "",
  "=== Erreurs par espece ===",
  errors
)
writeLines(log_lines, log_path)
cat("    Log :", log_path, "\n\n=== Termine en", round(elapsed_min, 1), "min ===\n")
