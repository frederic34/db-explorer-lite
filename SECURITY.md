# Politique de sécurité

## Signaler une vulnérabilité

Merci de **ne pas ouvrir de ticket public** pour une faille de sécurité. Utilisez le signalement privé de GitHub : onglet **Security** du dépôt → *Report a vulnerability*
(<https://github.com/frederic34/db-explorer-lite/security/advisories/new>).

Indiquez la version de l'extension, le type de base (MySQL / MariaDB, PostgreSQL, SQLite), et les étapes pour reproduire. Le signalement est traité dès que possible ; un correctif est publié dès qu'il est prêt, avec une mention dans le [CHANGELOG](CHANGELOG.md).

Seule la **dernière version publiée** est maintenue.

## Ce que fait l'extension de vos données

- **Mots de passe de bases et de tunnels SSH** (et phrases secrètes de clés) : stockés dans le *SecretStorage* de VS Code, jamais dans les réglages, les fichiers ni les journaux. Les clés privées SSH ne sont pas copiées : seul leur chemin est enregistré.
- **Empreintes des serveurs SSH approuvés** : enregistrées dans l'état de l'extension ; une empreinte modifiée interrompt la connexion.
- **Aucun envoi à un tiers** : l'extension ne contacte que les serveurs que vous configurez. Elle ne collecte aucune télémétrie.
- **Historique des requêtes** : stocké localement (200 dernières). Il peut contenir des valeurs saisies dans vos requêtes : *DB Explorer: Effacer l'historique des requêtes* le vide.
- **Écritures** : les connexions marquées *lecture seule* sont protégées aussi côté serveur ; les instructions dangereuses demandent confirmation. Ces protections réduisent les erreurs, elles ne remplacent pas un compte de base de données aux droits limités : pour une base sensible, utilisez un utilisateur en lecture seule.
- **Exports** : les fichiers produits (CSV, JSON, SQL) contiennent vos données en clair.
