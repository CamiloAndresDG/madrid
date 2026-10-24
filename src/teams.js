// Equipos equilibrados para el entreno, según las estadísticas de la temporada.
// Mínimo 14 para jugar: 2 equipos (7 contra 7, 8 contra 8…) y, desde 21, triangular de 3 equipos con partidos de 8 minutos.

const TRAINING_MINUTES = 60;
const TRIANGULAR_MATCH_MINUTES = 8;
const MIN_PLAYERS = 14;
const TRIANGULAR_FROM = 21;

const TEAM_STYLES = [
  { name: 'Amarillos', color: '#facc15' },
  { name: 'Naranjas', color: '#f97316' },
  { name: 'Azules', color: '#2563eb' },
];

// Valoración de un jugador: puntos por partido + medio punto por gol o asistencia por entreno.
// Sin partidos jugados se usa la mediana del grupo, para no penalizar a quien llega nuevo.
function ratings(stats) {
  const known = [];
  const byId = new Map();
  for (const p of stats) {
    if (p.played > 0) {
      const r = p.points / p.played + 0.5 * ((p.goals + p.assists) / Math.max(1, p.attended || p.played));
      byId.set(p.player_id, r);
      known.push(r);
    }
  }
  known.sort((a, b) => a - b);
  const median = known.length ? known[Math.floor(known.length / 2)] : 1;
  return (id) => (byId.has(id) ? byId.get(id) : median);
}

function teamCount(n) {
  if (n < MIN_PLAYERS) return 0;
  return n >= TRIANGULAR_FROM ? 3 : 2;
}

// Reparto en serpiente (1-2-3-3-2-1…) y después intercambios mientras reduzcan la diferencia
function balance(players, k) {
  const sorted = [...players].sort((a, b) => b.rating - a.rating || a.name.localeCompare(b.name));
  const teams = Array.from({ length: k }, () => []);
  sorted.forEach((p, i) => {
    const round = Math.floor(i / k);
    const pos = i % k;
    teams[round % 2 === 0 ? pos : k - 1 - pos].push(p);
  });
  const total = (t) => t.reduce((a, p) => a + p.rating, 0);
  const spread = () => { const s = teams.map(total); return Math.max(...s) - Math.min(...s); };
  for (let iter = 0; iter < 200; iter++) {
    let best = null;
    const current = spread();
    for (let a = 0; a < k; a++) for (let b = a + 1; b < k; b++) {
      for (let i = 0; i < teams[a].length; i++) for (let j = 0; j < teams[b].length; j++) {
        [teams[a][i], teams[b][j]] = [teams[b][j], teams[a][i]];
        const s = spread();
        if (s < current - 1e-9 && (!best || s < best.s)) best = { a, b, i, j, s };
        [teams[a][i], teams[b][j]] = [teams[b][j], teams[a][i]];
      }
    }
    if (!best) break;
    [teams[best.a][best.i], teams[best.b][best.j]] = [teams[best.b][best.j], teams[best.a][best.i]];
  }
  return teams;
}

// Calendario del triangular: rotación A-B, A-C, B-C… mientras quepa en la hora
function triangularSchedule(names) {
  const pairs = [[0, 1], [0, 2], [1, 2]];
  const n = Math.floor(TRAINING_MINUTES / TRIANGULAR_MATCH_MINUTES);
  return Array.from({ length: n }, (_, i) => {
    const [h, a] = pairs[i % 3];
    return { order: i + 1, home: names[h], away: names[a], minutes: TRIANGULAR_MATCH_MINUTES,
      start: `${String(i * TRIANGULAR_MATCH_MINUTES).padStart(2, '0')}'` };
  });
}

// entries: titulares de la lista ({player_id, name}); stats: seasonStats()
function propose(entries, stats) {
  const k = teamCount(entries.length);
  if (!k) return null;
  const rate = ratings(stats);
  const players = entries.map((e) => ({ player_id: e.player_id, name: e.name, rating: Math.round(rate(e.player_id) * 100) / 100 }));
  const teams = balance(players, k).map((members, i) => ({
    ...TEAM_STYLES[i],
    players: members.sort((a, b) => a.name.localeCompare(b.name)),
    rating: Math.round(members.reduce((a, p) => a + p.rating, 0) * 10) / 10,
  }));
  const levels = teams.map((t) => t.rating);
  return {
    // Diferencia de nivel entre el equipo más fuerte y el más flojo (cuanto más baja, más parejo)
    spread: Math.round((Math.max(...levels) - Math.min(...levels)) * 10) / 10,
    format: k === 3 ? 'triangular' : 'partido',
    description: k === 3
      ? `Triangular de 3 equipos · partidos de ${TRIANGULAR_MATCH_MINUTES} minutos`
      : `Partido ${teams[0].players.length} contra ${teams[1].players.length} · ${TRAINING_MINUTES} minutos`,
    teams,
    schedule: k === 3 ? triangularSchedule(teams.map((t) => t.name)) : [],
  };
}

module.exports = { propose, teamCount, balance, ratings, TRIANGULAR_FROM };
