const { test } = require('node:test');
const assert = require('node:assert');
const T = require('../src/teams');

const entries = (n) => Array.from({ length: n }, (_, i) => ({ player_id: i + 1, name: `J${String(i + 1).padStart(2, '0')}` }));
// Estadísticas variadas: los primeros jugadores puntúan mucho más
const stats = (n) => entries(n).map((e, i) => ({
  player_id: e.player_id, played: 4, points: Math.max(0, 12 - i), goals: Math.max(0, 6 - i), assists: 1, attended: 4,
}));

test('con 16 apuntados: partido de 2 equipos de 8', () => {
  const p = T.propose(entries(16), stats(16));
  assert.strictEqual(p.format, 'partido');
  assert.deepStrictEqual(p.teams.map((t) => t.players.length), [8, 8]);
  assert.strictEqual(p.schedule.length, 0);
});

test('con 21 apuntados: triangular de 3 equipos de 7 y partidos de 8 minutos en la hora', () => {
  const p = T.propose(entries(21), stats(21));
  assert.strictEqual(p.format, 'triangular');
  assert.deepStrictEqual(p.teams.map((t) => t.players.length), [7, 7, 7]);
  assert.strictEqual(p.schedule.length, 7);                      // 7 × 8 min = 56 min
  assert.ok(p.schedule.every((m) => m.minutes === 8 && m.home !== m.away));
});

test('los equipos quedan equilibrados y nadie se repite', () => {
  for (const n of [10, 16, 18, 21]) {
    const p = T.propose(entries(n), stats(n));
    const ids = p.teams.flatMap((t) => t.players.map((x) => x.player_id));
    assert.strictEqual(new Set(ids).size, n);
    const totals = p.teams.map((t) => t.rating);
    assert.ok(Math.max(...totals) - Math.min(...totals) <= 1.5, `diferencia ${totals} con ${n}`);
  }
});

test('menos de 4 apuntados: aún no hay equipos; recién llegados valen la mediana', () => {
  assert.strictEqual(T.propose(entries(3), stats(3)), null);
  const rate = T.ratings([{ player_id: 1, played: 2, points: 6, goals: 0, assists: 0, attended: 2 }]);
  assert.strictEqual(rate(99), rate(1));
});
