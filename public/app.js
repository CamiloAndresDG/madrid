'use strict';

// ---------- Estado y utilidades ----------

const S = {
  token: localStorage.getItem('f7_token') || '',   // sesión de la cuenta (ver /api/auth/*)
  me: null,                                        // datos de /api/me (jugador, roles)
  adminSessionId: Number(sessionStorage.getItem('f7_admin_session')) || null,
  res: null,       // editor de resultados
  att: null,       // editor de asistencia
  sort: { key: 'points', dir: -1 },
};

const $app = document.getElementById('app');
const $nav = document.getElementById('nav');
const $dialog = document.getElementById('dialog');

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (S.token) headers.Authorization = `Bearer ${S.token}`;
  let res;
  try {
    res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    throw new Error(navigator.onLine === false ? 'No tienes conexión. Revisa tu internet y vuelve a intentarlo.' : 'No se ha podido contactar con el servidor. Vuelve a intentarlo en un momento.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status >= 500) throw new Error('Algo ha fallado en el servidor. Vuelve a intentarlo en un momento.');
  if (res.status === 401 && S.token && !path.startsWith('/api/auth/')) {
    forgetSession();
  }
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, isError ? 5000 : 2800);
}

const TZ = 'Europe/Madrid';
function fmtDate(dateStr, opts = { weekday: 'long', day: 'numeric', month: 'long' }) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const out = new Intl.DateTimeFormat('es-ES', { ...opts, timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d)));
  return out.charAt(0).toUpperCase() + out.slice(1);
}
function fmtShort(dateStr) { return fmtDate(dateStr, { weekday: 'short', day: 'numeric', month: 'short' }); }
function fmtDateTime(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('es-ES', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}
function fmtTime(iso) {
  if (!iso) return '';
  return new Intl.DateTimeFormat('es-ES', { timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(iso));
}

// Iconos SVG del sprite de index.html (un único trazo)
const icon = (name, label = '') => `<svg class="icon"${label ? ` role="img" aria-label="${esc(label)}"` : ' aria-hidden="true"'}><use href="#i-${name}"/></svg>`;
// Números con formato español (13,7) y plurales
const nf = (v, digits = 0) => Number(v || 0).toLocaleString('es-ES', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const plural = (n, one, many) => `${nf(n)} ${n === 1 ? one : many}`;

// Diálogo de confirmación propio (sustituye a confirm()): resuelve true/false
function confirmDialog({ title, body = '', confirm = 'Confirmar', danger = false }) {
  return new Promise((resolve) => {
    $dialog.innerHTML = `<form method="dialog">
      <h2>${esc(title)}</h2>${body ? `<p class="muted">${body}</p>` : ''}
      <div class="dialog-actions"><button value="cancel" class="btn-ghost">Volver</button>
      <button value="ok" class="${danger ? 'btn-danger-solid' : 'btn-primary'}">${esc(confirm)}</button></div></form>`;
    $dialog.onclose = () => resolve($dialog.returnValue === 'ok');
    $dialog.showModal();
  });
}
// Diálogo con un campo de texto (sustituye a prompt()): resuelve el texto o null
function textDialog({ title, label, value = '', confirm = 'Guardar' }) {
  return new Promise((resolve) => {
    $dialog.innerHTML = `<form method="dialog" class="stack">
      <h2>${esc(title)}</h2>
      <label class="field">${esc(label)}<textarea id="dlgText">${esc(value)}</textarea></label>
      <div class="dialog-actions"><button value="cancel" class="btn-ghost">Volver</button>
      <button value="ok" class="btn-primary">${esc(confirm)}</button></div></form>`;
    $dialog.onclose = () => resolve($dialog.returnValue === 'ok' ? document.getElementById('dlgText').value : null);
    $dialog.showModal();
  });
}

const prioBadge = (p) => `<span class="prio prio-${p}" title="Prioridad ${p}">P${p}</span>`;
const PRIO_LEGEND = `<div class="prio-legend" aria-label="Prioridades">
  <span>${prioBadge(1)} No vino la semana pasada</span>
  <span>${prioBadge(2)} Sí vino</span>
  <span>${prioBadge(3)} Sanción</span></div>`;

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copiado al portapapeles'); }
  catch { await textDialog({ title: 'Copia el texto', label: 'Selecciónalo y cópialo', value: text, confirm: 'Hecho' }); }
}

async function loadRules() {
  if (!S.rules) S.rules = await api('/api/rules');
  return S.rules;
}

// ---------- Router ----------

const routes = [
  [/^#\/?$/, viewHome],
  [/^#\/clasificacion(?:\/(yo))?$/, viewStats],
  [/^#\/resultados$/, viewResultsList],
  [/^#\/resultados\/(\d+)$/, viewResultsDetail],
  [/^#\/normas$/, viewRules],
  [/^#\/foro$/, viewForum],
  [/^#\/foro\/nueva$/, () => viewPostEditor(null)],
  [/^#\/foro\/editar\/(\d+)$/, (id) => viewPostEditor(Number(id))],
  [/^#\/admin(?:\/(\w+))?$/, viewAdmin],
  [/^#\/entrar$/, viewLogin],
  [/^#\/registro$/, viewRegister],
  [/^#\/salir$/, () => actions.logout()],
  [/^#\/cuenta$/, viewAccount],
];

function renderNav() {
  const h = location.hash || '#/';
  const items = [];
  if (S.token) {
    items.push(['#/foro', 'Foro', 'megaphone'], ['#/', 'Convocatoria', 'calendar'], ['#/resultados', 'Resultados', 'trophy']);
  }
  items.push(['#/normas', 'Normas', 'book']);
  if (S.token && canManage()) items.push(['#/admin', 'Coordinación', 'shield']);
  if (!S.token) items.unshift(['#/', 'Inicio', 'calendar']);
  $nav.innerHTML = items.map(([href, label, ic]) => {
    // Resultados incluye la clasificación, así que también se ilumina en esas páginas
    const active = href === '#/' ? (h === '#/' || h === '#')
      : href === '#/resultados' ? (h.startsWith('#/resultados') || h.startsWith('#/clasificacion'))
        : h.startsWith(href);
    return `<a href="${href}"${active ? ' aria-current="page"' : ''}>${icon(ic)}<span>${label}</span></a>`;
  }).join('');
  renderAccount();
}

// ---------- Menú de cuenta (arriba a la derecha) ----------
const $accountBtn = document.getElementById('accountBtn');
const $accountMenu = document.getElementById('accountMenu');

function renderAccount() {
  const pl = S.me?.player;
  const initials = $accountBtn.querySelector('.account-initials');
  if (S.token && pl) {
    initials.textContent = pl.name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
    initials.hidden = false;
    $accountBtn.setAttribute('aria-label', `Cuenta de ${pl.name}`);
    $accountMenu.innerHTML = `<div class="account-head"><strong>${esc(pl.name)}</strong><span>${esc(pl.email || '')}</span></div>
      <a href="#/cuenta" role="menuitem">${icon('user')} Mi cuenta</a>
      <a href="#/clasificacion/yo" role="menuitem">${icon('chart')} Mi temporada</a>
      <hr>
      <a href="#/salir" role="menuitem" class="danger">${icon('logout')} Cerrar sesión</a>`;
  } else {
    initials.hidden = true;
    $accountBtn.setAttribute('aria-label', 'Cuenta');
    $accountMenu.innerHTML = S.token
      ? `<a href="#/cuenta" role="menuitem">${icon('user')} Mi cuenta</a><a href="#/salir" role="menuitem" class="danger">${icon('logout')} Cerrar sesión</a>`
      : `<div class="account-head"><strong>¿Juegas en la sección?</strong><span>Entra o crea tu cuenta para apuntarte.</span></div>
        <a href="#/entrar" role="menuitem">${icon('user')} Entrar</a>
        <a href="#/registro" role="menuitem">${icon('plus')} Crear cuenta</a>`;
  }
}
function setAccountMenu(open) {
  $accountMenu.hidden = !open;
  $accountBtn.setAttribute('aria-expanded', String(open));
  if (open) $accountMenu.querySelector('[role="menuitem"]')?.focus();
}
$accountBtn.addEventListener('click', (e) => { e.stopPropagation(); setAccountMenu($accountMenu.hidden); });
document.addEventListener('click', (e) => { if (!$accountMenu.hidden && !e.target.closest('.account')) setAccountMenu(false); });
$accountMenu.addEventListener('click', (e) => { if (e.target.closest('a')) setAccountMenu(false); });
document.addEventListener('keydown', (e) => {
  if ($accountMenu.hidden) return;
  const items = [...$accountMenu.querySelectorAll('[role="menuitem"]')];
  const i = items.indexOf(document.activeElement);
  if (e.key === 'Escape') { setAccountMenu(false); $accountBtn.focus(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
});
window.addEventListener('hashchange', () => setAccountMenu(false));

const SKELETON = `<div class="skeleton" aria-hidden="true"><i style="width:40%;height:1.6rem"></i><i class="big"></i><i class="mid"></i><i class="mid"></i></div>`;
let lastRoute = null;
let renderSeq = 0;

async function render() {
  renderNav();
  const h = location.hash || '#/';
  const route = h.replace(/\/(yo)$/, '');
  const changedRoute = route !== lastRoute;
  lastRoute = route;
  const seq = ++renderSeq;
  // Si la sección tarda, se muestran siluetas en lugar de dejar la anterior congelada
  const skel = changedRoute ? setTimeout(() => { if (seq === renderSeq) { $app.innerHTML = SKELETON; $app.setAttribute('aria-busy', 'true'); } }, 180) : null;
  for (const [re, fn] of routes) {
    const m = h.match(re);
    if (m) {
      try { await fn(...m.slice(1)); }
      catch (e) {
        if (seq !== renderSeq) return;
        $app.innerHTML = `<div class="card empty load-error" role="alert">${icon('alert')}<h2>No se ha podido cargar</h2>
          <p class="muted">${esc(e.message)}</p><button class="btn-primary" data-act="retry">Reintentar</button></div>`;
      } finally {
        clearTimeout(skel);
        $app.removeAttribute('aria-busy');
      }
      if (changedRoute && seq === renderSeq) {
        $app.classList.remove('view-enter'); void $app.offsetWidth; $app.classList.add('view-enter');
        if (!S.keepScroll) window.scrollTo({ top: 0 });
      }
      S.keepScroll = false;
      renderAccount();
      return;
    }
  }
  location.hash = '#/';
}
window.addEventListener('offline', () => toast('Sin conexión: los cambios no se guardarán hasta que vuelva', true));
window.addEventListener('online', () => { toast('Conexión recuperada'); render(); });
// ---------- Versión nueva desplegada ----------
// La web no se recarga al cambiar de sección, así que una pestaña abierta seguiría con la versión vieja.
// Se consulta la versión al volver a la pestaña y cada pocos minutos: al cambiar de sección se recarga sola
// y, mientras tanto, se ofrece «Actualizar».
const BOOT_V = (document.querySelector('script[src*="app.js"]')?.getAttribute('src') || '').split('v=')[1] || '';
let newVersion = false;
async function checkVersion() {
  if (!BOOT_V || newVersion || document.hidden) return;
  try {
    const { v } = await fetch('/api/version', { cache: 'no-store' }).then((r) => r.json());
    if (v && v !== BOOT_V) {
      newVersion = true;
      const bar = document.createElement('div');
      bar.className = 'update-bar'; bar.setAttribute('role', 'status');
      bar.innerHTML = `<span>Hay una versión nueva de la web.</span><button class="btn-primary btn-sm" type="button">Actualizar</button>`;
      bar.querySelector('button').addEventListener('click', () => location.reload());
      document.body.appendChild(bar);
    }
  } catch (e) { /* sin conexión: se vuelve a intentar más tarde */ }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkVersion(); });
window.addEventListener('focus', checkVersion);
setInterval(checkVersion, 3 * 60 * 1000);

window.addEventListener('hashchange', () => {
  if (newVersion) { location.reload(); return; } // al cambiar de sección, se carga la versión nueva
  render();
});

// Delegación de eventos: data-act="nombre" -> actions.nombre(el, event)
const actions = {};
actions.retry = () => render();
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.act];
  if (!fn) return;
  e.preventDefault();
  const isButton = el.tagName === 'BUTTON';
  if (isButton) { el.disabled = true; el.setAttribute('aria-busy', 'true'); }
  Promise.resolve(fn(el, e))
    .catch((err) => toast(err.message, true))
    .finally(() => { if (isButton && el.isConnected) { el.disabled = false; el.removeAttribute('aria-busy'); } });
});
// Formularios: el botón de enviar muestra que está trabajando y no se envía dos veces
async function withBusy(form, work) {
  const btn = form.querySelector('[type="submit"]');
  if (btn?.getAttribute('aria-busy') === 'true') return;
  btn?.setAttribute('aria-busy', 'true'); if (btn) btn.disabled = true;
  try { await work(); } finally { if (btn?.isConnected) { btn.removeAttribute('aria-busy'); btn.disabled = false; } }
}
document.addEventListener('change', (e) => {
  const el = e.target.closest('[data-change]');
  if (!el) return;
  const fn = actions[el.dataset.change];
  if (fn) Promise.resolve(fn(el, e)).catch((err) => toast(err.message, true));
});
document.addEventListener('input', (e) => {
  const el = e.target.closest('[data-input]');
  if (el && actions[el.dataset.input]) actions[el.dataset.input](el, e);
});

// ---------- Jugador: convocatoria ----------

async function viewHome() {
  if (!S.token) {
    $app.innerHTML = `<div class="page-head"><h1>Fútbol 7 · Gmadrid</h1></div>
      <div class="card empty">
        <h2>Apúntate a los entrenamientos de los miércoles</h2>
        <p class="muted">Con tu cuenta confirmas si vienes, ves quién va y en qué equipo juegas.</p>
        <div class="row" style="margin-top:1rem">
          <a class="btn btn-primary" href="#/registro">Crear cuenta</a>
          <a class="btn" href="#/entrar">Ya tengo cuenta</a></div></div>`;
    return;
  }
  let me;
  try { me = await api('/api/me'); }
  catch (e) {
    $app.innerHTML = `<div class="card empty"><h2>Tu sesión ha caducado</h2><p class="muted">Vuelve a entrar para seguir.</p>
      <a class="btn btn-primary" href="#/entrar">Entrar</a></div>`;
    return;
  }
  S.me = me;
  const s = me.session;
  let html = '';

  if (me.expelled) {
    html += `<div class="status-box danger">${icon('alert')}<div><strong>Tienes dos faltas graves esta temporada</strong>
      Según las normas de la sección quedas fuera del equipo. Habla con Coordinación.</div></div>`;
  }

  if (!s) {
    html += `<div class="page-head"><h1>Convocatoria</h1></div>
      <div class="card empty"><h2>Todavía no hay convocatoria</h2>
      <p class="muted">Aparecerá aquí en cuanto Coordinación la publique. Normalmente, el domingo por la tarde.</p></div>`;
    $app.innerHTML = html;
    return;
  }

  const sess = s.session;
  const total = s.titulares.length + s.reservas.length;
  const mine = s.my_entry;
  const ahead = mine && mine.role === 'reserva' ? mine.position - sess.capacity - 1 : 0;
  let status;
  if (sess.cancelled) {
    status = { cls: 'is-cancel', ic: 'x', title: 'Entrenamiento cancelado', text: 'Este miércoles no hay entreno.' };
  } else if (mine && mine.role === 'titular') {
    status = { cls: 'is-in', ic: 'check', title: `Estás dentro · puesto ${mine.position} de ${sess.capacity}`, text: `${mine.reason}.` };
  } else if (mine) {
    status = { cls: 'is-wait', ic: 'wait', title: ahead > 0 ? `Reserva · ${plural(ahead, 'persona', 'personas')} por delante` : 'Reserva · eres la siguiente persona en entrar',
      text: 'Si alguien se borra, entras automáticamente.' };
  } else if (s.my_response === 'no') {
    status = { cls: 'is-out', ic: 'x', title: 'Has dicho que no vienes', text: 'Si cambias de idea, apúntate: entrarás según tu prioridad y la hora.' };
  } else if (!sess.is_open && !sess.has_started) {
    status = { cls: '', ic: 'lock', title: 'Inscripciones cerradas por ahora', text: `Se abren el ${fmtDateTime(sess.opens_at)}.` };
  } else {
    status = { cls: '', ic: 'calendar', title: '¿Vienes este miércoles?', text: `Quedan ${plural(Math.max(0, sess.capacity - s.titulares.length), 'plaza', 'plazas')} de ${sess.capacity}.` };
  }

  const canYes = sess.is_open && !mine && !me.expelled;
  const canNo = !sess.has_started && !sess.cancelled && s.my_response !== 'no';
  const myKit = (s.equipment || []).filter((e) => e.holder_id === me.player.id);
  const actionsHtml = canYes
    ? `<button class="btn btn-primary btn-big" data-act="answerYes" data-id="${sess.id}">Voy</button>
       ${canNo ? `<button class="btn btn-quiet btn-big" data-act="answerNo" data-id="${sess.id}">No puedo ir</button>` : ''}`
    : (canNo ? `<button class="btn btn-quiet" data-act="answerNo" data-id="${sess.id}">${mine ? 'Borrarme' : 'No puedo ir'}</button>` : '');

  const joined = S.justJoined; S.justJoined = false;
  if (!introDone()) {
    html += `<section class="card welcome" aria-labelledby="welcomeTitle">
      <h2 id="welcomeTitle">Así funciona</h2>
      <ul>
        <li>${icon('calendar')}<span><strong>Apúntate cada semana.</strong> La convocatoria se publica el domingo y te apuntas con «Voy».</span></li>
        <li>${icon('check')}<span><strong>La lista se hace sola.</strong> Entra primero quien no vino la semana anterior; después, por hora de inscripción.</span></li>
        <li>${icon('clock')}<span><strong>Si no puedes, bórrate a tiempo.</strong> Sin penalización hasta el martes a las 15:00.</span></li>
      </ul>
      <div class="row"><button class="btn-primary" data-act="dismissIntro">Entendido</button><a class="btn btn-ghost" href="#/normas">Ver todas las normas</a></div>
    </section>`;
  }
  html += `<section class="hero${joined ? ' just-joined' : ''}" aria-labelledby="heroDate">
    <h1 class="hero-date" id="heroDate">${esc(fmtDate(sess.date))}</h1>
    <div class="hero-meta">
      <span>${icon('clock')} ${esc(sess.start_time)} · llegada ${esc(sess.arrival_time || '21:45')}</span>
      <span>${icon('pin')} ${esc(sess.location)}</span>
    </div>
    ${sess.notes ? `<p class="hero-notes">${esc(sess.notes)}</p>` : ''}
    <div class="hero-status ${status.cls}" aria-live="polite">${icon(status.ic)}
      <div><strong>${esc(status.title)}</strong><p>${esc(status.text)}</p></div></div>
    ${actionsHtml ? `<div class="hero-actions">${actionsHtml}</div>` : ''}
    ${myKit.length ? `<div class="kit-line">${icon('bib')} Te toca llevar ${myKit.map((e) => esc(e.name.toLowerCase())).join(' y ')}.</div>` : ''}
    ${canNo && mine ? `<p class="hero-foot">Puedes borrarte sin penalización hasta el ${esc(fmtDateTime(sess.tuesday_deadline))}.</p>` : ''}
  </section>`;

  html += `<div class="card"><div class="row spread" style="margin-bottom:.5rem"><h2 style="margin:0">Quién va · ${total}</h2>
      <span class="chip">${sess.finalized_at ? 'Lista cerrada' : 'En directo'}</span></div>
    ${PRIO_LEGEND}
    ${renderList(s, me.player.id, { flashMe: joined })}</div>`;
  if (s.teams_proposal) html += teamsProposalHtml(s.teams_proposal, me.player.id);
  $app.innerHTML = html;
}

// Equipos provisionales: se recalculan con cada inscripción según las estadísticas
function teamsProposalHtml(tp, meId = null) {
  if (!tp) {
    return `<div class="card"><h2>Equipos</h2><p class="muted small">Se forman solos en cuanto haya 4 personas apuntadas:
      dos equipos hasta 17 y triangular de tres desde 18.</p></div>`;
  }
  return `<div class="card"><h2>Equipos</h2>
    <p class="small muted">${esc(tp.description)}. Se reequilibran con cada inscripción según las estadísticas de la temporada.</p>
    <div class="teams">${tp.teams.map((t) => `
      <div class="team"><h3><span class="team-dot" style="background:${esc(t.color)}"></span>${esc(t.name)} <span class="muted small">${t.players.length}</span></h3>
        <ul>${t.players.map((pl) => `<li${pl.player_id === meId ? ' class="me"' : ''}>${esc(pl.name)}${pl.player_id === meId ? ' (tú)' : ''}</li>`).join('')}</ul></div>`).join('')}</div>
    ${tp.schedule.length ? `<h3 style="margin-top:1.25rem">Orden de partidos</h3><ol class="schedule">${tp.schedule.map((m) => `
      <li><span class="muted">${esc(m.start)}</span><span>${esc(m.home)} – ${esc(m.away)}</span><span class="muted">${m.minutes} min</span></li>`).join('')}</ol>
      <p class="small muted" style="margin-top:.5rem">El equipo que descansa entra en el siguiente partido.</p>` : ''}</div>`;
}

// Registro de actividad: «Camilo asignó a Andrés los Petos amarillos · mié 21 oct, 23:05»
function activityList(rows) {
  if (!rows.length) return '<p class="muted small">Aún no hay cambios registrados.</p>';
  return `<ul class="list">${rows.map((a) => `<li style="align-items:flex-start">
    <span class="name"><strong>${esc(a.actor_name)}</strong> ${esc(a.summary)}
      <small>${esc(fmtDateTime(a.at))}${a.session_date ? ` · entreno del ${esc(fmtShort(a.session_date))}` : ''}</small></span></li>`).join('')}</ul>`;
}

function renderList(s, meId, { admin = false, flashMe = false } = {}) {
  const row = (e) => `<li class="${e.player_id === meId ? `me${flashMe ? ' flash' : ''}` : ''}">
    <span class="pos">${e.position}</span>${prioBadge(e.priority)}
    <span class="name">${esc(e.name)}${e.player_id === meId ? ' <span class="muted">(tú)</span>' : ''}${e.is_coordinator ? ' <span class="chip">Coordinación</span>' : ''}
      <small>${esc(e.reason)}${e.signed_up_at ? ` · ${esc(fmtTime(e.signed_up_at))}` : ''}${e.added_by_admin ? ' · añadido por coordinación' : ''}</small></span>
    ${admin ? `<button class="btn btn-ghost btn-icon" data-act="adminSetResponse" data-pid="${e.player_id}" data-answer="no" aria-label="Quitar a ${esc(e.name)} de la lista" title="Quitar de la lista">${icon('x')}</button>` : ''}
  </li>`;
  let html = `<div class="divider">Titulares</div>`;
  html += s.titulares.length ? `<ul class="list">${s.titulares.map(row).join('')}</ul>` : '<p class="muted small">Aún no se ha apuntado nadie. Las primeras plazas son para quien no vino la semana pasada.</p>';
  if (s.reservas.length) html += `<div class="divider">Reservas</div><ul class="list">${s.reservas.map(row).join('')}</ul>`;
  if (s.no_van.length) {
    html += `<div class="divider">No van · ${s.no_van.length}</div><p class="small muted">${s.no_van.map((n) => esc(n.name)).join(', ')}</p>`;
  }
  return html;
}

function infStatusChip(status) {
  return status === 'pending' ? '<span class="chip warn">Pendiente de revisar</span>'
    : status === 'justified' ? '<span class="chip ok">Justificada</span>'
      : '<span class="chip danger">Confirmada</span>';
}

// Bienvenida: se muestra una sola vez por navegador
function introDone() { try { return localStorage.getItem('f7_intro_done') === '1'; } catch (e) { return true; } }
actions.dismissIntro = () => {
  try { localStorage.setItem('f7_intro_done', '1'); } catch (e) { /* sin almacenamiento */ }
  document.querySelector('.welcome')?.remove();
};

// Cierra la sesión en este navegador (y en el servidor si se puede)
function forgetSession() {
  S.token = ''; S.me = null;
  try { localStorage.removeItem('f7_token'); } catch (e) { /* sin almacenamiento */ }
}
function canManage() { return !!(S.me && S.me.player && S.me.player.can_manage); }
actions.logout = async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) { /* ya cerrada */ }
  forgetSession(); toast('Sesión cerrada'); location.hash = '#/';
};

actions.answerYes = async (el) => {
  el.disabled = true;
  await api(`/api/sessions/${el.dataset.id}/response`, { method: 'PUT', body: { answer: 'yes' } });
  S.justJoined = true; S.keepScroll = true;
  toast('¡Dentro! Te esperamos el miércoles');
  await render();
};

actions.answerNo = async (el) => {
  const me = await api('/api/me');
  const s = me.session;
  const sess = s.session;
  const now = new Date();
  let warning = '';
  if (s.my_entry) {
    if (now > new Date(sess.wednesday_deadline)) {
      warning = 'Te borras después de las 15h del miércoles. Si no hay motivo justificado supone <strong>2 semanas en prioridad 3</strong> y cuenta como <strong>falta grave</strong> (dos en la temporada = fuera del equipo).';
    } else if (now > new Date(sess.tuesday_deadline)) {
      warning = 'Te borras después de las 15h del martes. Si no hay motivo justificado tendrás <strong>prioridad 3</strong> la próxima semana.';
    }
    if (sess.finalized_at) {
      warning += `${warning ? '<br><br>' : ''}La lista final ya está publicada: <strong>avisa a Coordinación</strong> al borrarte
        (si no, ${s.my_entry.role === 'titular' ? '2 semanas' : '1 semana'} en prioridad 3).`;
    }
  }
  $dialog.innerHTML = `<form method="dialog" class="stack">
    <h2>¿No puedes ir el ${esc(fmtDate(sess.date).toLowerCase())}?</h2>
    ${warning ? `<div class="status-box warn small">${icon('alert')}<div>${warning}</div></div>` : ''}
    <label class="field">Motivo (opcional)<textarea id="cancelReason" placeholder="Lesión, trabajo, viaje…"></textarea></label>
    <p class="small muted" style="margin:0">Si hay un motivo justificado, cuéntalo aquí: Coordinación lo revisa antes de aplicar nada.</p>
    ${s.my_entry && sess.finalized_at ? '<label><input type="checkbox" id="cancelNotified"> He avisado a Coordinación</label>' : ''}
    <div class="dialog-actions">
      <button value="cancel" class="btn-ghost">Volver</button>
      <button value="ok" class="btn-danger" id="confirmNo">${s.my_entry ? 'Borrarme' : 'No puedo ir'}</button>
    </div></form>`;
  $dialog.showModal();
  $dialog.onclose = async () => {
    if ($dialog.returnValue !== 'ok') return;
    const body = {
      answer: 'no',
      reason: document.getElementById('cancelReason')?.value || '',
      notified: document.getElementById('cancelNotified')?.checked || false,
    };
    try {
      const r = await api(`/api/sessions/${sess.id}/response`, { method: 'PUT', body });
      toast(r.infraction ? `Anotado. Coordinación revisará: ${r.infraction.label.toLowerCase()}` : 'Anotado: no vienes este miércoles', !!r.infraction);
    } catch (e) { toast(e.message, true); }
    render();
  };
};

// ---------- Clasificación: panel general y personal ----------

const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const shortDate = (d) => fmtDate(d, { day: 'numeric', month: 'short' });
const STATUS_TEXT = {
  attended: 'Asistió', late: 'Llegó tarde', no_show: 'No se presentó', excused: 'Justificada', left_out: 'Fuera (lista llena)',
};

async function viewStats(sub) {
  if (!S.token) return viewHome();
  const [stats, dash] = await Promise.all([api('/api/stats'), api('/api/dashboard')]);
  S.statsData = stats;
  S.dash = dash;
  S.statsSub = sub === 'yo' ? 'yo' : 'general';
  renderDashboard();
}

function renderDashboard() {
  const sub = S.statsSub;
  $app.innerHTML = `${resultsTabs('clasificacion')}<div class="page-head"><h1>Clasificación</h1></div>
    <nav class="seg-tabs" aria-label="Vista">
      <a href="#/clasificacion"${sub === 'general' ? ' aria-current="page"' : ''}>General</a>
      <a href="#/clasificacion/yo"${sub === 'yo' ? ' aria-current="page"' : ''}>Mi temporada</a>
    </nav>
    <div id="dashBody"></div>`;
  const body = document.getElementById('dashBody');
  if (sub === 'yo') renderPersonal(body); else renderGeneral(body);
}

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (location.hash.startsWith('#/clasificacion') && S.dash) renderDashboard(); }, 200);
});

const statTile = (label, value, sub = '') =>
  `<div class="stat"><div class="stat-label">${esc(label)}</div><div class="stat-value">${esc(value)}</div>${sub ? `<div class="stat-sub">${esc(sub)}</div>` : ''}</div>`;

// Puesto: 1 + cuántas personas tienen más (los empates comparten puesto)
const rankIn = (players, key, value) => 1 + players.filter((p) => p[key] > value).length;

// Ranking con barras (top N); la persona que mira se resalta en su color
function barList(players, key, { top = 5, meId = null, unit = '' } = {}) {
  const sorted = players.filter((p) => p[key] > 0).sort((a, b) => b[key] - a[key] || a.name.localeCompare(b.name));
  if (!sorted.length) return '<p class="muted small">Todavía sin datos.</p>';
  const max = sorted[0][key];
  let rows = sorted.slice(0, top);
  const meIdx = sorted.findIndex((p) => p.player_id === meId);
  if (meIdx >= top) rows = [...rows, sorted[meIdx]];
  return `<ol class="barlist">${rows.map((p) => {
    const rank = rankIn(players, key, p[key]);
    return `<li class="${p.player_id === meId ? 'me' : ''}">
      <span class="rank">${rank}</span><span class="who">${esc(p.name)}${p.player_id === meId ? ' (tú)' : ''}</span>
      <span class="val">${nf(p[key])}${unit}</span>
      <span class="track"><span style="width:${pct(p[key], max)}%"></span></span></li>`;
  }).join('')}</ol>`;
}

function renderGeneral(body) {
  const data = S.statsData;
  const g = S.dash.group;
  const meId = S.me?.player?.id;
  const active = data.players.filter((p) => p.active);
  const sessions = g.sessions;
  const totalGoals = sessions.reduce((a, s) => a + s.goals, 0);
  const avgAtt = sessions.length ? sessions.reduce((a, s) => a + s.attended, 0) / sessions.length : 0;
  const avgCap = sessions.length ? sessions.reduce((a, s) => a + s.capacity, 0) / sessions.length : 0;
  const eligible = active.filter((p) => !p.attendance_exempt);
  const meeting = eligible.filter((p) => p.current_quarter_count >= data.min_per_quarter).length;
  const infTotal = g.infractions_by_type.reduce((a, r) => a + r.n, 0);

  body.innerHTML = `
  <div class="statstrip">
    ${statTile('Entrenos jugados', nf(sessions.length))}
    ${statTile('Asistencia media', avgAtt ? nf(avgAtt, 1) : '—', avgCap ? `${pct(avgAtt, avgCap)} % de las plazas` : '')}
    ${statTile('Goles', nf(totalGoals), sessions.length ? `${nf(totalGoals / sessions.length, 1)} por entreno` : '')}
    ${statTile('Cumplen el mínimo', `${meeting} de ${eligible.length}`, `${data.min_per_quarter} entrenos este trimestre`)}
    ${statTile('Incidencias', nf(infTotal), 'confirmadas')}
  </div>
  <div class="grid grid-2">
    <div class="card"><h2>Asistencia por entreno</h2><p class="small muted">Personas que jugaron cada miércoles; la línea marca las plazas.</p><div id="chAtt"></div></div>
    <div class="card"><h2>Goles por entreno</h2><p class="small muted">Suma de todos los partidos del día.</p><div id="chGoals"></div></div>
  </div>
  <div class="card"><h2>Líderes</h2>
    <div class="leaders">
      <div><h3>Puntos</h3>${barList(active, 'points', { meId })}</div>
      <div><h3>Goles</h3>${barList(active, 'goals', { meId })}</div>
      <div><h3>Asistencias de gol</h3>${barList(active, 'assists', { meId })}</div>
      <div><h3>Entrenos</h3>${barList(active, 'attended', { meId })}</div>
      <div><h3>MVP</h3>${barList(active, 'mvps', { meId })}</div>
      <div><h3>Paradas</h3>${barList(active, 'saves', { meId })}</div>
    </div></div>
  ${g.infractions_by_type.length ? `<div class="card"><h2>Incidencias por tipo</h2>
    <ol class="barlist wrap">${g.infractions_by_type.sort((a, b) => b.n - a.n).map((r) => `<li>
      <span class="rank"></span><span class="who">${esc(r.label)}</span><span class="val">${r.n}</span>
      <span class="track"><span style="width:${pct(r.n, Math.max(...g.infractions_by_type.map((x) => x.n)))}%"></span></span></li>`).join('')}</ol></div>` : ''}
  <div class="card"><h2>Clasificación completa</h2><div id="statsTable"></div></div>`;

  Charts.columns(document.getElementById('chAtt'), {
    data: sessions.map((s) => ({ x: shortDate(s.date), title: fmtDate(s.date), value: s.attended,
      detail: [s.late ? `${s.late} tarde` : '', s.no_show ? `${s.no_show} sin presentarse` : '', s.left_out ? `${s.left_out} fuera por lista llena` : ''].filter(Boolean) })),
    colorVar: '--chart-group', label: 'asistentes', format: (v) => nf(v),
    refValue: sessions.length ? sessions[sessions.length - 1].capacity : 0, refLabel: 'plazas',
  });
  Charts.columns(document.getElementById('chGoals'), {
    data: sessions.map((s) => ({ x: shortDate(s.date), title: fmtDate(s.date), value: s.goals,
      detail: [`${s.matches} partido${s.matches === 1 ? '' : 's'}`] })),
    colorVar: '--chart-group', label: 'goles', format: (v) => nf(v),
  });
  renderStatsTable();
}

function renderStatsTable() {
  const data = S.statsData;
  const meId = S.me?.player?.id;
  const cols = [
    ['name', 'Jugador', false], ['attended', 'Entrenos', true], ['current_quarter_count', 'Trim.', true],
    ['played', 'PJ', true], ['wins', 'G', true], ['draws', 'E', true], ['losses', 'P', true], ['points', 'Pts', true],
    ['goals', 'Goles', true], ['assists', 'Asist.', true], ['mvps', 'MVP', true], ['saves', 'Paradas', true],
  ];
  if (canManage()) cols.push(['infractions', 'Incid.', true]);
  const { key, dir } = S.sort;
  const rows = [...data.players].sort((a, b) => {
    const va = a[key], vb = b[key];
    if (typeof va === 'string') return dir * va.localeCompare(vb);
    return dir * (va - vb) || a.name.localeCompare(b.name);
  });
  document.getElementById('statsTable').innerHTML = `<div class="table-wrap"><table>
    <thead><tr>${cols.map(([k, l, n]) => `<th class="${n ? 'num' : ''}" data-act="sortStats" data-key="${k}" tabindex="0"
      aria-sort="${k === key ? (dir < 0 ? 'descending' : 'ascending') : 'none'}">${l}${k === key ? icon(dir < 0 ? 'sort-down' : 'sort-up') : ''}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((p) => `<tr class="${p.active ? '' : 'dim'}${p.player_id === meId ? ' me' : ''}">${cols.map(([k, , n]) => {
      let v = typeof p[k] === 'number' ? nf(p[k]) : esc(p[k]);
      if (k === 'name') v = `${esc(p.name)}${p.expelled ? ' <span class="chip danger">fuera</span>' : ''}`;
      if (k === 'current_quarter_count') {
        const low = !p.attendance_exempt && p[k] < data.min_per_quarter;
        v = p.attendance_exempt ? '<span class="chip">Exención</span>' : `<span class="chip ${low ? 'warn' : 'ok'}">${p[k]} de ${data.min_per_quarter}</span>`;
      }
      return `<td class="${n ? 'num' : ''}">${v}</td>`;
    }).join('')}</tr>`).join('')}</tbody></table></div>
    <p class="small muted" style="margin-top:.75rem">Puntos: 3 por partido ganado y 1 por empate con tu equipo. «Trim.» son los entrenos de este trimestre
    (mínimo ${data.min_per_quarter}; si te quedaste fuera por lista llena, cuenta a favor).</p>`;
}
document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches?.('th[data-act="sortStats"]')) { e.preventDefault(); actions.sortStats(e.target); }
});
actions.sortStats = (el) => {
  const k = el.dataset.key;
  S.sort = { key: k, dir: S.sort.key === k ? -S.sort.dir : (k === 'name' ? 1 : -1) };
  renderStatsTable();
};

function renderPersonal(body) {
  const data = S.statsData;
  const meId = S.me?.player?.id;
  const me = data.players.find((p) => p.player_id === meId);
  const d = S.dash.me;
  if (!me) { body.innerHTML = '<div class="card empty"><h2>Aún no hay datos de tu temporada</h2><p class="muted">Aparecerán después de tu primer entreno.</p></div>'; return; }
  const active = data.players.filter((p) => p.active);
  const rankOf = (key) => rankIn(active, key, me[key]);
  const held = S.dash.group.sessions.length;
  const played = d.history.filter((h) => h.team);
  const form = played.slice(-10).map((h) => {
    const r = h.wins > h.losses ? 'w' : h.wins < h.losses ? 'l' : 'd';
    const word = { w: 'Ganado', d: 'Empate', l: 'Perdido' }[r];
    return `<span class="${r}" title="${esc(fmtDate(h.date))}: ${word} (${h.wins}-${h.draws}-${h.losses})" aria-label="${esc(fmtShort(h.date))}: ${word}">${{ w: 'G', d: 'E', l: 'P' }[r]}</span>`;
  }).join('');
  const qMin = data.min_per_quarter;
  const qCount = me.current_quarter_count;
  const myInf = S.me?.infractions || [];

  body.innerHTML = `
  <div class="grid grid-2">
    <div class="card">
      <h2>Vas ${rankOf('points')}.º de ${active.length} con ${plural(me.points, 'punto', 'puntos')}</h2>
      <p class="muted">${plural(me.wins, 'victoria', 'victorias')}, ${plural(me.draws, 'empate', 'empates')} y ${plural(me.losses, 'derrota', 'derrotas')}.</p>
      ${form ? `<div class="stat-label" style="margin:.25rem 0 .35rem">Últimos entrenos (G ganado · E empate · P perdido)</div><div class="form-strip">${form}</div>` : ''}
    </div>
    <div class="card">
      <h2>Este trimestre</h2>
      ${me.attendance_exempt ? '<p class="muted">Tienes exención del mínimo de asistencia.</p>' : `
      <p><strong>${qCount}</strong> de ${qMin} entrenos mínimos</p>
      <div class="meter ${qCount >= qMin ? '' : 'warn'}" role="meter" aria-label="Entrenos del trimestre" aria-valuemin="0" aria-valuemax="${qMin}" aria-valuenow="${qCount}"><span style="width:${Math.min(100, pct(qCount, qMin))}%"></span></div>
      <p class="small muted" style="margin-top:.5rem">${qCount >= qMin ? 'Cumples el mínimo.' : `Te ${qMin - qCount === 1 ? 'falta 1' : `faltan ${qMin - qCount}`} para el mínimo.`} Si te quedas fuera por lista llena, cuenta a favor.</p>`}
      <p class="small" style="margin:.75rem 0 0">Racha: <strong>${plural(d.streak, 'entreno seguido', 'entrenos seguidos')}</strong> · mejor racha: ${nf(d.best_streak)}</p>
    </div>
  </div>
  <div class="statstrip">
    ${statTile('Entrenos', nf(me.attended), held ? `${pct(me.attended, held)} % de ${held}` : '')}
    ${statTile('Goles', nf(me.goals), `${rankOf('goals')}.º · ${nf(played.length ? me.goals / played.length : 0, 1)} por entreno`)}
    ${statTile('Asistencias', nf(me.assists), `${rankOf('assists')}.º`)}
    ${statTile('MVP', nf(me.mvps), `${rankOf('mvps')}.º`)}
    ${statTile('Victorias', me.played ? `${pct(me.wins, me.played)} %` : '—', plural(me.played, 'partido', 'partidos'))}
    ${statTile('Paradas', nf(me.saves))}
  </div>
  <div class="grid grid-2">
    <div class="card"><h2>Puntos acumulados</h2><p class="small muted">Tú frente a la media del grupo.</p><div id="chCum"></div></div>
    <div class="card"><h2>Tus goles por entreno</h2><div id="chMyGoals"></div></div>
  </div>
  <div class="card"><h2>Historial</h2>${d.history.length ? `<div class="table-wrap"><table>
    <thead><tr><th>Fecha</th><th>Estado</th><th>Equipo</th><th class="num">G-E-P</th><th class="num">Pts</th><th class="num">Goles</th><th class="num">Asist.</th><th class="num">Paradas</th><th></th></tr></thead>
    <tbody>${[...d.history].reverse().map((h) => `<tr>
      <td>${esc(shortDate(h.date))}</td>
      <td>${h.status ? esc(STATUS_TEXT[h.status] || h.status) : '<span class="muted">No apuntado</span>'}</td>
      <td>${h.team ? `<span class="team-dot" style="background:${esc(h.team.color || '#ccc')}"></span> ${esc(h.team.name)}` : '—'}</td>
      <td class="num">${h.team ? `${h.wins}-${h.draws}-${h.losses}` : '—'}</td>
      <td class="num">${h.points}</td><td class="num">${h.goals}</td><td class="num">${h.assists}</td><td class="num">${h.saves}</td>
      <td>${h.mvp ? `${icon('star')} MVP` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Aún no hay entrenos jugados.</p>'}</div>
  <div class="card"><h2>Mis incidencias</h2>${myInf.length ? `<ul class="list">${myInf.map((i) => `
    <li><span class="name">${esc(i.label)}<small>${esc(fmtShort(i.date))} · ${i.weeks === 2 ? '2 semanas en P3' : '1 semana en P3'}</small></span>
    ${infStatusChip(i.status)}</li>`).join('')}</ul>` : '<p class="muted small">Ninguna. Sigue así.</p>'}</div>`;

  Charts.line(document.getElementById('chCum'), {
    data: d.cumulative.map((c) => ({ x: shortDate(c.date), title: fmtDate(c.date), me: c.me, group: c.group })),
    series: [{ key: 'me', label: 'Tú', colorVar: '--chart-me' }, { key: 'group', label: 'Media del grupo', colorVar: '--chart-group' }],
    format: (v) => nf(v, Number.isInteger(v) ? 0 : 1),
  });
  Charts.columns(document.getElementById('chMyGoals'), {
    data: d.history.map((h) => ({ x: shortDate(h.date), title: fmtDate(h.date), value: h.goals,
      detail: [h.assists ? `${h.assists} asistencia${h.assists === 1 ? '' : 's'}` : '', h.mvp ? 'MVP' : ''].filter(Boolean) })),
    colorVar: '--chart-me', label: 'goles', format: (v) => nf(v),
  });
}

// ---------- Foro ----------

const POST_CATS = { noticia: 'Noticia', anuncio: 'Anuncio', fotos: 'Fotos' };
const POST_FILTERS = [['', 'Todo'], ['noticia', 'Noticias'], ['anuncio', 'Anuncios'], ['fotos', 'Fotos']];
const isCoordinator = () => !!(S.me && S.me.player && S.me.player.roles.includes('coordinador'));
const fmtWhen = (iso) => new Intl.DateTimeFormat('es-ES', { timeZone: TZ, day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

async function viewForum() {
  if (!S.token) return viewHome();
  if (!S.me) S.me = await api('/api/me');
  const filter = S.forumFilter || '';
  const posts = await api(`/api/posts?limit=40${filter ? `&category=${filter}` : ''}`);
  S.posts = new Map(posts.map((pst) => [pst.id, pst]));
  $app.innerHTML = `<div class="page-head"><h1>Foro</h1>
      ${isCoordinator() ? `<a class="btn btn-primary" href="#/foro/nueva">${icon('plus')} Nueva publicación</a>` : ''}</div>
    <nav class="seg-tabs forum-filters" aria-label="Filtrar publicaciones">${POST_FILTERS.map(([k, l]) =>
      `<a href="#/foro" data-act="forumFilter" data-cat="${k}"${k === filter ? ' aria-current="page"' : ''}>${l}</a>`).join('')}</nav>
    ${posts.length ? posts.map(postHtml).join('') : `<div class="card empty"><h2>${filter ? 'Nada por aquí todavía' : 'El foro está esperando su primera publicación'}</h2>
      <p class="muted">Aquí aparecerán las noticias de la sección, los anuncios y las fotos de después de los entrenos.</p>
      ${isCoordinator() ? `<a class="btn btn-primary" href="#/foro/nueva">${icon('plus')} Escribir la primera</a>` : ''}</div>`}`;
  // Fotos: aparecen con un fundido cuando terminan de cargar
  $app.querySelectorAll('img[data-loading]').forEach((img) => {
    if (img.complete) img.removeAttribute('data-loading');
    else img.addEventListener('load', () => img.removeAttribute('data-loading'), { once: true });
  });
}

function postHtml(pst) {
  const n = pst.images.length;
  const shown = pst.images.slice(0, 4);
  const long = (pst.body || '').length > 600;
  const gallery = n ? `<div class="gallery g-${n > 3 ? 'many' : n}">${shown.map((img, i) => `
    <button class="g-item" data-act="openImage" data-post="${pst.id}" data-i="${i}" aria-label="Ver foto ${i + 1} de ${n}">
      <img src="/api/images/${img.id}" alt="" loading="lazy" decoding="async" data-loading${img.width ? ` width="${img.width}" height="${img.height}"` : ''}>
      ${i === 3 && n > 4 ? `<span class="g-more">+${n - 4}</span>` : ''}</button>`).join('')}</div>` : '';
  return `<article class="card post${pst.pinned ? ' is-pinned' : ''}" aria-labelledby="post${pst.id}">
    <div class="post-meta"><span class="chip cat-${pst.category}">${POST_CATS[pst.category]}</span>
      ${pst.pinned ? `<span>${icon('pushpin')} Fijada</span>` : ''}<time datetime="${esc(pst.created_at)}">${esc(fmtWhen(pst.created_at))}</time></div>
    <h2 id="post${pst.id}">${esc(pst.title)}</h2>
    ${pst.body ? `<p class="post-body${long ? ' clamped' : ''}" id="body${pst.id}">${esc(pst.body)}</p>
      ${long ? `<button class="btn btn-ghost btn-sm" data-act="expandPost" data-id="${pst.id}" aria-controls="body${pst.id}">Leer más</button>` : ''}` : ''}
    ${gallery}
    <div class="post-foot"><span>Por ${esc(pst.author_name || 'Coordinación')}${pst.session_date ? ` · entreno del ${esc(fmtShort(pst.session_date))}` : ''}${pst.updated_at ? ' · editada' : ''}</span>
      ${isCoordinator() ? `<span class="row"><a class="btn btn-ghost btn-sm" href="#/foro/editar/${pst.id}">${icon('edit')} Editar</a>
        <button class="btn btn-ghost btn-sm" data-act="togglePin" data-id="${pst.id}">${icon('pushpin')} ${pst.pinned ? 'Desfijar' : 'Fijar'}</button>
        <button class="btn btn-ghost btn-icon" data-act="deletePost" data-id="${pst.id}" aria-label="Eliminar publicación">${icon('trash')}</button></span>` : ''}</div>
  </article>`;
}

actions.forumFilter = (el) => { S.forumFilter = el.dataset.cat; S.keepScroll = true; viewForum(); };
actions.expandPost = (el) => {
  document.getElementById(`body${el.dataset.id}`)?.classList.remove('clamped');
  el.remove();
};
actions.togglePin = async (el) => {
  const pst = S.posts.get(Number(el.dataset.id));
  await api(`/api/admin/posts/${pst.id}`, { method: 'PATCH', body: { pinned: !pst.pinned } });
  toast(pst.pinned ? 'Publicación desfijada' : 'Publicación fijada arriba'); S.keepScroll = true; await viewForum();
};
actions.deletePost = async (el) => {
  const pst = S.posts.get(Number(el.dataset.id));
  if (!await confirmDialog({ title: `¿Eliminar «${pst.title}»?`, body: 'Se borran también sus fotos. No se puede deshacer.', confirm: 'Eliminar', danger: true })) return;
  await api(`/api/admin/posts/${pst.id}`, { method: 'DELETE' });
  toast('Publicación eliminada'); S.keepScroll = true; await viewForum();
};

// Visor de fotos a pantalla completa (flechas del teclado y botones)
actions.openImage = (el) => {
  const pst = S.posts.get(Number(el.dataset.post));
  S.lightbox = { imgs: pst.images, i: Number(el.dataset.i), title: pst.title };
  paintLightbox();
  $dialog.className = 'lightbox';
  $dialog.showModal();
  $dialog.onclose = () => { $dialog.className = ''; S.lightbox = null; };
};
function paintLightbox() {
  const L = S.lightbox;
  const img = L.imgs[L.i];
  $dialog.innerHTML = `<figure>
    <img src="/api/images/${img.id}" alt="Foto ${L.i + 1} de ${L.imgs.length} de «${esc(L.title)}»">
    <figcaption><span>${esc(L.title)}</span><span>${L.i + 1} / ${L.imgs.length}</span></figcaption></figure>
    <button class="icon-btn lb-close" data-act="closeDialog" aria-label="Cerrar">${icon('x')}</button>
    ${L.imgs.length > 1 ? `<button class="icon-btn lb-nav lb-prev" data-act="lightboxStep" data-step="-1" aria-label="Foto anterior">${icon('chevron-left')}</button>
      <button class="icon-btn lb-nav lb-next" data-act="lightboxStep" data-step="1" aria-label="Foto siguiente">${icon('chevron')}</button>` : ''}`;
}
actions.lightboxStep = (el) => {
  const L = S.lightbox; if (!L) return;
  L.i = (L.i + Number(el.dataset.step) + L.imgs.length) % L.imgs.length;
  paintLightbox();
};
actions.closeDialog = () => $dialog.close();
document.addEventListener('keydown', (e) => {
  if (!S.lightbox || !$dialog.open) return;
  if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    S.lightbox.i = (S.lightbox.i + (e.key === 'ArrowRight' ? 1 : -1) + S.lightbox.imgs.length) % S.lightbox.imgs.length;
    paintLightbox();
  }
});

// Reduce una foto en el navegador (lado largo 1600 px, JPEG): sube rápido y ocupa poco
async function shrinkImage(file, max = 1600, quality = 0.82) {
  let source;
  try { source = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
  catch (e) {
    source = await new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error(`No se ha podido leer «${file.name}». Prueba con una foto JPG o PNG.`));
      im.src = URL.createObjectURL(file);
    });
  }
  const w = source.width, h = source.height;
  const scale = Math.min(1, max / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) throw new Error(`No se ha podido preparar «${file.name}».`);
  const data = await new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(r.result); r.readAsDataURL(blob); });
  return { data, width: canvas.width, height: canvas.height, preview: URL.createObjectURL(blob) };
}

async function viewPostEditor(id) {
  if (!S.token) return viewLogin();
  if (!S.me) S.me = await api('/api/me');
  if (!isCoordinator()) {
    $app.innerHTML = `<div class="card empty"><h2>Solo Coordinación puede publicar en el foro</h2><a class="btn" href="#/foro">Volver al foro</a></div>`;
    return;
  }
  let post = null;
  if (id) {
    post = S.posts?.get(id) || (await api('/api/posts?limit=100')).find((x) => x.id === id);
    if (!post) throw new Error('Esta publicación ya no existe.');
  }
  const sessions = S.overview?.sessions || (await api('/api/admin/overview').then((ov) => { S.overview = ov; return ov.sessions; }));
  S.editor = { id, keep: post ? post.images.map((im) => im.id) : [], removed: [], added: [] };
  $app.innerHTML = `<p style="margin:0 0 .5rem"><a href="#/foro">Volver al foro</a></p>
  <div class="page-head"><h1>${id ? 'Editar publicación' : 'Nueva publicación'}</h1></div>
  <form id="postForm" class="card stack" novalidate>
    <label class="field">Título<input name="title" maxlength="140" required value="${esc(post?.title || '')}" placeholder="Ej.: Fotos del entreno del miércoles"></label>
    <div class="grid grid-2" style="gap:.75rem">
      <label class="field">Tipo<select name="category">${Object.entries(POST_CATS).map(([k, l]) => `<option value="${k}" ${(post?.category || 'noticia') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      <label class="field">Entreno relacionado (opcional)<select name="session_id"><option value="">Ninguno</option>${sessions.map((x) => `<option value="${x.id}" ${post?.session_id === x.id ? 'selected' : ''}>${esc(fmtShort(x.date))}</option>`).join('')}</select></label>
    </div>
    <label class="field">Texto<textarea name="body" rows="8" maxlength="10000" placeholder="Cuenta lo que quieras compartir con la sección">${esc(post?.body || '')}</textarea></label>
    <div class="stack">
      <label class="uploader" id="uploader">${icon('image')}<strong>Añadir fotos</strong><span class="small">Hasta 10. Se reducen antes de subir.</span>
        <input type="file" id="postFiles" accept="image/*" multiple></label>
      <div class="previews" id="previews"></div>
    </div>
    <label><input type="checkbox" name="pinned" ${post?.pinned ? 'checked' : ''}> Fijar arriba del foro</label>
    <p class="status-box danger form-error" id="formError" role="alert" hidden></p>
    <div class="dialog-actions" style="justify-content:flex-start">
      <button class="btn-primary btn-big" type="submit">${icon('send')} ${id ? 'Guardar cambios' : 'Publicar'}</button>
      <a class="btn btn-ghost" href="#/foro">Cancelar</a></div>
  </form>`;
  paintPreviews(post);
  const input = document.getElementById('postFiles');
  const zone = document.getElementById('uploader');
  input.addEventListener('change', () => { addFiles([...input.files], post); input.value = ''; });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('drag'); addFiles([...e.dataTransfer.files].filter((f) => f.type.startsWith('image/')), post); });
  document.getElementById('postForm').onsubmit = (e) => { e.preventDefault(); savePost(e.target); };
}

function paintPreviews(post) {
  const E = S.editor;
  const box = document.getElementById('previews');
  if (!box) return;
  box.innerHTML = [
    ...E.keep.map((imgId) => `<div class="preview"><img src="/api/images/${imgId}" alt="">
      <button type="button" data-act="removeImage" data-kind="keep" data-id="${imgId}" aria-label="Quitar foto">${icon('x')}</button></div>`),
    ...E.added.map((a, i) => `<div class="preview${a.pending ? ' processing' : ''}">${a.preview ? `<img src="${a.preview}" alt="">` : ''}
      ${a.pending ? '' : `<button type="button" data-act="removeImage" data-kind="added" data-i="${i}" aria-label="Quitar foto">${icon('x')}</button>`}</div>`),
  ].join('');
  S.editorPost = post;
}

async function addFiles(files, post) {
  const E = S.editor;
  const room = 10 - E.keep.length - E.added.length;
  if (files.length > room) toast(room ? `Solo caben ${room} foto${room === 1 ? '' : 's'} más (máximo 10)` : 'Ya hay 10 fotos', true);
  for (const file of files.slice(0, Math.max(0, room))) {
    const slot = { pending: true };
    E.added.push(slot); paintPreviews(post);
    try { Object.assign(slot, await shrinkImage(file), { pending: false }); }
    catch (err) { E.added.splice(E.added.indexOf(slot), 1); toast(err.message, true); }
    paintPreviews(post);
  }
}
actions.removeImage = (el) => {
  const E = S.editor;
  if (el.dataset.kind === 'keep') { E.keep = E.keep.filter((x) => x !== el.dataset.id); E.removed.push(el.dataset.id); }
  else E.added.splice(Number(el.dataset.i), 1);
  paintPreviews(S.editorPost);
};

function savePost(form) {
  const E = S.editor;
  const f = new FormData(form);
  const title = String(f.get('title') || '').trim();
  if (!title) { showFormError('Escribe un título.'); form.title.focus(); return; }
  if (E.added.some((a) => a.pending)) { showFormError('Espera a que terminen de prepararse las fotos.'); return; }
  const fields = { title, body: f.get('body'), category: f.get('category'), session_id: f.get('session_id') || null, pinned: f.get('pinned') === 'on' };
  if (fields.category === 'fotos' && !E.keep.length && !E.added.length) { showFormError('Una publicación de fotos necesita al menos una foto.'); return; }
  const imgs = E.added.map(({ data, width, height }) => ({ data, width, height }));
  withBusy(form, async () => {
    try {
      if (E.id) {
        await api(`/api/admin/posts/${E.id}`, { method: 'PATCH', body: { ...fields, add_images: imgs, remove_images: E.removed } });
        toast('Publicación actualizada');
      } else {
        await api('/api/admin/posts', { method: 'POST', body: { ...fields, images: imgs } });
        toast('Publicado en el foro');
      }
      E.added.forEach((a) => a.preview && URL.revokeObjectURL(a.preview));
      S.forumFilter = ''; location.hash = '#/foro';
    } catch (err) { showFormError(err.message); }
  });
}

// ---------- Resultados ----------

// Pestañas de la sección Resultados: partidos y clasificación
function resultsTabs(current) {
  return `<nav class="tabs" aria-label="Resultados y clasificación">
    <a href="#/resultados"${current === 'partidos' ? ' aria-current="page"' : ''}>Partidos</a>
    <a href="#/clasificacion"${current === 'clasificacion' ? ' aria-current="page"' : ''}>Clasificación</a></nav>`;
}

async function viewResultsList() {
  if (!S.token) return viewHome();
  const sessions = (await api('/api/sessions')).filter((s) => s.has_results);
  $app.innerHTML = `<div class="page-head"><h1>Resultados</h1></div>${resultsTabs('partidos')}${sessions.length ? `<div class="card">${sessions.map((s) => `
    <a class="link-row" href="#/resultados/${s.id}"><span><strong>${esc(fmtDate(s.date))}</strong>
      <span class="small muted"> · ${plural(s.yes_count, 'apuntado', 'apuntados')}</span></span>${icon('chevron')}</a>`).join('')}
    </div>` : '<div class="card empty"><h2>Aún no hay resultados</h2><p class="muted">Aparecerán aquí cuando Coordinación los apunte al terminar cada entreno.</p></div>'}`;
}

async function viewResultsDetail(id) {
  const r = await api(`/api/sessions/${id}/results`);
  $app.innerHTML = `<p style="margin:0 0 .5rem"><a href="#/resultados">Todos los resultados</a></p>
    <div class="page-head"><h1>${esc(fmtDate(r.session.date))}</h1></div>${renderResults(r)}`;
}

function renderResults(r) {
  if (!r.teams.length) return '<div class="card empty"><h2>Sin resultados</h2><p class="muted">Este entreno no tiene partidos apuntados.</p></div>';
  const teamName = new Map(r.teams.map((t) => [t.id, t]));
  const dot = (t) => `<span class="team-dot" style="background:${esc(t?.color || '#ccc')}"></span>`;
  const winner = r.table[0] && r.table[0].pts > (r.table[1]?.pts ?? -1) ? r.table[0] : null;
  return `
  ${winner ? `<div class="status-box ok">${icon('trophy')}<div><strong>Gana ${esc(winner.name)}</strong>${plural(winner.pts, 'punto', 'puntos')}</div></div>` : ''}
  <div class="grid grid-2">
    <div class="card"><h2>Clasificación del día</h2><div class="table-wrap"><table>
      <thead><tr><th>Equipo</th><th class="num">PJ</th><th class="num">G</th><th class="num">E</th><th class="num">P</th><th class="num">GF</th><th class="num">GC</th><th class="num">Pts</th></tr></thead>
      <tbody>${r.table.map((t) => `<tr><td>${dot(t)} ${esc(t.name)}</td><td class="num">${t.pj}</td><td class="num">${t.w}</td><td class="num">${t.d}</td><td class="num">${t.l}</td><td class="num">${t.gf}</td><td class="num">${t.gc}</td><td class="num"><strong>${t.pts}</strong></td></tr>`).join('')}</tbody>
    </table></div></div>
    <div class="card"><h2>Partidos</h2><ul class="list">${r.matches.map((m) => {
      const h = teamName.get(m.home_team_id), a = teamName.get(m.away_team_id);
      return `<li><span class="name">${dot(h)} ${esc(h?.name)}</span><span class="score">${m.home_goals} – ${m.away_goals}</span><span class="name" style="text-align:right">${esc(a?.name)} ${dot(a)}</span></li>`;
    }).join('')}</ul></div>
  </div>
  <div class="grid grid-2">
    <div class="card"><h2>Equipos</h2>${r.teams.map((t) => `<p><strong>${dot(t)} ${esc(t.name)}</strong><br><span class="small">${t.players.map((p) => esc(p.name)).join(', ') || '—'}</span></p>`).join('')}</div>
    <div class="card"><h2>Estadísticas</h2>${r.stats.length ? `<div class="table-wrap"><table>
      <thead><tr><th>Jugador</th><th class="num">Goles</th><th class="num">Asist.</th><th class="num">Paradas</th><th></th></tr></thead>
      <tbody>${r.stats.map((s) => `<tr><td>${esc(s.name)}</td><td class="num">${s.goals}</td><td class="num">${s.assists}</td><td class="num">${s.saves}</td><td>${s.mvp ? `${icon('star')} MVP` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Sin estadísticas individuales.</p>'}
    </div>
  </div>
  ${r.notes ? `<div class="card"><h2>Notas</h2><p style="white-space:pre-wrap">${esc(r.notes)}</p></div>` : ''}`;
}

// ---------- Normas ----------

async function viewRules() {
  const { infraction_types: T } = await loadRules();
  $app.innerHTML = `<div class="page-head"><h1>Normas</h1></div>
  <div class="card"><h2>Entrenamientos</h2><ul class="rules">
    <li>Miércoles de 22:00 a 23:00 en el Polideportivo Marqués de Samaranch. Llega 15 minutos antes para cambiarte.</li>
    <li>Coordinación publica la convocatoria, normalmente el <strong>domingo a las 17:00</strong>. Si no sabes seguro si podrás ir, no te apuntes.</li>
    <li>Hay 16 plazas (21 si se juega triangular). Si está llena, quedas en reservas y entras automáticamente cuando alguien se borra.</li>
    <li>La lista se completa en directo. Coordinación puede cerrarla antes del entreno.</li>
    <li>Puedes borrarte sin penalización hasta el <strong>martes a las 15:00</strong>.</li></ul></div>
  <div class="card"><h2>Prioridades</h2>
    <p>Para entrar cuenta primero la prioridad y después la hora de inscripción.</p>
    <ul class="list">
      <li>${prioBadge(1)}<span class="name">No viniste al entreno de la semana anterior. Siempre entra también al menos una persona de Coordinación.</span></li>
      <li>${prioBadge(2)}<span class="name">Viniste al entreno de la semana anterior.</span></li>
      <li>${prioBadge(3)}<span class="name">La semana anterior cometiste alguna de estas infracciones:</span></li>
    </ul>
    <ul class="list" style="margin-top:.25rem">${Object.values(T).map((t) => `<li><span class="name">${esc(t.label)}</span>
      <span class="chip ${t.serious ? 'danger' : t.weeks === 2 ? 'warn' : ''}">${t.weeks === 2 ? '2 semanas' : '1 semana'}${t.serious ? ' · grave' : ''}</span></li>`).join('')}</ul>
    <p class="small muted" style="margin-top:.75rem">Dos faltas graves en la temporada suponen quedar fuera del equipo.</p></div>
  <div class="card"><h2>Asistencia</h2><ul class="rules">
    <li>Hacen falta <strong>4 entrenos cada tres meses</strong> para seguir en la sección.</li>
    <li>Con motivo justificado (lesión, temporada fuera…) Coordinación te da una exención.</li>
    <li>Si te quedaste fuera porque la lista estaba llena, no cuenta como falta.</li></ul></div>`;
}

// ---------- Coordinación ----------

const ADMIN_TABS = [
  ['convocatoria', 'Convocatoria'], ['asistencia', 'Asistencia'], ['resultados', 'Resultados'], ['material', 'Material'],
  ['incidencias', 'Incidencias'], ['jugadores', 'Jugadores'], ['actividad', 'Actividad'],
];

async function viewAdmin(tab = 'convocatoria') {
  if (!S.token) return viewLogin();
  if (!S.me) { try { S.me = await api('/api/me'); } catch (e) { return viewLogin(); } }
  if (!canManage()) {
    $app.innerHTML = `<div class="card empty"><h2>Esta sección es para Coordinación</h2>
      <p class="muted">Si te toca ayudar con las convocatorias, pide a Coordinación el rol de gestión.</p>
      <a class="btn" href="#/">Volver a la convocatoria</a></div>`;
    return;
  }
  if (tab === 'clasificacion') { location.hash = '#/clasificacion'; return; }
  const ov = await api('/api/admin/overview');
  S.overview = ov;
  // Sin elección explícita: asistencia, resultados y material van sobre el último entreno jugado;
  // la convocatoria, sobre el próximo
  if (!S.sessionPicked || !ov.sessions.some((s) => s.id === S.adminSessionId)) {
    const lastPlayed = ov.sessions.find((s) => s.has_started && !s.cancelled)?.id;
    S.adminSessionId = (['asistencia', 'resultados', 'material'].includes(tab) && lastPlayed)
      || ov.current_id || ov.sessions[0]?.id || null;
  }
  const head = adminTabsHtml(tab, ov) + sessionPicker(ov, tab);
  const fn = {
    convocatoria: adminConvocatoria, asistencia: adminAsistencia, resultados: adminResultados, material: adminMaterial,
    incidencias: adminIncidencias, jugadores: adminJugadores, actividad: adminActividad,
  }[tab];
  if (!fn) { location.hash = '#/admin'; return; }
  $app.innerHTML = head + '<div id="adminBody"><p class="muted">Cargando…</p></div>';
  const body = document.getElementById('adminBody');
  if (body) await fn(body);
}

function adminTabsHtml(tab, ov) {
  return `<div class="page-head"><h1>Coordinación</h1>
    <button class="btn-primary" data-act="newSession">${icon('plus')} Nueva convocatoria</button></div>
  <nav class="tabs" aria-label="Secciones de coordinación">${ADMIN_TABS.map(([k, l]) => `<a href="#/admin/${k}"${k === tab ? ' aria-current="page"' : ''}>${l}${k === 'incidencias' && ov?.pending_infractions ? `<span class="badge" aria-label="${ov.pending_infractions} pendientes">${ov.pending_infractions}</span>` : ''}</a>`).join('')}</nav>`;
}

function sessionPicker(ov, tab) {
  if (['incidencias', 'jugadores', 'actividad'].includes(tab)) return '';
  if (!ov.sessions.length) return '';
  return `<div style="margin-bottom:1rem;max-width:22rem">
    <label class="field">Entreno
      <select data-change="pickSession">${ov.sessions.map((s) => `<option value="${s.id}" ${s.id === S.adminSessionId ? 'selected' : ''}>
      ${esc(fmtShort(s.date))}${s.cancelled ? ' · cancelado' : !s.is_published ? ' · borrador' : ''}${s.id === ov.current_id ? ' · el próximo' : ''}</option>`).join('')}</select></label></div>`;
}

actions.pickSession = (el) => {
  S.adminSessionId = Number(el.value); sessionStorage.setItem('f7_admin_session', el.value);
  S.sessionPicked = true; S.res = null; S.att = null; render();
};
actions.newSession = () => {
  $dialog.innerHTML = `<form method="dialog" class="stack"><h2>Nueva convocatoria</h2>
    <div class="grid grid-2" style="gap:.75rem">
      <label class="field">Fecha<input type="date" id="nsDate" value="${S.overview.next_wednesday}" required></label>
      <label class="field">Plazas<input type="number" id="nsCap" min="2" max="40" value="16"></label>
      <label class="field">Hora de inicio<input type="time" id="nsTime" value="22:00"></label>
      <label class="field">Hora de llegada<input type="time" id="nsArrive" value="21:45"></label>
    </div>
    <label class="field">Lugar<input id="nsLoc" value="Polideportivo Marqués de Samaranch"></label>
    <label class="field">Notas para el equipo (opcional)<textarea id="nsNotes" placeholder="Ej.: traed camiseta clara y oscura"></textarea></label>
    <fieldset class="stack" style="border:1px solid var(--border);border-radius:var(--r-sm);padding:.75rem">
      <legend class="small muted">Publicación</legend>
      <label><input type="radio" name="nsPub" value="open" checked> Publicar y abrir inscripciones ya</label>
      <label><input type="radio" name="nsPub" value="sunday"> Publicar, inscripciones desde el domingo a las 17:00</label>
      <label><input type="radio" name="nsPub" value="draft"> Guardar como borrador (no la ven los jugadores)</label>
    </fieldset>
    <p class="small muted">Con 16 plazas se juega un partido; con 21, triangular de tres equipos con partidos de 8 minutos.</p>
    <div class="dialog-actions"><button value="cancel" class="btn-ghost">Volver</button><button value="ok" class="btn-primary">Crear convocatoria</button></div></form>`;
  $dialog.showModal();
  $dialog.onclose = async () => {
    if ($dialog.returnValue !== 'ok') return;
    const pub = document.querySelector('input[name="nsPub"]:checked').value;
    try {
      const r = await api('/api/admin/sessions', { method: 'POST', body: {
        date: document.getElementById('nsDate').value,
        capacity: Number(document.getElementById('nsCap').value),
        start_time: document.getElementById('nsTime').value,
        arrival_time: document.getElementById('nsArrive').value,
        location: document.getElementById('nsLoc').value,
        notes: document.getElementById('nsNotes').value,
        publish: pub !== 'draft', open_now: pub === 'open',
      } });
      S.adminSessionId = r.id; S.sessionPicked = true; sessionStorage.setItem('f7_admin_session', r.id);
      toast(pub === 'draft' ? 'Borrador guardado' : 'Convocatoria publicada'); location.hash = '#/admin/convocatoria'; render();
    } catch (e) { toast(e.message, true); }
  };
};

function noSession(el) {
  el.innerHTML = `<div class="card empty welcome"><h2>Empieza la temporada</h2>
    <ul>
      <li>${icon('plus')}<span><strong>Crea la convocatoria</strong> del miércoles con «Nueva convocatoria». Puedes dejarla en borrador hasta el domingo.</span></li>
      <li>${icon('send')}<span><strong>Publícala</strong> y la verán al momento quienes tengan cuenta.</span></li>
      <li>${icon('check')}<span><strong>Después del entreno</strong>, pasa lista, apunta los resultados y asigna el material.</span></li>
    </ul>
    <button class="btn-primary" data-act="newSession">${icon('plus')} Nueva convocatoria</button></div>`;
}

// --- Convocatoria ---
// Fecha/hora ISO -> valor de <input type="datetime-local"> en la hora del navegador
const toLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

async function adminConvocatoria(el) {
  if (!S.adminSessionId) return noSession(el);
  const d = await api(`/api/admin/sessions/${S.adminSessionId}`);
  if (!el.isConnected) return; // el usuario ya ha cambiado de pestaña
  S.detail = d;
  const s = d.session;
  const players = (await api('/api/admin/players')).filter((p) => p.active);
  S.players = players;
  const inList = new Set([...d.titulares, ...d.reservas].map((e) => e.player_id));
  const yes = d.titulares.length + d.reservas.length;
  const pubState = s.cancelled ? { cls: 'is-cancel', ic: 'x', t: 'Entrenamiento cancelado', p: 'Los jugadores lo ven como cancelado.' }
    : !s.is_published ? { cls: 'is-wait', ic: 'lock', t: 'Borrador', p: 'Los jugadores todavía no la ven.' }
      : s.is_open ? { cls: 'is-in', ic: 'check', t: 'Publicada · inscripciones abiertas', p: `${plural(yes, 'persona apuntada', 'personas apuntadas')} de ${s.capacity} plazas.` }
        : s.has_started ? { cls: '', ic: 'lock', t: 'Publicada · inscripciones cerradas', p: 'El entreno ya ha empezado.' }
          : { cls: 'is-wait', ic: 'clock', t: 'Publicada', p: `Las inscripciones se abren el ${fmtDateTime(s.opens_at)}.` };
  const pubButtons = s.cancelled || s.has_started ? '' : !s.is_published
    ? `<button class="btn-primary" data-act="publishSession" data-open="1">${icon('send')} Publicar y abrir inscripciones</button>
       <button class="btn-quiet" data-act="publishSession" data-open="0">Publicar con apertura el ${esc(fmtDateTime(s.opens_at))}</button>`
    : `${!s.is_open ? '<button class="btn-primary" data-act="publishSession" data-open="1">Abrir inscripciones ahora</button>' : ''}
       ${yes ? '' : '<button class="btn-quiet" data-act="unpublishSession">Volver a borrador</button>'}`;
  el.innerHTML = `
  <section class="hero" aria-labelledby="admDate">
    <h2 class="hero-date" id="admDate">${esc(fmtDate(s.date))}</h2>
    <div class="hero-meta">
      <span>${icon('clock')} ${esc(s.start_time)} · llegada ${esc(s.arrival_time || '21:45')}</span>
      <span>${icon('pin')} ${esc(s.location)}</span>
    </div>
    <div class="hero-status ${pubState.cls}">${icon(pubState.ic)}<div><strong>${esc(pubState.t)}</strong>
      <p>${esc(pubState.p)}${s.finalized_at ? ` Lista cerrada el ${esc(fmtDateTime(s.finalized_at))}.` : ''}${d.created_by_name ? ` Creada por ${esc(d.created_by_name)}.` : ''}</p></div></div>
    ${pubButtons ? `<div class="hero-actions">${pubButtons}</div>` : ''}
  </section>

  <div class="card"><h2>Detalles</h2>
    <form id="sessionForm" class="stack">
      <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:.75rem">
        <label class="field">Fecha<input type="date" name="date" value="${esc(s.date)}" required></label>
        <label class="field">Hora de inicio<input type="time" name="start_time" value="${esc(s.start_time)}" required></label>
        <label class="field">Hora de llegada<input type="time" name="arrival_time" value="${esc(s.arrival_time || '21:45')}" required></label>
        <label class="field">Plazas<input type="number" name="capacity" min="2" max="40" value="${s.capacity}" required></label>
        <label class="field">Inscripciones desde<input type="datetime-local" name="opens_at" value="${esc(toLocalInput(s.opens_at))}"></label>
      </div>
      <label class="field">Lugar<input name="location" value="${esc(s.location)}" required></label>
      <label class="field">Notas para el equipo<textarea name="notes" placeholder="Opcional. Las verán los jugadores en la convocatoria.">${esc(s.notes || '')}</textarea></label>
      <div class="row"><button class="btn-primary" type="submit">Guardar cambios</button>
        <span class="small muted">Cada cambio queda registrado en Actividad.</span></div>
    </form>
    <div class="danger-zone row">
      <button class="btn-danger btn-sm" data-act="toggleCancel">${s.cancelled ? 'Reactivar entrenamiento' : 'Cancelar entrenamiento'}</button>
      <button class="btn-danger btn-sm" data-act="deleteSession">${icon('trash')} Eliminar</button>
    </div>
  </div>

  <div class="grid grid-2">
    <div class="card"><div class="row spread" style="margin-bottom:.5rem"><h2 style="margin:0">Lista · ${d.titulares.length} de ${s.capacity}${d.reservas.length ? ` + ${plural(d.reservas.length, 'reserva', 'reservas')}` : ''}</h2>
      <span class="row">${s.finalized_at
        ? `<button class="btn-sm" data-act="finalize">${icon('refresh')} Recalcular</button><button class="btn-sm btn-ghost" data-act="unfinalize">Reabrir</button>`
        : `<button class="btn-sm" data-act="finalize">${icon('lock')} Cerrar la lista</button>`}</span></div>
      ${d.previous ? `<p class="small muted">Prioridades según el entreno del ${esc(fmtShort(d.previous.date))}.</p>` : ''}
      ${PRIO_LEGEND}${renderList(d, null, { admin: true })}
      <div class="row" style="margin-top:1rem">
        <select id="addPlayer"><option value="">Añadir a alguien…</option>${players.filter((p) => !inList.has(p.id)).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
        <button class="btn-sm" data-act="adminAdd">Añadir</button>
      </div></div>
    <div class="stack">
      ${teamsProposalHtml(d.teams_proposal)}
      <div class="card"><div class="row spread" style="margin-bottom:.6rem"><h2 style="margin:0">Mensaje para WhatsApp</h2><button class="btn-sm" data-act="copyWa">${icon('copy')} Copiar</button></div>
        <pre class="wa">${esc(d.whatsapp)}</pre></div>
      <div class="card"><h2>Sin responder · ${d.sin_responder.length}</h2><p class="small">${d.sin_responder.map((p) => esc(p.name)).join(', ') || 'Ha respondido todo el mundo.'}</p>
        ${d.no_van.length ? `<h3>No van</h3><ul class="list">${d.no_van.map((n) => `<li><span class="name">${esc(n.name)}<small>${esc(n.cancel_reason || '')} ${esc(fmtTime(n.updated_at))}</small></span></li>`).join('')}</ul>` : ''}
      </div>
      ${d.infractions.length ? `<div class="card"><h2>Incidencias de este entreno</h2><ul class="list">${d.infractions.map((i) => `<li><span class="name">${esc(i.name)}<small>${esc(S.rules?.infraction_types[i.type]?.label || i.type)}</small></span>${infStatusChip(i.status)}</li>`).join('')}</ul><a href="#/admin/incidencias" class="small">Revisar incidencias</a></div>` : ''}
      <div class="card"><h2>Actividad de esta convocatoria</h2>${activityList(d.activity)}</div>
    </div>
  </div>`;

  const sessionForm = document.getElementById('sessionForm');
  if (!sessionForm) return;
  sessionForm.onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = Object.fromEntries(f.entries());
    body.capacity = Number(body.capacity);
    body.opens_at = body.opens_at ? new Date(body.opens_at).toISOString() : null;
    withBusy(e.target, async () => {
      try {
        await api(`/api/admin/sessions/${S.adminSessionId}`, { method: 'PATCH', body });
        S.keepScroll = true; toast('Cambios guardados'); await render();
      } catch (err) { toast(err.message, true); }
    });
  };
}
actions.publishSession = async (el) => {
  await api(`/api/admin/sessions/${S.adminSessionId}/publish`, { method: 'POST', body: { open_now: el.dataset.open === '1' } });
  toast(el.dataset.open === '1' ? 'Publicada: ya pueden apuntarse' : 'Publicada'); render();
};
actions.unpublishSession = async () => {
  await api(`/api/admin/sessions/${S.adminSessionId}/unpublish`, { method: 'POST' });
  toast('Ahora es un borrador'); render();
};
actions.copyWa = () => copyText(S.detail.whatsapp);
actions.finalize = async () => {
  const r = await api(`/api/admin/sessions/${S.adminSessionId}/finalize`, { method: 'POST' });
  await copyText(r.whatsapp).catch(() => {});
  toast('Lista cerrada. Mensaje copiado para WhatsApp'); render();
};
actions.unfinalize = async () => {
  await api(`/api/admin/sessions/${S.adminSessionId}/unfinalize`, { method: 'POST' }); render();
};
actions.toggleCancel = async () => {
  const cancelling = !S.detail.session.cancelled;
  if (cancelling && !await confirmDialog({ title: '¿Cancelar este entrenamiento?', body: 'Los jugadores lo verán cancelado. Podrás reactivarlo después.', confirm: 'Cancelar entrenamiento', danger: true })) return;
  await api(`/api/admin/sessions/${S.adminSessionId}`, { method: 'PATCH', body: { cancelled: cancelling } });
  toast(cancelling ? 'Entrenamiento cancelado' : 'Entrenamiento reactivado'); render();
};
actions.deleteSession = async () => {
  if (!await confirmDialog({ title: '¿Eliminar este entrenamiento?', body: 'Se borran la lista, la asistencia y los resultados. No se puede deshacer.', confirm: 'Eliminar', danger: true })) return;
  await api(`/api/admin/sessions/${S.adminSessionId}`, { method: 'DELETE' });
  S.adminSessionId = null; S.sessionPicked = false; toast('Entrenamiento eliminado'); render();
};
actions.adminSetResponse = async (el) => {
  await api(`/api/admin/sessions/${S.adminSessionId}/responses/${el.dataset.pid}`, { method: 'PUT', body: { answer: el.dataset.answer } });
  render();
};
actions.adminAdd = async () => {
  const pid = document.getElementById('addPlayer').value;
  if (!pid) return;
  await api(`/api/admin/sessions/${S.adminSessionId}/responses/${pid}`, { method: 'PUT', body: { answer: 'yes' } });
  render();
};

// --- Material ---
async function adminMaterial(el) {
  const [data, players] = await Promise.all([api('/api/admin/equipment'), api('/api/admin/players')]);
  const active = players.filter((p) => p.active);
  const sess = S.overview.sessions.find((x) => x.id === S.adminSessionId);
  const opts = (sel) => `<option value="">En el club (nadie se lo lleva)</option>${active.map((p) => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}`;
  el.innerHTML = `
  <div class="card"><h2>¿Quién se lleva el material?</h2>
    <p class="small muted">Al terminar el entreno, elige quién se lleva cada cosa${sess ? ` (queda asociado al entreno del ${esc(fmtShort(sess.date))})` : ''}. Se registra quién lo asignó y cuándo.</p>
    <ul class="list">${data.items.filter((i) => i.active).map((i) => `<li style="flex-wrap:wrap">
      <span class="name"><strong>${icon('bib')} ${esc(i.name)}</strong>
        <small>${i.holder_name ? `Lo tiene <b>${esc(i.holder_name)}</b>` : 'En el club'}${i.assigned_at ? ` · ${esc(i.assigned_by_name || '—')} lo asignó el ${esc(fmtDateTime(i.assigned_at))}` : ''}</small></span>
      <span class="row">
        <select id="eqHolder${i.id}" aria-label="Quién se lleva ${esc(i.name)}">${opts(i.holder_id)}</select>
        <button class="btn-primary btn-sm" data-act="assignEquipment" data-id="${i.id}">Asignar</button>
        <button class="btn-ghost btn-sm" data-act="toggleEquipment" data-id="${i.id}" data-active="0">Retirar</button>
      </span></li>`).join('') || '<li class="muted">No hay material activo.</li>'}</ul>
    <div class="row" style="margin-top:1rem">
      <input id="eqNew" placeholder="Nuevo material (p. ej. Conos)" style="flex:1">
      <button class="btn-sm" data-act="addEquipment">Añadir material</button>
    </div>
    ${data.items.some((i) => !i.active) ? `<p class="small muted" style="margin-top:.75rem">Retirado: ${data.items.filter((i) => !i.active).map((i) => `${esc(i.name)} <a href="#" data-act="toggleEquipment" data-id="${i.id}" data-active="1">reactivar</a>`).join(' · ')}</p>` : ''}
  </div>
  <div class="card"><h2>Historial del material</h2>${data.history.length ? `<ul class="list">${data.history.map((h) => `<li>
    <span class="name"><strong>${esc(h.assigned_by_name || '—')}</strong> ${h.holder_name ? `asignó a <strong>${esc(h.holder_name)}</strong>` : 'dejó en el club'} los «${esc(h.equipment_name)}»
      <small>${esc(fmtDateTime(h.assigned_at))}${h.session_date ? ` · tras el entreno del ${esc(fmtShort(h.session_date))}` : ''}${h.note ? ` · ${esc(h.note)}` : ''}</small></span></li>`).join('')}</ul>` : '<p class="muted small">Aún no se ha asignado nada.</p>'}</div>`;
}
actions.assignEquipment = async (el) => {
  const holder = document.getElementById(`eqHolder${el.dataset.id}`).value;
  await api(`/api/admin/equipment/${el.dataset.id}/assign`, { method: 'POST', body: { holder_id: holder ? Number(holder) : null, session_id: S.adminSessionId } });
  toast(holder ? 'Material asignado' : 'Marcado como guardado en el club'); render();
};
actions.toggleEquipment = async (el) => {
  await api(`/api/admin/equipment/${el.dataset.id}`, { method: 'PATCH', body: { active: el.dataset.active === '1' } });
  render();
};
actions.addEquipment = async () => {
  const name = document.getElementById('eqNew').value.trim();
  if (!name) return;
  await api('/api/admin/equipment', { method: 'POST', body: { name } });
  toast('Material añadido'); render();
};

// --- Actividad ---
const AUDIT_FILTERS = [['', 'Todo'], ['session', 'Convocatorias'], ['attendance', 'Asistencia'], ['results', 'Resultados'],
  ['infraction', 'Incidencias'], ['equipment', 'Material'], ['player', 'Jugadores y roles'], ['post', 'Foro']];
async function adminActividad(el) {
  const filter = S.auditFilter || '';
  const rows = await api(`/api/admin/audit?limit=300${filter ? `&entity=${encodeURIComponent(filter)}` : ''}`);
  el.innerHTML = `<div class="card"><div class="row spread" style="margin-bottom:.5rem"><h2 style="margin:0">Actividad</h2>
    <select data-change="auditFilter" aria-label="Filtrar por tipo">${AUDIT_FILTERS.map(([k, l]) => `<option value="${k}" ${k === filter ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <p class="small muted">Cada cambio de Coordinación queda aquí con su autor, la fecha y la hora.</p>
    ${activityList(rows)}</div>`;
}
actions.auditFilter = (el) => { S.auditFilter = el.value; render(); };

// --- Asistencia ---
async function adminAsistencia(el) {
  if (!S.adminSessionId) return noSession(el);
  const [d, rules] = [await api(`/api/admin/sessions/${S.adminSessionId}`), await loadRules()];
  S.detail = d;
  const saved = new Map(d.attendance.map((a) => [a.player_id, a.status]));
  if (!S.att || S.att.sid !== S.adminSessionId) {
    const rows = [...d.titulares, ...d.reservas].map((e) => ({
      player_id: e.player_id, name: e.name, role: e.role,
      status: saved.get(e.player_id) || (e.role === 'titular' ? 'attended' : 'left_out'),
    }));
    // Personas con asistencia guardada que ya no están en la lista (p. ej. se borraron tarde)
    for (const [pid, status] of saved) {
      if (!rows.some((r) => r.player_id === pid)) {
        const n = d.no_van.find((x) => x.player_id === pid)?.name || `#${pid}`;
        rows.push({ player_id: pid, name: n, role: 'otro', status });
      }
    }
    S.att = { sid: S.adminSessionId, rows };
  }
  const ROLE = { titular: 'Titular', reserva: 'Reserva', otro: 'Añadido a mano' };
  const CREATES = new Set(['late', 'no_show']);
  const baseline = new Map(S.att.rows.map((r) => [r.player_id, saved.get(r.player_id) || (r.role === 'reserva' ? 'left_out' : 'attended')]));
  const changed = S.att.rows.filter((r) => r.status !== baseline.get(r.player_id) || !d.attendance.length).length;
  const creating = S.att.rows.filter((r) => CREATES.has(r.status));
  el.innerHTML = `<div class="card">
    <div class="row spread"><h2 style="margin:0">Pasar lista</h2>${d.attendance.length ? '<span class="chip ok">Guardada</span>' : '<span class="chip warn">Sin guardar</span>'}</div>
    <p class="small muted">Todo el mundo empieza como «Asistió»: cambia solo las excepciones. «Llegó tarde» y «No se presentó» crean una incidencia.</p>
    <div>${S.att.rows.map((r, i) => `<div class="att-row${r.status !== baseline.get(r.player_id) ? ' changed' : ''}${CREATES.has(r.status) ? ' creates' : ''}">
      <div class="who"><strong>${esc(r.name)}</strong><small>${ROLE[r.role] || r.role}</small></div>
      <select data-change="setAtt" data-i="${i}" aria-label="Asistencia de ${esc(r.name)}">${Object.entries(rules.attendance_statuses).map(([k, l]) => `<option value="${k}" ${r.status === k ? 'selected' : ''}>${l}${CREATES.has(k) ? ' (incidencia)' : ''}</option>`).join('')}</select>
    </div>`).join('')}</div>
    <div class="row" style="margin-top:1rem">
      <select id="attAdd" aria-label="Añadir a alguien que vino"><option value="">Añadir a alguien que vino…</option>${d.no_van.concat(d.sin_responder.map((p) => ({ player_id: p.id, name: p.name })))
        .filter((p) => !S.att.rows.some((r) => r.player_id === p.player_id)).map((p) => `<option value="${p.player_id}">${esc(p.name)}</option>`).join('')}</select>
      <button class="btn-sm" data-act="attAdd">Añadir</button>
    </div>
    <div class="savebar">
      <span class="small ${creating.length ? '' : 'muted'}">${creating.length ? `${icon('alert')} Se ${creating.length === 1 ? 'creará 1 incidencia' : `crearán ${creating.length} incidencias`}` : `${plural(S.att.rows.length, 'persona', 'personas')} en la lista`}</span>
      <button class="btn-primary" data-act="saveAtt">${d.attendance.length && !changed ? 'Guardar de nuevo' : 'Guardar asistencia'}</button>
    </div>
  </div>`;
}
actions.setAtt = (el) => { S.att.rows[Number(el.dataset.i)].status = el.value; adminAsistencia(document.getElementById('adminBody')); };
actions.attAdd = () => {
  const sel = document.getElementById('attAdd');
  if (!sel.value) return;
  S.att.rows.push({ player_id: Number(sel.value), name: sel.selectedOptions[0].textContent, role: 'otro', status: 'attended' });
  adminAsistencia(document.getElementById('adminBody'));
};
actions.saveAtt = async () => {
  const STATUS = S.rules?.attendance_statuses || {};
  const creating = S.att.rows.filter((r) => r.status === 'late' || r.status === 'no_show');
  if (creating.length && !await confirmDialog({
    title: creating.length === 1 ? 'Se va a crear 1 incidencia' : `Se van a crear ${creating.length} incidencias`,
    body: creating.map((r) => `${esc(r.name)}: ${esc((STATUS[r.status] || r.status).toLowerCase())}`).join('<br>'),
    confirm: 'Guardar asistencia',
  })) return;
  await api(`/api/admin/sessions/${S.adminSessionId}/attendance`, { method: 'PUT', body: { items: S.att.rows.map(({ player_id, status }) => ({ player_id, status })) } });
  S.att = null; toast('Asistencia guardada'); render();
};

// --- Resultados ---
const TEAM_COLORS = ['#f97316', '#f8fafc', '#2563eb', '#16a34a', '#facc15', '#111827'];

async function adminResultados(el) {
  if (!S.adminSessionId) return noSession(el);
  const d = await api(`/api/admin/sessions/${S.adminSessionId}`);
  S.detail = d;
  if (!S.res || S.res.sid !== S.adminSessionId) {
    const r = d.results;
    const idx = new Map(r.teams.map((t, i) => [t.id, i]));
    const stats = {};
    for (const st of r.stats) stats[st.player_id] = { goals: st.goals, assists: st.assists, saves: st.saves, mvp: !!st.mvp };
    const assign = {};
    r.teams.forEach((t, i) => t.players.forEach((p) => { assign[p.id] = i; }));
    // Jugadores: los que asistieron (o titulares si no se pasó lista) + los que ya estaban en un equipo
    const names = new Map();
    const attended = d.attendance.length
      ? d.attendance.filter((a) => a.status === 'attended' || a.status === 'late').map((a) => a.player_id)
      : d.titulares.map((e) => e.player_id);
    const all = [...d.titulares, ...d.reservas, ...d.no_van];
    for (const pid of attended) names.set(pid, all.find((e) => e.player_id === pid)?.name || `#${pid}`);
    r.teams.forEach((t) => t.players.forEach((p) => names.set(p.id, p.name)));
    S.res = {
      sid: S.adminSessionId,
      teams: r.teams.length ? r.teams.map((t) => ({ name: t.name, color: t.color || '#cccccc' }))
        : [{ name: 'Petos', color: TEAM_COLORS[0] }, { name: 'Sin petos', color: TEAM_COLORS[1] }],
      matches: r.matches.map((m) => ({ home: idx.get(m.home_team_id), away: idx.get(m.away_team_id), home_goals: m.home_goals, away_goals: m.away_goals })),
      players: [...names].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
      assign, stats, notes: r.notes || '',
    };
  }
  renderResEditor(el);
}

function renderResEditor(el = document.getElementById('adminBody')) {
  const R = S.res;
  const teamOpts = (sel) => R.teams.map((t, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
  const st = (pid) => R.stats[pid] || { goals: 0, assists: 0, saves: 0, mvp: false };
  el.innerHTML = `<div class="editor">
  <div class="card"><div class="row spread"><h2 style="margin:0">Equipos</h2>
    <span class="row">${S.detail?.teams_proposal ? '<button class="btn-sm" data-act="useProposedTeams">Usar equipos propuestos</button>' : ''}
    <button class="btn-sm" data-act="resAddTeam">${icon('plus')} Equipo</button></span></div>
    <div class="grid" style="grid-template-columns:repeat(auto-fit,minmax(220px,1fr));margin-top:.75rem">${R.teams.map((t, i) => `
      <div class="team-card row"><input type="color" value="${esc(t.color)}" data-input="resTeam" data-i="${i}" data-f="color" style="width:44px;padding:2px" aria-label="Color de ${esc(t.name)}">
        <input value="${esc(t.name)}" data-input="resTeam" data-i="${i}" data-f="name" style="flex:1;min-width:0" aria-label="Nombre del equipo">
        ${R.teams.length > 2 ? `<button class="btn btn-ghost btn-icon" data-act="resDelTeam" data-i="${i}" aria-label="Quitar ${esc(t.name)}">${icon('x')}</button>` : ''}
        <span class="small muted" style="width:100%">${R.players.filter((p) => R.assign[p.id] === i).length} jugadores</span></div>`).join('')}</div></div>

  <div class="card"><div class="row spread"><h2 style="margin:0">Partidos</h2><button class="btn-sm" data-act="resAddMatch">${icon('plus')} Partido</button></div>
    ${R.matches.length ? `<ul class="list">${R.matches.map((m, i) => `<li style="flex-wrap:wrap">
      <select data-change="resMatch" data-i="${i}" data-f="home">${teamOpts(m.home)}</select>
      <input type="number" min="0" value="${m.home_goals}" data-input="resMatch" data-i="${i}" data-f="home_goals" aria-label="Goles local">
      <span>–</span>
      <input type="number" min="0" value="${m.away_goals}" data-input="resMatch" data-i="${i}" data-f="away_goals" aria-label="Goles visitante">
      <select data-change="resMatch" data-i="${i}" data-f="away">${teamOpts(m.away)}</select>
      <button class="btn btn-ghost btn-icon" data-act="resDelMatch" data-i="${i}" aria-label="Quitar partido">${icon('x')}</button></li>`).join('')}</ul>`
      : `<p class="muted small">Añade los partidos jugados (en un triangular, uno por cruce)${S.detail?.teams_proposal ? ' o carga los equipos propuestos para empezar con el orden ya hecho' : ''}.</p>`}</div>

  <div class="card"><h2>Jugadores</h2>
    <p class="small muted">Asigna cada persona a su equipo y apunta goles, asistencias, paradas y MVP.</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Jugador</th><th>Equipo</th><th class="num">Goles</th><th class="num">Asist.</th><th class="num">Paradas</th><th>MVP</th></tr></thead>
      <tbody>${R.players.map((p) => `<tr>
        <td>${esc(p.name)}</td>
        <td><select data-change="resAssign" data-pid="${p.id}"><option value="">—</option>${teamOpts(R.assign[p.id])}</select></td>
        ${['goals', 'assists', 'saves'].map((f) => `<td class="num"><input type="number" min="0" value="${st(p.id)[f]}" data-input="resStat" data-pid="${p.id}" data-f="${f}"></td>`).join('')}
        <td><input type="checkbox" ${st(p.id).mvp ? 'checked' : ''} data-change="resStat" data-pid="${p.id}" data-f="mvp"></td>
      </tr>`).join('')}</tbody></table></div>
    <div class="row" style="margin-top:.75rem">
      <select id="resAddPlayer"><option value="">Añadir jugador…</option>${(S.players || []).filter((p) => !R.players.some((x) => x.id === p.id)).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
      <button class="btn-sm" data-act="resAddPlayer">Añadir</button></div>
  </div>

  <div class="card"><h2>Notas del entreno</h2>
    <textarea data-input="resNotes" aria-label="Notas del entreno" placeholder="Lesiones, jugadas destacadas, lo que haya que recordar…">${esc(R.notes)}</textarea></div>
  <div class="savebar floating"><span class="small muted">${plural(R.matches.length, 'partido', 'partidos')} · ${plural(Object.keys(R.assign).length, 'jugador en equipo', 'jugadores en equipos')}</span>
    <button class="btn-primary" data-act="resSave">Guardar resultados</button></div></div>`;
  if (!S.players) api('/api/admin/players').then((ps) => { S.players = ps.filter((p) => p.active); renderResEditor(); });
}
actions.resTeam = (el) => { S.res.teams[el.dataset.i][el.dataset.f] = el.value; };
// Carga los equipos equilibrados (y el orden del triangular) en el editor de resultados
actions.useProposedTeams = () => {
  const tp = S.detail.teams_proposal;
  const R = S.res;
  R.teams = tp.teams.map((t) => ({ name: t.name, color: t.color }));
  R.assign = {};
  tp.teams.forEach((t, i) => t.players.forEach((pl) => {
    R.assign[pl.player_id] = i;
    if (!R.players.some((x) => x.id === pl.player_id)) R.players.push({ id: pl.player_id, name: pl.name });
  }));
  R.players.sort((a, b) => a.name.localeCompare(b.name));
  const idx = new Map(tp.teams.map((t, i) => [t.name, i]));
  R.matches = tp.schedule.length
    ? tp.schedule.map((m) => ({ home: idx.get(m.home), away: idx.get(m.away), home_goals: 0, away_goals: 0 }))
    : [{ home: 0, away: 1, home_goals: 0, away_goals: 0 }];
  toast('Equipos propuestos cargados: apunta los marcadores'); renderResEditor();
};
actions.resAddTeam = () => { const n = S.res.teams.length; S.res.teams.push({ name: `Equipo ${n + 1}`, color: TEAM_COLORS[n % TEAM_COLORS.length] }); renderResEditor(); };
actions.resDelTeam = (el) => {
  const i = Number(el.dataset.i);
  S.res.teams.splice(i, 1);
  S.res.matches = S.res.matches.filter((m) => m.home !== i && m.away !== i).map((m) => ({ ...m, home: m.home > i ? m.home - 1 : m.home, away: m.away > i ? m.away - 1 : m.away }));
  for (const k of Object.keys(S.res.assign)) {
    if (S.res.assign[k] === i) delete S.res.assign[k];
    else if (S.res.assign[k] > i) S.res.assign[k]--;
  }
  renderResEditor();
};
actions.resAddMatch = () => { S.res.matches.push({ home: 0, away: 1, home_goals: 0, away_goals: 0 }); renderResEditor(); };
actions.resDelMatch = (el) => { S.res.matches.splice(Number(el.dataset.i), 1); renderResEditor(); };
actions.resMatch = (el) => {
  const m = S.res.matches[el.dataset.i];
  m[el.dataset.f] = Number(el.value) || 0;
};
actions.resAssign = (el) => {
  if (el.value === '') delete S.res.assign[el.dataset.pid]; else S.res.assign[el.dataset.pid] = Number(el.value);
};
actions.resStat = (el) => {
  const pid = el.dataset.pid;
  S.res.stats[pid] ??= { goals: 0, assists: 0, saves: 0, mvp: false };
  S.res.stats[pid][el.dataset.f] = el.type === 'checkbox' ? el.checked : Number(el.value) || 0;
};
actions.resNotes = (el) => { S.res.notes = el.value; };
actions.resAddPlayer = () => {
  const sel = document.getElementById('resAddPlayer');
  if (!sel.value) return;
  S.res.players.push({ id: Number(sel.value), name: sel.selectedOptions[0].textContent });
  renderResEditor();
};
actions.resSave = async () => {
  const R = S.res;
  const bad = R.matches.find((m) => m.home === m.away);
  if (bad) return toast('Un partido tiene el mismo equipo a los dos lados', true);
  const body = {
    teams: R.teams.map((t, i) => ({ ...t, player_ids: Object.entries(R.assign).filter(([, ti]) => ti === i).map(([pid]) => Number(pid)) })),
    matches: R.matches,
    stats: Object.entries(R.stats).map(([pid, s]) => ({ player_id: Number(pid), ...s })),
    notes: R.notes,
  };
  await api(`/api/admin/sessions/${S.adminSessionId}/results`, { method: 'PUT', body });
  S.res = null; toast('Resultados guardados'); location.hash = `#/resultados/${S.adminSessionId}`;
};

// --- Incidencias ---
async function adminIncidencias(el) {
  const [list, rules, players] = [await api('/api/admin/infractions'), await loadRules(), await api('/api/admin/players')];
  const sessions = S.overview.sessions;
  const pending = list.filter((i) => i.status === 'pending');
  const rest = list.filter((i) => i.status !== 'pending');
  const expelled = players.filter((p) => p.expelled);
  const typeOpts = (sel) => Object.entries(rules.infraction_types).map(([k, t]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(t.label)}</option>`).join('');
  const row = (i) => `<li style="flex-wrap:wrap">
    <span class="name"><strong>${esc(i.name)}</strong> · ${esc(fmtShort(i.date))}
      <small>${i.weeks === 2 ? '2 semanas' : '1 semana'} en P3${i.serious ? ' · <b>grave</b>' : ''} · ${i.source === 'auto' ? 'automática al borrarse' : i.source === 'attendance' ? 'desde asistencia' : 'manual'}
        ${i.created_by_name ? ` · registrada por ${esc(i.created_by_name)}` : ''}${i.updated_by_name ? ` · último cambio: ${esc(i.updated_by_name)}, ${esc(fmtDateTime(i.updated_at))}` : ''}</small>
      <select data-change="infType" data-id="${i.id}" aria-label="Tipo de incidencia" style="margin-top:.35rem;max-width:100%">${typeOpts(i.type)}</select>
      ${i.note ? `<small>Nota: ${esc(i.note)}</small>` : ''}</span>
    ${infStatusChip(i.status)}
    <span class="row">
      ${i.status !== 'confirmed' ? `<button class="btn-sm" data-act="infStatus" data-id="${i.id}" data-status="confirmed">Confirmar</button>` : ''}
      ${i.status !== 'justified' ? `<button class="btn-sm" data-act="infStatus" data-id="${i.id}" data-status="justified">Justificada</button>` : ''}
      <button class="btn btn-ghost btn-icon" data-act="infNote" data-id="${i.id}" aria-label="Editar la nota" title="Editar la nota">${icon('edit')}</button>
      <button class="btn btn-ghost btn-icon" data-act="infDelete" data-id="${i.id}" aria-label="Eliminar la incidencia" title="Eliminar">${icon('trash')}</button>
    </span></li>`;
  S.infractionsById = new Map(list.map((x) => [x.id, x]));
  el.innerHTML = `
  ${expelled.length ? `<div class="status-box danger">${icon('alert')}<div><strong>Fuera del equipo por dos faltas graves</strong>${expelled.map((p) => esc(p.name)).join(', ')}.
    No pueden apuntarse mientras tengan dos faltas graves confirmadas.</div></div>` : ''}
  <div class="card"><h2>Pendientes de revisar · ${pending.length}</h2>
    <p class="small muted">Se crean solas cuando alguien se borra fuera de plazo o sin avisar. Solo cuentan para la prioridad cuando las confirmas.</p>
    ${pending.length ? `<ul class="list">${pending.map(row).join('')}</ul>` : '<p class="muted">No hay nada pendiente.</p>'}</div>
  <div class="card"><h2>Registrar incidencia</h2>
    <div class="row">
      <select id="infSession" aria-label="Entreno">${sessions.map((s) => `<option value="${s.id}" ${s.id === S.adminSessionId ? 'selected' : ''}>${esc(fmtShort(s.date))}</option>`).join('')}</select>
      <select id="infPlayer" aria-label="Jugador"><option value="">Elige a quién…</option>${players.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select>
      <select id="infType" aria-label="Tipo de incidencia">${Object.entries(rules.infraction_types).map(([k, t]) => `<option value="${k}">${esc(t.label)}</option>`).join('')}</select>
    </div>
    <div class="row" style="margin-top:.5rem"><input id="infNote" placeholder="Nota (opcional)" style="flex:1"><button class="btn-primary" data-act="infCreate">Registrar</button></div></div>
  <div class="card"><h2>Historial · ${rest.length}</h2>${rest.length ? `<ul class="list">${rest.map(row).join('')}</ul>` : '<p class="muted">Todavía no hay incidencias.</p>'}</div>`;
}
actions.infStatus = async (el) => {
  await api(`/api/admin/infractions/${el.dataset.id}`, { method: 'PATCH', body: { status: el.dataset.status } });
  toast(el.dataset.status === 'justified' ? 'Marcada como justificada' : 'Incidencia confirmada'); render();
};
actions.infType = async (el) => {
  await api(`/api/admin/infractions/${el.dataset.id}`, { method: 'PATCH', body: { type: el.value } });
  toast('Tipo cambiado'); render();
};
actions.infNote = async (el) => {
  const inf = S.infractionsById.get(Number(el.dataset.id));
  const note = await textDialog({ title: `Nota de la incidencia de ${inf.name}`, label: 'Nota (la ve Coordinación)', value: inf.note || '' });
  if (note === null) return;
  await api(`/api/admin/infractions/${el.dataset.id}`, { method: 'PATCH', body: { note } });
  toast('Nota guardada'); render();
};
actions.infDelete = async (el) => {
  const inf = S.infractionsById.get(Number(el.dataset.id));
  if (!await confirmDialog({ title: `¿Eliminar la incidencia de ${inf.name}?`, body: 'Deja de contar para la prioridad. Queda registrado en Actividad.', confirm: 'Eliminar', danger: true })) return;
  await api(`/api/admin/infractions/${el.dataset.id}`, { method: 'DELETE' }); toast('Incidencia eliminada'); render();
};
actions.infCreate = async () => {
  const body = {
    session_id: Number(document.getElementById('infSession').value), player_id: Number(document.getElementById('infPlayer').value),
    type: document.getElementById('infType').value, note: document.getElementById('infNote').value,
  };
  if (!body.player_id) return toast('Elige un jugador', true);
  await api('/api/admin/infractions', { method: 'POST', body });
  toast('Incidencia registrada'); render();
};

// --- Jugadores ---
const ROLE_LABELS = { coordinador: 'Coordinación', gestor: 'Gestión', petos: 'Petos', balones: 'Balones' };

async function adminJugadores(el) {
  const players = await api('/api/admin/players');
  S.adminPlayers = players;
  const isCoord = !!(S.me && S.me.player.roles.includes('coordinador'));
  const roleToggles = (p) => Object.keys(ROLE_LABELS).map((code) => `
    <button type="button" class="toggle" aria-pressed="${p.roles.includes(code)}" ${isCoord ? '' : 'disabled'}
      data-act="toggleRole" data-id="${p.id}" data-role="${code}">${p.roles.includes(code) ? icon('check') : ''}${ROLE_LABELS[code]}</button>`).join('');
  const signupUrl = `${location.origin}/#/registro`;
  S.inviteText = `¡Hola! Para apuntarte a los entrenos de Fútbol 7 crea tu cuenta aquí: ${signupUrl}`;
  el.innerHTML = `
  <div class="card"><h2>Invita al equipo</h2>
    <p class="small muted">Comparte este enlace en el grupo de WhatsApp. Cada persona crea su cuenta y aparece aquí.</p>
    <div class="share-box"><code>${esc(signupUrl)}</code><button class="btn-sm" data-act="copyInvite">${icon('copy')} Copiar invitación</button></div>
  </div>
  <div class="card"><h2>Jugadores · ${players.filter((p) => p.active).length} activos</h2>
    <p class="small muted">Cada persona crea su cuenta. Aquí se asignan los roles: <strong>Coordinación</strong> (todo), <strong>Gestión</strong>
    (convocatorias, asistencia, resultados e incidencias) y <strong>Petos</strong> o <strong>Balones</strong> (material).
    ${isCoord ? '' : 'Solo Coordinación puede cambiar los roles.'}</p>
    ${players.map((p) => `<div class="player-row${p.active ? '' : ' dim'}">
      <div><strong>${esc(p.name)}</strong>
        <div class="contact">${esc(p.email || 'Sin email')}${p.phone ? ` · ${esc(p.phone)}` : ''}</div>
        <div class="contact">${p.last_login_at ? `Último acceso: ${esc(fmtDateTime(p.last_login_at))}` : 'Aún no ha entrado'}</div></div>
      <div class="player-controls" role="group" aria-label="Roles de ${esc(p.name)}">${roleToggles(p)}</div>
      <div class="player-flags">
        <label><input type="checkbox" ${p.active ? 'checked' : ''} data-change="playerField" data-id="${p.id}" data-f="active"> Activo</label>
        <label title="No le aplica el mínimo de asistencia"><input type="checkbox" ${p.attendance_exempt ? 'checked' : ''} data-change="playerField" data-id="${p.id}" data-f="attendance_exempt"> Exención</label>
        ${p.serious_infractions ? `<span class="chip ${p.expelled ? 'danger' : 'warn'}">${plural(p.serious_infractions, 'falta grave', 'faltas graves')}</span>` : ''}
      </div>
    </div>`).join('')}</div>`;
}

actions.copyInvite = () => copyText(S.inviteText);

// Cambia un rol: se envía el conjunto completo de roles del jugador
actions.toggleRole = async (el) => {
  const pid = Number(el.dataset.id);
  const p = S.adminPlayers.find((x) => x.id === pid);
  const roles = new Set(p.roles);
  if (el.getAttribute('aria-pressed') === 'true') roles.delete(el.dataset.role); else roles.add(el.dataset.role);
  try {
    const r = await api(`/api/admin/players/${pid}/roles`, { method: 'PUT', body: { roles: [...roles] } });
    p.roles = r.roles; toast(`Roles de ${p.name} guardados`);
  } catch (err) { toast(err.message, true); }
  if (S.me && pid === S.me.player.id) S.me = await api('/api/me');
  render();
};
actions.playerField = async (el) => {
  const v = el.type === 'checkbox' ? el.checked : el.value;
  await api(`/api/admin/players/${el.dataset.id}`, { method: 'PATCH', body: { [el.dataset.f]: v } });
  toast('Guardado');
  if (el.type === 'checkbox') render();
};

// ---------- Mi cuenta ----------

async function viewAccount() {
  if (!S.token) return viewLogin();
  S.me = await api('/api/me');
  const pl = S.me.player;
  const ROLE_NAMES = { coordinador: 'Coordinación', gestor: 'Gestión', petos: 'Petos', balones: 'Balones' };
  $app.innerHTML = `<div class="page-head"><h1>Mi cuenta</h1></div>
  <div class="grid grid-2">
    <form id="profileForm" class="card stack" novalidate>
      <h2>Tus datos</h2>
      <div class="grid grid-2" style="gap:.75rem">
        ${FIELD('Nombre', 'pfFirst', 'text', `autocomplete="given-name" required value="${esc(pl.first_name || pl.name.split(' ')[0] || '')}"`)}
        ${FIELD('Apellidos', 'pfLast', 'text', `autocomplete="family-name" required value="${esc(pl.last_name || pl.name.split(' ').slice(1).join(' '))}"`)}
      </div>
      ${FIELD('Teléfono', 'pfPhone', 'tel', `autocomplete="tel" required value="${esc(pl.phone || '')}"`)}
      ${FIELD('Email', 'pfEmail', 'email', `autocomplete="email" required value="${esc(pl.email || '')}"`)}
      <p class="small muted" style="margin:0">Solo los ve Coordinación. Con el email entras en la web.</p>
      <p class="status-box danger form-error" id="profileError" role="alert" hidden></p>
      <div><button class="btn-primary" type="submit">Guardar datos</button></div>
    </form>
    <div class="stack">
      <form id="pwForm" class="card stack" novalidate>
        <h2>Contraseña</h2>
        ${FIELD('Contraseña actual', 'pwCurrent', 'password', 'autocomplete="current-password" required')}
        ${FIELD('Nueva contraseña (mín. 8)', 'pwNext', 'password', 'autocomplete="new-password" minlength="8" required')}
        ${FIELD('Repite la nueva contraseña', 'pwNext2', 'password', 'autocomplete="new-password" minlength="8" required')}
        <p class="small muted" style="margin:0">Al cambiarla se cierra tu sesión en los demás dispositivos.</p>
        <p class="status-box danger form-error" id="pwError" role="alert" hidden></p>
        <div><button class="btn-primary" type="submit">Cambiar contraseña</button></div>
      </form>
      <div class="card"><h2>Sesión</h2>
        ${pl.roles.length ? `<p class="small">Tus roles: ${pl.roles.map((r) => `<span class="chip brand">${ROLE_NAMES[r] || r}</span>`).join(' ')}</p>` : ''}
        <div class="row">
          <a class="btn" href="#/salir">${icon('logout')} Cerrar sesión</a>
          <button class="btn-danger" data-act="logoutAll">Cerrar en todos los dispositivos</button>
        </div></div>
    </div>
  </div>`;
  const formError = (id, msg) => { const b = document.getElementById(id); b.textContent = msg; b.hidden = !msg; };
  document.getElementById('profileForm').onsubmit = (e) => {
    e.preventDefault();
    formError('profileError', '');
    withBusy(e.target, async () => {
      try {
        await api('/api/me/profile', { method: 'PATCH', body: {
          first_name: document.getElementById('pfFirst').value, last_name: document.getElementById('pfLast').value,
          phone: document.getElementById('pfPhone').value, email: document.getElementById('pfEmail').value,
        } });
        S.me = await api('/api/me'); renderAccount(); toast('Datos guardados');
      } catch (err) { formError('profileError', err.message); }
    });
  };
  document.getElementById('pwForm').onsubmit = (e) => {
    e.preventDefault();
    formError('pwError', '');
    const next = document.getElementById('pwNext').value;
    if (next !== document.getElementById('pwNext2').value) { formError('pwError', 'Las contraseñas nuevas no coinciden.'); return; }
    withBusy(e.target, async () => {
      try {
        await api('/api/me/password', { method: 'POST', body: { current: document.getElementById('pwCurrent').value, next } });
        e.target.reset(); toast('Contraseña cambiada');
      } catch (err) { formError('pwError', err.message); }
    });
  };
}
actions.logoutAll = async () => {
  if (!await confirmDialog({ title: '¿Cerrar sesión en todos los dispositivos?', body: 'Tendrás que volver a entrar en el móvil, el ordenador y donde la tengas abierta.', confirm: 'Cerrar en todos', danger: true })) return;
  await api('/api/auth/logout-all', { method: 'POST' });
  forgetSession(); toast('Sesión cerrada en todos los dispositivos'); location.hash = '#/entrar';
};

// ---------- Cuentas: entrar y registrarse ----------

function showFormError(msg) {
  const box = document.getElementById('formError');
  if (!box) return toast(msg, true);
  box.textContent = msg; box.hidden = false;
}

const FIELD = (label, id, type = 'text', extra = '') =>
  `<label class="field">${label}<input id="${id}" type="${type}" ${extra}></label>`;

async function viewLogin() {
  $app.innerHTML = `<div class="card" style="max-width:420px;margin:1rem auto">
    <h1>Entrar</h1>
    <form id="loginForm" class="stack">
      ${FIELD('Email', 'loginEmail', 'email', 'autocomplete="email" required')}
      ${FIELD('Contraseña', 'loginPw', 'password', 'autocomplete="current-password" required')}
      <p class="status-box danger form-error" id="formError" role="alert" hidden></p>
      <button class="btn-primary btn-big" type="submit">Entrar</button>
    </form>
    <p class="small muted" style="margin-top:1rem">¿Aún no tienes cuenta? <a href="#/registro">Regístrate</a></p></div>`;
  document.getElementById('loginForm').onsubmit = (e) => {
    e.preventDefault();
    withBusy(e.target, async () => {
      try {
        const r = await api('/api/auth/login', { method: 'POST', body: {
          email: document.getElementById('loginEmail').value, password: document.getElementById('loginPw').value } });
        S.token = r.token; localStorage.setItem('f7_token', r.token); S.me = null;
        toast(`Hola, ${r.player.name}`); location.hash = '#/';
      } catch (err) { showFormError(err.message); }
    });
  };
}

async function viewRegister() {
  $app.innerHTML = `<div class="card" style="max-width:480px;margin:1rem auto">
    <h1>Crear cuenta</h1>
    <p class="small muted">Tus datos solo los ve Coordinación. Con el email y la contraseña entrarás después.</p>
    <form id="regForm" class="stack">
      <div class="grid grid-2" style="gap:.75rem">
        ${FIELD('Nombre', 'regFirst', 'text', 'autocomplete="given-name" required')}
        ${FIELD('Apellidos', 'regLast', 'text', 'autocomplete="family-name" required')}
      </div>
      ${FIELD('Teléfono', 'regPhone', 'tel', 'autocomplete="tel" placeholder="600 000 000" required')}
      ${FIELD('Email', 'regEmail', 'email', 'autocomplete="email" required')}
      <div class="grid grid-2" style="gap:.75rem">
        ${FIELD('Contraseña (mín. 8)', 'regPw', 'password', 'autocomplete="new-password" minlength="8" required')}
        ${FIELD('Repite la contraseña', 'regPw2', 'password', 'autocomplete="new-password" minlength="8" required')}
      </div>
      <p class="status-box danger form-error" id="formError" role="alert" hidden></p>
      <button class="btn-primary btn-big" type="submit">Crear cuenta</button>
    </form>
    <p class="small muted" style="margin-top:1rem">¿Ya tienes cuenta? <a href="#/entrar">Entrar</a></p></div>`;
  document.getElementById('regForm').onsubmit = (e) => {
    e.preventDefault();
    const pw = document.getElementById('regPw').value;
    if (pw !== document.getElementById('regPw2').value) { showFormError('Las contraseñas no coinciden.'); document.getElementById('regPw2').focus(); return; }
    withBusy(e.target, async () => { try {
      const r = await api('/api/auth/register', { method: 'POST', body: {
        first_name: document.getElementById('regFirst').value,
        last_name: document.getElementById('regLast').value,
        phone: document.getElementById('regPhone').value,
        email: document.getElementById('regEmail').value,
        password: pw,
      } });
      S.token = r.token; localStorage.setItem('f7_token', r.token); S.me = null;
      try { localStorage.removeItem('f7_intro_done'); } catch (e2) { /* sin almacenamiento */ }
      toast('Cuenta creada. Te damos la bienvenida a la sección'); location.hash = '#/';
    } catch (err) { showFormError(err.message.endsWith('.') ? err.message : `${err.message}.`); } });
  };
}

// ---------- Modo claro / oscuro ----------
function currentTheme() {
  const set = document.documentElement.getAttribute('data-theme');
  if (set === 'light' || set === 'dark') return set;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function paintThemeToggle() {
  const dark = currentTheme() === 'dark';
  const btn = document.getElementById('themeToggle');
  btn.querySelector('use').setAttribute('href', dark ? '#i-sun' : '#i-moon');
  btn.setAttribute('aria-label', dark ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro');
}
document.getElementById('themeToggle').addEventListener('click', () => {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try { localStorage.setItem('f7_theme', next); } catch (e) { /* sin almacenamiento: solo esta visita */ }
  paintThemeToggle();
  // Los gráficos leen sus colores al pintarse
  if (location.hash.startsWith('#/clasificacion') && S.dash) renderDashboard();
});
paintThemeToggle();

// ---------- Inicio ----------
loadRules().catch(() => {});
(async () => {
  if (S.token) { try { S.me = await api('/api/me'); } catch (e) { /* sesión caducada: api() la cierra */ } }
  render();
})();
