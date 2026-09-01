# build-abundance-by-region-multi.R
#
# Genere le S&T weekly par region pour les pays non-FR : ES/IT/GB/PT/ME.
# Structure identique au build-abundance-by-region-fr.R mais parametrise par pays.
#
# Utilise l'optimisation Opt#1 : chaque raster charge UNE fois, extract multi-region
# en un seul terra::extract call (les 4-20 polygones passes en batch).
#
# Sortie : data/abundance_st_by_region_XX.json (~500 KB - 1 MB par pays)
#   Format : { region_code: { sci: { w: [52] } } }, especes weekly all-zero omises.
#
# Cache raster Cornell partage avec les autres scripts (180 GB deja telecharge).
# Nouveaux downloads uniquement pour especes non encore vues.
#
# Usage :
#   Rscript tools/ebirdst/build-abundance-by-region-multi.R           # tous 4 pays
#   Rscript tools/ebirdst/build-abundance-by-region-multi.R ES        # 1 pays

suppressPackageStartupMessages({
  library(ebirdst)
  library(sf)
  library(terra)
  library(dplyr)
  library(rnaturalearth)
  library(jsonlite)
  library(httr)
})

# Force flush stdout apres cat -> live progression via Tee-Object
.cat_orig <- cat
cat <- function(...) { .cat_orig(...); flush.console() }

EBIRD_API_KEY <- "dbflh4atmsom"
Sys.setenv(EBIRDST_KEY = "obfvm9uetmhe")

# -------- Config : regions par pays (memes codes ISO 3166-2 que l'app) --------
# ES : 17 comunidades autonomas (+2 villes autonomes rare)
# IT : 20 regioni
# GB : 4 nations (ENG/SCT/WLS/NIR)
# PT : 20 subdivisions (18 districts + 2 regions autonomes)
COUNTRIES <- list(
  ES = list(
    iso3 = "ESP", name = "Espagne",
    regions = c("ES-AN","ES-AR","ES-AS","ES-CB","ES-CE","ES-CL","ES-CM",
                "ES-CN","ES-CT","ES-EX","ES-GA","ES-IB","ES-MC","ES-MD",
                "ES-ML","ES-NC","ES-PV","ES-RI","ES-VC")
  ),
  IT = list(
    iso3 = "ITA", name = "Italie",
    regions = c("IT-21","IT-23","IT-25","IT-32","IT-34","IT-36","IT-42",
                "IT-45","IT-52","IT-55","IT-57","IT-62","IT-65","IT-67",
                "IT-72","IT-75","IT-77","IT-78","IT-82","IT-88")
  ),
  GB = list(
    iso3 = "GBR", name = "Royaume-Uni",
    regions = c("GB-ENG","GB-SCT","GB-WLS","GB-NIR")
  ),
  PT = list(
    iso3 = "PRT", name = "Portugal",
    regions = c("PT-01","PT-02","PT-03","PT-04","PT-05","PT-06","PT-07",
                "PT-08","PT-09","PT-10","PT-11","PT-12","PT-13","PT-14",
                "PT-15","PT-16","PT-17","PT-18","PT-20","PT-30")
  ),
  ME = list(
    iso3 = "MNE", name = "Montenegro",
    # 3 regions statistiques officielles MONSTAT (agregat de municipalites) :
    # ME-N Sjeverni (Nord), ME-C Sredisnji (Central), ME-P Primorski (Cote)
    regions = c("ME-N","ME-C","ME-P")
  )
)

args <- commandArgs(trailingOnly = TRUE)
if (length(args) >= 1) {
  cc_args <- toupper(args)
  unknown <- setdiff(cc_args, names(COUNTRIES))
  if (length(unknown) > 0) stop("Codes pays inconnus : ", paste(unknown, collapse=", "),
                                ". Attendus : ", paste(names(COUNTRIES), collapse=", "))
  COUNTRIES <- COUNTRIES[cc_args]
}

# -------- eBird API spplist pour filter les especes candidates par pays --------
fetch_country_species <- function(cc) {
  url <- paste0("https://api.ebird.org/v2/product/spplist/", cc)
  r <- httr::GET(url, httr::add_headers(`X-eBirdApiToken` = EBIRD_API_KEY))
  if (httr::status_code(r) != 200) stop("eBird API error ", httr::status_code(r), " pour ", cc)
  jsonlite::fromJSON(httr::content(r, as = "text", encoding = "UTF-8"))
}

runs <- ebirdst_runs
runs$sci_lc <- tolower(runs$scientific_name)

# -------- Boucle pays --------
global_start <- Sys.time()

for (cc in names(COUNTRIES)) {
  info <- COUNTRIES[[cc]]
  iso3 <- info$iso3; cc_name <- info$name; region_codes <- info$regions
  t_start <- Sys.time()
  cat("\n\n========================================================================\n")
  cat("[", cc, "] ", cc_name, " (", length(region_codes), " regions)\n", sep="")
  cat("========================================================================\n")

  # 1) Polygones regions : approche differente selon pays car ne_states donne des
  #    granularites variables selon l'implementation naturalearth :
  #      GB : counties (232) -> utilise ne_countries(type='map_units') = 4 nations
  #      PT : districts (20) = matche directement notre iso_3166_2
  #      ES : provinces (52) -> agrege par 'region' (nom comunidad) via st_union
  #      IT : provincie (110) -> agrege par 'region' (nom regione) via st_union
  cat("[1] Charge polygones regions...\n")
  found_regions <- list()

  if (cc == "GB") {
    mu <- ne_countries(type = "map_units", country = "United Kingdom", returnclass = "sf")
    gb_map <- list("GB-ENG" = "England", "GB-SCT" = "Scotland",
                   "GB-WLS" = "Wales", "GB-NIR" = "N. Ireland")
    for (rc in names(gb_map)) {
      row <- mu[mu$name == gb_map[[rc]], ]
      if (nrow(row) > 0) found_regions[[rc]] <- row
    }
  } else if (cc == "PT") {
    all_states <- ne_states(country = "Portugal", returnclass = "sf")
    for (rc in region_codes) {
      row <- all_states[all_states$iso_3166_2 == rc, ]
      if (nrow(row) > 0) found_regions[[rc]] <- row
    }
  } else if (cc == "ES") {
    es <- ne_states(country = "Spain", returnclass = "sf")
    es_map <- list(
      "ES-AN" = "Andalucía", "ES-AR" = "Aragón", "ES-AS" = "Asturias",
      "ES-CB" = "Cantabria", "ES-CE" = "Ceuta", "ES-CL" = "Castilla y León",
      "ES-CM" = "Castilla-La Mancha", "ES-CN" = "Canary Is.",
      "ES-CT" = "Cataluña", "ES-EX" = "Extremadura", "ES-GA" = "Galicia",
      "ES-IB" = "Islas Baleares", "ES-MC" = "Murcia", "ES-MD" = "Madrid",
      "ES-ML" = "Melilla", "ES-NC" = "Foral de Navarra", "ES-PV" = "País Vasco",
      "ES-RI" = "La Rioja", "ES-VC" = "Valenciana"
    )
    for (rc in names(es_map)) {
      sub <- es[es$region == es_map[[rc]], ]
      if (nrow(sub) > 0) {
        # Dissolve provinces to comunidad (st_union)
        merged <- st_sf(iso_3166_2 = rc, geometry = st_union(sub))
        found_regions[[rc]] <- merged
      }
    }
  } else if (cc == "ME") {
    # Montenegro : ne_states retourne les municipalites (opstine). On agrege
    # selon le decoupage officiel MONSTAT en 3 regions statistiques.
    me <- ne_states(country = "Montenegro", returnclass = "sf")
    cat("    ne_states Montenegro :", nrow(me), " municipalites trouvees\n")
    if (nrow(me) > 0) cat("    Field name :", paste(head(me$name, 30), collapse=", "), "\n")
    me_map <- list(
      "ME-N" = c("Andrijevica","Berane","Bijelo Polje","Gusinje","Kolašin","Kolasin",
                 "Mojkovac","Petnjica","Plav","Pljevlja","Plužine","Pluzine","Rožaje","Rozaje",
                 "Šavnik","Savnik","Žabljak","Zabljak"),
      "ME-C" = c("Cetinje","Danilovgrad","Nikšić","Niksic","Podgorica","Tuzi"),
      "ME-P" = c("Bar","Budva","Herceg Novi","Herceg-Novi","Kotor","Tivat","Ulcinj")
    )
    for (rc in names(me_map)) {
      sub <- me[me$name %in% me_map[[rc]], ]
      if (nrow(sub) > 0) {
        merged <- st_sf(iso_3166_2 = rc, geometry = st_union(sub))
        found_regions[[rc]] <- merged
        cat("    ", rc, ":", nrow(sub), " municipalites agregees\n")
      } else {
        cat("    ", rc, ": AUCUNE municipalite matchee !\n")
      }
    }
    # Fallback : si ne_states ne donne rien d'utile, utilise le polygone national
    # entier decoupe par latitude (approximatif mais fonctionnel).
    if (length(found_regions) == 0) {
      cat("    Fallback : split par latitude\n")
      me_ctry <- ne_countries(country = "Montenegro", returnclass = "sf", scale = "large")
      bbox <- st_bbox(me_ctry)
      # 3 bandes horizontales (Nord/Centre/Cote de haut en bas approx)
      y_mid1 <- bbox$ymin + (bbox$ymax - bbox$ymin) * 0.66
      y_mid2 <- bbox$ymin + (bbox$ymax - bbox$ymin) * 0.33
      strips <- list(
        "ME-N" = st_as_sfc(st_bbox(c(xmin=bbox$xmin, ymin=y_mid1, xmax=bbox$xmax, ymax=bbox$ymax),
                                    crs = st_crs(me_ctry))),
        "ME-C" = st_as_sfc(st_bbox(c(xmin=bbox$xmin, ymin=y_mid2, xmax=bbox$xmax, ymax=y_mid1),
                                    crs = st_crs(me_ctry))),
        "ME-P" = st_as_sfc(st_bbox(c(xmin=bbox$xmin, ymin=bbox$ymin, xmax=bbox$xmax, ymax=y_mid2),
                                    crs = st_crs(me_ctry)))
      )
      for (rc in names(strips)) {
        inter <- st_intersection(me_ctry, strips[[rc]])
        if (nrow(inter) > 0) {
          found_regions[[rc]] <- st_sf(iso_3166_2 = rc, geometry = st_union(inter))
        }
      }
    }
  } else if (cc == "IT") {
    it <- ne_states(country = "Italy", returnclass = "sf")
    it_map <- list(
      "IT-21" = "Piemonte", "IT-23" = "Valle d'Aosta", "IT-25" = "Lombardia",
      "IT-32" = "Trentino-Alto Adige", "IT-34" = "Veneto",
      "IT-36" = "Friuli-Venezia Giulia", "IT-42" = "Liguria",
      "IT-45" = "Emilia-Romagna", "IT-52" = "Toscana", "IT-55" = "Umbria",
      "IT-57" = "Marche", "IT-62" = "Lazio", "IT-65" = "Abruzzo",
      "IT-67" = "Molise", "IT-72" = "Campania", "IT-75" = "Apulia",
      "IT-77" = "Basilicata", "IT-78" = "Calabria", "IT-82" = "Sicily",
      "IT-88" = "Sardegna"
    )
    for (rc in names(it_map)) {
      sub <- it[it$region == it_map[[rc]], ]
      if (nrow(sub) > 0) {
        merged <- st_sf(iso_3166_2 = rc, geometry = st_union(sub))
        found_regions[[rc]] <- merged
      }
    }
  }

  if (length(found_regions) == 0) { cat("    ERREUR : aucune region trouvee, skip pays\n"); next }
  cat("    Regions matched :", length(found_regions), "/", length(region_codes), "\n")

  # 2) Species list eBird API du pays
  cat("[2] Fetch species list eBird API pour ", cc, "...\n", sep="")
  country_species <- tryCatch(fetch_country_species(cc), error = function(e) NULL)
  if (is.null(country_species)) { cat("    ERR API, skip\n"); next }
  runs_country <- runs[runs$species_code %in% country_species, ]
  cat("    Match ebirdst_runs :", nrow(runs_country), " especes S&T pour ce pays\n")

  # 3) Boucle par espece : raster charge 1x, extract multi-region (Opt#1)
  cat("[3] Traitement (", nrow(runs_country), " especes)...\n", sep="")
  regions_prj <- NULL   # cache polygones projetes (calcule au 1er raster charge)
  # Structure : results[[region_code]][[sci]] = c(52 valeurs)
  results <- setNames(vector("list", length(found_regions)), names(found_regions))
  for (rc in names(found_regions)) results[[rc]] <- list()
  n_ok <- 0; n_err <- 0
  errors <- character(0)

  for (i in seq_len(nrow(runs_country))) {
    row <- runs_country[i, ]
    sci <- tolower(row$scientific_name); code <- row$species_code
    if (i %% 25 == 0 || i == 1) {
      elapsed <- as.numeric(Sys.time() - t_start, units = "mins")
      n_entries <- sum(sapply(results, length))
      cat(sprintf("    [%d/%d] %.1f min, %d OK, %d err, %d entries cross-region, %s (%s)\n",
                  i, nrow(runs_country), elapsed, n_ok, n_err, n_entries, sci, code))
    }
    tryCatch({
      suppressMessages(
        ebirdst_download_status(species = code, download_abundance = TRUE,
                                download_ranges = FALSE, pattern = "abundance_median_3km",
                                force = FALSE)
      )
      r_weekly <- tryCatch(
        load_raster(code, resolution = "3km", product = "abundance", period = "weekly"),
        error = function(e) tryCatch(
          load_raster(code, resolution = "9km", product = "abundance", period = "weekly"),
          error = function(e2) NULL
        )
      )
      if (is.null(r_weekly)) {
        n_err <- n_err + 1
        errors <- c(errors, paste0(sci, " (", code, "): raster load failed"))
      } else {
        # Cache : projeter tous les polygones regions en CRS raster (une seule fois)
        if (is.null(regions_prj)) {
          regions_prj <- list()
          for (rc in names(found_regions)) {
            regions_prj[[rc]] <- st_transform(found_regions[[rc]], crs = crs(r_weekly))
          }
        }
        # Extract multi-region en une passe (batch de polygones)
        all_vec <- do.call(rbind, lapply(names(regions_prj), function(rc) {
          poly <- regions_prj[[rc]]
          data.frame(region = rc, id = 1)
        }))
        # Faire une extraction par region : rapide car raster deja en memoire
        for (rc in names(regions_prj)) {
          weekly_means <- terra::extract(r_weekly, vect(regions_prj[[rc]]), fun = mean, na.rm = TRUE)
          layer_cols <- setdiff(names(weekly_means), "ID")
          w_vec <- as.numeric(colMeans(weekly_means[, layer_cols, drop = FALSE], na.rm = TRUE))
          w_vec[is.nan(w_vec) | is.na(w_vec)] <- 0
          if (length(w_vec) != 52) {
            pad <- 52 - length(w_vec)
            if (pad > 0) w_vec <- c(w_vec, rep(0, pad)) else w_vec <- w_vec[1:52]
          }
          if (max(w_vec) > 0) {
            results[[rc]][[sci]] <- round(w_vec, 6)
          }
        }
        n_ok <- n_ok + 1
      }
    }, error = function(e) {
      msg <- paste0(sci, " (", code, "): ", conditionMessage(e))
      errors <<- c(errors, msg)
      n_err <<- n_err + 1
    })

    # Free memoire apres chaque espece
    if (exists("r_weekly")) rm(r_weekly)
    if (exists("weekly_means")) rm(weekly_means)
    invisible(gc(verbose = FALSE))
  }

  cat("\n[3] Termine. OK :", n_ok, "  Erreurs :", n_err, "\n")

  # 4) Ecriture JSON output
  cat("[4] Ecriture JSON...\n")
  out <- setNames(vector("list", length(results)), names(results))
  n_total_entries <- 0
  for (rc in names(results)) {
    sp_list <- results[[rc]]
    out[[rc]] <- setNames(
      lapply(sp_list, function(w) list(w = w)),
      names(sp_list)
    )
    n_total_entries <- n_total_entries + length(sp_list)
  }
  out_path <- paste0("C:/Users/mathi/Documents/Projets/Ligue_des_Plumes/data/abundance_st_by_region_",
                     tolower(cc), ".json")
  writeLines(toJSON(out, auto_unbox = TRUE, null = "null"), out_path)
  cat("    Ecrit :", out_path, "(", file.info(out_path)$size, "bytes,",
      n_total_entries, "entries region-species)\n")

  # Log
  log_path <- paste0("C:/Users/mathi/Documents/Projets/Ligue_des_Plumes/tools/ebirdst-build-region-", cc, ".log")
  elapsed_min <- as.numeric(Sys.time() - t_start, units = "mins")
  writeLines(c(
    paste0("Build eBird S&T weekly par region ", cc, " - ", format(Sys.time())),
    paste0("Duree : ", round(elapsed_min, 1), " min"),
    paste0("Regions : ", length(found_regions)),
    paste0("Especes traitees : ", n_ok),
    paste0("Erreurs : ", n_err),
    paste0("Entries region-species : ", n_total_entries),
    "", "=== Erreurs ===", errors
  ), log_path)
  cat("[", cc, "] Termine en ", round(elapsed_min, 1), " min.\n", sep="")
}

global_elapsed <- as.numeric(Sys.time() - global_start, units = "hours")
cat("\n\nGlobal termine en ", round(global_elapsed, 2), " h\n", sep="")
