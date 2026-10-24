const { test } = require('node:test');
const assert = require('node:assert');
const R = require('../src/roster');

const P = [
  { id: 1, name: 'Camilo Díaz', first_name: 'Camilo' }, { id: 2, name: 'Andrés López', first_name: 'Andrés' },
  { id: 3, name: 'Daniel Ruiz', first_name: 'Daniel' }, { id: 4, name: 'Daniel Gómez', first_name: 'Daniel' },
  { id: 5, name: 'Mario Sanz', first_name: 'Mario' },
];

test('limpia las líneas de WhatsApp: números, viñetas, negritas, emojis y comentarios', () => {
  assert.strictEqual(R.cleanLine('1. Camilo 🏳️‍🌈'), 'Camilo');
  assert.strictEqual(R.cleanLine('* Andrés'), 'Andrés');
  assert.strictEqual(R.cleanLine('*Daniel G.*'), 'Daniel G');
  assert.strictEqual(R.cleanLine('4) mario (portero)'), 'mario');
  assert.strictEqual(R.cleanLine('12 - Camilo - llego 21:50'), 'Camilo');
  assert.strictEqual(R.cleanLine('Entreno miércoles 22h:'), null);
  assert.strictEqual(R.cleanLine('   '), null);
});

test('reconoce a cada persona y marca dudas, repetidos y gente sin ficha', () => {
  const lines = R.preview('1. Camilo\n2. Andres\n3. Daniel G.\n4. Daniel\n5. Pepe Nuevo\n6. Camilo', P);
  assert.deepStrictEqual(lines.map((l) => [l.status, l.player_id]), [
    ['match', 1], ['match', 2], ['match', 4], ['ambiguous', null], ['new', null], ['duplicate', 1],
  ]);
  assert.deepStrictEqual(lines[3].options.map((o) => o.id).sort(), [3, 4]);
  assert.strictEqual(R.titleCase('pepe nuevo'), 'Pepe Nuevo');
});
