/**
 * perfilafiliados-mcp — Worker de infraestructura para la taxonomia CPV de PerfilAfiliadosCPV.
 *
 * Fase MCP-1 (ver docs/taxonomia/plan_mcp_cira.md del repo PerfilAfiliadosCPV): arranca como un
 * endpoint de embeddings puro (/embed), protegido con un Bearer token propio (EMBED_TOKEN,
 * secret del Worker, nunca en este repo) - lo usa el comando `taxonomy:generate-embeddings` de
 * Laravel para poblar `taxonomy_category_embeddings` en Supabase por lote. Las tools MCP en si
 * (search_taxonomy, list_sectores, list_taxonomy_groups) se agregan despues, sobre este mismo
 * Worker - no es un servicio descartable, es el arranque real de la pieza de infraestructura.
 *
 * Modelo: @cf/baai/bge-m3 (multilingue, ES/EN sin distincion - clave porque la taxonomia esta en
 * los dos idiomas). Dimension real del vector: NO asumida, se documenta abajo una vez verificada
 * empiricamente contra el modelo real (ver comentario junto a EmbedResponse).
 */

export interface Env {
	AI: Ai;
	EMBED_TOKEN: string;
}

interface EmbedRequestBody {
	texts: string[];
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === '/' && request.method === 'GET') {
			return Response.json({ ok: true, service: 'perfilafiliados-mcp' });
		}

		if (url.pathname === '/embed' && request.method === 'POST') {
			return handleEmbed(request, env);
		}

		return new Response('Not found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;

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
