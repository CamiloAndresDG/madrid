# Fútbol 7 Gmadrid · Convocatorias

Web para gestionar los entrenamientos de la sección de Fútbol 7 (temporada 26/27):
confirmar asistencia, aplicar el sistema de prioridades, generar la lista final del lunes,
registrar incidencias y apuntar los resultados de cada entreno.

## Cómo funciona

**Cuentas**: cada persona se registra con nombre, apellidos, teléfono, email y contraseña, y después entra con su email.
Las contraseñas se guardan con scrypt y las sesiones duran 30 días (solo se guarda el hash del token).

**Roles** (un jugador puede tener varios; los asigna un coordinador en *Coordinación → Jugadores*):

| Rol | Puede |
|---|---|
| Coordinador/a | Todo, incluido cambiar roles (siempre queda al menos uno) |
| Gestor/a | Convocatorias, asistencia, resultados e incidencias |
| Petos / Balones | Responsables del material; aparecen como tales en la convocatoria |

**Jugadores** (con su cuenta):
- Ven el próximo entrenamiento y pulsan **Voy / No voy**. La convocatoria se abre el domingo a las 17:00.
- Ven la lista en directo: titulares, reservas, su puesto y su prioridad (con el motivo).
- Al borrarse fuera de plazo se les avisa de la consecuencia y se crea una incidencia *pendiente* para que Coordinación la revise.
- Pueden consultar la clasificación, los resultados y las normas.

**Coordinación** (`/admin`, cuentas con rol de coordinador o gestor):
- **Publicar convocatorias**: se crean como borrador o publicadas; «Publicar y abrir inscripciones ya» hace que
  aparezcan al momento a los jugadores. Se editan fecha, hora de inicio y de llegada, lugar, plazas, apertura y notas.
- **Equipos automáticos**: con cada inscripción se reequilibran según las estadísticas (puntos por partido, goles y
  asistencias). Hasta 17 titulares, partido de 2 equipos; desde 18, triangular de 3 equipos con partidos de 8 minutos.
  En «Resultados» se cargan con «Usar equipos propuestos».
- **Material**: quién se lleva cada cosa (petos amarillos, naranjas, balones… y lo que se añada), con historial.
- **Actividad**: cada cambio de coordinación queda registrado con autor, fecha y hora
  (p. ej. «Camilo asignó a Andrés los Petos amarillos tras el entreno del 21/10 · mié 21 oct, 23:05»).
- **Convocatoria**: crear entrenamientos, plazas (14/16…), encargados de petos y balones, añadir o quitar gente,
  **generar la lista final** (congela el orden) y copiar el mensaje para WhatsApp.
- **Asistencia**: pasar lista (Asistió / Llegó tarde / No se presentó / Falta justificada / Fuera por lista llena).
  «Llegó tarde» y «No se presentó» crean la incidencia automáticamente.
- **Resultados**: equipos (con color), partidos y marcador, goles, asistencias, paradas, MVP y notas.
- **Incidencias**: revisar las pendientes (confirmar / justificada), registrar otras a mano, ver quién tiene 2 faltas graves.
- **Jugadores**: roles, bajas y exentos del mínimo de asistencia.

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
   - `COORDINATOR_EMAIL` = el email con el que se registrará el primer coordinador (recibe el rol automáticamente)
3. Regístrate en la web con ese email: tendrás el rol de coordinador y podrás dar roles al resto desde **Coordinación → Jugadores**.
4. Comparte el enlace de la web: cada persona crea su cuenta en *Crear cuenta*.

El plan gratuito de Render «duerme» el servicio tras 15 minutos sin visitas: la primera visita tarda unos 30–50 segundos.
Supabase pausa los proyectos gratuitos tras una semana sin actividad (con el uso semanal no debería pasar).

## Desarrollo en local

Requiere Node.js 20 o superior. No hace falta instalar Postgres: la demo y los tests usan uno embebido.

```bash
npm install
```

Demo con datos ficticios en http://localhost:3000 (cuentas `jugador01@example.com` … `jugador28@example.com`, contraseña `demo1234`; `jugador01` es coordinador y `jugador02` gestor):

```bash
npm run demo
```

Contra una base de datos real (por ejemplo Supabase):

```bash
DATABASE_URL=postgresql://... COORDINATOR_EMAIL=tu@email.com npm start
```

### Tests

```bash
npm test
```
