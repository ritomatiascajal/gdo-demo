# GdO — Gestión de Obras Municipales (demo)

Prototipo de plataforma para que un municipio gestione y siga sus obras: mapa con semáforo,
fichas de obra, carga de avances con foto y GPS desde el celular, circuito de validación y
certificados, y visor público para vecinos.

**Todos los datos son ficticios.** Desarrollado por **HydroGIS** — hydrogis.arg@gmail.com · Instagram @hydrogis.arg · Córdoba, Argentina.

## Stack
- Base de datos: Supabase (Postgres + PostGIS, Auth, Storage, API automática). Plan gratuito.
- Web y app del inspector: HTML/JS estático + Leaflet, publicado en GitHub Pages. Sin servidor propio.

## Visor web y tablero
`index.html` + `js/` + `css/`. Se publica con GitHub Pages (Settings > Pages > Deploy from branch > main / root).
- Pantalla de inicio: el visitante elige **vecino** (visor público, sin usuario) o **funcionario** (ingresa con usuario).
- Vecino: obras publicadas, estado y avance, sin montos de certificados.
- Funcionario: tablero con semáforo, indicadores, ítems, certificados, fotos y validación de mediciones.
- Secretario OO.PP., Jefe de SSPP y Administrador: alta y edición de obras (ubicación marcada en el mapa,
  estado, contratista, inspector, publicación en el visor) y de sus ítems (no se borra un ítem con mediciones).
- Modo claro / oscuro (botón ☾/☀), recordado en el navegador; también en la app del inspector.

## App del inspector
`inspector.html` (se instala en el celular desde el navegador: menú ⋮ → "Agregar a la pantalla principal").
Ingresa solo el rol Inspector de obra. Flujo: mis obras → ítem → cantidad + fotos con GPS → queda Pendiente.
Las fotos se achican a 1600 px y se guardan en el bucket privado `fotos`; la app avisa si la foto se toma a más
de `radio_foto_m` metros de la obra. El Secretario / Jefe de SSPP las ve y aprueba u observa desde la ficha del tablero.

La configuración (URL del proyecto y clave publicable de Supabase) está en `js/config.js`.

## Estructura
```
index.html, js/, css/   visor web y tablero
inspector.html          app del inspector (manifest.json + sw.js la hacen instalable)
sql/
  01_esquema.sql        tablas, restricciones y vistas calculadas (avance, desvío, semáforo…)
  02_datos_ejemplo.sql  datos del Excel modelo (16 obras, 68 ítems, 193 mediciones, 88 fotos, 31 certificados)
  03_seguridad.sql      roles y permisos (RLS) + bucket privado "fotos"
  04_usuarios_demo.sql  vincula logins de prueba con roles
tools/
  excel_a_sql.py        regenera 02 a partir del Excel
```

## Instalar la base
En Supabase > SQL Editor, pegar y correr en orden `01`, `02`, `03`. Después crear los logins de
prueba y correr `04`. Para empezar de cero, volver a correr `01 → 02 → 03 → 04`.

## Modelo
| Tabla | Qué guarda |
|---|---|
| `obras` | Tabla central. Geometría PostGIS (punto, línea o polígono). |
| `items` | Cómputo y presupuesto; `subtotal` = cantidad × precio unitario. |
| `mediciones` | Avance por ítem y período. Circuito Pendiente → Aprobada / Observada / Rechazada. |
| `fotos` | Foto georreferenciada; el archivo va al bucket `fotos`. |
| `certificados` | Solo obras por contrato. En revisión → Aprobado → Liquidado → Pagado. |
| `partes_diarios` | Libro de obra (clave en obras por administración). |
| `usuarios`, `contratistas`, `catalogos`, `parametros` | Actores, listas de valores y supuestos. |

| Vista | Uso |
|---|---|
| `v_obras` | Obra + presupuesto, avance físico y previsto, desvío, semáforo, escala, pagado. |
| `v_items`, `v_mediciones`, `v_fotos`, `v_certificados` | Calculados por ítem, medición, foto (distancia a la obra) y certificado (fondo de reparo, respaldo). |
| `v_resumen` | Indicadores del tablero. |
| `v_obras_publicas` | Único acceso del vecino (sin login): obras publicadas, campos públicos. |

## Roles
Intendente · Secretario de Obras Públicas · Jefe de Servicios Públicos · Inspector de obra ·
Contaduría · Administrador del sistema · Vecino (anónimo). Detalle en `sql/03_seguridad.sql`.
