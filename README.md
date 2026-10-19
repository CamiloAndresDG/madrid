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

## Arquitectura

- **Render** (plan gratuito) ejecuta la web: servidor Node/Express en [src/server.js](src/server.js).
- **Supabase** (plan gratuito) guarda los datos en Postgres. Las tablas se crean solas al arrancar
  ([src/db.js](src/db.js)) con RLS activado, así que la API pública de Supabase no puede leerlas.

## Publicarla (Supabase + Render)

1. **Supabase**: crea un proyecto (región Europa). En *Connect → Session pooler* copia la cadena de conexión
   (`postgresql://postgres.xxxx:[TU-CONTRASEÑA]@aws-0-eu-....pooler.supabase.com:5432/postgres`) y pon tu contraseña.
   Usa el *Session pooler*: la conexión directa es solo IPv6 y Render no la alcanza.
2. **Render**: el servicio está descrito en [render.yaml](render.yaml). En *Environment* añade:
   - `DATABASE_URL` = la cadena de Supabase
   - `ADMIN_PASSWORD` = la contraseña de coordinación
3. Abre la web, entra en **Coordinación → Jugadores**, pega los nombres (uno por línea) y envía a cada persona su enlace.

El plan gratuito de Render «duerme» el servicio tras 15 minutos sin visitas: la primera visita tarda unos 30–50 segundos.
Supabase pausa los proyectos gratuitos tras una semana sin actividad (con el uso semanal no debería pasar).

## Desarrollo en local

Requiere Node.js 20 o superior. No hace falta instalar Postgres: la demo y los tests usan uno embebido.

```bash
npm install
```

Demo con datos ficticios en http://localhost:3000 (contraseña de coordinación: `cambiame`):

```bash
npm run demo
```

Contra una base de datos real (por ejemplo Supabase):

```bash
DATABASE_URL=postgresql://... ADMIN_PASSWORD=una-contraseña-segura npm start
```

Para crear al equipo de coordinación de la presentación:

```bash
DATABASE_URL=postgresql://... npm run seed
```

### Tests

```bash
npm test
```
