// Postgres embebido para desarrollo y tests (no hace falta Docker ni instalar Postgres).
const fs = require('node:fs');
const path = require('node:path');

async function startLocalPg({ dir = path.join(__dirname, '..', 'data', 'pg'), port = 54329, persistent = true } = {}) {
  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const fresh = !fs.existsSync(path.join(dir, 'PG_VERSION'));
  const pg = new EmbeddedPostgres({
    databaseDir: dir, user: 'postgres', password: 'postgres', port, persistent, onLog: () => {},
  });
  if (fresh) await pg.initialise();
  await pg.start();
  if (fresh) await pg.createDatabase('futbol7');
  return {
    url: `postgres://postgres:postgres@localhost:${port}/futbol7`,
    stop: () => pg.stop(),
  };
}

module.exports = { startLocalPg };
