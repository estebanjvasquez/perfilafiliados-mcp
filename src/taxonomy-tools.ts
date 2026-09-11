import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Env } from './index';
import { getSql } from './db';

/**
 * Fase MCP-1 (ver docs/taxonomia/plan_mcp_cira.md de PerfilAfiliadosCPV): las 3 tools que no
 * dependen de la homologación empresa<->categoría (Fase 3/4, todavía sin correr) - `search_empresas`/
 * `get_empresa` se agregan después, en la Fase MCP-3.
 *
 * Hallazgo real al calibrar esto (11 sep 2026): una búsqueda semántica PURA falla para sinónimos
 * locales cortos y ambiguos — "arbolito" (jerga venezolana de "API 6A Wellhead Valves") embebido
 * solo, sin contexto, cae semánticamente cerca de "Grafito"/"Aluminio", no de válvulas, aunque el
 * texto embebido del nodo SÍ contenga la palabra "arbolito" (el modelo captura el significado del
 * texto completo, no hace matching de substring). Por eso `search_taxonomy` es HÍBRIDO de
 * entrada, no semántico puro: intenta léxico exacto/parcial primero (rápido y preciso para jerga
 * conocida) y complementa con semántico (para consultas conceptuales en lenguaje natural, donde sí
 * funciona muy bien — verificado con "necesito comprar válvulas para el cabezal de un pozo
 * petrolero" → top resultados todos de la familia Válvulas/Valves).
 *
 * Bug real encontrado durante la Fase MCP-3 (11 sep 2026), corregido acá también: a diferencia de
 * MySQL (collation por defecto insensible a tildes), Postgres SÍ distingue tildes en ILIKE - un
 * ILIKE sin `unaccent()` no matchea "construccion" contra "CONSTRUCCIÓN" en la base real. Todo el
 * matching léxico de esta tool usa `unaccent(columna) ilike unaccent(termino)` en ambos lados por
 * este motivo (la extensión `unaccent` ya está habilitada en este proyecto de Supabase).
 */
export function registerTaxonomyTools(server: McpServer, env: Env): void {
	server.registerTool(
		'search_taxonomy',
		{
			description:
				'Busca categorías/familias/grupos de la taxonomía CPV por texto libre (español o inglés). ' +
				'Combina coincidencia léxica exacta (nombres oficiales y sinónimos/términos locales venezolanos) ' +
				'con búsqueda semántica (para consultas conceptuales que no comparten palabras literales). ' +
				'Cada resultado trae su código CPV y la ruta jerárquica completa (path).',
			inputSchema: {
				query: z.string().min(2).describe('Texto de búsqueda, en español o inglés'),
				limit: z.number().int().min(1).max(20).optional().describe('Máximo de resultados a devolver (default 8)'),
			},
		},
		async ({ query, limit }) => {
			const max = limit ?? 8;
			const sql = getSql(env);

			try {
				const lexical = await sql<{ code: string; level: number; path: string; name_es: string | null; name_en: string | null; matched_term: string }[]>`
					select distinct on (tc.id)
						tc.code, tc.level, tc.path,
						tt_es.name as name_es, tt_en.name as name_en,
						coalesce(s.term, tt_es.name, tt_en.name) as matched_term
					from taxonomy_categories tc
					left join taxonomy_category_translations tt_es on tt_es.category_id = tc.id and tt_es.locale = 'es'
					left join taxonomy_category_translations tt_en on tt_en.category_id = tc.id and tt_en.locale = 'en'
					left join taxonomy_category_synonyms s on s.category_id = tc.id and unaccent(s.term) ilike unaccent(${'%' + query + '%'})
					where unaccent(tt_es.name) ilike unaccent(${'%' + query + '%'})
						or unaccent(tt_en.name) ilike unaccent(${'%' + query + '%'})
						or unaccent(s.term) ilike unaccent(${'%' + query + '%'})
					limit ${max}
				`;

				const queryEmbedding = await env.AI.run('@cf/baai/bge-m3', { text: [query] });
				const vector = extractEmbeddingVector(queryEmbedding);

				const semantic = vector
					? await sql<{ code: string; level: number; path: string; name_es: string | null; name_en: string | null; distance: number }[]>`
						select
							tc.code, tc.level, tc.path,
							tt_es.name as name_es, tt_en.name as name_en,
							(tce.embedding <=> ${vector}::vector) as distance
						from taxonomy_category_embeddings tce
						join taxonomy_categories tc on tc.id = tce.category_id
						left join taxonomy_category_translations tt_es on tt_es.category_id = tc.id and tt_es.locale = 'es'
						left join taxonomy_category_translations tt_en on tt_en.category_id = tc.id and tt_en.locale = 'en'
						order by tce.embedding <=> ${vector}::vector
						limit ${max}
					`
					: [];

				const seen = new Set<string>();
				const results: Record<string, unknown>[] = [];

				for (const row of lexical) {
					seen.add(row.code);
					results.push({
						code: row.code,
						level: row.level,
						path: row.path,
						name_es: row.name_es,
						name_en: row.name_en,
						match_type: 'lexical',
						matched_term: row.matched_term,
					});
				}

				for (const row of semantic) {
					if (seen.has(row.code) || results.length >= max) continue;
					seen.add(row.code);
					results.push({
						code: row.code,
						level: row.level,
						path: row.path,
						name_es: row.name_es,
						name_en: row.name_en,
						match_type: 'semantic',
						distance: row.distance,
					});
				}

				return { content: [{ type: 'text' as const, text: JSON.stringify(results.slice(0, max), null, 2) }] };
			} finally {
				await sql.end({ timeout: 1 });
			}
		}
	);

	server.registerTool(
		'list_sectores',
		{
			description: 'Lista el catálogo plano de sectores institucionales de la Cámara Petrolera de Venezuela (para filtros estructurados de búsqueda).',
			inputSchema: {},
		},
		async () => {
			const sql = getSql(env);

			try {
				const rows = await sql`select id, name from sectors order by name`;

				return { content: [{ type: 'text' as const, text: JSON.stringify(rows, null, 2) }] };
			} finally {
				await sql.end({ timeout: 1 });
			}
		}
	);

	server.registerTool(
		'list_taxonomy_groups',
		{
			description:
				'Navega la taxonomía CPV jerárquicamente. Sin parent_code: devuelve los 48 Grupos de nivel superior. ' +
				'Con parent_code (ej. "CPV-05"): devuelve sus hijos directos (Familias de un Grupo, o Categorías de una Familia).',
			inputSchema: {
				parent_code: z.string().optional().describe('Código CPV del nodo padre, ej. "CPV-05". Si se omite, devuelve los Grupos de nivel superior.'),
			},
		},
		async ({ parent_code }) => {
			const sql = getSql(env);

			try {
				const rows = parent_code
					? await sql`
						select tc.code, tc.level, tt_es.name as name_es, tt_en.name as name_en
						from taxonomy_categories tc
						join taxonomy_categories parent on parent.id = tc.parent_id
						left join taxonomy_category_translations tt_es on tt_es.category_id = tc.id and tt_es.locale = 'es'
						left join taxonomy_category_translations tt_en on tt_en.category_id = tc.id and tt_en.locale = 'en'
						where parent.code = ${parent_code}
						order by tc.code
					`
					: await sql`
						select tc.code, tc.level, tt_es.name as name_es, tt_en.name as name_en
						from taxonomy_categories tc
						left join taxonomy_category_translations tt_es on tt_es.category_id = tc.id and tt_es.locale = 'es'
						left join taxonomy_category_translations tt_en on tt_en.category_id = tc.id and tt_en.locale = 'en'
						where tc.level = 0
						order by tc.code
					`;

				return { content: [{ type: 'text' as const, text: JSON.stringify(rows, null, 2) }] };
			} finally {
				await sql.end({ timeout: 1 });
			}
		}
	);
}

/** Misma forma de respuesta verificada empíricamente en handleEmbed() de index.ts. */
function extractEmbeddingVector(result: unknown): string | null {
	const data = (result as any)?.data ?? (result as any)?.response?.data;

	if (!Array.isArray(data) || !Array.isArray(data[0])) {
		return null;
	}

	return '[' + data[0].join(',') + ']';
}
