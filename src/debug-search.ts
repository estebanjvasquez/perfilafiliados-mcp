import type { Env } from './index';
import { getSql } from './db';
import {
	computePhraseEvidence,
	mergePhraseEvidence,
	rankedIds,
	countDirectMatches,
	LIST_WEIGHTS,
	MATCH_TYPE_BY_LIST,
	type EvidenceList,
	type Evidence,
	type PhraseEvidenceDetail,
} from './hybrid-search';

/**
 * Fase 23B (ver plan en PerfilAfiliadosCPV, docs/taxonomia): reporte técnico completo del pipeline
 * de `search_empresas`, para el modo DEBUG de `public/cira-test/index.html` (`/debug-on`).
 *
 * NUNCA se llama desde el flujo real de CIRA (n8n no conoce este módulo ni este endpoint) - existe
 * exclusivamente para que un administrador reconstruya, para una consulta dada, exactamente qué
 * entendió el pipeline, qué expandió, qué candidatos generó cada señal, por qué cada empresa
 * apareció (o no) y con qué score. NO duplica búsquedas: reusa `computePhraseEvidence` (la misma
 * función que ya corre en producción dentro de `resolvePhraseEvidence`) y solo agrega lectura de
 * los datos que esa función YA calculó - la única instrumentación nueva son los `timingsMs` (medir
 * no cambia el orden ni el resultado de las promesas) y `perEmpresaContributions` (ya se computaba
 * al vuelo dentro del loop de fusión RRF, solo faltaba guardarlo desagregado).
 *
 * DEBUG != un segundo motor de búsqueda: la sección `ranking` de este reporte usa
 * `mergePhraseEvidence`/`rankedIds` tal cual, las MISMAS funciones que usa `search_empresas` - si
 * este reporte alguna vez mostrara una empresa/orden/score distinto al de una búsqueda real con el
 * mismo query, sería un bug de este archivo, no una feature.
 */

const VERSIONS = {
	mcp: 'MCP-7',
	taxonomy: 'TAXV3',
	canonical_resolver: '23A-v1',
	debug: '23B-v1',
} as const;

let debugCounter = 0;

function newDebugId(): string {
	debugCounter += 1;
	const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
	return `DBG-${date}-${String(debugCounter).padStart(5, '0')}`;
}

type EmpresaRow = { id: number; name: string };

export type DebugSearchReport = ReturnType<typeof buildReportShape>;

function buildReportShape(input: {
	debugId: string;
	query: string;
	resolvedPhrases: string[];
	phraseDetails: { phrase: string; detail: PhraseEvidenceDetail }[];
	empresasById: Map<number, EmpresaRow>;
	ranked: { empresa_id: number; score: number; matchType: string; matchedVia: string }[];
	directMatchCount: number;
	crawlerSystemWideTotal: number;
	totalMs: number;
}) {
	const { debugId, query, resolvedPhrases, phraseDetails, empresasById, ranked, directMatchCount, crawlerSystemWideTotal, totalMs } = input;

	// Fase 23B: une la expansión canónica y los conteos de candidatos de TODAS las frases (query +
	// resolvedPhrases) - mismo criterio que `mergePhraseEvidence` ya aplica al score: cada frase es
	// evidencia adicional, nunca reemplaza a la anterior.
	const allMatches = phraseDetails.flatMap(({ phrase, detail }) => detail.canonicalCtx.matches.map((m) => ({ ...m, phrase })));
	const regionalTerms = Array.from(new Set(phraseDetails.flatMap(({ detail }) => detail.canonicalCtx.regionalTerms)));
	const canonicalConcepts = Array.from(new Set(phraseDetails.flatMap(({ detail }) => detail.canonicalCtx.canonicalConcepts)));

	const candidateCountBySource: Record<string, number> = {};
	let candidatesBeforeDedup = 0;
	for (const { detail } of phraseDetails) {
		for (const [list, rows] of Object.entries(detail.namedLists) as [EvidenceList, Evidence[]][]) {
			candidateCountBySource[list] = (candidateCountBySource[list] ?? 0) + new Set(rows.map((r) => r.empresa_id)).size;
			candidatesBeforeDedup += rows.length;
		}
	}

	const timingsMs: Record<string, number> = {};
	for (const { phrase, detail } of phraseDetails) {
		for (const [stage, ms] of Object.entries(detail.timingsMs)) {
			timingsMs[phraseDetails.length > 1 ? `${phrase} · ${stage}` : stage] = ms;
		}
	}
	timingsMs.total = Math.round(totalMs * 100) / 100;

	const fallbackLevelUsed = phraseDetails.some(({ detail }) => detail.namedLists.canonical_cpv.length > 0)
		? 'L0_L3_direct'
		: phraseDetails.some(({ detail }) => detail.namedLists.canonical_related.length > 0)
			? 'L5_family_fallback'
			: 'none';

	const candidates = ranked.map((r, index) => buildCandidateDetail(r, index, phraseDetails, empresasById));

	const diagnosticFlags = buildDebugDiagnosticFlags({
		candidateCountBySource,
		crawlerSystemWideTotal,
		allMatches,
		candidates,
	});

	return {
		debug_id: debugId,
		timestamp: new Date().toISOString(),
		versions: VERSIONS,
		original_query: {
			query,
			language: 'es' as const,
			resolved_phrases: resolvedPhrases,
		},
		query_understanding: {
			// Fase 23B: `detected_intent`/`regional_terms`/`canonical_concepts` salen de
			// `canonical-expansion.ts` (tabla determinística de intención, NUNCA un LLM - ver
			// docblock de esa función). Se etiqueta `source` explícitamente por transparencia.
			detected_intent: phraseDetails[0]?.detail.canonicalCtx.detectedIntent ?? 'generic',
			intent_source: 'RULE' as const,
			regional_terms: regionalTerms,
			regional_terms_source: 'TAXONOMY' as const,
			canonical_concepts: canonicalConcepts,
		},
		mcp_payload_real: {
			// Fase 23B (punto 7 del pedido): esto es literalmente lo que search_empresas recibiría -
			// no una reconstrucción aproximada.
			query,
			resolvedPhrases,
		},
		canonical_expansion_table: allMatches.map((m) => ({
			term: m.term,
			type: m.level,
			level: levelToNumber(m.level),
			weight: m.weight,
			source: m.viaTerm ? 'taxonomy_term_concepts' : 'taxonomy_term_cpv_relations',
			via_term: m.viaTerm,
			phrase: m.phrase,
		})),
		cpv_relations: allMatches.map((m) => ({ cpv_code: m.cpvCode, level: m.level, weight: m.weight, via_term: m.viaTerm, status: 'approved' as const })),
		candidate_generation: {
			candidates_by_signal: candidateCountBySource,
			candidates_before_dedup: candidatesBeforeDedup,
			candidates_after_dedup: ranked.length,
		},
		candidates,
		fallback: {
			fallback_used: fallbackLevelUsed !== 'none' && fallbackLevelUsed === 'L5_family_fallback',
			fallback_level: fallbackLevelUsed,
		},
		early_stop_triggered: false,
		crawler_evidence: {
			system_wide_total: crawlerSystemWideTotal,
			note:
				crawlerSystemWideTotal < 50
					? 'Cobertura del crawler muy baja - no representativa todavía (Fase 23B, Problema B separado del MCP).'
					: null,
		},
		diagnostic_flags: diagnosticFlags,
		timings_ms: timingsMs,
		query_count: {
			signal_functions_run: phraseDetails.length * Object.keys(phraseDetails[0]?.detail.namedLists ?? {}).length,
			cache: 'not implemented',
		},
		direct_match_count: directMatchCount,
	};
}

function levelToNumber(level: string): number {
	const map: Record<string, number> = { L0_exact: 0, L1_alias: 1, L2_concept: 2, L3_cpv: 3, L5_family_fallback: 5 };
	return map[level] ?? -1;
}

function buildCandidateDetail(
	ranked: { empresa_id: number; score: number; matchType: string; matchedVia: string },
	index: number,
	phraseDetails: { phrase: string; detail: PhraseEvidenceDetail }[],
	empresasById: Map<number, EmpresaRow>
) {
	const empresa = empresasById.get(ranked.empresa_id);

	// Fase 23B: junta, de TODAS las frases, qué señales encontraron a esta empresa y con qué label
	// (evidencia real ya calculada - `matchedVia` nunca se inventa acá).
	const evidenceBySource: { source: EvidenceList; label: string; phrase: string }[] = [];
	const scoreBreakdown: Partial<Record<EvidenceList, number>> = {};

	for (const { phrase, detail } of phraseDetails) {
		for (const [list, rows] of Object.entries(detail.namedLists) as [EvidenceList, Evidence[]][]) {
			const hit = rows.find((r) => r.empresa_id === ranked.empresa_id);
			if (hit) evidenceBySource.push({ source: list, label: hit.label, phrase });
		}
		const contributions = detail.perEmpresaContributions.get(ranked.empresa_id);
		if (contributions) {
			for (const [list, value] of Object.entries(contributions) as [EvidenceList, number][]) {
				scoreBreakdown[list] = Math.round(((scoreBreakdown[list] ?? 0) + value) * 10000) / 10000;
			}
		}
	}

	const directSources: EvidenceList[] = ['structured', 'lexical_experiencia', 'lexical_taxonomy', 'fulltext', 'name_typo'];
	const directEvidence = evidenceBySource.filter((e) => directSources.includes(e.source));
	const inferredEvidence = evidenceBySource.filter((e) => !directSources.includes(e.source));

	const evidenceStrength = classifyEvidenceStrength(evidenceBySource.map((e) => e.source));
	const whyIncluded = buildWhyIncluded(evidenceBySource, evidenceStrength);

	return {
		rank: index + 1,
		empresa_id: ranked.empresa_id,
		empresa_name: empresa?.name ?? `#${ranked.empresa_id}`,
		match_type: ranked.matchType,
		matched_via: ranked.matchedVia,
		score: Math.round(ranked.score * 10000) / 10000,
		evidence_sources: Array.from(new Set(evidenceBySource.map((e) => e.source))),
		score_breakdown: scoreBreakdown,
		evidence_strength: evidenceStrength,
		direct_match: directEvidence.length > 0 ? directEvidence.map((e) => e.label) : ['none'],
		inferred_match: inferredEvidence.length > 0 ? inferredEvidence.map((e) => e.label) : ['none'],
		why_included: whyIncluded,
	};
}

function classifyEvidenceStrength(sources: EvidenceList[]): string {
	if (sources.includes('structured') || sources.includes('lexical_experiencia') || sources.includes('lexical_taxonomy') || sources.includes('fulltext')) {
		return 'LITERAL_MATCH';
	}
	if (sources.includes('canonical_cpv')) return 'CPV_CAPABILITY';
	if (sources.includes('canonical_related')) return 'RELATED_CAPABILITY';
	if (sources.includes('taxonomy')) return 'TAXONOMY_INFERENCE';
	if (sources.includes('service') || sources.includes('experiencia')) return 'SEMANTIC_INFERENCE';
	if (sources.includes('name_typo')) return 'RELATED_CAPABILITY';
	return 'RELATED_CAPABILITY';
}

/** Fase 23B (punto 40 del pedido): armada por plantilla a partir de evidencia real, NUNCA por un LLM. */
function buildWhyIncluded(evidence: { source: EvidenceList; label: string }[], strength: string): string {
	if (evidence.length === 0) return 'Sin evidencia registrada (no debería ocurrir - reportar como bug).';

	const primary = evidence[0];
	return `Evidencia principal (${strength}): ${primary.label}.${evidence.length > 1 ? ` Además: ${evidence.slice(1).map((e) => e.label).join('; ')}.` : ''}`;
}

function buildDebugDiagnosticFlags(input: {
	candidateCountBySource: Record<string, number>;
	crawlerSystemWideTotal: number;
	allMatches: unknown[];
	candidates: ReturnType<typeof buildCandidateDetail>[];
}): string[] {
	const flags: string[] = [];
	if (input.crawlerSystemWideTotal < 50) flags.push('NO_CRAWLER_EVIDENCE');
	if (input.candidates.some((c) => c.evidence_sources.length > 2)) flags.push('POSSIBLE_DOUBLE_COUNTING');
	if (flags.length === 0) flags.push('NO_ISSUES_DETECTED');
	return flags;
}

export async function resolveDebugSearch(env: Env, query: string, resolvedPhrases: string[] = []) {
	const start = performance.now();
	const sql = getSql(env);

	try {
		const phrases = Array.from(new Set([query, ...resolvedPhrases]));
		const phraseDetails = await Promise.all(phrases.map(async (phrase) => ({ phrase, detail: await computePhraseEvidence(sql, env, phrase) })));

		const fusedEvidence = mergePhraseEvidence(phraseDetails.map(({ detail }) => detail.result));
		const ranked = rankedIds(fusedEvidence);
		const directMatchCount = await countDirectMatches(sql, phrases[0]);

		const empresasById = new Map<number, EmpresaRow>();
		if (ranked.length > 0) {
			const rows = await sql<EmpresaRow[]>`select id, name from empresas where id in ${sql(ranked.map((r) => r.empresa_id))}`;
			for (const row of rows) empresasById.set(row.id, row);
		}

		const [{ count: crawlerTotal }] = await sql<{ count: number }[]>`select count(*)::int as count from company_term_matches`;

		return buildReportShape({
			debugId: newDebugId(),
			query,
			resolvedPhrases,
			phraseDetails,
			empresasById,
			ranked,
			directMatchCount,
			crawlerSystemWideTotal: crawlerTotal,
			totalMs: performance.now() - start,
		});
	} finally {
		await sql.end({ timeout: 1 });
	}
}
