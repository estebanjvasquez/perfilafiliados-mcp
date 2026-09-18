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
 *
 * **TAXV3-7 (integración con el diccionario de términos)**: hasta esta fase, `search_taxonomy`
 * solo conocía `taxonomy_categories`/`taxonomy_category_synonyms` (3 filas en total) - todo el
 * diccionario construido en PerfilAfiliadosCPV (`taxonomy_terms`, 1.889 filas con alias, jerga
 * regional venezolana y ahora procedencia real por fuente) vivía en tablas que esta tool nunca
 * leía. Se agrega un nivel `dictionary` entre el léxico y el semántico, con el mismo criterio ya
 * probado en `TaxonomyCategorySearch::dictionary()` del repo Laravel (PHP, panel de admin): solo
 * relaciones `taxonomy_term_cpv_relations.status = 'approved'` (nunca el backlog histórico
 * `needs_review` de 9.288 filas ni los candidatos de baja confianza del Auto Mapper - ver
 * `MIGRACION_TAXONOMIA_CPV_V2_A_V3.md`), más un fallback de **herencia por concepto canónico**:
 * si el término que matchea el texto de búsqueda no tiene su propia relación aprobada pero SÍ
 * pertenece a un `taxonomy_canonical_concepts` con al menos un término hermano que sí la tiene
 * (ej. "drill pipe" no verificado individualmente hereda CPV-28.04.09G de su hermano aprobado
 * "tubería de perforación"), se usa la de ese hermano - así una jerga regional nunca necesita
 * verificación propia para aparecer en la búsqueda real (objetivo central de TAXV3). La relación
 * PROPIA del término, cuando existe, siempre tiene prioridad sobre la heredada (ver `ORDER BY` del
 * subquery `dm` abajo: `own_relation DESC`) - evita que un término ya verificado quede opacado por
 * un hermano de concepto con distinto peso.
 *
 * Es un PORT de la misma lógica que ya vive en PHP para el autocompletado del panel (no reemplaza
 * ese código, ni viceversa - dos runtimes distintos, Cloudflare Worker vs Laravel, no pueden
 * compartir código directamente; ambos deben mantenerse en sync manualmente si cambia el criterio
 * de confianza, ver docblock de `TaxonomyCategorySearch`).
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

				const lexicalCodes = lexical.map((row) => row.code);

				// TAXV3-7: nivel `dictionary` - ver docblock de la función arriba. `own_relation` (1/0)
				// ordena antes que `weight` para que la relación PROPIA de un término siempre gane sobre
				// una heredada por concepto, aunque la heredada tenga mayor peso.
				const dictionary = lexicalCodes.length < max
					? await sql<{
							code: string; level: number; path: string; name_es: string | null; name_en: string | null;
							matched_term: string; via_term: string | null; weight: number;
						}[]>`
						select distinct on (tc.code)
							tc.code, tc.level, tc.path, tt_es.name as name_es, tt_en.name as name_en,
							dm.matched_term, dm.via_term, dm.weight
						from (
							select
								r.category_id, t.term as matched_term, null::text as via_term, r.weight, 1 as own_relation
							from taxonomy_term_cpv_relations r
							join taxonomy_terms t on t.id = r.term_id
							left join taxonomy_term_aliases a on a.term_id = t.id
							where r.status = 'approved'
								and (
									unaccent(t.term) ilike unaccent(${'%' + query + '%'})
									or unaccent(t.canonical_term) ilike unaccent(${'%' + query + '%'})
									or unaccent(coalesce(a.alias, '')) ilike unaccent(${'%' + query + '%'})
								)
							union all
							select
								r.category_id, t.term as matched_term, sib.term as via_term, r.weight, 0 as own_relation
							from taxonomy_terms t
							join taxonomy_term_concepts link on link.term_id = t.id
							join taxonomy_term_concepts sib_link on sib_link.concept_id = link.concept_id and sib_link.term_id != t.id
							join taxonomy_terms sib on sib.id = sib_link.term_id
							join taxonomy_term_cpv_relations r on r.term_id = sib.id and r.status = 'approved'
							where (unaccent(t.term) ilike unaccent(${'%' + query + '%'}) or unaccent(t.canonical_term) ilike unaccent(${'%' + query + '%'}))
								and not exists (
									select 1 from taxonomy_term_cpv_relations r2
									where r2.term_id = t.id and r2.status = 'approved'
								)
						) dm
						join taxonomy_categories tc on tc.id = dm.category_id
						left join taxonomy_category_translations tt_es on tt_es.category_id = tc.id and tt_es.locale = 'es'
						left join taxonomy_category_translations tt_en on tt_en.category_id = tc.id and tt_en.locale = 'en'
						where tc.level != 0 and tc.is_active = true
							${lexicalCodes.length > 0 ? sql`and tc.code not in ${sql(lexicalCodes)}` : sql``}
						order by tc.code, dm.own_relation desc, dm.weight desc
						limit ${max - lexicalCodes.length}
					`
					: [];

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

				for (const row of dictionary) {
					if (seen.has(row.code) || results.length >= max) continue;
					seen.add(row.code);
					results.push({
						code: row.code,
						level: row.level,
						path: row.path,
						name_es: row.name_es,
						name_en: row.name_en,
						match_type: row.via_term ? 'dictionary_concept' : 'dictionary',
						matched_term: row.matched_term,
						...(row.via_term ? { via_term: row.via_term } : {}),
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

/** Misma forma de respuesta verificada empíricamente en handleEmbed() de index.ts. Exportada: la reusa empresa-tools.ts para el fallback semántico de search_empresas. */
export function extractEmbeddingVector(result: unknown): string | null {
	return extractEmbeddingVectors(result)[0] ?? null;
}

/**
 * Igual que `extractEmbeddingVector` pero devuelve TODOS los vectores de una respuesta con
 * varios textos de entrada (`env.AI.run(..., { text: [t1, t2, ...] })` -> `data: number[][]`,
 * uno por texto, en el mismo orden) - usada por el fallback semantico de `search_empresas`
 * (Fase MCP-4.3) para embeber varias frases candidatas en una sola llamada al modelo.
 */
export function extractEmbeddingVectors(result: unknown): (string | null)[] {
	const data = (result as any)?.data ?? (result as any)?.response?.data;

	if (!Array.isArray(data)) {
		return [];
	}

	return data.map((vec: unknown) => (Array.isArray(vec) ? '[' + vec.join(',') + ']' : null));
}
