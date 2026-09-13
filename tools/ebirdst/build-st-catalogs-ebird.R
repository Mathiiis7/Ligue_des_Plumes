# build-st-catalogs-ebird.R
# Genere un `st_by_species.json` par pays a partir de l'API eBird globale.
# Source intemporelle : liste des especes deja observees dans le pays selon eBird,
# pas selon la ligue Mathis.
#
# Endpoint : GET /v2/product/spplist/{regionCode}
#   Retourne un array de species_code S&T (ex: ["eugdov", "carwar", ...]).
#
# Croise avec ebirdst::ebirdst_runs pour ajouter le sci_name.
# Format sortie : { "sci_name_lowercase": { "sci": "...", "code": "..." }, ... }

suppressMessages({
  library(jsonlite); library(ebirdst); library(httr2)
})

OUT_DIR   <- "C:/Users/mathi/Documents/Projets/Ligue_des_Plumes/data/countries"
CACHE_DIR <- "C:/Users/mathi/Documents/Projets/clc/cache_frac"
EBIRD_KEY <- "dbflh4atmsom"

# Backbone : code S&T -> sci_name_lowercase
runs <- ebirdst::ebirdst_runs
runs$sci_lower <- tolower(runs$scientific_name)
code_to_sci <- setNames(runs$sci_lower, as.character(runs$species_code))
cat(sprintf("[SETUP] %d especes ebirdst_runs disponibles\n", nrow(runs)))

# Liste des pays a traiter : depuis cache_frac (les 240 avec Phase A ok)
cache_files <- list.files(CACHE_DIR, pattern = "_habitat_frac\\.tif$")
countries <- sort(unique(sub("_habitat_frac\\.tif$", "", cache_files)))
# On skip AK/HI (shards internes, pas des pays eBird)
countries <- setdiff(countries, c("AK", "HI"))
cat(sprintf("[SETUP] %d pays a interroger via eBird\n", length(countries)))

fetch_spplist <- function(cc) {
  url <- sprintf("https://api.ebird.org/v2/product/spplist/%s", cc)
  resp <- tryCatch(
    request(url) |>
      req_headers(`X-eBirdApiToken` = EBIRD_KEY) |>
      req_timeout(30) |>
      req_perform(),
    error = function(e) NULL
  )
  if (is.null(resp) || resp$status_code != 200) return(NULL)
  content <- resp_body_string(resp)
  jsonlite::fromJSON(content)   # array de species_code
}

n_ok <- 0
n_fail <- 0
for (cc in countries) {
  cat(sprintf("[%s] ", cc))
  codes <- fetch_spplist(cc)
  if (is.null(codes) || length(codes) == 0) {
    cat("echec API\n")
    n_fail <- n_fail + 1
    next
  }
  # Filtre : ne garder que les codes qui ont un modele S&T dans ebirdst_runs
  codes_with_st <- codes[codes %in% names(code_to_sci)]
  # Construit catalogue : sci_lowercase -> {sci, code}
  catalog <- list()
  for (code in codes_with_st) {
    sci <- code_to_sci[[code]]
    catalog[[sci]] <- list(sci = sci, code = code)
  }
  # Cree le dossier pays si besoin
  cd <- file.path(OUT_DIR, tolower(cc))
  dir.create(cd, showWarnings = FALSE, recursive = TRUE)
  out_file <- file.path(cd, "st_by_species.json")
  write_json(catalog, out_file, auto_unbox = TRUE, pretty = FALSE)
  cat(sprintf("%d obs eBird, %d avec modele S&T -> %s\n",
              length(codes), length(codes_with_st), out_file))
  n_ok <- n_ok + 1
  Sys.sleep(0.2)   # rate limit friendly
}
cat(sprintf("\n[DONE] %d pays OK, %d echecs API\n", n_ok, n_fail))
