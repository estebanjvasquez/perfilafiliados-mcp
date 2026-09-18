import type { Env } from './index';
import { getSql } from './db';
import { extractEmbeddingVectors } from './taxonomy-tools';
import { resolveCanonicalQueryWithSql, type CanonicalSearchContext } from './canonical-expansion';

/**
 * Fase MCP-7 (Fase A, ver docs/taxonomia/plan_mcp_cira.md de PerfilAfiliadosCPV): reemplaza el
 * sistema de 6 niveles secuenciales/paralelos de `search_empresas` (Fases MCP-1 a MCP-6.1) por un
 * buscador híbrido de una sola pasada: SQL estructurado + full-text nativo de Postgres + vectorial
 * (3 catálogos) + léxico directo, fusionados con RRF (Reciprocal Rank Fusion) ponderado.
 *
 * Motivo del reemplazo (no una limpieza cosmética): el sistema de 6 niveles requería un umbral o
 * `LIMIT` calibrado A MANO por nivel, y cada fix a un caso regresionaba otro (represas→camiones→
 * TOTAL CLEAN, ver Fases MCP-4.8 a MCP-6.1 en el doc del proyecto) - la causa de fondo era que un
 * termino truncado por el LLM ("repres") podia colisionar por SUBSTRING literal contra nombres
 * reales ("representaciones"), y que un `LIMIT` fijo por frase competia mal entre frases cuando la
 * cantidad de frases candidatas cambiaba. Full-text con stemming en español (`to_tsvector('spanish',
 * ...)`) elimina la primera causa de raiz (opera sobre lexemas normalizados, no substrings), y RRF
 * (que fusiona por POSICION en cada lista, no por score absoluto) elimina la segunda (una empresa
 * relevante acumula señal de varias listas en vez de depender de ganar un unico `LIMIT`).
 *
 * Calibrado en vivo (16 sep 2026) contra `docs/taxonomia/intent_eval_cases.md` completo, primero en
 * PHP/tinker contra la Supabase real (ver "Fase MCP-7" en el doc del proyecto para los 2 bugs reales
 * encontrados en el camino - un `LIMIT` que se aplicaba ANTES de ordenar por score, y una lista
 * "estructurada" a la que le faltaban los chequeos léxicos de experiencia/taxonomía), luego portado
 * acá con los mismos parámetros ya validados.
 *
 * DOS hallazgos de calibración quedan fijados en las constantes de abajo, no son arbitrarios:
 * 1. El `limit` por catálogo vectorial NO es uniforme - ensanchar taxonomía (3.497 categorías, la
 *    más grande y heterogénea) al mismo nivel que experiencia (961, el catálogo que de verdad tenía
 *    el bug de recall) inundaba de ruido "represas"/"grua" con 27-30 empresas sin relación real.
 * 2. RRF sin pesos deja que un solo hit vectorial en un catálogo grande compita en igualdad con
 *    evidencia de alta confianza (certificación real, coincidencia léxica literal) - "ISO 9001" con
 *    66 certificaciones reales quedaba diluido, y "grua" arriesgaba perder sus 2 coincidencias
 *    léxicas reales contra ruido. Evidencia estructurada/léxica pesa más en la fusión.
 *
 * FASE 23A (ver plan en PerfilAfiliadosCPV, diagnóstico de `cabrias`): agrega 2 listas de evidencia
 * NUEVAS - `canonical_cpv` (L0-L3: término exacto/alias/concepto canónico/CPV aprobado, resuelto por
 * `resolveCanonicalQueryWithSql` en `canonical-expansion.ts`) y `canonical_related` (L5: fallback de
 * UN solo salto por `taxonomy_categories.parent_id` a la Familia inmediata, solo si L0-L3 no trajo
 * ninguna empresa, penalizado). Corren en el MISMO `Promise.all` que las 8 listas de siempre, NUNCA
 * como fallback secuencial - insertarlas condicionadas a que las demás fallen reproduciría el bug de
 * cascada de Fase MCP-4.6 (la taxonomía vieja quedó ahogada por el nivel difuso durante días). Las 8
 * listas originales NO se tocan. `canonical-expansion.ts` reduce por su cuenta sinónimos que apuntan
 * al mismo CPV (cabria/derrick/mast) a UN solo match antes de llegar acá - evita triple conteo
 * DENTRO de las listas canónicas. Sigue existiendo la posibilidad de que el MISMO CPV llegue también
 * por `lexicalTaxonomyList` (tabla vieja de sinónimos) o `vectorTaxonomyList` (embedding) de forma
 * independiente - riesgo aceptado y documentado (no distinto en espíritu al ya aceptado arriba para
 * "reciclaje"~"VIALIDAD Y DRENAJES"), verificado explícitamente contra el benchmark de la Fase 23A
 * antes de desplegar (ver `candidate_count_by_source` en `debugCanonicalSearch`).
 */

export const RRF_K = 60;

// Fase MCP-7.2 (17 sep 2026): bajado de 15 a 8. Medido en vivo (usuario reportó el patrón de
// "rellena hasta 20" - confirmado real): servicios genéricos/vagos ("OPERADOR PRIVADO" a 0.572,
// "ADQUISICIÓN, PROCESAMIENTO E INTERPRETACIÓN DE DATOS" a 0.594) NO tienen un salto limpio de
// distancia que los separe de servicios genuinamente relevantes para OTRAS consultas ("SERVICIOS
// LOGÍSTICA TRANSPORTE" mide 0.567-0.593 para "camiones" - un match real, en el MISMO rango que el
// ruido de "criptoactivos") - a diferencia de `TAXONOMY_THRESHOLD` (que sí tuvo un salto limpio
// medible), bajar `SERVICE_THRESHOLD` sacaría ruido real pero también resultados genuinos de otras
// consultas. Como el catálogo de servicios es chico (112 entradas), la mitigación de fondo es
// acotar cuántos candidatos de UNA SOLA señal semántica débil pueden entrar por frase, no perseguir
// un umbral perfecto que no existe en los datos. Limitación conocida y aceptada: esto reduce el
// ruido, no lo elimina del todo - un ajuste más fino (ej. exigir corroboración de otra lista antes
// de mostrar un resultado solo-semántico) queda pendiente si el ruido sigue siendo un problema.
const SERVICE_VECTOR_LIMIT = 8;
const TAXONOMY_VECTOR_LIMIT = 10;
const EXPERIENCIA_VECTOR_LIMIT = 30;
const FULLTEXT_LIMIT = 30;

const SERVICE_THRESHOLD = 0.6;
// Fase MCP-7 (16 sep 2026) - bajado de 0.6 (heredado sin cambios del sistema anterior) a 0.47,
// medido en vivo calibrando esta fase: "represas" tiene su categoría CORRECTA a 0.397 ("Presas",
// CPV-37.11.03S/CPV-31.06.03S - traducción literal), con un salto limpio de ~0.1 hasta el próximo
// resultado real ("Impresoras" a 0.494 - sin relación, coincidencia fonética/estructural del
// embedding). El umbral de 0.6 heredado dejaba pasar 8+ categorías genéricas sin relación real
// (Compresores, Refuerzos, Bombas, Demoliciones...) antes de llegar a cualquiera de ellas - excluir
// atractores uno por uno (ver GENERIC_ATTRACTOR_FAMILY_CODES) no escala si el problema es el
// umbral, no la categoría puntual. 0.47 deja margen sobre el caso ya validado en Fase MCP-4.6
// ("válvulas de cabezal de pozo" a 0.4519) sin dejar pasar el piso de ruido medido acá.
const TAXONOMY_THRESHOLD = 0.47;
const EXPERIENCIA_THRESHOLD = 0.5;

// Mismas familias CPV "atractoras" que ya excluía el nivel semántico de taxonomía del sistema
// anterior (Fase MCP-4.x/4.6) y el comando `empresas:build-search-documents` (Fase MCP-7) - nombre
// lo bastante genérico como para atraer coincidencias sin relación temática real.
// `CPV-22.08` (Armamento) agregada en vivo calibrando Fase MCP-7 (16 sep 2026): "represas" resolvía
// semánticamente MUY cerca de esta familia (sin relación temática real - vocabulario de ingeniería/
// estructuras compartido), inundando el nivel taxonomía de empresas sin relación ("Armamento" como
// único motivo de match para ~10 empresas de construcción/industria general). Mismo criterio de
// exclusión puntual por código ya usado para las otras 3.
const GENERIC_ATTRACTOR_FAMILY_CODES = ['CPV-29.02', 'CPV-12.04', 'CPV-48.02', 'CPV-22.08'];

// Fase MCP-4.7 (heredado del sistema anterior): umbral de tipeo de nombre, calibrado en vivo -
// separa "vincler"~"VINCCLER" (0.70) de falsos positivos tipo "grua"~cualquier "GRUPO..." (0.60,
// motivo del umbral en 0.65, no 0.60). Longitud mínima 5 como segunda barrera barata contra
// palabras cortas. Cubre el caso real de Fase MCP-4.7: un nombre sin sufijo legal (sin "C.A.") puede
// llegar mal enrutado a `search_empresas` en vez de `get_empresa` si el clasificador de intención no
// lo identifica como nombre propio.
const NAME_TYPO_THRESHOLD = 0.65;
const NAME_TYPO_MIN_LENGTH = 5;

type EvidenceList =
	| 'structured'
	| 'name_typo'
	| 'lexical_experiencia'
	| 'lexical_taxonomy'
	| 'fulltext'
	| 'service'
	| 'taxonomy'
	| 'experiencia'
	| 'canonical_cpv'
	| 'canonical_related';

const LIST_WEIGHTS: Record<EvidenceList, number> = {
	structured: 2.5,
	name_typo: 2.0,
	lexical_experiencia: 2.5,
	lexical_taxonomy: 2.5,
	fulltext: 1.5,
	service: 1.0,
	experiencia: 1.0,
	taxonomy: 0.5,
	// Fase 23A: tier alto porque el CPV ya viene de una relación `approved` (curada o heredada de un
	// concepto canónico), no de una coincidencia difusa - mismo orden de magnitud que la evidencia
	// léxica directa (`lexical_taxonomy`), nunca por debajo de `taxonomy` (semántico puro).
	canonical_cpv: 2.0,
	// Deliberadamente bajo - es un fallback de UN salto de familia (L5), tagueado RELATED_CANDIDATE
	// (no DIRECT_MATCH), penalización adicional ya aplicada por `mcp_canonical.level5_fallback_penalty`
	// dentro del propio weight de cada match (ver `canonical-expansion.ts`).
	canonical_related: 0.4,
};

// match_type expuesto en la respuesta final, derivado de qué lista aportó la evidencia de mayor
// peso para esa empresa - mismo espíritu explicativo que `matched_via` ya tenía en el sistema
// anterior (Fase MCP-4.4: "nunca dejar sin explicar por qué apareció una empresa").
const MATCH_TYPE_BY_LIST: Record<EvidenceList, string> = {
	structured: 'exact',
	name_typo: 'fuzzy',
	lexical_experiencia: 'lexical',
	lexical_taxonomy: 'lexical',
	fulltext: 'fulltext',
	service: 'semantic',
	taxonomy: 'semantic',
	experiencia: 'semantic',
	canonical_cpv: 'canonical_direct',
	canonical_related: 'canonical_related_candidate',
};

export type Evidence = { empresa_id: number; label: string };

export type FusedMatch = { empresa_id: number; score: number; matchType: string; matchedVia: string };

/** Un embedding por frase (bge-m3, mismo modelo que ya usan taxonomía/servicios/experiencias). */
export async function embedPhrase(env: Env, phrase: string): Promise<string | null> {
	const result = await env.AI.run('@cf/baai/bge-m3', { text: [phrase] });
	return extractEmbeddingVectors(result)[0] ?? null;
}

// Fase MCP-7.2 (17 sep 2026): longitud mínima para matchear el NOMBRE de empresa por substring -
// defensa contra la colisión recurrente "represas"~"REPRESENTACIONES..." (5 causas raíz DISTINTAS
// de la MISMA colisión de fondo a lo largo del proyecto: Fase MCP-4.8/5.4/6.1/7/7.2). Esta vez el
// agente externo de n8n truncó la raíz a "repres" (6 letras) - que son literalmente las primeras 6
// letras de "REPRESENTACIONES...", "REPROQUIMICA", etc. - y `ilike '%repres%'` sin conciencia de
// límites de palabra matcheaba por coincidencia. Verificado en vivo contra Supabase real antes de
// fijar el número: "repres" (6) matchea las 6 empresas de la familia REPRESENTACIONES; "represa" (7)
// no matchea NINGUNA empresa por nombre (no hace falta - el caso real se resuelve por experiencia);
// "construccion" (12) sigue encontrando VINCCLER (18 empresas reales, sin pérdida); "camion" (6)
// pierde a DIMACA por ESTA vía puntual, pero full-text (con stemming real, ver `fullTextList`)
// encuentra a DIMACA de todas formas por su nombre indexado - sin pérdida neta. Servicio/sector NO
// llevan este mínimo: son catálogos curados y acotados (112/8 entradas), sin el riesgo de razones
// sociales libres que sí tiene `empresas.name`.
const NAME_SUBSTRING_MIN_LENGTH = 7;

async function structuredList(sql: ReturnType<typeof getSql>, phrase: string): Promise<Evidence[]> {
	const like = '%' + phrase + '%';
	const nameRows =
		phrase.length >= NAME_SUBSTRING_MIN_LENGTH
			? await sql<{ empresa_id: number }[]>`
				select distinct e.id as empresa_id
				from empresas e
				where e.status_id = 1 and unaccent(e.name) ilike unaccent(${like})
			`
			: [];

	const serviceSectorRows = await sql<{ empresa_id: number }[]>`
		select distinct e.id as empresa_id
		from empresas e
		where e.status_id = 1
			and (
				exists (
					select 1 from empresa_sector_service ess join services sv on sv.id = ess.service_id
					where ess.empresa_id = e.id and unaccent(sv.name) ilike unaccent(${like})
				)
				or exists (
					select 1 from empresa_sector_service ess join services sv on sv.id = ess.service_id
					join sectors s on s.id = sv.sectors_id
					where ess.empresa_id = e.id and unaccent(s.name) ilike unaccent(${like})
				)
			)
	`;

	const normalized = phrase.toLowerCase().replace(/[^a-z0-9]/g, '');
	const certColumns = ['iso9001', 'iso14001', 'iso45001', 'iso27001', 'iso50001', 'iso17025', 'iso37001', 'dun', 'ovid', 'pmi'];
	const matchedCertColumn = certColumns.find((c) => normalized.includes(c)) ?? null;

	const certRows = matchedCertColumn
		? await sql<{ empresa_id: number }[]>`select empresa_id from empresa_certifications where ${sql(matchedCertColumn)} = true`
		: await sql<{ empresa_id: number }[]>`
			select empresa_id from empresa_certifications
			where unaccent(coalesce(otras_certificaciones, '')) ilike unaccent(${like})
		`;

	const sustRows = await sql<{ empresa_id: number }[]>`
		select distinct esa.empresa_id
		from empresa_sustainability_areas esa
		join sustainability_areas sa on sa.id = esa.area_id
		where unaccent(sa.name) ilike unaccent(${like}) or unaccent(coalesce(sa.synonyms, '')) ilike unaccent(${like})
	`;

	const label = matchedCertColumn ? `coincide con la certificación ${matchedCertColumn.toUpperCase()}` : `coincide con "${phrase}"`;

	return [...nameRows, ...serviceSectorRows, ...certRows, ...sustRows].map((r) => ({ empresa_id: r.empresa_id, label }));
}

async function nameTypoList(sql: ReturnType<typeof getSql>, phrase: string): Promise<Evidence[]> {
	if (phrase.length < NAME_TYPO_MIN_LENGTH) return [];

	const rows = await sql<{ empresa_id: number }[]>`
		select id as empresa_id from empresas
		where status_id = 1 and word_similarity(unaccent(${phrase}), unaccent(name)) > ${NAME_TYPO_THRESHOLD}
	`;
	return rows.map((r) => ({ empresa_id: r.empresa_id, label: `similar a "${phrase}" (nombre de empresa, posible diferencia de tipeo)` }));
}

async function lexicalExperienciaList(sql: ReturnType<typeof getSql>, phrase: string): Promise<Evidence[]> {
	const rows = await sql<{ empresa_id: number; descripcion: string }[]>`
		select empresa_id, descripcion from empresa_experiencias
		where unaccent(descripcion) ilike unaccent(${'%' + phrase + '%'})
		limit 20
	`;
	return rows.map((r) => ({ empresa_id: r.empresa_id, label: `coincide con "${phrase}" (experiencia: ${truncate(r.descripcion)})` }));
}

async function lexicalTaxonomyList(sql: ReturnType<typeof getSql>, phrase: string): Promise<Evidence[]> {
	const like = '%' + phrase + '%';
	const rows = await sql<{ empresa_id: number; name: string }[]>`
		select distinct etc.empresa_id, coalesce(tt.name, tc.code) as name
		from empresa_taxonomy_category etc
		join taxonomy_categories tc on tc.id = etc.category_id
		left join taxonomy_category_translations tt on tt.category_id = tc.id and tt.locale = 'es'
		left join taxonomy_category_translations tt_en on tt_en.category_id = tc.id and tt_en.locale = 'en'
		left join taxonomy_category_synonyms syn on syn.category_id = tc.id
		where tc.level != 0 and tc.is_active = true
			and tc.code not in ${sql(GENERIC_ATTRACTOR_FAMILY_CODES)}
			and (
				unaccent(coalesce(tt.name, '')) ilike unaccent(${like})
				or unaccent(coalesce(tt_en.name, '')) ilike unaccent(${like})
				or unaccent(coalesce(syn.term, '')) ilike unaccent(${like})
			)
	`;
	return rows.map((r) => ({ empresa_id: r.empresa_id, label: `coincide con "${phrase}" (categoría CPV: ${r.name})` }));
}

/**
 * Fase 23A: empresas con `empresa_taxonomy_category` en alguno de los CPV DIRECTOS que
 * `resolveCanonicalQueryWithSql` ya resolvió para esta frase (L0-L3 - término exacto/alias/concepto
 * canónico/CPV aprobado). No vuelve a tocar `taxonomy_terms` - el contexto ya viene resuelto.
 */
async function canonicalCpvList(sql: ReturnType<typeof getSql>, ctx: CanonicalSearchContext): Promise<Evidence[]> {
	if (ctx.directCpvCodes.length === 0) return [];

	const rows = await sql<{ empresa_id: number }[]>`
		select distinct etc.empresa_id
		from empresa_taxonomy_category etc
		join taxonomy_categories tc on tc.id = etc.category_id
		where tc.code in ${sql(ctx.directCpvCodes)}
	`;
	const conceptLabel = ctx.canonicalConcepts[0] ? ` (concepto: ${ctx.canonicalConcepts[0]})` : '';
	return rows.map((r) => ({ empresa_id: r.empresa_id, label: `coincide con "${ctx.originalQuery}" vía taxonomía CPV${conceptLabel}` }));
}

/**
 * Fase 23A: fallback L5 - solo si `canonicalCpvList` no encontró NINGUNA empresa para esta frase
 * (decisión en TypeScript, no una segunda consulta condicional - `relatedCpvCodes` ya vino en la
 * MISMA consulta de `resolveCanonicalQueryWithSql`). Tag distinto (`canonical_related_candidate` en
 * `MATCH_TYPE_BY_LIST`) para que la respuesta final pueda distinguir DIRECT_MATCH de
 * RELATED_CANDIDATE - nunca se presenta con la misma certeza.
 */
async function canonicalRelatedList(sql: ReturnType<typeof getSql>, ctx: CanonicalSearchContext, directHits: number): Promise<Evidence[]> {
	if (directHits > 0 || ctx.relatedCpvCodes.length === 0) return [];

	const rows = await sql<{ empresa_id: number }[]>`
		select distinct etc.empresa_id
		from empresa_taxonomy_category etc
		join taxonomy_categories tc on tc.id = etc.category_id
		where tc.code in ${sql(ctx.relatedCpvCodes)}
	`;
	const conceptLabel = ctx.canonicalConcepts[0] ? ` (familia relacionada con: ${ctx.canonicalConcepts[0]})` : '';
	return rows.map((r) => ({ empresa_id: r.empresa_id, label: `candidato relacionado con "${ctx.originalQuery}"${conceptLabel} - no es coincidencia directa` }));
}

async function fullTextList(sql: ReturnType<typeof getSql>, phrase: string): Promise<Evidence[]> {
	const rows = await sql<{ empresa_id: number }[]>`
		select esd.empresa_id
		from empresa_search_documents esd, websearch_to_tsquery('spanish', unaccent(${phrase})) q
		where esd.search_vector @@ q
		order by ts_rank_cd(esd.search_vector, q, 1) desc
		limit ${FULLTEXT_LIMIT}
	`;
	return rows.map((r) => ({ empresa_id: r.empresa_id, label: `coincide en texto con "${phrase}"` }));
}

/** Patrón compartido por las 3 listas vectoriales: mejor score POR EMPRESA primero (subconsulta), recién ahí orden+limit globales - un `LIMIT` aplicado antes de reordenar por score devuelve filas casi arbitrarias (bug real encontrado calibrando esta fase). */
async function vectorServiceList(sql: ReturnType<typeof getSql>, vector: string, phrase: string): Promise<Evidence[]> {
	const rows = await sql<{ empresa_id: number; name: string }[]>`
		select empresa_id, name from (
			select distinct on (ess.empresa_id) ess.empresa_id, sv.name, (se.embedding <=> ${vector}::vector) as score
			from service_embeddings se
			join services sv on sv.id = se.service_id
			join empresa_sector_service ess on ess.service_id = sv.id
			where upper(sv.name) not in ('X', 'OTROS') and (se.embedding <=> ${vector}::vector) < ${SERVICE_THRESHOLD}
			order by ess.empresa_id, score asc
		) best
		order by score asc
		limit ${SERVICE_VECTOR_LIMIT}
	`;
	return rows.map((r) => ({ empresa_id: r.empresa_id, label: `similar a "${phrase}" (servicio: ${r.name})` }));
}

async function vectorTaxonomyList(sql: ReturnType<typeof getSql>, vector: string, phrase: string): Promise<Evidence[]> {
	const rows = await sql<{ empresa_id: number; name: string }[]>`
		select empresa_id, name from (
			select distinct on (etc.empresa_id) etc.empresa_id, coalesce(tt.name, tc.code) as name, (tce.embedding <=> ${vector}::vector) as score
			from taxonomy_category_embeddings tce
			join taxonomy_categories tc on tc.id = tce.category_id
			left join taxonomy_category_translations tt on tt.category_id = tc.id and tt.locale = 'es'
			join empresa_taxonomy_category etc on etc.category_id = tc.id
			where tc.code not in ${sql(GENERIC_ATTRACTOR_FAMILY_CODES)} and (tce.embedding <=> ${vector}::vector) < ${TAXONOMY_THRESHOLD}
			order by etc.empresa_id, score asc
		) best
		order by score asc
		limit ${TAXONOMY_VECTOR_LIMIT}
	`;
	return rows.map((r) => ({ empresa_id: r.empresa_id, label: `similar a "${phrase}" (categoría CPV: ${r.name})` }));
}

async function vectorExperienciaList(sql: ReturnType<typeof getSql>, vector: string, phrase: string): Promise<Evidence[]> {
	const rows = await sql<{ empresa_id: number; descripcion: string }[]>`
		select empresa_id, descripcion from (
			select distinct on (ee.empresa_id) ee.empresa_id, ee.descripcion, (eee.embedding <=> ${vector}::vector) as score
			from empresa_experiencia_embeddings eee
			join empresa_experiencias ee on ee.id = eee.experiencia_id
			where (eee.embedding <=> ${vector}::vector) < ${EXPERIENCIA_THRESHOLD}
			order by ee.empresa_id, score asc
		) best
		order by score asc
		limit ${EXPERIENCIA_VECTOR_LIMIT}
	`;
	return rows.map((r) => ({ empresa_id: r.empresa_id, label: `similar a "${phrase}" (experiencia: ${truncate(r.descripcion)})` }));
}

function truncate(text: string, max = 100): string {
	return text.length > max ? text.slice(0, max).trimEnd() + '…' : text;
}

/**
 * Resuelve TODA la evidencia (estructurada + léxica + full-text + vectorial) para UNA frase y la
 * fusiona por RRF ponderado. Para `multi_concept` (varias frases independientes de
 * `resolve_search_intent`), el llamador corre esta función una vez por frase y suma los mapas de
 * score resultantes - RRF es composicional, cada frase adicional es simplemente más evidencia.
 */
type PhraseEvidenceDetail = {
	namedLists: Record<EvidenceList, Evidence[]>;
	canonicalCtx: CanonicalSearchContext;
	result: Map<number, { score: number; matchType: string; matchedVia: string }>;
};

async function computePhraseEvidence(sql: ReturnType<typeof getSql>, env: Env, phrase: string): Promise<PhraseEvidenceDetail> {
	const vector = await embedPhrase(env, phrase);

	const [structured, lexExp, lexTax, fulltext, service, taxonomy, experiencia, canonicalCtx] = await Promise.all([
		structuredList(sql, phrase),
		lexicalExperienciaList(sql, phrase),
		lexicalTaxonomyList(sql, phrase),
		fullTextList(sql, phrase),
		vector ? vectorServiceList(sql, vector, phrase) : Promise.resolve([]),
		vector ? vectorTaxonomyList(sql, vector, phrase) : Promise.resolve([]),
		vector ? vectorExperienciaList(sql, vector, phrase) : Promise.resolve([]),
		resolveCanonicalQueryWithSql(sql, phrase),
	]);

	// Fase 23A: canonicalRelated depende del RESULTADO de canonicalDirect (¿hubo 0 empresas directas?
	// - decisión explícita, no una starvation accidental como la de Fase MCP-4.6) - por eso corre
	// DESPUÉS del Promise.all de arriba, no dentro. Nunca agrega una consulta si `resolveCanonicalQuery`
	// no encontró ningún concepto para esta frase (`canonicalCpvList`/`canonicalRelatedList` retornan
	// [] sin tocar la base cuando `directCpvCodes`/`relatedCpvCodes` vienen vacíos).
	const canonicalDirect = await canonicalCpvList(sql, canonicalCtx);
	const canonicalRelated = await canonicalRelatedList(sql, canonicalCtx, canonicalDirect.length);

	// Fase MCP-5.4 (heredado): "represas" volvía a colisionar con "REPRESENTACIONES..." la primera
	// vez que se probó esto hoy - el tipeo de nombre corría SIEMPRE, sin las salvaguardas que esa
	// fase ya había probado necesarias. Mismo fix de fondo: tipeo de nombre es el ÚLTIMO recurso,
	// solo se considera si NINGÚN otro nivel encontró ya una coincidencia de concepto real - evidencia
	// objetiva calculada acá mismo, no depende de ningún clasificador externo.
	const hasConceptMatch =
		structured.length > 0 ||
		lexExp.length > 0 ||
		lexTax.length > 0 ||
		fulltext.length > 0 ||
		service.length > 0 ||
		taxonomy.length > 0 ||
		experiencia.length > 0 ||
		canonicalDirect.length > 0 ||
		canonicalRelated.length > 0;
	const nameTypo = hasConceptMatch ? [] : await nameTypoList(sql, phrase);

	const namedLists: Record<EvidenceList, Evidence[]> = {
		structured,
		name_typo: nameTypo,
		lexical_experiencia: lexExp,
		lexical_taxonomy: lexTax,
		fulltext,
		service,
		taxonomy,
		experiencia,
		canonical_cpv: canonicalDirect,
		canonical_related: canonicalRelated,
	};

	const result = new Map<number, { score: number; matchType: string; matchedVia: string }>();

	for (const [listName, rows] of Object.entries(namedLists) as [EvidenceList, Evidence[]][]) {
		const weight = LIST_WEIGHTS[listName];
		const seen = new Set<number>();
		let rank = 0;
		for (const row of rows) {
			if (seen.has(row.empresa_id)) continue;
			seen.add(row.empresa_id);
			rank++;
			const contribution = weight / (RRF_K + rank);
			const existing = result.get(row.empresa_id);
			if (!existing) {
				result.set(row.empresa_id, { score: contribution, matchType: MATCH_TYPE_BY_LIST[listName], matchedVia: row.label });
			} else {
				// La etiqueta explicativa se queda con la de mayor peso ya vista (primera lista con
				// peso mas alto que aporto a esta empresa) - RRF suma el score de TODAS las listas,
				// pero mostrar todas las razones a la vez satura `matched_via` sin agregar valor real.
				const existingWeight = LIST_WEIGHTS[Object.entries(MATCH_TYPE_BY_LIST).find(([, mt]) => mt === existing.matchType)?.[0] as EvidenceList] ?? 0;
				result.set(row.empresa_id, {
					score: existing.score + contribution,
					matchType: weight > existingWeight ? MATCH_TYPE_BY_LIST[listName] : existing.matchType,
					matchedVia: weight > existingWeight ? row.label : existing.matchedVia,
				});
			}
		}
	}

	return { namedLists, canonicalCtx, result };
}

/**
 * Resuelve TODA la evidencia (estructurada + léxica + full-text + vectorial + canónica, Fase 23A)
 * para UNA frase y la fusiona por RRF ponderado. Para `multi_concept` (varias frases independientes
 * de `resolve_search_intent`), el llamador corre esta función una vez por frase y suma los mapas de
 * score resultantes - RRF es composicional, cada frase adicional es simplemente más evidencia.
 */
export async function resolvePhraseEvidence(
	sql: ReturnType<typeof getSql>,
	env: Env,
	phrase: string
): Promise<Map<number, { score: number; matchType: string; matchedVia: string }>> {
	return (await computePhraseEvidence(sql, env, phrase)).result;
}

/**
 * Fase 23A: diagnóstico opcional (punto 16 del pedido) - mismo pipeline exacto que
 * `resolvePhraseEvidence`, pero devuelve el desglose completo por señal en vez de solo el mapa
 * fusionado. NO se expone como tool MCP de cara a CIRA - `search_empresas` lo activa solo con
 * `debug: true` (ver `empresa-tools.ts`), para uso manual de administración/benchmark.
 * `candidate_count_by_source` es OBLIGATORIO revisar contra el benchmark completo antes de
 * desplegar - es la única forma de detectar si el mismo CPV llega duplicado por `canonical_cpv` Y
 * por `lexical_taxonomy`/`taxonomy` (riesgo aceptado y documentado, ver docblock de este archivo).
 */
export async function debugCanonicalSearch(sql: ReturnType<typeof getSql>, env: Env, phrase: string) {
	const { namedLists, canonicalCtx, result } = await computePhraseEvidence(sql, env, phrase);

	const candidateCountBySource = Object.fromEntries(
		(Object.entries(namedLists) as [EvidenceList, Evidence[]][]).map(([list, rows]) => [list, new Set(rows.map((r) => r.empresa_id)).size])
	);

	const fallbackLevelUsed: 'none' | 'L0_L3_direct' | 'L5_family_fallback' =
		namedLists.canonical_cpv.length > 0 ? 'L0_L3_direct' : namedLists.canonical_related.length > 0 ? 'L5_family_fallback' : 'none';

	return {
		original_query: canonicalCtx.originalQuery,
		detected_intent: canonicalCtx.detectedIntent,
		regional_terms: canonicalCtx.regionalTerms,
		canonical_concepts: canonicalCtx.canonicalConcepts,
		expanded_terms: canonicalCtx.matches.map((m) => m.term),
		cpv_relations: canonicalCtx.matches.map((m) => ({ level: m.level, cpv_code: m.cpvCode, weight: m.weight, via_term: m.viaTerm })),
		candidate_sources: Object.keys(namedLists).filter((list) => candidateCountBySource[list] > 0),
		candidate_count_by_source: candidateCountBySource,
		deduplicated_candidate_count: result.size,
		fallback_level_used: fallbackLevelUsed,
		final_count: result.size,
	};
}

/** Empresas con al menos una coincidencia estructurada/léxica directa (substring) para esta frase - usado para decidir el límite final de salida, mismo criterio de "un match literal nunca es ruido a recortar" que ya usaba el nivel EXACTO del sistema anterior (Fase MCP-4.9). */
export async function countDirectMatches(sql: ReturnType<typeof getSql>, phrase: string): Promise<number> {
	const rows = await structuredList(sql, phrase);
	return new Set(rows.map((r) => r.empresa_id)).size;
}

/** Fusiona los mapas de score de varias frases (multi_concept) sumando contribuciones - mismo principio RRF, cada frase es una fuente de evidencia mas. */
export function mergePhraseEvidence(
	maps: Map<number, { score: number; matchType: string; matchedVia: string }>[]
): Map<number, { score: number; matchType: string; matchedVia: string }> {
	if (maps.length === 1) return maps[0];

	const merged = new Map<number, { score: number; matchType: string; matchedVia: string }>();
	for (const map of maps) {
		for (const [empresaId, evidence] of map) {
			const existing = merged.get(empresaId);
			if (!existing) {
				merged.set(empresaId, { ...evidence });
			} else {
				merged.set(empresaId, {
					score: existing.score + evidence.score,
					matchType: evidence.score > existing.score ? evidence.matchType : existing.matchType,
					matchedVia: evidence.score > existing.score ? evidence.matchedVia : existing.matchedVia,
				});
			}
		}
	}
	return merged;
}

export function rankedIds(evidence: Map<number, { score: number; matchType: string; matchedVia: string }>): FusedMatch[] {
	return Array.from(evidence.entries())
		.map(([empresa_id, e]) => ({ empresa_id, score: e.score, matchType: e.matchType, matchedVia: e.matchedVia }))
		.sort((a, b) => b.score - a.score);
}
