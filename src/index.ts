/**
 * perfilafiliados-mcp — Worker de infraestructura para la taxonomia CPV de PerfilAfiliadosCPV.
 *
 * Fase MCP-1 (ver docs/taxonomia/plan_mcp_cira.md del repo PerfilAfiliadosCPV):
 *
 * - `/embed` — endpoint interno (Bearer EMBED_TOKEN) usado por `taxonomy:generate-embeddings` de
 *   Laravel para poblar `taxonomy_category_embeddings` en Supabase por lote.
 * - `/mcp` — el servidor MCP en si (Bearer MCP_TOKEN). Fase MCP-1: `search_taxonomy`,
 *   `list_sectores`, `list_taxonomy_groups` (src/taxonomy-tools.ts). Fase MCP-3: `search_empresas`,
 *   `get_empresa` (src/empresa-tools.ts), contra las tablas reales de empresas en Postgres/Supabase
 *   (no la vista MySQL `ChatView` que usa CIRA en produccion hoy).
 *   `createMcpHandler` (paquete `agents/mcp/server`, que envuelve `@modelcontextprotocol/server`)
 *   sirve ambas eras del protocolo (legacy SSE 2025 y moderno Streamable HTTP 2026-07-28) desde el
 *   mismo endpoint por defecto (`legacy: 'stateless'`) - no hace falta elegir un transporte fijo
 *   para que el nodo "MCP Client Tool" de n8n conecte, sea cual sea la opcion que tenga elegida.
 *
 * Modelo de embeddings: @cf/baai/bge-m3 (multilingue, ES/EN sin distincion - clave porque la
 * taxonomia esta en los dos idiomas). Dimension real del vector, verificada empiricamente contra
 * el modelo real (no asumida de la documentacion de Cloudflare, que no la especifica): 1024.
 */

import { createMcpHandler } from 'agents/mcp/server';
import { McpServer } from '@modelcontextprotocol/server';
import { registerTaxonomyTools } from './taxonomy-tools';
import { registerEmpresaTools } from './empresa-tools';
import { registerIntentTools } from './intent-tools';
import { resolveDebugSearch } from './debug-search';

export interface Env {
	AI: Ai;
	HYPERDRIVE: Hyperdrive;
	EMBED_TOKEN: string;
	MCP_TOKEN: string;
	OPENAI_API_KEY: string;
	// Fase 23B: token propio, independiente de MCP_TOKEN/EMBED_TOKEN - protege /debug-search, un
	// endpoint de solo lectura para el modo DEBUG de public/cira-test/index.html. Deliberadamente
	// NO se embebe en esa página (sin login) - la página guarda esta clave en sessionStorage cuando
	// el admin escribe "/debug-on <clave>", nunca en el código fuente servido (ver plan de Fase 23B).
	DEBUG_TOKEN: string;
}

interface EmbedRequestBody {
	texts: string[];
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/' && request.method === 'GET') {
			return Response.json({ ok: true, service: 'perfilafiliados-mcp' });
		}

		if (url.pathname === '/embed' && request.method === 'POST') {
			return handleEmbed(request, env);
		}

		if (url.pathname === '/mcp') {
			return handleMcp(request, env, ctx);
		}

		if (url.pathname === '/debug-search' && request.method === 'POST') {
			return handleDebugSearch(request, env);
		}

		return new Response('Not found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;

async function handleMcp(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const auth = request.headers.get('Authorization') ?? '';

	if (auth !== `Bearer ${env.MCP_TOKEN}`) {
		return Response.json({ error: 'unauthorized' }, { status: 401 });
	}

	const handler = createMcpHandler(() => {
		const server = new McpServer({ name: 'perfilafiliados-taxonomy-mcp', version: '0.1.0' });
		registerTaxonomyTools(server, env);
		registerEmpresaTools(server, env);
		registerIntentTools(server, env);

		return server;
	});

	return handler.fetch(request);
}

interface DebugSearchRequestBody {
	query: string;
	resolvedPhrases?: string[];
}

/**
 * Fase 23B: endpoint de solo lectura para el modo DEBUG de `public/cira-test/index.html`
 * (`/debug-on`). Deliberadamente FUERA del protocolo MCP (no necesita el nodo "MCP Client Tool" de
 * n8n ni el `MCP_TOKEN` real) y fuera del flujo de CIRA - nadie más lo llama. Mismo patrón de auth
 * simple que `/embed` (Bearer contra un secret propio), con su propio `DEBUG_TOKEN` para poder
 * revocarlo/rotarlo sin afectar `/mcp`/`/embed`.
 */
async function handleDebugSearch(request: Request, env: Env): Promise<Response> {
	const auth = request.headers.get('Authorization') ?? '';

	if (auth !== `Bearer ${env.DEBUG_TOKEN}`) {
		return Response.json({ error: 'unauthorized' }, { status: 401 });
	}

	let body: DebugSearchRequestBody;

	try {
		body = await request.json();
	} catch {
		return Response.json({ error: 'invalid_json' }, { status: 400 });
	}

	if (typeof body.query !== 'string' || body.query.trim().length < 2) {
		return Response.json({ error: 'query must be a string with at least 2 characters' }, { status: 400 });
	}

	const report = await resolveDebugSearch(env, body.query.trim(), body.resolvedPhrases ?? []);

	return Response.json(report);
}

async function handleEmbed(request: Request, env: Env): Promise<Response> {
	const auth = request.headers.get('Authorization') ?? '';

	if (auth !== `Bearer ${env.EMBED_TOKEN}`) {
		return Response.json({ error: 'unauthorized' }, { status: 401 });
	}

	let body: EmbedRequestBody;

	try {
		body = await request.json();
	} catch {
		return Response.json({ error: 'invalid_json' }, { status: 400 });
	}

	if (!Array.isArray(body.texts) || body.texts.length === 0) {
		return Response.json({ error: 'texts must be a non-empty array of strings' }, { status: 400 });
	}

	if (body.texts.length > 100) {
		// Limite conservador por request - el comando de Laravel manda en lotes, no todo junto.
		return Response.json({ error: 'max 100 texts per request' }, { status: 400 });
	}

	const result = await env.AI.run('@cf/baai/bge-m3', { text: body.texts });

	// Forma real de la respuesta de bge-m3 en Workers AI: { response: { shape: [n, dim], data: number[][] } }
	// (confirmado empiricamente al desplegar - ver docs/verificacion-embed.md de este repo).
	const data = (result as any)?.data ?? (result as any)?.response?.data;
	const shape = (result as any)?.shape ?? (result as any)?.response?.shape;

	if (!Array.isArray(data)) {
		return Response.json({ error: 'unexpected_ai_response', raw: result }, { status: 502 });
	}

	return Response.json({
		model: '@cf/baai/bge-m3',
		count: data.length,
		dimension: Array.isArray(data[0]) ? data[0].length : null,
		shape: shape ?? null,
		embeddings: data,
	});
}
