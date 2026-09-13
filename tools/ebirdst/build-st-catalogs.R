# build-st-catalogs.R
# Genere un `st_by_species.json` par pays a partir de :
#   - Liste des scis presents dans l'ancien habitat_by_species.json du pays
#   - Cross-ref avec ebirdst::ebirdst_runs pour obtenir species_code S&T
#
# Format sortie : { "sci_name_lowercase": { "sci": "...", "code": "..." }, ... }
# Consomme par build-habitat-phase-b.R.

suppressMessages({
  library(jsonlite); library(ebirdst)
})

OUT_DIR <- "C:/Users/mathi/Documents/Projets/Ligue_des_Plumes/data/countries"

# Table sci -> species_code (backbone ebirdst)
runs <- ebirdst::ebirdst_runs
runs$sci_lower <- tolower(runs$scientific_name)
sci_to_code <- setNames(as.character(runs$species_code), runs$sci_lower)
cat(sprintf("[SETUP] %d especes ebirdst_runs disponibles\n", nrow(runs)))

country_dirs <- list.dirs(OUT_DIR, recursive = FALSE)
n_ok <- 0
n_skip <- 0
n_species_total <- 0
for (cd in country_dirs) {
  cc <- basename(cd)
  habitat_file <- file.path(cd, "habitat_by_species.json")
  if (!file.exists(habitat_file)) { n_skip <- n_skip + 1; next }
  habitat <- fromJSON(habitat_file, simplifyVector = FALSE)
  scis <- names(habitat)
  if (length(scis) == 0) { n_skip <- n_skip + 1; next }
  # Construit catalogue : chaque sci -> {sci, code}, code peut etre NA (fallback AVONET)
  catalog <- list()
  for (sci in scis) {
    catalog[[sci]] <- list(sci = sci, code = sci_to_code[[sci]])
  }
  out_file <- file.path(cd, "st_by_species.json")
  write_json(catalog, out_file, auto_unbox = TRUE, pretty = FALSE)
  n_ok <- n_ok + 1
  n_species_total <- n_species_total + length(scis)
}
cat(sprintf("\n[DONE] %d catalogues ecrits, %d pays skip (pas de habitat_by_species prealable).\n",
            n_ok, n_skip))
cat(sprintf("       Total entrees especes-pays : %d\n", n_species_total))
