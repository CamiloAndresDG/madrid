// Foro: noticias, anuncios y fotos post-entreno. Lo leen los jugadores (o cualquiera, si Coordinación lo abre al público); solo Coordinación publica.
const crypto = require('node:crypto');
const { db } = require('./db');

const CATEGORIES = { noticia: 'Noticia', anuncio: 'Anuncio', fotos: 'Fotos' };
const MAX_IMAGES = 10;
const MAX_IMAGE_BYTES = 3_000_000;

const fail = (status, message) => Object.assign(new Error(message), { status });

// Reconoce el formato por su contenido, no por lo que diga el cliente
function sniffMime(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// images: [{ data: base64 o dataURL, width, height }]
function decodeImages(images = []) {
  if (!Array.isArray(images)) throw fail(400, 'Formato de fotos no válido');
  return images.map((img, i) => {
    const raw = String(img?.data || '').replace(/^data:[^;]+;base64,/, '');
    const buf = Buffer.from(raw, 'base64');
    if (!buf.length) throw fail(400, `La foto ${i + 1} está vacía`);
    if (buf.length > MAX_IMAGE_BYTES) throw fail(400, `La foto ${i + 1} pesa demasiado (máximo 3 MB)`);
    const mime = sniffMime(buf);
    if (!mime) throw fail(400, `La foto ${i + 1} no es una imagen JPG, PNG o WebP`);
    const dim = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 && Number(v) < 20000 ? Number(v) : null);
    return { buf, mime, width: dim(img.width), height: dim(img.height) };
  });
}

function cleanPost(body, { partial = false } = {}) {
  const out = {};
  if (!partial || 'title' in body) {
    const title = String(body.title || '').trim();
    if (!title) throw fail(400, 'Escribe un título');
    if (title.length > 140) throw fail(400, 'El título es demasiado largo (máximo 140 caracteres)');
    out.title = title;
  }
  if (!partial || 'body' in body) {
    const text = String(body.body || '').trim();
    if (text.length > 10000) throw fail(400, 'El texto es demasiado largo (máximo 10.000 caracteres)');
    out.body = text || null;
  }
  if (!partial || 'category' in body) {
    const cat = body.category || 'noticia';
    if (!CATEGORIES[cat]) throw fail(400, 'Categoría no válida');
    out.category = cat;
  }
  if ('pinned' in body) out.pinned = body.pinned ? 1 : 0;
  if ('session_id' in body) out.session_id = body.session_id ? Number(body.session_id) : null;
  return out;
}

async function insertImages(c, postId, images, startAt = 0) {
  const now = new Date().toISOString();
  for (const [i, img] of images.entries()) {
    await c.run(`INSERT INTO post_images (id, post_id, position, mime, width, height, bytes, data, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [crypto.randomBytes(16).toString('hex'), postId, startAt + i, img.mime, img.width, img.height, img.buf.length, img.buf, now]);
  }
}

// Ajuste de Coordinación: ¿el foro lo puede leer quien no tiene cuenta? Por defecto, no (solo jugadores)
async function isPublic(runner = db) {
  const row = await runner.get(`SELECT value FROM settings WHERE key = 'forum_public'`);
  return row?.value === '1';
}

async function setPublic(runner, on) {
  await runner.run(`INSERT INTO settings (key, value) VALUES ('forum_public', $1)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [on ? '1' : '0']);
}

async function list({ category = null, limit = 30, before = null } = {}) {
  const params = [];
  const where = [];
  if (category && CATEGORIES[category]) { params.push(category); where.push(`p.category = $${params.length}`); }
  if (before) { params.push(before); where.push(`p.created_at < $${params.length}`); }
  params.push(Math.min(Math.max(Number(limit) || 30, 1), 100));
  const posts = await db.all(`SELECT p.id, p.title, p.body, p.category, p.pinned, p.created_at, p.updated_at, p.session_id,
      a.name AS author_name, s.date AS session_date
    FROM posts p LEFT JOIN players a ON a.id = p.author_id LEFT JOIN sessions s ON s.id = p.session_id
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${before ? '' : 'p.pinned DESC, '}p.created_at DESC LIMIT $${params.length}`, params);
  if (!posts.length) return [];
  const imgs = await db.all(`SELECT id, post_id, width, height FROM post_images WHERE post_id = ANY($1::int[]) ORDER BY position, created_at`,
    [posts.map((p) => p.id)]);
  for (const p of posts) {
    p.pinned = !!p.pinned;
    p.images = imgs.filter((i) => i.post_id === p.id).map(({ id, width, height }) => ({ id, width, height }));
  }
  return posts;
}

module.exports = { CATEGORIES, MAX_IMAGES, decodeImages, cleanPost, insertImages, list, isPublic, setPublic, fail };
