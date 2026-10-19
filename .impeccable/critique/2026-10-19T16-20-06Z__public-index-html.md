---
target: la página (app completa)
total_score: 24
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:C:\\Users\\camil\\Documents\\GitHub\\madrid\\public\\index.html"
target_fingerprint: "sha256:985eb92cd1194d05d2274dcd966f0f3894b2265abe77007ae53420657cec0325"
target_path: "C:\\Users\\camil\\Documents\\GitHub\\madrid\\public\\index.html"
timestamp: 2026-10-19T16-20-06Z
slug: public-index-html
---
# Crítica de diseño — Fútbol 7 Gmadrid (public/index.html, app SPA)
Método: dual-agent (A: revisión de diseño · B: detector + navegador)

## Puntuación (Nielsen)
1 Estado del sistema 3 · 2 Mundo real 3 · 3 Control 2 · 4 Coherencia 2 · 5 Prevención 2 · 6 Reconocimiento 3 · 7 Eficiencia 2 · 8 Minimalismo 2 · 9 Recuperación 2 · 10 Ayuda 3 → 24/40 (Aceptable)

## Veredicto de especificidad
~60 % plantilla: pila de tarjetas blancas idénticas, emojis como iconos, «Hola, Jugador 👋», lavado arcoíris en .card.featured, píldoras en todo, botones Unbounded mayúsculas diminutos, KPIs+gráficos+leaderboards de stock, Unbounded gastada en cada h2.
Detector: overused-font (Inter, index.html:12); border-accent-on-rounded styles.css:173 (falso positivo). Navegador: gradient-text + ai-color-palette en .rainbow-text y .card.featured; blanco sobre #E5197E 4,4:1 (<4,5) en .btn-primary y nav activo; P1/P2/P3 en oscuro <3:1; span.who recortado en Líderes.

## Problemas prioritarios
- [P1] Inicio sin foco único (estado como titular, Voy único primario, material en el hero, ocultar Equipos vacío, incidencias a Mi temporada) → distill, layout
- [P1] Piel genérica: emojis, lavados, píldoras, CTAs gritonas → quieter, typeset, bolder
- [P1] Asistencia en móvil pesada y propensa a errores (por defecto Asistió, barra fija de guardar, confirmar incidencias, sesión recién jugada por defecto) → harden, adapt
- [P2] Navegación móvil desborda; rosa = ok y sanción; contraste 4,4:1 → layout, colorize
- [P2] Rankings e incidencias públicas; puesto 20 vs 21; decimales con punto → clarify, delight

## Personas
Coordinador: Coordinación fuera de pantalla, sin atajo a pasar lista, 90 botones, Eliminar sin jerarquía, tabla Jugadores desborda.
Teclado/lector: sin :focus-visible, sin aria-pressed/aria-current, emojis leídos, lista sin aria-live.
Móvil/pulgar: navegación arriba, botones 32px, toast vacío asoma 9px.

## Menores
«1 grave(s)», decimales con punto, «Hola, Jugador», barras «/a», Normas (lunes) vs plazo (martes 15h), Resultados como enlace suelto, subtítulo de marca ilegible.

## Preguntas
¿Pantalla de las 21:30 del miércoles? ¿Ranking de puntos en un club de pertenencia? ¿Dónde está lo queer más allá del degradado?
