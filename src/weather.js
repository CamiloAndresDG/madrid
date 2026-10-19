// Previsión del tiempo para la hora del entreno (Open-Meteo, gratis y sin clave).
// Si falla o el entreno está a más de 15 días, no se muestra nada: nunca bloquea la convocatoria.

const COORDS = { lat: 40.404, lon: -3.717 }; // Polideportivo Marqués de Samaranch (Madrid)
const TTL_MS = 30 * 60 * 1000;
const MAX_DAYS = 15;
const cache = new Map();

const CODES = [
  [[0], '☀️', 'Despejado'], [[1], '🌤️', 'Casi despejado'], [[2], '⛅', 'Nubes y claros'], [[3], '☁️', 'Nublado'],
  [[45, 48], '🌫️', 'Niebla'], [[51, 53, 55, 56, 57], '🌦️', 'Llovizna'], [[61, 63, 66, 80, 81], '🌧️', 'Lluvia'],
  [[65, 67, 82], '🌧️', 'Lluvia fuerte'], [[71, 73, 75, 77, 85, 86], '❄️', 'Nieve'], [[95, 96, 99], '⛈️', 'Tormenta'],
];
const RAIN_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);

// Gracia interna para cuando llueve
const RAIN_JOKE = 'Dress code oficial por lluvia: ropa blanca. Ya sabéis por qué 😏';

function describe(code) {
  const hit = CODES.find(([codes]) => codes.includes(code));
  return hit ? { icon: hit[1], label: hit[2] } : { icon: '🌡️', label: 'Sin datos del cielo' };
}

// Convierte la respuesta horaria de Open-Meteo en la previsión de la hora del entreno
function pick(data, date, startTime) {
  const hour = `${date}T${String(startTime || '22:00').slice(0, 2)}:00`;
  const h = data?.hourly;
  const i = h?.time ? h.time.indexOf(hour) : -1;
  if (i < 0) return null;
  const code = h.weather_code[i];
  const prob = h.precipitation_probability?.[i] ?? null;
  const mm = h.precipitation?.[i] ?? 0;
  const rain = RAIN_CODES.has(code) || (prob ?? 0) >= 50 || mm >= 0.5;
  return {
    ...describe(code),
    temp: Math.round(h.temperature_2m[i]),
    rain_prob: prob,
    rain_mm: Math.round(mm * 10) / 10,
    wind: Math.round(h.wind_speed_10m[i]),
    rain,
    joke: rain ? RAIN_JOKE : null,
    hour: hour.slice(11),
  };
}

function daysUntil(date) {
  return Math.round((Date.parse(`${date}T12:00:00Z`) - Date.now()) / 86400000);
}

async function forecast(date, startTime) {
  if (process.env.WEATHER === 'off' || !date) return null;
  const days = daysUntil(date);
  if (days < -1 || days > MAX_DAYS) return null;
  const key = `${date}|${startTime}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  let value = null;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${COORDS.lat}&longitude=${COORDS.lon}`
      + '&hourly=temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m'
      + `&timezone=Europe%2FMadrid&start_date=${date}&end_date=${date}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (res.ok) value = pick(await res.json(), date, startTime);
  } catch { /* sin red o servicio caído: sin previsión */ }
  cache.set(key, { at: Date.now(), value });
  return value;
}

module.exports = { forecast, pick, describe, RAIN_JOKE };
