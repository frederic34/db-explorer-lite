// Connexions de test. Valeurs par défaut = test/docker-compose.yml ; surchargeables par variables d'environnement.
const env = process.env;

exports.PG = {
  cfg: {
    id: 'pg', name: 'PG', type: 'postgres',
    host: env.TEST_PG_HOST || '127.0.0.1',
    port: Number(env.TEST_PG_PORT || 55432),
    user: env.TEST_PG_USER || 'postgres',
    database: env.TEST_PG_DATABASE || 'postgres',
  },
  password: env.TEST_PG_PASSWORD ?? 'test',
};

exports.MY = {
  cfg: {
    id: 'my', name: 'MY', type: 'mysql',
    host: env.TEST_MYSQL_HOST || '127.0.0.1',
    port: Number(env.TEST_MYSQL_PORT || 53306),
    user: env.TEST_MYSQL_USER || 'root',
  },
  password: env.TEST_MYSQL_PASSWORD ?? 'test',
};

/** En CI (ou avec DBX_REQUIRE_DB=1), une base injoignable est une erreur ; en local, le test est ignoré. */
exports.requireDb = Boolean(env.CI || env.DBX_REQUIRE_DB);
