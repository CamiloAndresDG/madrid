const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startLocalPg } = require('../scripts/local-pg');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'f7-forum-'));
let pg, pool, db, tx, F;
const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

before(async () => {
  pg = await startLocalPg({ dir, port: 56000 + (process.pid % 1000), persistent: false });
  process.env.DATABASE_URL = pg.url;
  ({ db, tx, pool } = require('../src/db'));
  await require('../src/db').init();
  F = require('../src/forum');
});
after(async () => { await pool?.end(); await pg?.stop(); fs.rmSync(dir, { recursive: true, force: true }); });

test('las fotos se validan por su contenido, no por su nombre', () => {
  const [img] = F.decodeImages([{ data: PNG_1PX, width: 1, height: 1 }]);
  assert.strictEqual(img.mime, 'image/png');
  assert.throws(() => F.decodeImages([{ data: Buffer.from('<svg onload=alert(1)>').toString('base64') }]), /no es una imagen/);
  assert.throws(() => F.decodeImages([{ data: '' }]), /vacía/);
});

test('el título es obligatorio y la categoría tiene que existir', () => {
  assert.throws(() => F.cleanPost({ title: '   ' }), /título/);
  assert.throws(() => F.cleanPost({ title: 'Hola', category: 'spam' }), /Categoría/);
  assert.deepStrictEqual(F.cleanPost({ title: ' Fotos ', category: 'fotos', body: '' }), { title: 'Fotos', body: null, category: 'fotos' });
});

test('publicaciones con fotos: fijadas primero y borrado en cascada', async () => {
  const { id: author } = await db.get(`INSERT INTO players (name, email) VALUES ('Coord', 'c@test.local') RETURNING id`);
  const mk = async (title, pinned, at, images = []) => tx(async (c) => {
    const r = await c.get(`INSERT INTO posts (title, category, pinned, author_id, created_at) VALUES ($1, 'fotos', $2, $3, $4) RETURNING id`, [title, pinned, author, at]);
    await F.insertImages(c, r.id, F.decodeImages(images));
    return r.id;
  });
  const old = await mk('Anuncio fijado', 1, '2026-10-01T10:00:00Z');
  const recent = await mk('Fotos del miércoles', 0, '2026-10-15T10:00:00Z', [{ data: PNG_1PX, width: 1, height: 1 }, { data: PNG_1PX }]);
  const list = await F.list();
  assert.deepStrictEqual(list.map((x) => x.title), ['Anuncio fijado', 'Fotos del miércoles']);
  const withPhotos = list.find((x) => x.id === recent);
  assert.strictEqual(withPhotos.images.length, 2);
  assert.match(withPhotos.images[0].id, /^[a-f0-9]{32}$/);
  assert.strictEqual(withPhotos.author_name, 'Coord');
  await db.run('DELETE FROM posts WHERE id = $1', [recent]);
  assert.strictEqual((await db.get('SELECT COUNT(*)::int AS n FROM post_images')).n, 0);
  assert.ok(old);
});

test('el foro es solo para jugadores hasta que Coordinación lo abre al público', async () => {
  assert.strictEqual(await F.isPublic(), false);
  await F.setPublic(db, true);
  assert.strictEqual(await F.isPublic(), true);
  await F.setPublic(db, false);
  assert.strictEqual(await F.isPublic(), false);
  assert.strictEqual((await db.get(`SELECT COUNT(*)::int AS n FROM settings WHERE key = 'forum_public'`)).n, 1);
});
