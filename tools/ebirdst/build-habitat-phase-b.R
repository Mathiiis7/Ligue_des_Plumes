# build-habitat-phase-b.R
# Phase B : pour chaque espece dans chaque pays supporte, calcule les fractions
# habitat ponderees par l'abondance eBird S&T (weekly rasters).
#
# Formule :
#   Habitat_espece_pays[classe] = sum(S&T[cell] * habitat_frac[cell][classe]) / sum(S&T[cell])
#
# Overrides AVONET pour specialistes (Marine, Wetland, Riverine, Coastal) :
#   Force les fractions vers le vrai habitat de l'espece (evite le biais raster
#   pour les martin-pecheurs, frégates, marouettes, etc.).
#
# Especes sans S&T : produit un JSON entry {"unavailable": true} plutot que du fake.
#
# Output : data/countries/{cc}/habitat_by_species.json
#   { "sci_name_lowercase": { "111": 0.35, "112": 0.12, ..., "_source": "st|avonet|bar" } }

suppressMessages({
  library(terra); library(sf); library(jsonlite); library(ebirdst)
})

t0 <- Sys.time()

CACHE_DIR   <- "C:/Users/mathi/Documents/Projets/clc/cache_frac"
OUT_DIR     <- "C:/Users/mathi/Documents/Projets/Ligue_des_Plumes/data/countries"
EBIRDST_DIR <- "C:/Users/mathi/AppData/Roaming/R/data/R/ebirdst/2023"

# Pays cibles supportes par l'app.
# Extensible : ajouter code ISO + activation du compute.
SUPPORTED_COUNTRIES <- c("FR", "ME", "ES", "IT", "GB", "PT")

# AVONET habitat categories -> override fractions (indices L1 super-categories).
# Structure : {"Marine": c("water"=0.9, "wetland"=0.1)} = force 90% eau + 10% humide.
# Ces overrides s'appliquent APRES le calcul raster, si l'espece est taggee dans AVONET.
AVONET_HABITAT_OVERRIDE <- list(
  Marine    = list(water = 0.90, wetland = 0.10),
  Coastal   = list(water = 0.45, wetland = 0.35, forest_seminat = 0.10, artif = 0.10),
  Riverine  = list(wetland = 0.60, water = 0.25, forest_seminat = 0.10, agri = 0.05),
  Wetland   = list(wetland = 0.70, water = 0.15, forest_seminat = 0.10, agri = 0.05)
  # Autres categories AVONET (Forest, Woodland, Grassland, Shrubland, Rock, Human Modified)
  # -> pas d'override, on utilise le raster (deja fiable pour ces habitats communs)
)

# Mapping code CLC -> L1 super-categorie (utilise pour normaliser vers 5 groupes)
CLC_L1_MAP <- list(
  artif = c(111,112,121,122,123,124,131,132,133,141,142),
  agri = c(211,212,213,221,222,223,231,241,242,243,244),
  forest_seminat = c(311,312,313,321,322,323,324,331,332,333,334,335),
  wetland = c(411,412,421,422,423),
  water = c(511,512,521,522,523)
)
CGLC_L1_MAP <- list(
  artif = c(50),
  agri = c(40),
  forest_seminat = c(20,30,60,70,100,111,112,113,114,115,116,121,122,123,124,125,126),
  wetland = c(90),
  water = c(80,200)
)

# ============================================================================
# Charge AVONET
# ============================================================================
avonet_file <- "C:/Users/mathi/Documents/Projets/Ligue_des_Plumes/data/avonet_traits.json"
avonet <- if (file.exists(avonet_file)) fromJSON(avonet_file, simplifyVector = FALSE) else list()
cat(sprintf("[SETUP] AVONET : %d entrees\n", length(avonet)))

# Retourne la categorie AVONET Habitat pour une espece (sci lowercase), ou "" si NA/inconnue.
avonet_habitat_of <- function(sci) {
  entry <- avonet[[sci]]
  if (is.null(entry)) return("")
  h <- entry$Habitat
  if (is.null(h) || is.na(h) || h == "") return("")
  return(as.character(h))
}

# ============================================================================
# Pour un raster habitat multi-bandes (Phase A output), calcule les L1 fractions
# ponderees par un raster abondance (S&T). Retourne named vector L1.
# ============================================================================
compute_l1_fractions <- function(hab_rast, ab_rast) {
  # Aligne : resample abondance sur la grille habitat si necessaire
  if (!compareGeom(hab_rast[[1]], ab_rast, stopOnError = FALSE)) {
    ab_rast <- resample(ab_rast, hab_rast[[1]], method = "average")
  }
  ab_vals <- values(ab_rast)
  keep <- !is.na(ab_vals) & ab_vals > 0
  if (sum(keep) == 0) return(NULL)
  # Somme des ponderations (pour normaliser)
  total_ab <- sum(ab_vals[keep])
  # Detecte si CLC (44 bandes) ou CGLC (22 bandes) via nom de bande
  code_names <- as.integer(names(hab_rast))
  is_clc <- any(code_names > 400 & code_names < 600)   # codes CLC >= 411 tourbieres
  l1_map <- if (is_clc) CLC_L1_MAP else CGLC_L1_MAP
  # Pour chaque L1 : somme des (S&T * fraction_l1_pixel) / total_ab
  out <- setNames(numeric(length(l1_map)), names(l1_map))
  for (l1 in names(l1_map)) {
    codes_l1 <- l1_map[[l1]]
    bands <- which(code_names %in% codes_l1)
    if (length(bands) == 0) next
    band_sum <- app(hab_rast[[bands]], fun = "sum", na.rm = TRUE)
    band_vals <- values(band_sum)[keep]
    contrib <- sum(band_vals * ab_vals[keep], na.rm = TRUE) / total_ab
    out[[l1]] <- contrib
  }
  # Normalise en cas d'arrondi
  s <- sum(out)
  if (s > 0) out <- out / s
  return(out)
}

# ============================================================================
# Applique override AVONET si l'espece est taggee Marine/Wetland/Riverine/Coastal.
# ============================================================================
apply_avonet_override <- function(l1_fractions, sci) {
  hab <- avonet_habitat_of(sci)
  if (hab %in% names(AVONET_HABITAT_OVERRIDE)) {
    override <- AVONET_HABITAT_OVERRIDE[[hab]]
    out <- setNames(numeric(length(l1_fractions)), names(l1_fractions))
    for (k in names(override)) if (k %in% names(out)) out[[k]] <- override[[k]]
    return(list(fractions = out, source = paste0("avonet:", hab)))
  }
  return(list(fractions = l1_fractions, source = "st"))
}

# ============================================================================
# Charge le raster S&T weekly d'une espece dans un pays (extrait pour la zone).
# Retourne NULL si pas de modele S&T pour cette espece.
# Utilise l'abondance annuelle moyenne (moyenne des 52 semaines) pour Phase B.
# ============================================================================
load_st_abundance <- function(species_code) {
  st_path <- file.path(EBIRDST_DIR, species_code,
                       paste0(species_code, "_abundance_median_3km_2023.tif"))
  if (!file.exists(st_path)) return(NULL)
  tryCatch({
    r <- rast(st_path)
    # Reduit les 52 semaines a la moyenne annuelle
    r_annual <- app(r, fun = "mean", na.rm = TRUE)
    return(r_annual)
  }, error = function(e) NULL)
}

# ============================================================================
# Pour un pays : itere sur les especes du catalogue et calcule leurs fractions.
# ============================================================================
phase_b_country <- function(cc) {
  cat(sprintf("\n[%s]\n", cc))
  cache_file <- file.path(CACHE_DIR, paste0(cc, "_habitat_frac.tif"))
  if (!file.exists(cache_file)) {
    cat(sprintf("  Phase A cache manquant, skip.\n"))
    return(FALSE)
  }
  hab_rast <- rast(cache_file)
  # Liste des especes cibles : lecture depuis un fichier catalogue par pays.
  # Format : JSON { "sci_name": {sci, code, ...}, ... } charge par le repo app.
  catalog_file <- file.path(OUT_DIR, tolower(cc), "st_by_species.json")
  if (!file.exists(catalog_file)) {
    cat(sprintf("  Catalogue st_by_species.json manquant pour %s.\n", cc))
    return(FALSE)
  }
  catalog <- fromJSON(catalog_file, simplifyVector = FALSE)
  n_species <- length(catalog)
  cat(sprintf("  %d especes a traiter\n", n_species))
  out <- list()
  done <- 0; fallback_avonet <- 0; unavailable <- 0
  for (sci in names(catalog)) {
    entry <- catalog[[sci]]
    code <- entry$code
    ab_rast <- if (!is.null(code)) load_st_abundance(code) else NULL
    if (is.null(ab_rast)) {
      # Pas de S&T : fallback AVONET si dispo, sinon "unavailable".
      hab <- avonet_habitat_of(sci)
      if (hab %in% names(AVONET_HABITAT_OVERRIDE)) {
        result <- apply_avonet_override(rep(0, 5), sci)
        out[[sci]] <- as.list(result$fractions)
        out[[sci]][["_source"]] <- result$source
        fallback_avonet <- fallback_avonet + 1
      } else {
        out[[sci]] <- list("_source" = "unavailable")
        unavailable <- unavailable + 1
      }
    } else {
      l1 <- compute_l1_fractions(hab_rast, ab_rast)
      if (is.null(l1)) {
        out[[sci]] <- list("_source" = "no_overlap")
        unavailable <- unavailable + 1
      } else {
        result <- apply_avonet_override(l1, sci)
        out[[sci]] <- as.list(result$fractions)
        out[[sci]][["_source"]] <- result$source
      }
    }
    done <- done + 1
    if (done %% 50 == 0) cat(sprintf("    %d/%d...\n", done, n_species))
  }
  cat(sprintf("  Termine. ok_st=%d avonet_fallback=%d unavailable=%d\n",
              done - fallback_avonet - unavailable, fallback_avonet, unavailable))
  # Ecrit le JSON
  out_file <- file.path(OUT_DIR, tolower(cc), "habitat_by_species.json")
  dir.create(dirname(out_file), showWarnings = FALSE, recursive = TRUE)
  write(toJSON(out, auto_unbox = TRUE, digits = 4), file = out_file)
  cat(sprintf("  -> %s\n", out_file))
  return(TRUE)
}

# ============================================================================
# Main : loop sur les pays supportes
# ============================================================================
cat("=== PHASE B : fractions habitat par espece ===\n")
for (cc in SUPPORTED_COUNTRIES) {
  tryCatch(phase_b_country(cc), error = function(e) cat(sprintf("  [%s] ERREUR : %s\n", cc, e$message)))
}
cat(sprintf("\nPhase B terminee en %.1f min\n", as.numeric(Sys.time() - t0, units = "mins")))
