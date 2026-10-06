# Changelog

Toutes les évolutions notables de DB Explorer Lite. Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/), versions selon [SemVer](https://semver.org/lang/fr/).

## [0.7.0] — 2026-10-06

### Ajouté
- Après un `CREATE`, `ALTER`, `DROP`, `RENAME` ou `COMMENT` exécuté dans l'éditeur, l'arbre (la connexion concernée seulement) et l'autocomplétion se mettent à jour.
- Licence MIT, `SECURITY.md`, icône de l'extension, et ce journal des modifications.

### Modifié
- SQLite s'exécute dans un thread séparé : une requête longue ne bloque plus VS Code et peut être annulée (le fichier est rechargé ensuite).

## [0.6.0] — 2026-10-06

### Ajouté
- **Structure d'une table ou d'une vue** : colonnes détaillées, index, contraintes et DDL rejouable (copie, ouverture dans un éditeur SQL).
- **Export** en CSV, JSON ou instructions `INSERT`, de la page affichée ou de la table entière (lecture par lots, tri et filtre conservés, progression, annulation).
- **Plusieurs jeux de résultats** : un onglet par instruction d'un script (PostgreSQL, MariaDB / MySQL, SQLite).
- **Diagramme des relations** d'un schéma : déplacement, zoom, recherche, mode « clés seulement », export SVG, copie Mermaid.

## [0.5.0] — 2026-10-06

### Ajouté
- **SQLite** (fichier, lecture seule) via sql.js, sans module natif.
- **Tunnel SSH intégré** : mot de passe, clé privée ou agent, empreinte du serveur vérifiée (confiance à la première connexion), rétablissement automatique.
- **Garde-fous** : connexions *lecture seule* (imposée aussi côté serveur) et *production* (badge, confirmation des écritures), confirmation des requêtes dangereuses.
- **Navigation par clés étrangères** depuis la grille, avec retour en arrière.
- **Éditeur SQL** : autocomplétion, historique, scripts MySQL sur une seule connexion, annulation d'une requête en cours.
- Tests automatisés (unitaires et bout en bout sur PostgreSQL et MariaDB) et intégration continue.

## [0.4.0]

### Ajouté
- Aperçu de table **paginé** ; tri et filtre exécutés par le serveur sur toute la table, total compté en arrière-plan.

## [0.3.0]

### Ajouté
- Modification de ligne, suppression par sélection (une transaction) et ajout de ligne depuis la grille, par clé primaire.

## [0.2.0]

### Modifié
- Un formulaire unique remplace l'assistant de connexion (test de connexion, import d'URL).

## [0.1.0]

### Ajouté
- Explorateur de connexions, bases / schémas, tables et colonnes (MySQL / MariaDB et PostgreSQL), aperçu des données, éditeur SQL, résultats triables, export CSV, mots de passe dans le SecretStorage, workflow de publication du `.vsix`.
