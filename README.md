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

  **Tolerancia a errores de tipeo (11 sep 2026)**: `search_empresas`/`get_empresa` intentan primero
  el match exacto/parcial de siempre; si esa pasada no devuelve nada y el usuario dio texto libre,
  reintentan con `similarity()`/`word_similarity()` de `pg_trgm` (extensión ya instalada en este
  proyecto de Supabase, v1.6). Cada fila trae `match_type: 'exact'|'fuzzy'` para distinguir un match
  literal de uno aproximado. Umbral 0.35, ajustado contra datos reales (typos verificados: 0.53-1.0
  de similitud; pares realmente distintos como "fabricantes" vs "suplidores": 0.045 — sin falsos
  positivos). Idea tomada de [cómo Mercadona Tech construyó su
  buscador](https://newsletter.gemba.es/p/como-construimos-nuestro-buscador), adaptada a nuestra
  escala real (cientos de empresas, no millones de búsquedas): se usó solo la pieza de tolerancia a
  typos vía trigramas, sin el resto de su stack de ranking con ML (no aplica a este volumen de datos
  ni hay señales de clics para entrenar nada).

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
