# build-habitat-fractions.R
# Version FRACTIONS de la Phase A + B :
#   Phase A : aggrege CLC/CGLC a 3km avec 44 (ou 22) bandes = fraction de chaque classe
#             dans chaque pixel 3km (au lieu de modal = classe dominante).
#   Phase B : pour chaque espece, multiplier l'abondance S&T par chaque bande fraction,
#             sommer sur les cellules du pays → distribution ponderee reelle.
# Beaucoup moins de bruit terrestre pour oiseaux marins/cotiers.
# Cache separate : clc/cache_frac/ (44 bandes chacun, +5-20x plus lourd)

suppressMessages({
  library(terra); library(sf); library(jsonlite); library(ebirdst)
})

t0 <- Sys.time()

CLC_PATH  <- "C:/Users/mathi/Documents/Projets/clc/extracted/u2018_clc2018_v2020_20u1_raster100m/DATA/U2018_CLC2018_V2020_20u1.tif"
CGLC_PATH <- "C:/Users/mathi/Documents/Projets/clc/cglc/PROBAV_LC100_global_v3.0.1_2019-nrt_Discrete-Classification-map_EPSG-4326.tif"
CACHE_DIR <- "C:/Users/mathi/Documents/Projets/clc/cache_frac"
OUT_DIR   <- "C:/Users/mathi/Documents/Projets/Ligue_des_Plumes/data/countries"
EBIRDST_DIR <- "C:/Users/mathi/AppData/Roaming/R/data/R/ebirdst/2023"

dir.create(CACHE_DIR, showWarnings=FALSE, recursive=TRUE)

CLC_ID_TO_CODE <- c(111,112,121,122,123,124,131,132,133,141,142,
                    211,212,213,221,222,223,231,241,242,243,244,
                    311,312,313,321,322,323,324,331,332,333,334,335,
                    411,412,421,422,423,
                    511,512,521,522,523)
CLC_IDS   <- 1:44
CGLC_CODES <- c(20,30,40,50,60,70,80,90,100,111,112,113,114,115,116,121,122,123,124,125,126,200)

EEA_COUNTRIES <- c("FR","DE","ES","IT","GB","PT","BE","NL","LU","IE","AT","CH",
                   "PL","CZ","SK","HU","RO","BG","SI","HR","BA","RS","AL","MK",
                   "GR","CY","MT","SE","NO","FI","DK","IS","EE","LV","LT","TR","LI")

COUNTRY_BBOX <- list(
  FR = c(-5.5, 41, 10, 51.5),
  PT = c(-10, 36, -6, 42.5),
  ES = c(-10, 35, 5, 44),
  US = c(-125, 24, -66, 50)
  # Note : bboxes retirees pour les gros pays (CA/AU/BR/CN/etc.) afin de garder la
  # qualite complete sur les zones extremes (Arctique canadien, Tasmanie, etc.).
  # Compute plus long mais data complete.
)

# Skip list vide : avec les 3 methodes (mask avant segregate + fact adaptatif +
# buffer seabird), meme les atolls et micro-etats sont traites correctement.
SKIP_COUNTRIES <- c()

# Pays landlocked (aucune cote) : buffer = 0 km, evite de gaspiller sur territoires
# terrestres uniquement. Liste exhaustive des pays landlocked selon UN.
LANDLOCKED <- c(
  # Europe
  "CH","AT","CZ","SK","HU","RS","BY","MK","MD","AD","SM","VA","LI","LU",
  # Caucase
  "AM","AZ",
  # Asie centrale
  "KZ","KG","TJ","TM","UZ","MN","AF","NP","BT","LA",
  # Afrique
  "ML","NE","CF","TD","SS","ZM","ZW","BW","LS","SZ","MW","BF","ET","UG","RW","BI",
  # Amerique du Sud
  "PY","BO"
)

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
l1_of <- function(code, use_clc) {
  m <- if (use_clc) CLC_L1_MAP else CGLC_L1_MAP
  for (l1 in names(m)) if (code %in% m[[l1]]) return(l1)
  return("other")
}

cat("[SETUP] Chargement frontieres pays...\n")
world_sf <- rnaturalearth::ne_countries(scale=10, returnclass="sf")
ALL_COUNTRIES <- unique(world_sf$iso_a2_eh[
  !is.na(world_sf$iso_a2_eh) &
  world_sf$iso_a2_eh != "-99" &
  nchar(world_sf$iso_a2_eh) == 2
])
# Alaska et Hawaii : n'ont pas de code ISO propre (US uniquement). On les extrait
# des etats US via ne_states() et on les traite comme sub-countries US_AK / US_HI.
# Idem si un jour on veut split la Russie asiatique/europeenne, etc.
cat("[SETUP] Chargement etats US pour Alaska/Hawaii...\n")
us_states <- tryCatch(
  rnaturalearth::ne_states(country = "United States of America", returnclass = "sf"),
  error = function(e) { cat("  echec ne_states US : ", e$message, "\n"); NULL }
)
if (!is.null(us_states)) {
  # Injecte AK / HI en tant que "pays" virtuels dans world_sf
  ak <- us_states[us_states$name == "Alaska", ]
  hi <- us_states[us_states$name == "Hawaii", ]
  if (nrow(ak) > 0) {
    ak$iso_a2_eh <- "AK"
    world_sf <- rbind(world_sf[, "iso_a2_eh"], ak[, "iso_a2_eh"])
    ALL_COUNTRIES <- c(ALL_COUNTRIES, "AK")
  }
  if (nrow(hi) > 0) {
    hi$iso_a2_eh <- "HI"
    world_sf <- rbind(world_sf, hi[, "iso_a2_eh"])
    ALL_COUNTRIES <- c(ALL_COUNTRIES, "HI")
  }
}
cat(sprintf("[SETUP] %d pays (dont AK/HI en sub-US)\n", length(ALL_COUNTRIES)))

# Sharding : permet de lancer N processus en parallele en repartissant les pays.
# Env var SHARD au format "idx/n_total" (0-indexe). Ex: "1/4" = shard 1 de 4.
# Le launcher shell script lance 4 Rscript avec SHARD=0/4, 1/4, 2/4, 3/4.
SHARD <- Sys.getenv("SHARD", "0/1")
sh_parts <- strsplit(SHARD, "/")[[1]]
sh_idx <- as.integer(sh_parts[1])
sh_n <- as.integer(sh_parts[2])
if (sh_n > 1) {
  # Ordre alphabetique -> repartition equitable par pays alphabetise.
  ALL_COUNTRIES <- sort(ALL_COUNTRIES)
  keep_idx <- which((seq_along(ALL_COUNTRIES) %% sh_n) == sh_idx)
  ALL_COUNTRIES <- ALL_COUNTRIES[keep_idx]
  cat(sprintf("[SHARD %d/%d] Traite %d pays\n", sh_idx, sh_n, length(ALL_COUNTRIES)))
}

# =============================================================================
# PHASE A : aggregation fractions (44 CLC bandes ou 22 CGLC bandes par pays)
# =============================================================================

phase_a_country <- function(cc) {
  if (cc %in% SKIP_COUNTRIES) {
    cat(" SKIP (micro/disperse)")
    return(TRUE)
  }
  cache_file <- file.path(CACHE_DIR, paste0(cc, "_habitat_frac.tif"))
  if (file.exists(cache_file)) return(TRUE)

  country_sf <- world_sf[world_sf$iso_a2_eh == cc, ]
  if (nrow(country_sf) == 0) return(FALSE)
  if (!is.null(COUNTRY_BBOX[[cc]])) {
    bb <- COUNTRY_BBOX[[cc]]
    country_sf <- st_crop(country_sf, xmin=bb[1], ymin=bb[2], xmax=bb[3], ymax=bb[4])
  }

  # Antimeridien : les pays qui croisent la ligne 180°/-180° (Fidji, Kiribati,
  # Russie extreme est, USA avec Alaska) ont un polygone Natural Earth "cassé" en
  # 2 morceaux dont l'un a lon < -180 ou > 180. On detecte via l'etendue du polygone
  # ecclatant les 180 : si oui, on split en 2 sous-polygones (Est et Ouest).
  bb_check <- st_bbox(country_sf)
  crosses_antimeridian <- (bb_check["xmax"] - bb_check["xmin"]) > 300  # heuristique
  if (crosses_antimeridian) {
    cat(" [antimeridien detecte, traite comme 2 sous-polygones]")
    # Split : partie ouest (lon > 0) et est (lon < 0), cropees separement
    west_sf <- st_crop(country_sf, xmin=0, ymin=-90, xmax=180, ymax=90)
    east_sf <- st_crop(country_sf, xmin=-180, ymin=-90, xmax=0, ymax=90)
    # On garde le plus gros pour le compute principal (l'autre sera perdu, TODO ameliorer)
    if (as.numeric(sum(st_area(west_sf))) > as.numeric(sum(st_area(east_sf)))) {
      country_sf <- west_sf
    } else {
      country_sf <- east_sf
    }
  }

  # Buffer seabird : etend le polygone vers la mer pour capturer l'habitat des
  # especes marines (frégates, pétrels, albatros). Landlocked = 0, gros pays = 50km,
  # petits pays et iles = 200km. Antarctique = force 200km (côtes marines critiques).
  country_area_km2 <- as.numeric(sum(st_area(country_sf))) / 1e6
  if (cc == "AQ") {
    buffer_km <- 200   # Antarctique : buffer marin pour manchots/petrels
  } else if (cc %in% LANDLOCKED) {
    buffer_km <- 0
  } else if (country_area_km2 < 100000) {
    buffer_km <- 200   # petits pays / iles / atolls
  } else {
    buffer_km <- 50    # continentaux avec cote
  }
  if (buffer_km > 0) {
    # Buffer en degres approximatif : 1 deg latitude ~= 111 km
    country_sf_buffered <- st_buffer(country_sf, dist=buffer_km / 111)
    country_vect <- vect(country_sf_buffered)
  } else {
    country_vect <- vect(country_sf)
  }

  use_clc <- cc %in% EEA_COUNTRIES
  ts <- Sys.time()

  if (use_clc) {
    cvect <- project(country_vect, "EPSG:3035")
    lc <- rast(CLC_PATH)
    lc_crop <- crop(lc, cvect)
    codes <- CLC_IDS
  } else {
    cvect <- country_vect
    lc <- rast(CGLC_PATH)
    lc_crop <- crop(lc, cvect)
    codes <- CGLC_CODES
  }

  # METHODE 2 : fact adaptatif selon la taille du pays. Pour petits pays,
  # on veut plus de cellules resolution fine ; pour gros pays, cellules 3km
  # suffisent (compute raisonnable).
  land_area_km2 <- country_area_km2   # approx, sans buffer marin
  if (land_area_km2 < 100) {
    agg_fact <- 2       # ~200m cells : ~500-2500 cellules pour un pays <100 km2
  } else if (land_area_km2 < 1000) {
    agg_fact <- 5       # ~500m cells
  } else if (land_area_km2 < 10000) {
    agg_fact <- 10      # ~1km cells
  } else {
    agg_fact <- if (use_clc) 30 else max(2, round(0.027 / mean(res(lc_crop))))
  }

  cat(sprintf(" (source %dx%d, fact=%d, buffer=%dkm)", ncol(lc_crop), nrow(lc_crop), agg_fact, buffer_km))

  # METHODE 1 : mask AVANT segregate pour eliminer l'ocean et les pays voisins
  # avant le compute lourd (segregate multiplie par 22 le volume de data).
  # Cellules NA ne sont pas traitees par segregate/aggregate → gain massif.
  lc_masked <- mask(lc_crop, cvect)

  seg <- segregate(lc_masked, classes=codes, keep=FALSE, other=NA)
  agg_stack <- aggregate(seg, fact=agg_fact, fun="mean", na.rm=TRUE)
  names(agg_stack) <- as.character(codes)
  # mask final : ecrit dans le cache
  mask(agg_stack, cvect, filename=cache_file, overwrite=TRUE, datatype="FLT4S")

  dur <- as.numeric(Sys.time() - ts, units="secs")
  cat(sprintf(" -> %dx%d cells x %d bands, %.0f sec\n", ncol(agg_stack), nrow(agg_stack), nlyr(agg_stack), dur))
  # Cleanup temp raster files pour eviter accumulation de GB
  try(terra::tmpFiles(remove=TRUE, current=TRUE), silent=TRUE)
  return(TRUE)
}

cat("\n=== PHASE A FRACTIONS : agg par pays ===\n")
for (cc in ALL_COUNTRIES) {
  cat(sprintf("  [%s]", cc))
  tryCatch(phase_a_country(cc), error = function(e) cat(" ERREUR:", e$message, "\n"))
}
cat(sprintf("\nPhase A frac terminee en %.1f min\n", as.numeric(Sys.time() - t0, units="mins")))
