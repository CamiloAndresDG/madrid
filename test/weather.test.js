const { test } = require('node:test');
const assert = require('node:assert');
const W = require('../src/weather');

const hourly = (code, prob, mm) => ({ hourly: {
  time: ['2026-10-21T21:00', '2026-10-21T22:00'],
  temperature_2m: [15.2, 14.6], precipitation_probability: [10, prob], precipitation: [0, mm],
  weather_code: [1, code], wind_speed_10m: [8, 12],
} });

test('previsión a la hora del entreno', () => {
  const w = W.pick(hourly(2, 10, 0), '2026-10-21', '22:00');
  assert.strictEqual(w.label, 'Nubes y claros');
  assert.strictEqual(w.temp, 15);
  assert.strictEqual(w.rain, false);
  assert.strictEqual(w.joke, null);
});

test('si llueve, toca ropa blanca', () => {
  const w = W.pick(hourly(61, 80, 1.2), '2026-10-21', '22:00');
  assert.strictEqual(w.rain, true);
  assert.match(w.joke, /ropa blanca/);
  assert.strictEqual(W.pick(hourly(3, 60, 0), '2026-10-21', '22:00').rain, true); // alta probabilidad aunque esté nublado
});

test('sin datos para esa hora: no hay previsión', () => {
  assert.strictEqual(W.pick(hourly(0, 0, 0), '2026-10-21', '23:00'), null);
  assert.strictEqual(W.pick({}, '2026-10-21', '22:00'), null);
});
