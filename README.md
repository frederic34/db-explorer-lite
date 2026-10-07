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
- **Exécution** : `Ctrl+Alt+Entrée` (`Cmd+Alt+Entrée` sur Mac) ou bouton ▶ : la **sélection**, sinon **tout le fichier**. `Ctrl+Maj+Entrée` n'exécute que **l'instruction sous le curseur** ; `Ctrl+Alt+E` affiche son **plan d'exécution** (EXPLAIN). Voir [Éditeur SQL](#éditeur-sql).
- **Requêtes enregistrées** (vue dédiée, avec dossiers) et **paramètres nommés** `:nom` demandés à l'exécution ; voir [Éditeur SQL](#éditeur-sql).
- **Dossiers, import et export de connexions** (JSON sans mot de passe, `~/.pgpass`, `~/.my.cnf`, `~/.pg_service.conf`) : voir [Organiser ses connexions](#organiser-ses-connexions).
- **Résultats d'une requête** dans un panneau latéral : tri par colonne, filtre texte (sur les lignes affichées), `NULL` mis en évidence, durée, nombre de lignes / lignes affectées, erreurs SQL affichées. Un script de plusieurs instructions affiche **un onglet par résultat**.
- **Ajouter, modifier et supprimer des lignes** depuis l'aperçu d'une table : voir la section [Ajouter, modifier et supprimer des données](#ajouter-modifier-et-supprimer-des-données).
- **Structure d'une table** (index, contraintes, DDL) et **diagramme des relations** d'un schéma : voir [Structure et diagramme](#structure-et-diagramme).
- **Export** en CSV, JSON ou instructions INSERT, de la page affichée ou de la table entière : voir [Exporter](#exporter).
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

## Organiser ses connexions

- **Dossiers** : le champ *Groupe* du formulaire (avec suggestions des dossiers existants) range la connexion dans un dossier de l'arbre ; clic droit sur une connexion → *Déplacer dans un dossier…*, sur un dossier → *Renommer* / *Supprimer le dossier* (les connexions qu'il contient reviennent à la racine).
- **Exporter** (icône de la vue, ou commande *Exporter les connexions…*) : un fichier JSON sans identifiant ni **aucun mot de passe** (ni secret SSH). Il peut être partagé ou versionné.
- **Importer** : commande *Importer des connexions…* (lien dans la vue vide). Formats reconnus : le JSON ci-dessus, `~/.pgpass`, `~/.pg_service.conf`, `~/.my.cnf`. Les fichiers par défaut présents sur la machine sont proposés. Vous cochez les connexions à créer (les doublons sont décochés) ; les mots de passe de `.pgpass` / `.my.cnf` sont placés dans le SecretStorage, ceux d'un JSON importé sont toujours ignorés. Les entrées invalides sont écartées avec leur raison ; les sockets Unix et les lignes à joker de `.pgpass` ne sont pas importés.

## Parcourir une table

L'aperçu d'une table lit **une page à la fois** (200 lignes par défaut) : ouvrir une table de plusieurs millions de lignes ne charge que la première page.

- **Pagination** : ⏮ ◀ ▶ pour naviguer, ⟳ pour actualiser, sélecteur de **lignes par page** (25 à 1000). La position s'affiche « Lignes 101–200 sur 250 » ; le total est compté en arrière-plan et apparaît dès qu'il est connu (sur une très grosse table, il n'empêche jamais d'afficher la page). Il reste exact après vos propres insertions et suppressions ; ⟳ le recompte.
- **Tri** : clic sur l'en-tête d'une colonne — croissant, décroissant, puis retour à l'ordre de la clé primaire. Le tri est exécuté par le serveur sur toute la table ; la clé primaire sert de départage, donc aucune ligne n'est répétée ou oubliée d'une page à l'autre.
- **Filtre** : le texte saisi est recherché (« contient », sans tenir compte de la casse) dans **toutes les colonnes textuelles de la table**, pas seulement dans la page affichée. `%` et `_` sont cherchés tels quels. Sur une grosse table, ce filtre parcourt toutes les lignes : il peut prendre du temps s'il n'y a pas d'index utilisable.
- **Filtre par colonne** : dans le même champ, des conditions séparées par `;` — `prix > 20 ; nom contient dupont ; stock vide`. Opérateurs : `=`, `!=`, `>`, `>=`, `<`, `<=`, `contient` (ou `~`), `commence par`, `finit par`, `vide`, `non vide` ; `'valeur avec espaces'` entre guillemets. Ce qui n'est pas une condition sur une colonne connue reste une recherche dans toutes les colonnes.
- **Pagination par clé** : sans tri choisi, sur une table à clé primaire d'entiers, de texte ou d'uuid, la page suivante est lue par `WHERE clé > dernière valeur` au lieu de `OFFSET` : le temps de lecture ne grandit plus avec la profondeur. Dans les autres cas (tri, pas de clé, clé d'un autre type) l'extension utilise `OFFSET`.
- Changer de page, de tri ou de filtre efface la sélection de lignes et ferme toute saisie en cours.

## Ajouter, modifier et supprimer des données

Dans l'**aperçu d'une table** (icône « œil »), la grille est éditable :

- **Ajouter** : le bouton **Ajouter une ligne** ouvre une ligne de saisie en tête de grille. Pour chaque colonne, trois états : une **valeur** (dès que vous tapez), **NULL**, ou **défaut** (la colonne est omise et le serveur applique sa valeur par défaut ou son auto-incrément). Les colonnes `NOT NULL` sans valeur par défaut sont obligatoires ; ✓ ou `Entrée` insère, ✗ ou `Échap` annule. La ligne insérée est relue et affichée avec ses valeurs réelles (identifiant généré, valeurs par défaut, colonnes calculées).

- **Supprimer** : cochez une ou plusieurs lignes (case de l'en-tête = toutes les lignes de la page), puis **Supprimer la sélection**. Une confirmation est demandée ; la suppression se fait dans **une seule transaction** : si une ligne est refusée (clé étrangère, par exemple), aucune n'est supprimée.
- **Modifier** : cliquez sur le crayon d'une ligne, changez les valeurs, puis ✓ (ou `Entrée`) pour enregistrer, ✗ (ou `Échap`) pour annuler. `Maj+Entrée` ajoute un retour à la ligne. La case **NULL** permet de mettre une valeur à NULL (une chaîne vide reste une chaîne vide). La ligne est relue après l'enregistrement : vous voyez la valeur réellement stockée (`19.9` → `19.90`).

- **Colonnes JSON** (`json` / `jsonb`, MySQL `JSON`) : le JSON s'ouvre **indenté** dans un champ à chasse fixe, vérifié à la frappe (bordure rouge et message si invalide, enregistrement bloqué) ; le bouton **{ }** met en forme, `Entrée` insère une ligne et `Ctrl+Entrée` enregistre. Un JSON simplement indenté n'est pas une modification ; le texte est envoyé tel que saisi (les grands nombres ne sont pas altérés). Sous MariaDB, `JSON` est du `LONGTEXT` : champ texte ordinaire.
- **Dates et heures** (`date`, `time`, `datetime`, `timestamp` sans fuseau) : un **sélecteur natif** à côté du champ texte (qui reste libre) et un bouton **⏱** pour « maintenant ». Les types avec fuseau horaire restent en texte, pour ne pas perdre le décalage.

- **Résultat d'une requête modifiable** : `SELECT * FROM [schéma.]table [alias] [WHERE …] [ORDER BY …] [LIMIT …]` (une seule table, sans jointure, regroupement ni `DISTINCT`) donne une grille où l'on peut **modifier** et **supprimer** des lignes, comme dans l'aperçu ; pas d'insertion (la ligne ne correspondrait pas à la requête). Toute autre forme (colonnes choisies, jointure…) reste en lecture seule. Inactif sur une connexion en lecture seule.

Les lignes sont identifiées par leur **clé primaire** (simple ou composite). La grille reste donc en lecture seule, avec la raison affichée, pour :

- une table **sans clé primaire** ;
- une **vue** ;
- le résultat d'une **requête SQL** que vous avez écrite.

Ne sont pas modifiables : les colonnes de clé primaire (elles restent saisissables à l'insertion quand le serveur ne les génère pas), les colonnes **générées** (calculées par le serveur), les colonnes binaires (BLOB, `bytea`, `bit`), géométriques, et — sous PostgreSQL — les tableaux et intervalles, dont l'affichage en texte ne peut pas être réécrit sans risque. Ces colonnes sont omises à l'insertion.

Si la ligne a été modifiée ou supprimée par quelqu'un d'autre entre-temps, l'opération est annulée avec un message au lieu d'écraser silencieusement.

## Copier et voir les valeurs

- **Copier…** (barre de la grille) : les lignes **cochées**, sinon toutes celles affichées, vers le presse-papiers en **tableur** (TSV avec en-tête, à coller dans Excel / LibreOffice / Sheets), **Markdown**, **JSON**, **CSV** ou **INSERT SQL**.
- **Double-clic sur une cellule longue** (texte de plus de 60 caractères, multiligne, JSON) : la valeur complète s'ouvre dans un éditeur à côté, JSON indenté.
- **Colonnes binaires** : double-clic sur un `<binaire … octets>` — une **image** (PNG, JPEG, GIF, WebP, BMP, reconnue à ses premiers octets, jamais SVG) s'affiche dans un volet sans script ; tout autre contenu s'ouvre en vidage hexadécimal. La lecture se fait par la clé primaire, jusqu'à 10 Mo.
- **Adresses `http(s)://…`** : une cellule qui est une adresse est un lien cliquable (VS Code demande confirmation avant d'ouvrir le site).

## Structure et diagramme

- **Structure** : clic droit sur une table ou une vue → *Afficher la structure*. Colonnes (type, clé primaire, obligatoire, valeur par défaut, auto-incrément / identité / colonne générée, commentaire), **index**, **contraintes** (clé primaire, unique, clé étrangère avec table référencée et actions, CHECK) et **DDL** reconstitué : *Copier le DDL* ou *Ouvrir dans un éditeur SQL*. Le DDL est celui du serveur (`SHOW CREATE TABLE`, SQLite) ou reconstitué depuis le catalogue (PostgreSQL) ; il est rejouable tel quel.
- **Diagramme des relations** : clic droit sur une base / un schéma → *Diagramme des relations*. Les tables (colonnes, types, PK / FK) sont reliées par leurs clés étrangères ; une table est placée à droite de celles qu'elle référence. On peut **déplacer** les tables, **zoomer**, **chercher** une table, survoler une table pour mettre ses liens en évidence, passer en **clés seulement** pour alléger, **double-cliquer** une table pour afficher ses données. *Exporter en SVG* produit un fichier indépendant du thème ; *Copier (Mermaid)* donne un `erDiagram` à coller dans une documentation. Limites : 150 tables, clés étrangères sur une seule colonne (comme pour la navigation) ; les clés vers un autre schéma sont signalées par ↗ sans trait.

## Exporter

Le bouton **Exporter…** de la grille propose :

- **CSV** (BOM UTF-8, séparateur du réglage `dbExplorer.csvSeparator`), **JSON** (tableau d'objets ; les nombres, les booléens PostgreSQL et les colonnes JSON sont typés quand le type de la colonne est connu) et **INSERT SQL** (instructions rejouables, lots de 100 lignes, valeurs échappées pour le SGBD ; tableaux PostgreSQL et binaires restitués correctement) ;
- pour un aperçu de table : la **page affichée** (modifications comprises) ou la **table entière**. La table entière est relue sur le serveur par lots de 2 000 lignes, avec le **tri et le filtre** en cours, et écrite en continu dans le fichier : la mémoire reste bornée, une barre de progression permet d'**annuler** (le fichier partiel est alors supprimé). Une table modifiée pendant l'export peut donner des lignes manquantes ou en double : exportez sur une base calme si l'exactitude compte ;
- pour le résultat d'une requête libre : les lignes affichées (au plus `dbExplorer.maxRows`) ; le nom de la table des `INSERT` est demandé.

Les valeurs binaires de plus de 32 octets ne sont affichées que sous forme de taille : elles sont remplacées par `NULL` dans un export `INSERT` (l'extension le signale).

## Naviguer par les clés étrangères

Dans l'aperçu d'une table, les valeurs d'une colonne **clé étrangère** (sur une seule colonne) sont des liens (en-tête marqué ↗) : un clic ouvre la table référencée, filtrée sur la ligne visée. Une puce (`id = 10`, avec ✕ pour la retirer) rappelle le filtre, et le bouton **←** revient à la vue précédente, avec son tri, sa page et son filtre (20 niveaux). Le filtre texte se combine avec l'égalité, et la grille reste modifiable. Les clés composites ne sont pas suivies.

## Éditeur SQL

- **Autocomplétion** : mots-clés, bases / schémas, tables, colonnes ; les alias (`FROM clients c` → `c.`) sont compris. Le schéma est lu à la demande et gardé 5 minutes (actualiser la connexion le relit).
- **Historique** : commande `DB Explorer: Historique des requêtes` (200 dernières, doublons fusionnés, la plus récente en premier) ; *Effacer l'historique des requêtes* le vide.
- **Plusieurs instructions** : sous MySQL / MariaDB, un script est découpé et exécuté sur **une seule connexion** (tables temporaires, variables, transactions) ; une erreur indique « Instruction k/N ». Le résultat de **chaque** instruction est affiché dans un onglet (PostgreSQL, MariaDB / MySQL et SQLite) ; la durée n'est indiquée que pour l'ensemble sous PostgreSQL et SQLite.
- **Instruction sous le curseur** : `Ctrl+Maj+Entrée` (`Cmd+Maj+Entrée`), bouton de la barre de l'éditeur ou menu contextuel. Les instructions sont délimitées par leurs `;` (hors chaînes, commentaires et blocs `$$`) ; une sélection a la priorité.
- **EXPLAIN** : `Ctrl+Alt+E` (`Cmd+Alt+E`) ou bouton de la barre de l'éditeur affiche un **plan lisible** : une ligne par étape, indentée, avec coût, lignes estimées et alertes (parcours séquentiel / complet) — PostgreSQL (`FORMAT JSON`), MariaDB / MySQL, SQLite (`EXPLAIN QUERY PLAN`). La commande *Expliquer avec mesure (EXPLAIN ANALYZE)* ajoute les temps et lignes réels, mais **exécute réellement** l'instruction : une confirmation est demandée pour une écriture, qui reste soumise aux gardes-fous (refusée en lecture seule). SQLite ne mesure pas l'exécution.
- **Requêtes enregistrées** : clic droit dans l'éditeur → *Enregistrer la requête* (sélection, sinon instruction sous le curseur ; nom et dossier demandés). La vue **Requêtes enregistrées** les range par dossier : un clic les ouvre dans un éditeur SQL (relié à la connexion d'origine), ▶ les exécute directement, clic droit pour renommer, déplacer ou supprimer.
- **Paramètres nommés** : `WHERE ville = :ville AND age > :age` — la valeur de chaque `:nom` est demandée avant l'exécution (la dernière saisie sert de défaut) puis injectée en **littéral** : nombre tel quel, `null` pour NULL, sinon texte entre apostrophes correctement échappées (une valeur ne peut donc pas injecter de SQL). Sont ignorés : chaînes, identifiants, commentaires, blocs `$$`, conversions PostgreSQL `x::int`. Pour une liste (`IN`), saisissez plusieurs paramètres. Réglage `dbExplorer.promptParameters` pour désactiver.
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
- le moteur tourne dans un **thread séparé** : une requête longue ne bloque pas VS Code et peut être **annulée** (le fichier est alors rechargé à la requête suivante) ;
- tables, vues, colonnes, clés étrangères, pagination, tri, filtre et export CSV fonctionnent comme pour les autres bases ;

## Limites connues

- Sous MariaDB, une colonne `JSON` est un alias de `LONGTEXT` : elle est exportée en JSON comme une chaîne.
- Sous MySQL, si la clé primaire est générée par le serveur autrement que par auto-incrément (un `UUID()` par défaut, par exemple), la ligne est bien insérée mais ne peut pas être retrouvée : l'extension l'indique et il faut actualiser l'aperçu pour la voir. Sous PostgreSQL, la ligne est toujours relue.
- Sous MySQL, les tables MyISAM ne supportent pas les transactions : la suppression « tout ou rien » ne s'y applique pas.
- SQLite : lecture seule uniquement. Annuler une requête arrête aussi les autres requêtes SQLite en cours sur la même connexion.

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

- `test/features.js` : structure (DDL rejoué dans un autre schéma, structure identique), jeux de résultats multiples, exports (INSERT rejoués, JSON, lecture par lots, annulation) sur la vraie base. `test/er.test.js` et `test/structure.test.js` : disposition du diagramme et pages (jsdom).
- `test/sqlite.test.js` : pilote SQLite sur un fichier créé à la volée (aucun serveur requis). `test/tunnel.test.js` : tunnel SSH contre un faux serveur SSH. `test/form.test.js` : formulaire de connexion.
- `test/unit.test.js` : générateurs SQL (pagination, tri, filtre, UPDATE / INSERT / DELETE) et règles d'édition, sans base.
- `test/e2e.js` : la vraie grille (jsdom) → panneau de résultats → pilote → vraie base : édition, insertion, suppression, transactions, pagination, tri, filtre, messages périmés ou forgés. Le jeu de données (`test/seed.js`) est recréé à chaque exécution : **n'utilisez que des bases jetables**.
- Sans base joignable, les tests de bout en bout sont ignorés en local ; en CI (ou avec `DBX_REQUIRE_DB=1`) ils échouent. Les connexions se règlent par `TEST_PG_*` / `TEST_MYSQL_*` (voir `test/config.js`).
- La CI exécute ces tests (avec des bases en service) avant de construire le `.vsix` ; une release n'est publiée que s'ils passent.

#### Tests d'intégration dans un vrai VS Code

```bash
npm run test:integration            # télécharge VS Code (réseau requis) puis lance la suite Mocha dans l'hôte d'extensions
xvfb-run -a npm run test:integration  # Linux sans écran
```

`test/integration/` vérifie l'activation, l'enregistrement de toutes les commandes déclarées, l'arbre, une base SQLite (worker + WebAssembly sous le Node d'Electron), l'instruction sous le curseur et l'EXPLAIN. Le contenu des webviews n'est pas inspectable depuis l'hôte : il reste couvert par les tests jsdom. Dans la CI, ce job est **bloquant** : une release n'est construite que s'il passe.

### Publier une version

Un workflow GitHub Actions (`.github/workflows/release.yml`) construit l'extension à chaque push et pull request, et publie une **release avec le `.vsix`** lorsqu'un tag `v*` est poussé. Le tag doit correspondre à la version du `package.json` :

```bash
npm version patch          # met à jour package.json et crée le tag vX.Y.Z
git push --follow-tags
```

## Licence, sécurité, historique

- Licence [MIT](LICENSE).
- Signaler une faille : voir [SECURITY.md](SECURITY.md) (signalement privé GitHub, et ce que l'extension fait de vos données).
- Historique des versions : [CHANGELOG.md](CHANGELOG.md).
