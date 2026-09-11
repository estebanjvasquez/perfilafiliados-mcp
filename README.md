# perfilafiliados-mcp

Worker de Cloudflare para la taxonomía CPV de `PerfilAfiliadosCPV` — ver
`docs/taxonomia/plan_mcp_cira.md` en ese repo para el plan completo.

## Estado actual (11 sep 2026)

**Fase MCP-1 cerrada.** Dos endpoints:

- **`/embed`** (Bearer `EMBED_TOKEN`) — usado por `taxonomy:generate-embeddings` de Laravel para
  poblar `taxonomy_category_embeddings` en Supabase por lote (3.483 nodos cargados).
- **`/mcp`** (Bearer `MCP_TOKEN`) — el servidor MCP en sí, con 3 tools que no dependen de la
  homologación empresa↔categoría (Fase 3/4 de la taxonomía, todavía sin correr):

  | Tool | Qué hace |
  |---|---|
  | `search_taxonomy` | Búsqueda híbrida (léxica + semántica) por texto libre ES/EN |
  | `list_sectores` | Catálogo plano de sectores institucionales |
  | `list_taxonomy_groups` | Navega el árbol CPV (sin `parent_code`: 48 Grupos; con uno: sus hijos) |

  `search_empresas`/`get_empresa` se agregan en la Fase MCP-3, cuando `empresa_taxonomy_category`
  tenga datos reales.

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
