# Deploy migration-weekly : marche a suivre post-run

Steps a faire quand le run `Rscript tools/ebirdst/build-migration-weekly.R` est termine.

## 1. Verifier que le run a fini proprement

Regarde les 15 dernieres lignes du log :

```powershell
Get-Content tools\ebirdst\migration-weekly.log -Tail 15
```

Tu dois voir :
```
=== Termine ===
Succes : X  ; Echecs : Y
Dossiers especes : X  ; Total PNGs : Y  ; Poids : Z MB
```

Si Succes >= 280 sur 304 c'est OK (quelques echecs Cornell sont normaux). Si Succes < 200 ou si le script n'a pas atteint "Termine" -> il a crashe en cours, relance avec la meme commande (skip auto des especes deja faites).

## 2. Mesurer le poids reel

```powershell
$total = (Get-ChildItem data\range-weekly -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Host "Total : $([math]::Round($total/1MB,1)) MB"
$dirs = Get-ChildItem data\range-weekly -Directory | Measure-Object
Write-Host "Especes : $($dirs.Count)"
```

Attendu : ~150-500 MB total pour ~300 especes. Si > 700 MB, on evaluera des optims supplementaires.

## 3. Cloner et pusher dans le repo data

Ouvre PowerShell dans `C:\Users\mathi\Documents\` (parent du repo main) :

```powershell
cd C:\Users\mathi\Documents

# Clone le nouveau repo (si pas deja fait)
git clone https://github.com/Mathiiis7/Ligue_des_Plumes_data.git

# Copie le dossier range-weekly generne dedans (remplace si deja present)
Remove-Item Ligue_des_Plumes_data\range-weekly -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item Ligue_des_Plumes\data\range-weekly Ligue_des_Plumes_data\ -Recurse

# Push (peut prendre 2-5 min selon le poids)
cd Ligue_des_Plumes_data
git add -A
git commit -m "Import range-weekly PNGs (304 migrateurs FR, PNG-8 optim, 52 frames, bbox adaptatif)"
git push
```

## 4. Activer GitHub Pages sur le repo data (a faire UNE seule fois)

- Ouvre https://github.com/Mathiiis7/Ligue_des_Plumes_data/settings/pages
- Source : **Deploy from a branch** -> branch **main** / (root) -> **Save**
- Attends 1-2 min : verifie que https://mathiiis7.github.io/Ligue_des_Plumes_data/range-weekly/barswa/w01.png charge une image

## 5. Push le manifest a jour dans le main repo

```powershell
cd C:\Users\mathi\Documents\Ligue_des_Plumes
git add data\range-weekly-index.json
git commit -m "Manifest range-weekly complet (304 migrateurs)"
git push
```

## 6. (Optionnel) Retirer le dossier range-weekly du main repo

Le main a servi de scratch pendant les tests. Maintenant que tout est dans le repo data,
on peut retirer `data/range-weekly/` du main pour ne pas dupliquer 150+ MB inutile :

```powershell
cd C:\Users\mathi\Documents\Ligue_des_Plumes
git rm -r data\range-weekly
git commit -m "Retire range-weekly du main (deplace vers Ligue_des_Plumes_data)"
git push
```

**Attention** : ca ne libere pas d'espace disque local, juste le repo git. Pour libere l'espace local aussi :

```powershell
# Optionnel apres le git rm : purge du dossier local
# (les fichiers ne sont plus tracks par git, seulement en workspace)
Remove-Item C:\Users\mathi\Documents\Ligue_des_Plumes\data\range-weekly -Recurse -Force -ErrorAction SilentlyContinue
```

## 7. Tester

Attends 1 min que les 2 GitHub Pages redeploient, puis ouvre plusieurs fiches migrateurs sur ton site :

- **Hirondelle rustique** (trans-saharien) : anim doit montrer la vague Europe -> Afrique australe
- **Cigogne blanche** : idem
- **Fauvette a tete noire** (intra-europeenne) : bbox plus tight
- **Guepier d'Europe** : Med -> Afrique

Verifications :
- Card "Migration semaine par semaine" apparait
- Autoplay ▶ Lire tourne
- Slider fluide
- Molette-dezoom montre le monde entier
- Cadrage bbox adaptatif correct pour chaque espece

## 8. Libere le cache ebirdst (optionnel, ~50-70 GB)

Une fois que t'es sur que tout marche, tu peux liberer le cache Cornell (les rasters bruts) :

```powershell
Remove-Item "C:\Users\mathi\AppData\Roaming\R\data\R\ebirdst" -Recurse -Force
```

**Attention** : si tu veux re-runner un pipeline plus tard (autres pays, mise a jour), tout sera re-telecharge. Garde-le tant que tu bosses sur les cartes.

## 9. Notify

Envoie-moi les logs finaux + le poids reel du data repo, on validera ensemble et on decidera si des ajustements sont necessaires avant de fermer le chantier migration weekly.
