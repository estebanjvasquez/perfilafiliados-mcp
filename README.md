# perfilafiliados-mcp

Worker de Cloudflare para la taxonomía CPV de `PerfilAfiliadosCPV` — ver
`docs/taxonomia/plan_mcp_cira.md` en ese repo para el plan completo.

## Estado actual (11 sep 2026)

**Fases MCP-1 y MCP-3 cerradas** (MCP-2, la integración con n8n, vive en el repo
`PerfilAfiliadosCPV`). Dos endpoints:

- **`/embed`** (Bearer `EMBED_TOKEN`) — usado por `taxonomy:generate-embeddings` de Laravel para
  poblar `taxonomy_category_embeddings` en Supabase por lote (3.483 nodos cargados).
- **`/mcp`** (Bearer `MCP_TOKEN`) — el servidor MCP en sí, con 5 tools:

  | Tool | Qué hace | Fuente de datos |
  |---|---|---|
  | `search_taxonomy` | Búsqueda híbrida (léxica + semántica) por texto libre ES/EN | `taxonomy_categories` + embeddings |
  | `list_sectores` | Catálogo plano de sectores institucionales | `sectors` |
  | `list_taxonomy_groups` | Navega el árbol CPV (sin `parent_code`: 48 Grupos; con uno: sus hijos) | `taxonomy_categories` |
  | `search_empresas` | Busca empresas por texto libre/sector/ciudad/categoría CPV | `empresas` + `empresa_sector_service` + `services` + `sectors` + `cities` |
  | `get_empresa` | Ficha completa de una empresa por RIF exacto o nombre parcial | ídem |

  `search_empresas`/`get_empresa` (Fase MCP-3, 11 sep 2026) filtran solo `status_id = 1`
  (empresas activas — resuelve la decisión pendiente #4 del plan, hoy coincide con las 406). El
  filtro `categoria_codigo`/`tipo_oferta` está armado pero **sin datos reales todavía**:
  `empresa_taxonomy_category` sigue en 0 filas (Fase 3/4 de homologación del proyecto de
  taxonomía, aparte de este MCP, sin correr) — devuelve vacío, no error. El sector/servicio real
  de cada empresa sale del pivote `empresa_sector_service` (950 filas reales), el mismo join que
  ya usa `Empresa::distinctSectorIds()` en Laravel — no de `empresas.sector_principal_id`, que
  está NULL en muchas filas.

  **Limitación real encontrada (no es bug, es del propio dato)**: el catálogo `services` tiene
  solo 112 entradas curadas — más angosto que el texto libre de la columna `Servicios` de la
  vieja vista MySQL `ChatView` que usa CIRA hoy. Una búsqueda como `"soldadura"` puede devolver
  vacío acá aunque ChatView sí tenga empresas con esa palabra en su texto libre — a tener en
  cuenta al comparar contra el comportamiento de producción en la Fase MCP-4.

  **Bug real encontrado y corregido (11 sep 2026, aplica también a `search_taxonomy`)**: a
  diferencia de MySQL, Postgres SÍ distingue tildes en `ILIKE` — `"construccion"` no matcheaba
  `"CONSTRUCCIÓN"` sin `unaccent()`. Todo el matching de texto de este Worker usa
  `unaccent(columna) ilike unaccent(termino)` en ambos lados por este motivo.

  **Búsqueda híbrida en 3 niveles (11 sep 2026, `search_empresas`)** — cada nivel solo se activa si
  el anterior no devolvió nada, idea tomada de [cómo Mercadona Tech construyó su
  buscador](https://newsletter.gemba.es/p/como-construimos-nuestro-buscador) pero adaptada a
  nuestra escala real (cientos de empresas, no millones de búsquedas — se tomó solo la idea de
  híbrido léxico+semántico, no su stack de ranking con ML):
  1. **Exacto** — `unaccent(columna) ilike unaccent(término)` de siempre.
  2. **Difuso** (`pg_trgm`, ya instalado en este proyecto de Supabase, v1.6) — tolera errores de
     tipeo (`"consturccion"` → CONSTRUCCIÓN) vía `word_similarity()` contra servicio/sector (NO
     contra nombre de empresa — con 406 nombres reales, un término corto choca por coincidencia con
     nombres sin relación, ej. "grua" vs "GRUPO PROMARGON" da el mismo score que un match genuino).
     Umbral 0.5, calibrado contra datos reales.
  3. **Semántico** (mismo modelo `@cf/baai/bge-m3` que `search_taxonomy`, nueva tabla
     `service_embeddings` — un embedding por cada uno de los 112 servicios del catálogo + su
     sector) — encuentra el servicio conceptualmente más cercano aunque no comparta ninguna raíz
     literal (`"valvulas"` → cae cerca de "TUBERÍAS, TUBOS Y CONEXIONES"). Acotado a los 3 servicios
     MÁS cercanos (no "todos los que pasen el umbral" — una consulta larga en lenguaje natural puede
     caer cerca de 20+ de los 112 servicios sin ser relevante). Umbral de distancia coseno 0.60. No
     resuelve `"grua"` (equipos de izamiento): es un hueco real del catálogo, ningún servicio real
     cubre eso — ni el trigrama ni el embedding deberían inventar una respuesta ahí, y no la dan.

  Cada fila devuelta trae `match_type: 'exact'|'fuzzy'|'semantic'` para distinguir el tipo de match.

  Servido con `createMcpHandler` (`agents/mcp/server`, sobre `@modelcontextprotocol/server`) —
  soporta ambas eras del protocolo (SSE legacy 2025 y Streamable HTTP moderno 2026-07-28) desde el
  mismo endpoint por defecto, sin tener que elegir transporte para que conecte el nodo "MCP Client
  Tool" de n8n.

### Hallazgo real al calibrar `search_taxonomy` (11 sep 2026)

La búsqueda semántica **pura** falla para sinónimos locales cortos: `"arbolito"` (jerga
venezolana de "API 6A Wellhead Valves") embebido solo, sin contexto, cae semánticamente cerca de
"Grafito"/"Aluminio" — el modelo captura el significado del texto completo, no hace matching de
substring, así que un término corto y ambiguo no se acerca solo por *contener* la palabra en el
texto embebido de otro nodo. Por eso `search_taxonomy` es **híbrido de entrada**: intenta léxico
exacto/parcial primero (rápido y preciso para jerga conocida, vía `taxonomy_category_synonyms` +
nombres) y complementa con semántico (para consultas conceptuales en lenguaje natural, donde sí
funciona muy bien — verificado con `"necesito comprar válvulas para el cabezal de un pozo
petrolero"` → top resultados todos de la familia Válvulas/Valves). Verificado en vivo contra el
endpoint real: `"arbolito"` devuelve `CPV-05.01` (Válvulas de Cabezal de Pozo API 6A) como primer
resultado, vía coincidencia léxica.

### Infraestructura

- Modelo de embeddings: `@cf/baai/bge-m3` (multilingüe, ES/EN sin distinción). Dimensión real del
  vector, **verificada empíricamente** contra el modelo desplegado (no asumida, la documentación
  de Cloudflare no la especifica): **1024**.
- Acceso a Postgres/Supabase: **Hyperdrive** (`perfilafiliados-taxonomy`,
  `f16a1ab0a9514504b80bd14138699d4c`) + `postgres.js` — Workers no sostiene bien TCP directo
  contra el pooler de Supabase en cada invocación sin este pooling intermedio.
- URL desplegada: `https://perfilafiliados-mcp.sisteg.workers.dev`
- Auth: 2 Bearer tokens propios, independientes entre sí — `EMBED_TOKEN` y `MCP_TOKEN`, ambos
  secrets del Worker (`wrangler secret put`, nunca en este repo). Los mismos valores viven en el
  `.env` local de `PerfilAfiliadosCPV` (`MCP_EMBED_TOKEN`/`MCP_TOKEN`) para que Laravel y (más
  adelante) n8n los usen.

## Desarrollo

```bash
npm install
npm run dev      # wrangler dev, local
npm run deploy   # wrangler deploy
```

Después de desplegar, si cambia algún token: `npx wrangler secret put EMBED_TOKEN` /
`npx wrangler secret put MCP_TOKEN`.

## Probar `/mcp` a mano (sin n8n)

```bash
curl -X POST https://perfilafiliados-mcp.sisteg.workers.dev/mcp \
  -H "Authorization: Bearer $MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```
