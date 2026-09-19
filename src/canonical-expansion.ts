import type { Env } from './index';
import { getSql } from './db';

/**
 * Fase 23A (ver plan en PerfilAfiliadosCPV, docs/taxonomia - diagnóstico de `cabrias`): capa de
 * expansión canónica, independiente y testeable por separado de `hybrid-search.ts`. Conecta la
 * Taxonomía V3 (`taxonomy_terms`, `taxonomy_term_aliases`, `taxonomy_canonical_concepts`,
 * `taxonomy_term_concepts`, `taxonomy_term_cpv_relations`) - construida en PerfilAfiliadosCPV pero
 * hasta esta fase invisible para `search_empresas` - con la búsqueda real de empresas.
 *
 * Diseño DELIBERADO, no genérico: NO reemplaza ningún mecanismo de `hybrid-search.ts`, solo produce
 * un `CanonicalSearchContext` que ese archivo consume para generar 4 señales NUEVAS, adicionales a
 * sus 8 actuales (ver docblock de `hybrid-search.ts` tras esta fase). Este archivo nunca llama a
 * `resolvePhraseEvidence` ni viceversa en el sentido de acoplamiento - solo comparten `sql`.
 *
 * NIVELES DE EXPANSIÓN (L0-L5, ver plan): esta versión implementa L0 (término exacto), L1 (alias/
 * regionalismo), L2 (concepto canónico) y L3 (CPV aprobado, propio o heredado del concepto - MISMO
 * criterio "propia gana sobre heredada" ya probado y en producción en `taxonomy-tools.ts`) en UNA
 * sola consulta SQL, más L5 (fallback de un solo salto por `taxonomy_categories.parent_id` hacia la
 * Familia inmediata) EN LA MISMA consulta (sin round-trip extra) para que el llamador decida sin
 * necesitar una segunda query. L4 (salto semántico/conceptual, ej. "DERRICK"->"drilling equipment")
 * queda deliberadamente SIN implementar - es exactamente el riesgo de contaminación semántica que
 * motivó esta fase (ver `mcp_canonical.canonical_related_l4_expansion_enabled`, default 0).
 *
 * MATCH EXACTO, NO ILIKE '%..%': a diferencia de `TaxonomyCategorySearch::dictionary()` (pensado
 * para autocompletado interactivo, donde un ILIKE parcial tiene sentido), acá la entrada ya es una
 * frase/token acotado (viene de una frase de búsqueda ya segmentada, no de tipeo parcial de un
 * admin) - un ILIKE de substring reproduciría la clase de bug ya sufrida 5 veces en este proyecto
 * ("represas" ~ "REPRESENTACIONES...", ver `hybrid-search.ts`). Se normaliza (minúsculas, sin
 * tildes) y se prueba el término tal cual MÁS una heurística de plural español acotada
 * (`candidateForms`) - nunca substring.
 */

type Sql = ReturnType<typeof getSql>;

export type ExpansionLevel = 'L0_exact' | 'L1_alias' | 'L2_concept' | 'L3_cpv' | 'L5_family_fallback';

export type CanonicalTermMatch = {
	term: string;
	level: ExpansionLevel;
	viaTerm: string | null;
	cpvCode: string;
	weight: number;
	// Fase 24 (corrección de causas raíz A-J, ver docs/taxonomia): datos crudos de `taxonomy_terms`/
	// `taxonomy_term_cpv_relations` que ya existían en el schema pero nunca se propagaban fuera de
	// esta función - nunca inferidos, siempre el valor real de la fila que produjo este match.
	regions: string[];
	termType: string | null;
	isAlias: boolean;
	// Descriptor de CALIDAD del mapping término↔CPV (exact/strong_lexical/lexical/contextual/
	// explicit_synonym - ver taxonomy_term_cpv_relations.relation_type), NO una relación ontológica
	// verificada (EQUIPMENT_FOR/USED_FOR/etc. - esas no existen todavía, ver auditoría Fase 24 punto
	// 10). Deliberadamente sin reinterpretar: se expone tal cual la guarda el Auto Mapper.
	mappingRelationType: string | null;
};

export type DetectedIntent = 'manufacturing' | 'maintenance' | 'rental' | 'inspection' | 'supply' | 'generic';

export type CanonicalSearchContext = {
	originalQuery: string;
	normalizedTerm: string;
	detectedIntent: DetectedIntent;
	regionalTerms: string[];
	canonicalConcepts: string[];
	matches: CanonicalTermMatch[];
	directCpvCodes: string[];
	relatedCpvCodes: string[];
	expansionConfidence: number;
	// Fase 24: mapping_relation_type por cpv_code, para que `hybrid-search.ts` pueda etiquetar cada
	// Evidence de `canonical_cpv`/`canonical_related` con el tipo de relación real que la originó, sin
	// tener que volver a tocar `taxonomy_term_cpv_relations` - ya viene resuelto acá.
	relationTypeByCpv: Record<string, string | null>;
	// Fase 24, Fase 2 (evidence layering): el weight que tendría el fallback L5 (level5_fallback_penalty),
	// SIEMPRE presente cuando `relatedCpvCodes` no está vacío - independiente de si ese weight alcanzó
	// `minimum_expansion_confidence` (el gate que decide si el L5 entra a `matches`, un gate DISTINTO
	// y ya existente desde Fase 23A). `canonicalRelatedList` (hybrid-search.ts) necesita este valor
	// para su propio gate (`minimum_relation_confidence`) sin depender de que el otro gate haya
	// pasado - antes de este campo, un `minimum_relation_confidence` > 0 rompía canonical_related en
	// TODOS los casos, porque `matches` casi nunca lleva una entrada L5 bajo los defaults actuales
	// (0.30 < 0.50, ver bug encontrado probando esto contra "cabria").
	relatedWeight: number;
};

/**
 * Tabla determinística de intención - a propósito NO es un LLM (ver punto 22 del pedido original:
 * "no usar LLM para resolver lo que ya sabe la taxonomía"). El intent viaja como METADATA, nunca
 * como filtro SQL duro - se usa río abajo (`hybrid-search.ts`) para ETIQUETAR evidencia
 * (DIRECT_CAPABILITY vs RELATED_CAPABILITY), no para excluir empresas.
 */
const INTENT_KEYWORDS: Record<Exclude<DetectedIntent, 'generic'>, RegExp> = {
	manufacturing: /\b(fabrica\w*|manufactur\w*)\b/i,
	maintenance: /\b(mantenimiento|manteni\w*|reparaci[oó]n|repara\w*)\b/i,
	rental: /\b(alquiler|alquila\w*|renta\w*)\b/i,
	inspection: /\b(inspecci[oó]n|inspeccion\w*)\b/i,
	supply: /\b(venta|vend\w*|suministr\w*|distribui\w*|distribuidor\w*)\b/i,
};

// Preposiciones/conectores comunes en español que quedan pegados a la palabra de intención al
// removerla (ej. "mantenimiento de cabrias" -> "de cabrias" -> "cabrias") - se limpian aparte para
// no tener que listar cada combinación "verbo + de/para/en" en INTENT_KEYWORDS.
const LEADING_CONNECTOR = /^\s*(de|del|para|en)\s+/i;

function detectIntent(phrase: string): { intent: DetectedIntent; normalizedTerm: string } {
	for (const [intent, pattern] of Object.entries(INTENT_KEYWORDS) as [Exclude<DetectedIntent, 'generic'>, RegExp][]) {
		if (pattern.test(phrase)) {
			const stripped = phrase.replace(pattern, ' ').replace(LEADING_CONNECTOR, '').trim();
			return { intent, normalizedTerm: stripped || phrase };
		}
	}
	return { intent: 'generic', normalizedTerm: phrase.trim() };
}

/**
 * Fase 24 (encontrado validando el fix de canonical concepts contra un fixture real -
 * "levantamiento artificial"/"balancín", NO contra gandola/cabria, que por coincidencia no llevan
 * tilde): el SQL de abajo compara `unaccent(lower(t.term)) in (...)` - el lado de la COLUMNA se
 * unaccenta, pero `forms` nunca se unaccentaba del lado de JS, así que cualquier término de la
 * consulta con tilde/diéresis/eñe (`balancín`, `cigüeña`, `producción`) nunca podía matchear su
 * propia fila aunque existiera exacta - bug general de normalización, no específico de ningún
 * término. `normalize('NFD')` + strip de diacríticos combinantes es el equivalente JS está ndar del
 * `unaccent()` de Postgres (mismo resultado para el alfabeto español).
 */
function stripAccents(s: string): string {
	return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Heurística de plural español ACOTADA (no un stemmer completo) - nunca substring, solo formas exactas candidatas. */
function candidateForms(term: string): string[] {
	const base = stripAccents(term);
	const forms = new Set<string>([base]);
	if (base.length > 4 && base.endsWith('s')) forms.add(base.slice(0, -1));
	if (base.length > 5 && base.endsWith('es')) forms.add(base.slice(0, -2));
	return Array.from(forms);
}

/**
 * Fase 24 (punto 2 del pedido): clasificación GENERAL de `term_type` para decidir si un término
 * cuenta como "regionalismo" a mostrar en `regional_terms` - nunca por país/término específico, solo
 * por esta categoría ya modelada en `taxonomy_terms.term_type` desde la importación TAXV2. Deja
 * afuera `oilfield_slang` (jerga de industria, no ligada a geografía) a propósito: son categorías
 * conceptualmente distintas (jerga técnica del rubro vs. variante regional de un país/zona).
 */
const REGIONAL_TERM_TYPES = new Set(['regional_slang', 'regional_variant']);

type SettingsCache = { values: Record<string, string>; expiresAt: number };
let settingsCache: SettingsCache | null = null;
const SETTINGS_CACHE_TTL_MS = 60_000;

/**
 * `taxonomy_settings` es la MISMA tabla clave-valor que ya administra el panel de Laravel
 * (`TaxonomyRankingParameters`/`TaxonomyRankingSettingsPage`, grupo "MCP - Expansión canónica") -
 * no se crea configuración paralela. Cache a nivel de módulo con TTL corto: el isolate de Cloudflare
 * Workers se reutiliza entre invocaciones, así que esto evita una consulta a `taxonomy_settings` en
 * cada búsqueda sin necesitar KV/Durable Objects (ver punto 21 del pedido: performance).
 */
// Fase 24, Fase 2 (evidence layering): exportadas para que `hybrid-search.ts` pueda leer los NUEVOS
// settings de `canonical_related` (`related_candidates_parallel_enabled`/`max_related_candidates`/
// `minimum_relation_confidence`/`generic_relation_penalty`) sin reimplementar el cache/parseo - el
// cache es a nivel de módulo (`settingsCache` arriba), así que una segunda llamada desde otro archivo
// dentro de la misma invocación es un cache hit, no una query nueva.
export async function loadSettings(sql: Sql): Promise<Record<string, string>> {
	if (settingsCache && settingsCache.expiresAt > Date.now()) {
		return settingsCache.values;
	}

	const rows = await sql<{ key: string; value: string }[]>`
		select key, value from taxonomy_settings where key like 'mcp_canonical.%' or key = 'ranking.regional_alias_boost'
	`;
	const values: Record<string, string> = {};
	for (const row of rows) values[row.key] = row.value;

	settingsCache = { values, expiresAt: Date.now() + SETTINGS_CACHE_TTL_MS };
	return values;
}

export function flagEnabled(settings: Record<string, string>, key: string, defaultValue: boolean): boolean {
	const raw = settings[key];
	if (raw === undefined) return defaultValue;
	return raw === '1' || raw === '1.0000' || raw.startsWith('1.');
}

export function weightOf(settings: Record<string, string>, key: string, defaultValue: number): number {
	const raw = settings[key];
	if (raw === undefined) return defaultValue;
	const parsed = parseFloat(raw);
	return Number.isFinite(parsed) ? parsed : defaultValue;
}

/**
 * Mismas familias CPV "atractoras" que ya excluye `hybrid-search.ts` (`GENERIC_ATTRACTOR_FAMILY_CODES`)
 * - el fallback L5 (un salto de familia) NO debe poder aterrizar en una de estas por accidente.
 * Duplicada acá (no importada) a propósito: son archivos con responsabilidades distintas y esta
 * lista es chica y estable - importar cruzado entre `canonical-expansion.ts` y `hybrid-search.ts`
 * para 4 strings agregaría acoplamiento sin beneficio real.
 */
const GENERIC_ATTRACTOR_FAMILY_CODES = ['CPV-29.02', 'CPV-12.04', 'CPV-48.02', 'CPV-22.08'];

export async function resolveCanonicalQuery(env: Env, phrase: string): Promise<CanonicalSearchContext> {
	const sql = getSql(env);

	try {
		return await resolveCanonicalQueryWithSql(sql, phrase);
	} finally {
		await sql.end({ timeout: 1 });
	}
}

/** Variante que reusa un cliente `sql` ya abierto - la que realmente llama `hybrid-search.ts` (nunca abre su propia conexión por señal, ver `resolvePhraseEvidence`). */
export async function resolveCanonicalQueryWithSql(sql: Sql, phrase: string): Promise<CanonicalSearchContext> {
	const settings = await loadSettings(sql);
	const { intent, normalizedTerm } = detectIntent(phrase);

	if (!flagEnabled(settings, 'mcp_canonical.canonical_query_expansion_enabled', true) || normalizedTerm.length < 3) {
		return emptyContext(phrase, normalizedTerm, intent);
	}

	const level0Weight = weightOf(settings, 'mcp_canonical.level0_weight', 1.0);
	const level1Weight = weightOf(settings, 'ranking.regional_alias_boost', 1.08);
	const level2Weight = weightOf(settings, 'mcp_canonical.level2_weight', 0.9);
	const level3Weight = weightOf(settings, 'mcp_canonical.level3_weight', 0.9);
	const level5Penalty = weightOf(settings, 'mcp_canonical.level5_fallback_penalty', 0.3);
	const minConfidence = weightOf(settings, 'mcp_canonical.minimum_expansion_confidence', 0.5);
	const regionalEnabled = flagEnabled(settings, 'mcp_canonical.regional_expansion_enabled', true);
	const cpvEnabled = flagEnabled(settings, 'mcp_canonical.canonical_cpv_expansion_enabled', true);
	const relatedEnabled = flagEnabled(settings, 'mcp_canonical.canonical_related_expansion_enabled', true);

	const forms = candidateForms(normalizedTerm.toLowerCase());

	// Una sola consulta: L0/L1 (match exacto propio, con o sin alias) UNION L2/L3 (herencia por
	// concepto canónico) - cada fila trae también el código de Familia inmediata (`related_cpv_code`)
	// para L5, sin una segunda consulta condicional (ver plan, punto 4).
	//
	// Fase 24 (corrección de causa raíz D/G del diagnóstico A-J): la rama L2/L3 YA NO excluye
	// términos que tengan su propia relación directa (`NOT EXISTS` eliminado) - antes ese guard
	// impedía que un término con relación CPV propia (`balancín`→CPV-29.04.02G) pudiera ADEMÁS
	// resolver su concepto canónico (`Pumpjack`) vía sus hermanos de concepto, dejando
	// `canonical_concepts`/`regional_terms` estructuralmente vacíos para cualquier término en esa
	// forma - no solo gandola. Las evidencias ahora son aditivas (`own_relation` sigue priorizando
	// cuál gana el MISMO cpv_code vía `seenCpv` más abajo, nunca se pierde el anti-double-counting).
	// `t.region`/`t.term_type`/`r.relation_type` se seleccionan en ambas ramas porque ya existían en
	// el schema (TAXV2/TAXV3) sin que este resolver los leyera nunca (causas raíz E/H).
	//
	// Fase 24 (encontrado validando "levantamiento artificial"): el "distinct on (cpv_code,
	// matched_term)" que tenía esta consulta colapsaba la fila de la rama L2/L3 (con concept_name
	// real) contra la fila own_relation (concept_name siempre null) cuando ambas apuntan al MISMO
	// cpv_code - el caso más común de un término que además pertenece a un concepto -, perdiendo el
	// nombre del concepto incluso después de quitar el NOT EXISTS de arriba. Se quita ese distinct on:
	// el loop de JS de abajo ya hace su propio dedup por cpv_code (seenCpv) para decidir qué gana como
	// CanonicalTermMatch, pero recolecta concept_name/region/term_type de CADA fila sin condicionarlo
	// a ese dedup - nada se pierde con varias filas por (cpv_code, matched_term). El "order by" se
	// mantiene: sigue siendo lo que decide qué fila ve el JS primero por cpv_code (own_relation gana,
	// mismo criterio de siempre).
	const rows = await sql<
		{
			matched_term: string;
			via_term: string | null;
			is_alias: boolean;
			cpv_code: string;
			weight: number;
			own_relation: number;
			concept_name: string | null;
			related_cpv_code: string | null;
			region: string[];
			term_type: string | null;
			relation_type: string | null;
		}[]
	>`
		select
			dm.matched_term, dm.via_term, dm.is_alias, dm.cpv_code, dm.weight, dm.own_relation, dm.concept_name,
			dm.region, dm.term_type, dm.relation_type,
			tc_parent.code as related_cpv_code
		from (
			select
				t.term as matched_term, null::text as via_term, (a.alias is not null) as is_alias,
				r.cpv_code, r.weight, 1 as own_relation, null::text as concept_name, r.category_id,
				t.region, t.term_type, r.relation_type
			from taxonomy_term_cpv_relations r
			join taxonomy_terms t on t.id = r.term_id
			left join taxonomy_term_aliases a on a.term_id = t.id and unaccent(lower(a.alias)) in ${sql(forms)}
			where r.status = 'approved'
				and (unaccent(lower(t.term)) in ${sql(forms)} or unaccent(lower(t.canonical_term)) in ${sql(forms)} or a.id is not null)
			union all
			select
				t.term as matched_term, sib.term as via_term, false as is_alias,
				r.cpv_code, r.weight, 0 as own_relation, coalesce(c.canonical_name_es, c.canonical_name_en) as concept_name, r.category_id,
				t.region, t.term_type, r.relation_type
			from taxonomy_terms t
			join taxonomy_term_concepts link on link.term_id = t.id
			join taxonomy_canonical_concepts c on c.id = link.concept_id
			join taxonomy_term_concepts sib_link on sib_link.concept_id = link.concept_id and sib_link.term_id != t.id
			join taxonomy_terms sib on sib.id = sib_link.term_id
			join taxonomy_term_cpv_relations r on r.term_id = sib.id and r.status = 'approved'
			where (unaccent(lower(t.term)) in ${sql(forms)} or unaccent(lower(t.canonical_term)) in ${sql(forms)})
		) dm
		join taxonomy_categories tc on tc.id = dm.category_id
		left join taxonomy_categories tc_parent on tc_parent.id = tc.parent_id
		where tc.code not in ${sql(GENERIC_ATTRACTOR_FAMILY_CODES)}
		order by dm.cpv_code, dm.matched_term, dm.own_relation desc, dm.weight desc
	`;

	const matches: CanonicalTermMatch[] = [];
	const regionalTerms = new Set<string>();
	const canonicalConcepts = new Set<string>();
	const relatedCpvCodes = new Set<string>();
	const relationTypeByCpv: Record<string, string | null> = {};
	// Anti-double-counting (plan, punto 7): un mismo cpvCode nunca genera más de un CanonicalTermMatch
	// L0-L3, aunque varios sinónimos (cabria/derrick/mast) apunten al mismo código - se queda con el
	// de mayor nivel/peso ya calculado por el ORDER BY de la consulta.
	const seenCpv = new Set<string>();

	for (const row of rows) {
		if (row.concept_name) canonicalConcepts.add(row.concept_name);
		// Fase 24 (corrección de causa raíz E): "regional" se decide por `term_type` (categoría ya
		// modelada en TAXV2/TAXV3 - `regional_slang`/`regional_variant`), NUNCA por `is_alias` (que
		// solo indica "la búsqueda matcheó una alias string", un concepto distinto y ortogonal). Un
		// término puede ser regional sin ser alias de nada (gandola, balancín) y viceversa.
		if (regionalEnabled && row.term_type && REGIONAL_TERM_TYPES.has(row.term_type)) {
			regionalTerms.add(row.matched_term);
		}

		if (row.related_cpv_code && relatedEnabled) relatedCpvCodes.add(row.related_cpv_code);

		if (!cpvEnabled || seenCpv.has(row.cpv_code)) continue;
		seenCpv.add(row.cpv_code);
		relationTypeByCpv[row.cpv_code] = row.relation_type;

		const level: ExpansionLevel = row.own_relation === 1 ? (row.is_alias ? 'L1_alias' : 'L0_exact') : row.via_term ? 'L2_concept' : 'L3_cpv';
		const baseWeight = level === 'L1_alias' ? level1Weight : level === 'L0_exact' ? level0Weight : level === 'L2_concept' ? level2Weight : level3Weight;
		const weight = Math.round(baseWeight * row.weight * 100) / 100;

		if (weight < minConfidence) continue;

		matches.push({
			term: row.matched_term,
			level,
			viaTerm: row.via_term,
			cpvCode: row.cpv_code,
			weight,
			regions: row.region ?? [],
			termType: row.term_type,
			isAlias: row.is_alias,
			mappingRelationType: row.relation_type,
		});
	}

	const directCpvCodes = Array.from(seenCpv);
	// L5 solo aporta códigos de Familia que NO ya llegaron como CPV directo (evita que el mismo
	// código cuente dos veces como "directo" y "relacionado" a la vez).
	const relatedOnly = Array.from(relatedCpvCodes).filter((code) => !directCpvCodes.includes(code));

	if (relatedOnly.length > 0 && level5Penalty >= minConfidence) {
		matches.push(
			...relatedOnly.map((code) => ({
				term: normalizedTerm,
				level: 'L5_family_fallback' as ExpansionLevel,
				viaTerm: null,
				cpvCode: code,
				weight: Math.round(level5Penalty * 100) / 100,
				regions: [],
				termType: null,
				isAlias: false,
				mappingRelationType: relationTypeByCpv[code] ?? null,
			}))
		);
	}

	return {
		originalQuery: phrase,
		normalizedTerm,
		detectedIntent: intent,
		regionalTerms: Array.from(regionalTerms),
		canonicalConcepts: Array.from(canonicalConcepts),
		matches,
		directCpvCodes,
		relatedCpvCodes: relatedOnly,
		relationTypeByCpv,
		relatedWeight: relatedOnly.length > 0 ? Math.round(level5Penalty * 100) / 100 : 0,
		expansionConfidence: matches.length > 0 ? Math.max(...matches.map((m) => m.weight)) : 0,
	};
}

function emptyContext(phrase: string, normalizedTerm: string, intent: DetectedIntent): CanonicalSearchContext {
	return {
		originalQuery: phrase,
		normalizedTerm,
		detectedIntent: intent,
		regionalTerms: [],
		canonicalConcepts: [],
		matches: [],
		directCpvCodes: [],
		relatedCpvCodes: [],
		relationTypeByCpv: {},
		relatedWeight: 0,
		expansionConfidence: 0,
	};
}
