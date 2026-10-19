// Datos de prueba. Con --demo crea jugadores ficticios con cuenta (contraseña: demo1234)
// y reparte roles para probar la pantalla de coordinación.
//   DATABASE_URL=... npm run seed -- --demo
const { db, tx, init, pool } = require('../src/db');
const A = require('../src/auth');
const L = require('../src/logic');

const DEMO_PASSWORD = 'demo1234';
const DEMO_ROLES = { 1: ['coordinador'], 2: ['gestor'], 3: ['petos'], 4: ['balones'] };

async function seed({ demo = false } = {}) {
  await init();
  if (!demo) return;

  for (let i = 1; i <= 28; i++) {
    const num = String(i).padStart(2, '0');
    const email = `jugador${num}@example.com`;
    if (await db.get('SELECT 1 FROM players WHERE email = $1', [email])) continue;
    await db.run(`INSERT INTO players (name, first_name, last_name, phone, email, password_hash)
      VALUES ($1, $2, $3, $4, $5, $6)`,
    [`Jugador ${num}`, 'Jugador', num, `6${String(10000000 + i).slice(1)}`, email, A.hashPassword(DEMO_PASSWORD)]);
  }
  const players = await db.all('SELECT id, email FROM players ORDER BY id');
  for (const [n, roles] of Object.entries(DEMO_ROLES)) {
    const p = players.find((x) => x.email === `jugador${String(n).padStart(2, '0')}@example.com`);
    if (p) await A.setRoles(p.id, roles);
  }

  // Entrenamiento de la semana pasada (con asistencia, incidencias y resultados) y el próximo
  const next = L.nextWednesday();
  const last = L.addDays(next, -7);
  await tx(async (c) => {
    for (const date of [last, next]) {
      await c.run(`INSERT INTO sessions (date, published_at) VALUES ($1, $2) ON CONFLICT (date) DO NOTHING`, [date, new Date().toISOString()]);
    }
    const lastS = await c.get('SELECT * FROM sessions WHERE date = $1', [last]);
    if (await c.get('SELECT 1 FROM responses WHERE session_id = $1', [lastS.id])) return;

    const ids = players.map((p) => p.id);
    const opens = L.sessionTimes(lastS).opensAt.getTime();
    for (const [i, pid] of ids.slice(0, 18).entries()) {
      const t = new Date(opens + (i + 1) * 47_000).toISOString();
      await c.run(`INSERT INTO responses (session_id, player_id, answer, signed_up_at, updated_at) VALUES ($1, $2, 'yes', $3, $3)`, [lastS.id, pid, t]);
    }
    for (const [i, pid] of ids.slice(0, 16).entries()) {
      await c.run('INSERT INTO attendance (session_id, player_id, status) VALUES ($1, $2, $3)',
        [lastS.id, pid, i === 5 ? 'late' : i === 9 ? 'no_show' : 'attended']);
    }
    for (const pid of ids.slice(16, 18)) {
      await c.run(`INSERT INTO attendance (session_id, player_id, status) VALUES ($1, $2, 'left_out')`, [lastS.id, pid]);
    }
    const insI = `INSERT INTO infractions (session_id, player_id, type, status, source) VALUES ($1, $2, $3, 'confirmed', 'attendance')`;
    await c.run(insI, [lastS.id, ids[5], 'late_arrival']);
    await c.run(insI, [lastS.id, ids[9], 'no_show']);

    const a = (await c.get(`INSERT INTO teams (session_id, name, color) VALUES ($1, 'Petos', '#f97316') RETURNING id`, [lastS.id])).id;
    const b = (await c.get(`INSERT INTO teams (session_id, name, color) VALUES ($1, 'Sin petos', '#f8fafc') RETURNING id`, [lastS.id])).id;
    const present = ids.slice(0, 16).filter((_, i) => i !== 9);
    for (const [i, pid] of present.entries()) {
      await c.run('INSERT INTO team_players (team_id, player_id) VALUES ($1, $2)', [i % 2 ? b : a, pid]);
    }
    const insM = 'INSERT INTO matches (session_id, home_team_id, away_team_id, home_goals, away_goals) VALUES ($1, $2, $3, $4, $5)';
    await c.run(insM, [lastS.id, a, b, 5, 3]);
    await c.run(insM, [lastS.id, a, b, 2, 2]);
    const insS = 'INSERT INTO player_stats (session_id, player_id, goals, assists, saves, mvp) VALUES ($1, $2, $3, $4, $5, $6)';
    await c.run(insS, [lastS.id, present[0], 3, 1, 0, 1]);
    await c.run(insS, [lastS.id, present[2], 2, 2, 0, 0]);
    await c.run(insS, [lastS.id, present[1], 2, 0, 0, 0]);
    await c.run(insS, [lastS.id, present[3], 1, 1, 6, 0]);
  });
}

if (require.main === module) {
  seed({ demo: process.argv.includes('--demo') })
    .then(() => console.log('Listo. Cuentas de demo: jugador01@example.com … jugador28@example.com / demo1234'))
    .catch((e) => { console.error(e); process.exitCode = 1; })
    .finally(() => pool.end());
}

module.exports = { seed };
