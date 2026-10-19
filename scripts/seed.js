// Crea el equipo de coordinación. Con --demo añade además jugadores ficticios y
// un par de entrenamientos para probar la web.
//   DATABASE_URL=... npm run seed
const crypto = require('node:crypto');
const { db, tx, init, pool } = require('../src/db');
const L = require('../src/logic');

const token = () => crypto.randomBytes(12).toString('base64url');

const COORDINATORS = ['Aleix Artacho', 'Mario Hernández', 'Axel Blas', 'Andrés Aranda'];

async function seed({ demo = false } = {}) {
  await init();
  await tx(async (c) => {
    const addPlayer = async (name, coord) => {
      if (!(await c.get('SELECT 1 FROM players WHERE name = $1', [name]))) {
        await c.run('INSERT INTO players (name, is_coordinator, token) VALUES ($1, $2, $3)', [name, coord, token()]);
      }
    };
    for (const name of COORDINATORS) await addPlayer(name, 1);
    if (!demo) return;

    for (let i = 1; i <= 28; i++) await addPlayer(`Jugador ${String(i).padStart(2, '0')}`, 0);
    const players = (await c.all('SELECT id FROM players ORDER BY id')).map((p) => p.id);

    // Entrenamiento de la semana pasada (con asistencia, incidencias y resultados) y el próximo
    const next = L.nextWednesday();
    const last = L.addDays(next, -7);
    for (const date of [last, next]) {
      await c.run('INSERT INTO sessions (date) VALUES ($1) ON CONFLICT (date) DO NOTHING', [date]);
    }
    const lastS = await c.get('SELECT * FROM sessions WHERE date = $1', [last]);
    if (await c.get('SELECT 1 FROM responses WHERE session_id = $1', [lastS.id])) return;

    const opens = L.sessionTimes(lastS).opensAt.getTime();
    for (const [i, pid] of players.slice(0, 18).entries()) {
      const t = new Date(opens + (i + 1) * 47_000).toISOString();
      await c.run(`INSERT INTO responses (session_id, player_id, answer, signed_up_at, updated_at) VALUES ($1, $2, 'yes', $3, $3)`, [lastS.id, pid, t]);
    }
    for (const [i, pid] of players.slice(0, 16).entries()) {
      await c.run('INSERT INTO attendance (session_id, player_id, status) VALUES ($1, $2, $3)',
        [lastS.id, pid, i === 5 ? 'late' : i === 9 ? 'no_show' : 'attended']);
    }
    for (const pid of players.slice(16, 18)) {
      await c.run(`INSERT INTO attendance (session_id, player_id, status) VALUES ($1, $2, 'left_out')`, [lastS.id, pid]);
    }
    const insI = `INSERT INTO infractions (session_id, player_id, type, status, source) VALUES ($1, $2, $3, 'confirmed', 'attendance')`;
    await c.run(insI, [lastS.id, players[5], 'late_arrival']);
    await c.run(insI, [lastS.id, players[9], 'no_show']);

    const a = (await c.get(`INSERT INTO teams (session_id, name, color) VALUES ($1, 'Petos', '#f97316') RETURNING id`, [lastS.id])).id;
    const b = (await c.get(`INSERT INTO teams (session_id, name, color) VALUES ($1, 'Sin petos', '#f8fafc') RETURNING id`, [lastS.id])).id;
    const present = players.slice(0, 16).filter((_, i) => i !== 9);
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
    .then(async () => {
      for (const p of await db.all('SELECT name, is_coordinator FROM players ORDER BY id')) {
        console.log(`${p.is_coordinator ? '[coord] ' : '        '}${p.name}`);
      }
      console.log('Los enlaces personales están en Coordinación → Jugadores.');
    })
    .catch((e) => { console.error(e); process.exitCode = 1; })
    .finally(() => pool.end());
}

module.exports = { seed };
