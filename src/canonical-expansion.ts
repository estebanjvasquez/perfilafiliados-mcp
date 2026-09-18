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

/** Heurística de plural español ACOTADA (no un stemmer completo) - nunca substring, solo formas exactas candidatas. */
function candidateForms(term: string): string[] {
	const forms = new Set<string>([term]);
	if (term.length > 4 && term.endsWith('s')) forms.add(term.slice(0, -1));
	if (term.length > 5 && term.endsWith('es')) forms.add(term.slice(0, -2));
	return Array.from(forms);
}

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
async function loadSettings(sql: Sql): Promise<Record<string, string>> {
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

function flagEnabled(settings: Record<string, string>, key: string, defaultValue: boolean): boolean {
	const raw = settings[key];
	if (raw === undefined) return defaultValue;
	return raw === '1' || raw === '1.0000' || raw.startsWith('1.');
}

function weightOf(settings: Record<string, string>, key: string, defaultValue: number): number {
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
	// concepto canónico, "own_relation" prioriza la propia sobre la heredada, mismo criterio ya
	// probado en `taxonomy-tools.ts`) - cada fila trae también el código de Familia inmediata
	// (`related_cpv_code`) para L5, sin una segunda consulta condicional (ver plan, punto 4).
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
		}[]
	>`
		select distinct on (dm.cpv_code, dm.matched_term)
			dm.matched_term, dm.via_term, dm.is_alias, dm.cpv_code, dm.weight, dm.own_relation, dm.concept_name,
			tc_parent.code as related_cpv_code
		from (
			select
				t.term as matched_term, null::text as via_term, (a.alias is not null) as is_alias,
				r.cpv_code, r.weight, 1 as own_relation, null::text as concept_name, r.category_id
			from taxonomy_term_cpv_relations r
			join taxonomy_terms t on t.id = r.term_id
			left join taxonomy_term_aliases a on a.term_id = t.id and unaccent(lower(a.alias)) in ${sql(forms)}
			where r.status = 'approved'
				and (unaccent(lower(t.term)) in ${sql(forms)} or unaccent(lower(t.canonical_term)) in ${sql(forms)} or a.id is not null)
			union all
			select
				t.term as matched_term, sib.term as via_term, false as is_alias,
				r.cpv_code, r.weight, 0 as own_relation, coalesce(c.canonical_name_es, c.canonical_name_en) as concept_name, r.category_id
			from taxonomy_terms t
			join taxonomy_term_concepts link on link.term_id = t.id
			join taxonomy_canonical_concepts c on c.id = link.concept_id
			join taxonomy_term_concepts sib_link on sib_link.concept_id = link.concept_id and sib_link.term_id != t.id
			join taxonomy_terms sib on sib.id = sib_link.term_id
			join taxonomy_term_cpv_relations r on r.term_id = sib.id and r.status = 'approved'
			where (unaccent(lower(t.term)) in ${sql(forms)} or unaccent(lower(t.canonical_term)) in ${sql(forms)})
				and not exists (
					select 1 from taxonomy_term_cpv_relations r2 where r2.term_id = t.id and r2.status = 'approved'
				)
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
	// Anti-double-counting (plan, punto 7): un mismo cpvCode nunca genera más de un CanonicalTermMatch
	// L0-L3, aunque varios sinónimos (cabria/derrick/mast) apunten al mismo código - se queda con el
	// de mayor nivel/peso ya calculado por el ORDER BY de la consulta.
	const seenCpv = new Set<string>();

	for (const row of rows) {
		if (row.concept_name) canonicalConcepts.add(row.concept_name);
		if (row.is_alias && regionalEnabled) regionalTerms.add(row.matched_term);

		if (row.related_cpv_code && relatedEnabled) relatedCpvCodes.add(row.related_cpv_code);

		if (!cpvEnabled || seenCpv.has(row.cpv_code)) continue;
		seenCpv.add(row.cpv_code);

		const level: ExpansionLevel = row.own_relation === 1 ? (row.is_alias ? 'L1_alias' : 'L0_exact') : row.via_term ? 'L2_concept' : 'L3_cpv';
		const baseWeight = level === 'L1_alias' ? level1Weight : level === 'L0_exact' ? level0Weight : level === 'L2_concept' ? level2Weight : level3Weight;
		const weight = Math.round(baseWeight * row.weight * 100) / 100;

		if (weight < minConfidence) continue;

		matches.push({ term: row.matched_term, level, viaTerm: row.via_term, cpvCode: row.cpv_code, weight });
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
		expansionConfidence: 0,
	};
}
