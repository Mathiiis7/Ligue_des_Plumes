// Genere par tools/build-exotic-per-country.mjs depuis eBird API v2.
// Ne pas editer a la main. Regenerable : node tools/build-exotic-per-country.mjs
//
// Format : { regionCode: { sciName: category } }
// Categorie eBird : N (Naturalized) | P (Provisional) | X (Escapee) | C (obsolete)
//
// Source : field exoticCategory du /v2/data/obs/{region}/recent?back=30
// (une entree par espece, la plus recente sur 30 jours).
//
// LIMITE : exotiques rares non observes sur 30 derniers jours peuvent manquer.
// index.html merge ce dict avec la liste EXOTIC curatorial en fallback.
export const EXOTIC_BY_COUNTRY = {"FR":{"columba livia":"N","psittacula krameri":"N","tadorna ferruginea":"N","phasianus colchicus":"N","euodice malabarica":"N","branta canadensis":"N","threskiornis aethiopicus":"N","leiothrix lutea":"N","alopochen aegyptiaca":"N","anser indicus":"N","oxyura jamaicensis":"N","aix galericulata":"N","callipepla californica":"N","geopelia cuneata":"X"},"ME":{"pelecanus rufescens":"X"}};
