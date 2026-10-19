const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startLocalPg } = require('../scripts/local-pg');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f7-auth-'));
let pg, pool, A;

before(async () => {
  pg = await startLocalPg({ dir, port: 55000 + (process.pid % 1000), persistent: false });
  process.env.DATABASE_URL = pg.url;
  process.env.COORDINATOR_EMAIL = 'coord@example.com';
  const db = require('../src/db');
  pool = db.pool;
  await db.init();
  A = require('../src/auth');
});

after(async () => {
  await pool?.end();
  await pg?.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

const datos = (extra = {}) => ({
  first_name: 'Ana', last_name: 'García', phone: '600 123 456', email: 'Ana@Example.com', password: 'segura123', ...extra,
});

test('registro valida los datos', async () => {
  await assert.rejects(A.register(datos({ email: 'no-es-email' })), /email/);
  await assert.rejects(A.register(datos({ phone: '123' })), /teléfono/);
  await assert.rejects(A.register(datos({ password: 'corta' })), /8 caracteres/);
});

test('registro, entrada y sesión', async () => {
  const id = await A.register(datos());
  await assert.rejects(A.register(datos()), /Ya existe/);              // email único (sin distinguir mayúsculas)
  await assert.rejects(A.login('ana@example.com', 'otra-clave'), /incorrectos/);
  assert.strictEqual(await A.login('ANA@example.com', 'segura123'), id);

  const { token } = await A.createSession(id);
  const me = await A.sessionPlayer(token);
  assert.strictEqual(me.name, 'Ana García');
  assert.deepStrictEqual(me.roles, []);
  await A.deleteSession(token);
  assert.strictEqual(await A.sessionPlayer(token), null);
});

test('el email de COORDINATOR_EMAIL entra como coordinador y siempre queda uno', async () => {
  const coord = await A.register(datos({ email: 'coord@example.com', first_name: 'Coord' }));
  assert.deepStrictEqual(await A.rolesOf(coord), ['coordinador']);
  await assert.rejects(A.setRoles(coord, []), /al menos un coordinador/);

  const ana = (await A.sessionPlayer((await A.createSession(await A.login('ana@example.com', 'segura123'))).token)).id;
  await A.setRoles(ana, ['gestor', 'petos', 'inventado']);
  assert.deepStrictEqual(await A.rolesOf(ana), ['gestor', 'petos']);
  assert.ok(A.canManage(await A.rolesOf(ana)));
  await A.setRoles(ana, ['coordinador']);
  await A.setRoles(coord, ['balones']);                               // ya hay otro coordinador
  assert.deepStrictEqual(await A.rolesOf(coord), ['balones']);
});
