# perfilafiliados-mcp

Worker de Cloudflare para la taxonomía CPV de `PerfilAfiliadosCPV` — ver
`docs/taxonomia/plan_mcp_cira.md` en ese repo para el plan completo.

## Estado actual

**Fase MCP-1, arranque.** Por ahora expone un solo endpoint interno, `/embed`, usado por el
comando `taxonomy:generate-embeddings` de Laravel para poblar `taxonomy_category_embeddings` en
Supabase por lote. Las tools MCP en sí (`search_taxonomy`, `list_sectores`,
`list_taxonomy_groups`, servidas por SSE para el nodo MCP Client Tool de n8n) se agregan sobre
este mismo Worker más adelante — no es un servicio descartable.

- Modelo: `@cf/baai/bge-m3` (multilingüe, ES/EN sin distinción).
- Dimensión real del vector, **verificada empíricamente** contra el modelo desplegado (no
  asumida): **1024**.
- URL desplegada: `https://perfilafiliados-mcp.sisteg.workers.dev`
- Auth: Bearer token propio (`EMBED_TOKEN`, secret del Worker vía `wrangler secret put` — no
  vive en este repo). El mismo valor se guarda en el `.env` local de `PerfilAfiliadosCPV`
  (`MCP_EMBED_TOKEN`) para que el comando de Laravel lo use.

## Desarrollo

```bash
npm install
npm run dev      # wrangler dev, local
npm run deploy   # wrangler deploy
```

Después de desplegar, si cambia el token: `npx wrangler secret put EMBED_TOKEN`.
