// Jeu de données des tests de bout en bout : schéma / base « shop », recréé à chaque exécution.
const pg = [
  `DROP SCHEMA IF EXISTS shop CASCADE`,
  `CREATE SCHEMA shop`,
  `CREATE TABLE shop.produits (id serial PRIMARY KEY, nom text NOT NULL, prix numeric(10,2), cree_le timestamptz DEFAULT '2026-10-06 18:00:00+02', meta jsonb, actif boolean DEFAULT true, note text, tags text[], bin bytea)`,
  `INSERT INTO shop.produits (nom, prix, meta, note, tags, bin) VALUES
 ('Alpha', 10.5, '{"a":1}', 'première', '{x,y}', '\\x616263'),
 ('Bravo', 20, NULL, NULL, NULL, NULL),
 ('Charlie', 30.25, '{"b":2}', '', NULL, NULL),
 ('Delta', 40, NULL, 'quatre', NULL, NULL),
 ('Écho', 50, NULL, NULL, NULL, NULL)`,
  `CREATE TABLE shop.enfants (id serial PRIMARY KEY, produit_id int REFERENCES shop.produits(id), label text)`,
  `INSERT INTO shop.enfants (produit_id, label) VALUES (1, 'lié à Alpha')`,
  `CREATE TABLE shop.lignes (cmd int, ligne int, qte int NOT NULL, PRIMARY KEY (cmd, ligne))`,
  `INSERT INTO shop.lignes VALUES (1,1,5),(1,2,6),(2,1,7),(2,2,8)`,
  `CREATE TABLE shop.sanspk (a int, b text)`,
  `INSERT INTO shop.sanspk VALUES (1,'x'),(2,'y')`,
  `CREATE TABLE shop.tout_defaut (id serial PRIMARY KEY, a int DEFAULT 5)`,
  `CREATE TABLE shop.gen (id serial PRIMARY KEY, a int NOT NULL, g int GENERATED ALWAYS AS (a * 2) STORED)`,
  `INSERT INTO shop.gen (a) VALUES (1),(2)`,
  `CREATE TABLE shop.ident (id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, label text NOT NULL)`,
  `CREATE TABLE shop.uuids (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), label text)`,
];

const my = [
  `DROP DATABASE IF EXISTS shop`,
  `CREATE DATABASE shop CHARACTER SET utf8mb4`,
  `CREATE TABLE shop.produits (id INT AUTO_INCREMENT PRIMARY KEY, nom VARCHAR(100) NOT NULL, prix DECIMAL(10,2), cree_le DATETIME DEFAULT '2026-10-06 18:00:00', meta JSON, actif TINYINT(1) DEFAULT 1, note TEXT, bin BLOB) ENGINE=InnoDB`,
  `INSERT INTO shop.produits (nom, prix, meta, note, bin) VALUES
 ('Alpha', 10.5, '{"a":1}', 'première', 'abc'),
 ('Bravo', 20, NULL, NULL, NULL),
 ('Charlie', 30.25, '{"b":2}', '', NULL),
 ('Delta', 40, NULL, 'quatre', NULL),
 ('Écho', 50, NULL, NULL, NULL)`,
  `CREATE TABLE shop.enfants (id INT AUTO_INCREMENT PRIMARY KEY, produit_id INT, label VARCHAR(50), FOREIGN KEY (produit_id) REFERENCES shop.produits(id)) ENGINE=InnoDB`,
  `INSERT INTO shop.enfants (produit_id, label) VALUES (1, 'lié à Alpha')`,
  `CREATE TABLE shop.lignes (cmd INT, ligne INT, qte INT NOT NULL, PRIMARY KEY (cmd, ligne)) ENGINE=InnoDB`,
  `INSERT INTO shop.lignes VALUES (1,1,5),(1,2,6),(2,1,7),(2,2,8)`,
  `CREATE TABLE shop.sanspk (a INT, b VARCHAR(10)) ENGINE=InnoDB`,
  `INSERT INTO shop.sanspk VALUES (1,'x'),(2,'y')`,
  `CREATE TABLE shop.tout_defaut (id INT AUTO_INCREMENT PRIMARY KEY, a INT DEFAULT 5) ENGINE=InnoDB`,
  `CREATE TABLE shop.gen (id INT AUTO_INCREMENT PRIMARY KEY, a INT NOT NULL, g INT AS (a * 2) STORED) ENGINE=InnoDB`,
  `INSERT INTO shop.gen (a) VALUES (1),(2)`,
  `CREATE TABLE shop.uuids (id CHAR(36) NOT NULL DEFAULT (UUID()) PRIMARY KEY, label VARCHAR(50)) ENGINE=InnoDB`,
];

exports.seed = async (kind, driver) => {
  for (const sql of kind === 'pg' ? pg : my) {
    await driver.query(sql);
  }
};
