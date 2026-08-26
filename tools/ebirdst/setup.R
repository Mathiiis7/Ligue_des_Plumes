# setup.R — Verifie / installe le pipeline ebirdst.
# Usage : Rscript tools/ebirdst/setup.R

cat("=== ebirdst setup check ===\n\n")

# 1) Verifier install de ebirdst
if (!requireNamespace("ebirdst", quietly = TRUE)) {
  cat("Package 'ebirdst' non installe. Installation en cours (~3 min)...\n")
  install.packages("ebirdst", repos = "https://cran.r-project.org", dependencies = TRUE)
} else {
  cat("[OK] Package 'ebirdst' installe. Version : ", as.character(packageVersion("ebirdst")), "\n", sep="")
}

# 2) Verifier deps optionnelles pour polygones pays
for (pkg in c("rnaturalearth", "sf", "terra", "dplyr")) {
  if (!requireNamespace(pkg, quietly = TRUE)) {
    cat("Package '", pkg, "' manquant. Installation...\n", sep="")
    install.packages(pkg, repos = "https://cran.r-project.org")
  } else {
    cat("[OK] ", pkg, " ", as.character(packageVersion(pkg)), "\n", sep="")
  }
}

# 3) Verifier la cle Cornell
key <- Sys.getenv("EBIRDST_KEY", unset = "")
if (nchar(key) == 0) {
  # Essayer aussi la config ebirdst persistee
  key2 <- tryCatch(ebirdst::get_ebirdst_access_key(), error = function(e) "")
  if (nchar(key2) > 0) {
    cat("[OK] Cle Cornell trouvee via config ebirdst persistente.\n")
  } else {
    cat("[ERREUR] Cle Cornell absente.\n")
    cat("  Solution rapide (temporaire):  export EBIRDST_KEY=<ta-cle>  puis relancer\n")
    cat("  Solution persistente:  dans R -> usethis::edit_r_environ() -> ajouter EBIRDST_KEY=<ta-cle>\n")
    quit(status = 1)
  }
} else {
  cat("[OK] Cle Cornell trouvee via variable d'env EBIRDST_KEY (longueur ", nchar(key), " chars).\n", sep="")
  # Enregistrer dans la config ebirdst pour reutilisation
  tryCatch({
    ebirdst::set_ebirdst_access_key(key, overwrite = TRUE)
    cat("[OK] Cle sauvee dans la config ebirdst persistente.\n")
  }, error = function(e) cat("[WARN] Impossible de sauver la cle:", conditionMessage(e), "\n"))
}

# 4) Test API : liste des versions dispo
cat("\n=== Test connexion API ebirdst ===\n")
tryCatch({
  runs <- ebirdst::ebirdst_runs
  cat("[OK] Metadata chargee. ", nrow(runs), " especes disponibles dans S&T.\n", sep="")
  cat("     Version courante des donnees : ", as.character(unique(runs$version_year)), "\n", sep="")
}, error = function(e) {
  cat("[ERREUR] Impossible de lire les metadata ebirdst:", conditionMessage(e), "\n")
  quit(status = 1)
})

cat("\n=== Setup pret. Prochaine etape : test-setup.R ===\n")
