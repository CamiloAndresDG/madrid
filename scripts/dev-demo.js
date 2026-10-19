// Arranca la web en local con un Postgres embebido (data/pg) y datos de demostración.
const { startLocalPg } = require('./local-pg');

(async () => {
  const pg = await startLocalPg();
  process.env.DATABASE_URL = pg.url;
  const { start } = require('../src/server');
  await start(process.env.PORT || 3000);
  const { seed } = require('./seed');
  const { db } = require('../src/db');
  if (!(await db.get('SELECT 1 FROM players LIMIT 1'))) await seed({ demo: true });
  console.log('Demo lista: entra con jugador01@example.com (coordinador) y la contraseña demo1234');
  const stop = async () => { await pg.stop(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})().catch((e) => { console.error(e); process.exit(1); });
