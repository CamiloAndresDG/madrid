# Fútbol 7 Gmadrid · Convocatorias

Web para gestionar los entrenamientos de la sección de Fútbol 7 (temporada 26/27):
confirmar asistencia, aplicar el sistema de prioridades, generar la lista final del lunes,
registrar incidencias y apuntar los resultados de cada entreno.

## Cómo funciona

**Jugadores** (con su enlace personal, sin contraseña):
- Ven el próximo entrenamiento y pulsan **Voy / No voy**. La convocatoria se abre el domingo a las 17:00.
- Ven la lista en directo: titulares, reservas, su puesto y su prioridad (con el motivo).
- Al borrarse fuera de plazo se les avisa de la consecuencia y se crea una incidencia *pendiente* para que Coordinación la revise.
- Pueden consultar la clasificación, los resultados y las normas.

**Coordinación** (`/#/admin`, con contraseña):
- **Convocatoria**: crear entrenamientos, plazas (14/16…), encargados de petos y balones, añadir o quitar gente,
  **generar la lista final** (congela el orden) y copiar el mensaje para WhatsApp.
- **Asistencia**: pasar lista (Asistió / Llegó tarde / No se presentó / Falta justificada / Fuera por lista llena).
  «Llegó tarde» y «No se presentó» crean la incidencia automáticamente.
- **Resultados**: equipos (con color), partidos y marcador, goles, asistencias, paradas, MVP y notas.
- **Incidencias**: revisar las pendientes (confirmar / justificada), registrar otras a mano, ver quién tiene 2 faltas graves.
- **Jugadores**: alta masiva, enlaces personales, coordinadores, bajas, exentos del mínimo de asistencia.

### Sistema de prioridades

El orden de entrada es: primero la prioridad, después la hora de inscripción.

| Prioridad | Quién |
|---|---|
| P1 | No asistió al entrenamiento anterior · al menos un coordinador |
| P2 | Sí asistió al entrenamiento anterior |
| P3 | Cometió una infracción en el entrenamiento anterior (o una de 2 semanas en el de antes) |

Infracciones (definidas en [src/logic.js](src/logic.js)):

| Infracción | Semanas en P3 | Grave |
|---|---|---|
| Llegar después de las 21:50 sin avisar | 1 | |
| Borrarse después de las 15h del martes | 1 | |
| Borrarse estando en reservas sin avisar al coordinador | 1 | |
| Borrarse estando en titulares sin avisar al coordinador | 2 | |
| No presentarse estando inscrito | 2 | ✔ |
| Borrarse después de las 15h del miércoles | 2 | ✔ |

Dos faltas graves confirmadas en la temporada → la persona no puede apuntarse (queda fuera del equipo).
Solo cuentan las incidencias **confirmadas**; las marcadas como justificadas no penalizan.

«Asistir» se toma de la lista que pasa Coordinación. Si no se pasa lista, se asume que fueron los titulares.

La clasificación muestra los entrenos del trimestre frente al mínimo de 4 (quedarse fuera por lista llena cuenta a favor).

## Ponerlo en marcha

Requiere Node.js 22.13 o superior (usa la base de datos SQLite integrada en Node, sin instalar nada más).

```bash
npm install
```

```bash
ADMIN_PASSWORD=una-contraseña-segura npm start
```

La web queda en http://localhost:3000. Los datos se guardan en `data/futbol7.db` (cópialo para hacer copias de seguridad).

Para crear al equipo de coordinación de la presentación:

```bash
npm run seed
```

Después, desde **Coordinación → Jugadores**, pega los nombres de la sección (uno por línea) y envía a cada persona su enlace.

### Demo con datos ficticios

```bash
DB_PATH=data/demo.db npm run seed -- --demo
```

```bash
node scripts/dev-demo.js
```

### Tests

```bash
npm test
```

### Publicarla en internet

Cualquier servicio que ejecute Node con disco persistente sirve (Render, Railway, Fly.io, un VPS…).
Configura las variables `ADMIN_PASSWORD`, `PORT` (si el servicio lo pide) y `DB_PATH` apuntando a un volumen persistente.
