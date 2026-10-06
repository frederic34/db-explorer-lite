# DB Explorer Lite

Extension VS Code légère pour **se connecter à une base de données, lister les tables, consulter les données et exécuter des requêtes SQL**.

Bases prises en charge : **MySQL / MariaDB**, **PostgreSQL** et **SQLite** (fichier, en lecture seule).

## Fonctionnalités

- **Vue « DB Explorer »** dans la barre d'activité : connexions → bases (MySQL) ou schémas (PostgreSQL) → tables et vues → colonnes (type, clé primaire, NOT NULL).
- **Aperçu des données** : icône « œil » au survol d'une table (ou clic droit → *Afficher les données*). Les données sont **paginées** ; le **tri** et le **filtre** portent sur toute la table, pas seulement sur la page affichée (voir [Parcourir une table](#parcourir-une-table)).
- **Navigation par clés étrangères** : cliquez sur une valeur de clé étrangère pour ouvrir la ligne référencée ; voir [Naviguer par les clés étrangères](#naviguer-par-les-clés-étrangères).
- **Éditeur SQL** : clic droit → *Nouvelle requête SQL*, ou commande `DB Explorer: Nouvelle requête SQL`. Autocomplétion, historique, annulation : voir [Éditeur SQL](#éditeur-sql).
- **Garde-fous production** : connexions *lecture seule* et *production*, confirmation avant les requêtes dangereuses ; voir [Sécurité](#sécurité).
- **Tunnel SSH intégré** ; voir [Tunnel SSH](#tunnel-ssh).
- **Exécution** : `Ctrl+Alt+Entrée` (`Cmd+Alt+Entrée` sur Mac) ou bouton ▶ dans la barre de l'éditeur. La **sélection** est exécutée si elle existe, sinon **tout le fichier**.
- **Résultats d'une requête** dans un panneau latéral : tri par colonne, filtre texte (sur les lignes affichées), `NULL` mis en évidence, durée, nombre de lignes / lignes affectées, erreurs SQL affichées.
- **Ajouter, modifier et supprimer des lignes** depuis l'aperçu d'une table : voir la section [Ajouter, modifier et supprimer des données](#ajouter-modifier-et-supprimer-des-données).
- **Export CSV** du résultat affiché (pour un aperçu de table : la page courante).
- Mots de passe stockés dans le **SecretStorage** de VS Code (jamais en clair dans les réglages).
- Barre d'état : connexion utilisée par l'éditeur SQL actif (cliquer pour en changer).

## Installation

```bash
code --install-extension db-explorer-lite-<version>.vsix
```

Ou dans VS Code : `Extensions` → `…` → *Installer à partir d'un VSIX…*

## Utilisation

1. Ouvrir la vue **DB Explorer** (icône base de données) → **Ajouter une connexion**. Un formulaire s'ouvre avec tous les champs (type, hôte, port, utilisateur, mot de passe, base, SSL, nom) :
   - le **port** et l'**utilisateur** par défaut suivent le type choisi ;
   - une **URL de connexion** (`mysql://user:mdp@hote:3306/base`, `postgresql://…`) peut être collée pour remplir les champs d'un coup ;
   - le bouton **Tester la connexion** vérifie les paramètres avant d'enregistrer ;
   - en modification, un mot de passe laissé vide conserve l'actuel.
2. Déplier la connexion pour parcourir les tables.
3. Cliquer sur l'icône d'aperçu d'une table, ou ouvrir une nouvelle requête et l'exécuter.

> SQLite : choisissez le type *SQLite* puis le fichier (bouton *Parcourir…*) ; il n'y a ni hôte, ni utilisateur, ni mot de passe.

> MySQL : si le champ « base de données » est laissé vide, toutes les bases du serveur sont listées. PostgreSQL : le champ est obligatoire, les schémas de cette base sont listés.

## Réglages

| Réglage | Défaut | Description |
|---|---|---|
| `dbExplorer.previewLimit` | `200` | Lignes par page au départ dans l'aperçu d'une table (modifiable dans l'aperçu, 1 à 1000) |
| `dbExplorer.maxRows` | `5000` | Lignes maximum conservées pour un résultat de requête |
| `dbExplorer.showSystemSchemas` | `false` | Afficher `information_schema`, `mysql`, `pg_catalog`… |
| `dbExplorer.confirmDangerous` | `true` | Demander confirmation avant `UPDATE` / `DELETE` sans `WHERE`, `DROP`, `TRUNCATE`, `ALTER … DROP` |
| `dbExplorer.confirmOnProduction` | `true` | Demander confirmation avant toute écriture sur une connexion marquée *production* |
| `dbExplorer.csvSeparator` | `,` | Séparateur CSV (`,`, `;` ou `tab`) — `;` convient mieux à Excel en français |

## Parcourir une table

L'aperçu d'une table lit **une page à la fois** (200 lignes par défaut) : ouvrir une table de plusieurs millions de lignes ne charge que la première page.

- **Pagination** : ⏮ ◀ ▶ pour naviguer, ⟳ pour actualiser, sélecteur de **lignes par page** (25 à 1000). La position s'affiche « Lignes 101–200 sur 250 » ; le total est compté en arrière-plan et apparaît dès qu'il est connu (sur une très grosse table, il n'empêche jamais d'afficher la page). Il reste exact après vos propres insertions et suppressions ; ⟳ le recompte.
- **Tri** : clic sur l'en-tête d'une colonne — croissant, décroissant, puis retour à l'ordre de la clé primaire. Le tri est exécuté par le serveur sur toute la table ; la clé primaire sert de départage, donc aucune ligne n'est répétée ou oubliée d'une page à l'autre.
- **Filtre** : le texte saisi est recherché (« contient », sans tenir compte de la casse) dans **toutes les colonnes textuelles de la table**, pas seulement dans la page affichée. `%` et `_` sont cherchés tels quels. Sur une grosse table, ce filtre parcourt toutes les lignes : il peut prendre du temps s'il n'y a pas d'index utilisable.
- Changer de page, de tri ou de filtre efface la sélection de lignes et ferme toute saisie en cours.

## Ajouter, modifier et supprimer des données

Dans l'**aperçu d'une table** (icône « œil »), la grille est éditable :

- **Ajouter** : le bouton **Ajouter une ligne** ouvre une ligne de saisie en tête de grille. Pour chaque colonne, trois états : une **valeur** (dès que vous tapez), **NULL**, ou **défaut** (la colonne est omise et le serveur applique sa valeur par défaut ou son auto-incrément). Les colonnes `NOT NULL` sans valeur par défaut sont obligatoires ; ✓ ou `Entrée` insère, ✗ ou `Échap` annule. La ligne insérée est relue et affichée avec ses valeurs réelles (identifiant généré, valeurs par défaut, colonnes calculées).

- **Supprimer** : cochez une ou plusieurs lignes (case de l'en-tête = toutes les lignes de la page), puis **Supprimer la sélection**. Une confirmation est demandée ; la suppression se fait dans **une seule transaction** : si une ligne est refusée (clé étrangère, par exemple), aucune n'est supprimée.
- **Modifier** : cliquez sur le crayon d'une ligne, changez les valeurs, puis ✓ (ou `Entrée`) pour enregistrer, ✗ (ou `Échap`) pour annuler. `Maj+Entrée` ajoute un retour à la ligne. La case **NULL** permet de mettre une valeur à NULL (une chaîne vide reste une chaîne vide). La ligne est relue après l'enregistrement : vous voyez la valeur réellement stockée (`19.9` → `19.90`).

Les lignes sont identifiées par leur **clé primaire** (simple ou composite). La grille reste donc en lecture seule, avec la raison affichée, pour :

- une table **sans clé primaire** ;
- une **vue** ;
- le résultat d'une **requête SQL** que vous avez écrite.

Ne sont pas modifiables : les colonnes de clé primaire (elles restent saisissables à l'insertion quand le serveur ne les génère pas), les colonnes **générées** (calculées par le serveur), les colonnes binaires (BLOB, `bytea`, `bit`), géométriques, et — sous PostgreSQL — les tableaux et intervalles, dont l'affichage en texte ne peut pas être réécrit sans risque. Ces colonnes sont omises à l'insertion.

Si la ligne a été modifiée ou supprimée par quelqu'un d'autre entre-temps, l'opération est annulée avec un message au lieu d'écraser silencieusement.

## Naviguer par les clés étrangères

Dans l'aperçu d'une table, les valeurs d'une colonne **clé étrangère** (sur une seule colonne) sont des liens (en-tête marqué ↗) : un clic ouvre la table référencée, filtrée sur la ligne visée. Une puce (`id = 10`, avec ✕ pour la retirer) rappelle le filtre, et le bouton **←** revient à la vue précédente, avec son tri, sa page et son filtre (20 niveaux). Le filtre texte se combine avec l'égalité, et la grille reste modifiable. Les clés composites ne sont pas suivies.

## Éditeur SQL

- **Autocomplétion** : mots-clés, bases / schémas, tables, colonnes ; les alias (`FROM clients c` → `c.`) sont compris. Le schéma est lu à la demande et gardé 5 minutes (actualiser la connexion le relit).
- **Historique** : commande `DB Explorer: Historique des requêtes` (200 dernières, doublons fusionnés, la plus récente en premier) ; *Effacer l'historique des requêtes* le vide.
- **Plusieurs instructions** : sous MySQL / MariaDB, un script est découpé et exécuté sur **une seule connexion** (tables temporaires, variables, transactions) ; le résultat de la dernière est affiché, et une erreur indique « Instruction k/N ».
- **Annulation** : `DB Explorer: Annuler la requête en cours` (ou l'indicateur dans la barre d'état) interrompt la requête côté serveur (`pg_cancel_backend`, `KILL QUERY`).

## Sécurité

Dans le formulaire de connexion, rubrique **Sécurité** :

- **Lecture seule** : aucune écriture, ni par la grille ni par l'éditeur SQL. C'est aussi imposé **côté serveur** (`default_transaction_read_only` pour PostgreSQL, `SET SESSION TRANSACTION READ ONLY` pour MySQL), et une instruction qui tenterait de lever la protection est refusée.
- **Production** : badge **PROD** (rouge) dans l'arbre et les résultats, et confirmation avant toute écriture.
- Dans tous les cas, `UPDATE` / `DELETE` sans `WHERE`, `DROP`, `TRUNCATE` et `ALTER … DROP` demandent confirmation (réglage `confirmDangerous`).

L'analyse est faite par un lecteur SQL qui ignore commentaires et chaînes ; elle complète la protection du serveur sans la remplacer.

## Tunnel SSH

Cochez **Se connecter à travers un tunnel SSH** dans le formulaire : l'hôte et le port de la base sont alors ceux vus *depuis le serveur SSH* (souvent `localhost`). Authentification par mot de passe, clé privée (avec phrase secrète éventuelle) ou agent SSH. À la première connexion, l'**empreinte** du serveur est demandée puis mémorisée et vérifiée ensuite ; commande `DB Explorer: Oublier les serveurs SSH approuvés` pour la réinitialiser. Le tunnel se rétablit seul après une coupure. Mots de passe et phrases secrètes sont dans le SecretStorage.

## SQLite

Les fichiers SQLite sont ouverts avec **sql.js** (SQLite compilé en WebAssembly : rien à installer, aucun module natif) :

- **lecture seule**, toujours : le fichier n'est jamais modifié ; les écritures sont refusées ;
- le fichier est **chargé en mémoire** (300 Mo maximum) et **relu automatiquement** s'il change sur le disque ;
- tables, vues, colonnes, clés étrangères, pagination, tri, filtre et export CSV fonctionnent comme pour les autres bases ;
- une requête très longue ne peut pas être annulée (SQLite s'exécute dans le processus de l'extension).

## Limites connues

- Plusieurs instructions : seul le résultat de la dernière est affiché.
- Sous MySQL, si la clé primaire est générée par le serveur autrement que par auto-incrément (un `UUID()` par défaut, par exemple), la ligne est bien insérée mais ne peut pas être retrouvée : l'extension l'indique et il faut actualiser l'aperçu pour la voir. Sous PostgreSQL, la ligne est toujours relue.
- Sous MySQL, les tables MyISAM ne supportent pas les transactions : la suppression « tout ou rien » ne s'y applique pas.
- SQLite : lecture seule uniquement, pas d'annulation de requête.

## Développement

```bash
npm install
npm run build      # vérification des types + bundle esbuild dans dist/
# F5 dans VS Code pour lancer une fenêtre de développement
npm run package    # produit db-explorer-lite-<version>.vsix
```

### Tests

```bash
docker compose -f test/docker-compose.yml up -d --wait   # PostgreSQL 16 (port 55432) et MariaDB 11 (port 53306)
npm test                                                 # unitaires + bout en bout sur les deux bases
npm test pg                                              # une seule base : « pg » ou « my »
```

- `test/sqlite.test.js` : pilote SQLite sur un fichier créé à la volée (aucun serveur requis). `test/tunnel.test.js` : tunnel SSH contre un faux serveur SSH. `test/form.test.js` : formulaire de connexion.
- `test/unit.test.js` : générateurs SQL (pagination, tri, filtre, UPDATE / INSERT / DELETE) et règles d'édition, sans base.
- `test/e2e.js` : la vraie grille (jsdom) → panneau de résultats → pilote → vraie base : édition, insertion, suppression, transactions, pagination, tri, filtre, messages périmés ou forgés. Le jeu de données (`test/seed.js`) est recréé à chaque exécution : **n'utilisez que des bases jetables**.
- Sans base joignable, les tests de bout en bout sont ignorés en local ; en CI (ou avec `DBX_REQUIRE_DB=1`) ils échouent. Les connexions se règlent par `TEST_PG_*` / `TEST_MYSQL_*` (voir `test/config.js`).
- La CI exécute ces tests (avec des bases en service) avant de construire le `.vsix` ; une release n'est publiée que s'ils passent.

### Publier une version

Un workflow GitHub Actions (`.github/workflows/release.yml`) construit l'extension à chaque push et pull request, et publie une **release avec le `.vsix`** lorsqu'un tag `v*` est poussé. Le tag doit correspondre à la version du `package.json` :

```bash
npm version patch          # met à jour package.json et crée le tag vX.Y.Z
git push --follow-tags
```
