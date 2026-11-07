/**
 * TASK-0013 (PerfilAfiliadosCPV, Issue #2): explicación por resultado para `search_empresas` con
 * `explain: true`. Muestra de dónde salió cada empresa (nombre, servicio, sector, experiencia,
 * taxonomía CPV, texto del perfil...) y cuánto aportó cada fuente al puntaje con el que quedó ordenada.
 *
 * SOLO LEE. No cambia ni el ranking ni el corte ni `matched_via`: reusa la evidencia y las
 * contribuciones que `computePhraseEvidence` ya calculó para ordenar (`perEmpresaContributions`, el
 * mismo dato que usa /debug-search), y agrega una consulta aparte, solo para las empresas ya
 * devueltas, que dice qué campo concreto coincidió en la lista `structured` (la lista sigue igual).
 */
import type { getSql } from './db';
import {
	isDirectEvidenceList,
	LIST_WEIGHTS,
	NAME_SUBSTRING_MIN_LENGTH,
	RRF_K,
	type EvidenceList,
	type PhraseEvidenceDetail,
} from './hybrid-search';

type Sql = ReturnType<typeof getSql>;

export type ExplainKind = 'coincide' | 'capacidad_cpv' | 'similar' | 'relacionado';

export type ExplainSource = {
	/** Fuente legible: "Servicio", "Sector", "Experiencia", "Taxonomía CPV"... */
	fuente: string;
	/** Lista interna del ranking (para trazabilidad técnica). */
	lista: EvidenceList;
	tipo: ExplainKind;
	/** Qué coincidió, con el texto real del perfil. */
	detalle: string;
	/** Frase buscada que produjo esta evidencia (query o una de resolvedPhrases). */
	frase: string;
	/** Peso efectivo de la lista (incluye penalizaciones configuradas). */
	peso: number;
	/** Posición de la empresa dentro de esa lista, que es lo que usa RRF. */
	posicion_en_fuente: number;
	/** peso / (RRF_K + posicion_en_fuente). */
	aporte: number;
	/** Porcentaje del puntaje de la empresa que viene de esta fuente. */
	aporte_pct: number;
};

export type Explain = {
	posicion: number;
	puntaje: number;
	/** Puntaje relativo al primer resultado de la lista (= 100). */
	puntaje_relativo: number;
	fuentes: ExplainSource[];
	formula: string;
};

const FUENTE: Record<EvidenceList, string> = {
	structured: 'Nombre, servicio, sector o certificación',
	name_typo: 'Nombre de la empresa (posible error de tipeo)',
	lexical_experiencia: 'Experiencia',
	lexical_taxonomy: 'Taxonomía CPV',
	fulltext: 'Texto del perfil',
	service: 'Servicio',
	experiencia: 'Experiencia',
	taxonomy: 'Taxonomía CPV',
	canonical_cpv: 'Taxonomía CPV (relación aprobada)',
	canonical_related: 'Taxonomía CPV relacionada',
	sector_focus: 'Especialización (sector o servicios)',
};

function kindOf(list: EvidenceList): ExplainKind {
	if (list === 'name_typo') return 'similar';
	if (isDirectEvidenceList(list)) return 'coincide';
	if (list === 'canonical_cpv') return 'capacidad_cpv';
	if (list === 'canonical_related') return 'relacionado';
	return 'similar';
}

const round = (x: number, d = 4) => Math.round(x * 10 ** d) / 10 ** d;

/** Posición de cada empresa dentro de cada lista, con la misma deduplicación que el bucle RRF. */
function positionsByList(detail: PhraseEvidenceDetail): Map<EvidenceList, Map<string, { pos: number; label: string }>> {
	const out = new Map<EvidenceList, Map<string, { pos: number; label: string }>>();
	for (const [list, rows] of Object.entries(detail.namedLists) as [EvidenceList, PhraseEvidenceDetail['namedLists'][EvidenceList]][]) {
		const m = new Map<string, { pos: number; label: string }>();
		let pos = 0;
		for (const r of rows) {
			const k = String(r.empresa_id);
			if (m.has(k)) continue;
			m.set(k, { pos: ++pos, label: r.label });
		}
		out.set(list, m);
	}
	return out;
}

/**
 * Qué campo concreto coincidió en la lista `structured` para cada empresa. Mismo criterio de
 * coincidencia que `structuredList` (ilike + unaccent sobre la frase), pero consultando el texto del
 * campo y solo para `ids`. No participa del ranking.
 */
async function structuredFields(sql: Sql, phrase: string, ids: string[]): Promise<Map<string, { fuente: string; detalle: string }[]>> {
	const out = new Map<string, { fuente: string; detalle: string }[]>();
	if (ids.length === 0) return out;
	const like = '%' + phrase + '%';
	const add = (id: string, fuente: string, detalle: string) => {
		const arr = out.get(id) ?? [];
		if (!arr.some((x) => x.fuente === fuente && x.detalle === detalle)) arr.push({ fuente, detalle });
		out.set(id, arr);
	};

	const [names, services, sectors, certs, sust, declared] = await Promise.all([
		phrase.length >= NAME_SUBSTRING_MIN_LENGTH
			? sql<{ id: number; name: string }[]>`select id, name from empresas where id in ${sql(ids)} and unaccent(name) ilike unaccent(${like})`
			: Promise.resolve([] as { id: number; name: string }[]),
		sql<{ id: number; name: string }[]>`
			select distinct ess.empresa_id as id, sv.name
			from empresa_sector_service ess join services sv on sv.id = ess.service_id
			where ess.empresa_id in ${sql(ids)} and unaccent(sv.name) ilike unaccent(${like})`,
		sql<{ id: number; name: string }[]>`
			select distinct ess.empresa_id as id, s.name
			from empresa_sector_service ess join services sv on sv.id = ess.service_id join sectors s on s.id = sv.sectors_id
			where ess.empresa_id in ${sql(ids)} and unaccent(s.name) ilike unaccent(${like})`,
		sql<{ id: number; otras: string | null }[]>`
			select empresa_id as id, otras_certificaciones as otras from empresa_certifications
			where empresa_id in ${sql(ids)} and unaccent(coalesce(otras_certificaciones, '')) ilike unaccent(${like})`,
		sql<{ id: number; name: string }[]>`
			select distinct esa.empresa_id as id, sa.name
			from empresa_sustainability_areas esa join sustainability_areas sa on sa.id = esa.area_id
			where esa.empresa_id in ${sql(ids)} and (unaccent(sa.name) ilike unaccent(${like}) or unaccent(coalesce(sa.synonyms, '')) ilike unaccent(${like}))`,
		sql<{ id: number; principal: string | null; secundario: string | null }[]>`
			select e.id,
				case when unaccent(coalesce(sp.name, '')) ilike unaccent(${like}) then sp.name end as principal,
				case when unaccent(coalesce(ss.name, '')) ilike unaccent(${like}) then ss.name end as secundario
			from empresas e
			left join sectors sp on sp.id = e.sector_principal_id
			left join sectors ss on ss.id = e.sector_secundario_id
			where e.id in ${sql(ids)}`,
	]);

	for (const r of names) add(String(r.id), 'Nombre de la empresa', String(r.name).trim());
	for (const r of services) add(String(r.id), 'Servicio', String(r.name).trim());
	for (const r of sectors) add(String(r.id), 'Sector', String(r.name).trim());
	for (const r of certs) add(String(r.id), 'Certificación', String(r.otras ?? '').trim().slice(0, 120));
	for (const r of sust) add(String(r.id), 'Área de sostenibilidad', String(r.name).trim());
	for (const r of declared) {
		if (r.principal) add(String(r.id), 'Sector principal', String(r.principal).trim());
		if (r.secundario) add(String(r.id), 'Sector secundario', String(r.secundario).trim());
	}
	return out;
}

/**
 * Para la lista `fulltext`: qué palabras del perfil coincidieron de verdad y un fragmento. El
 * full-text reduce las palabras a su raíz, así que "operadores" puede haber coincidido con
 * "operaciones"; sin esto la explicación decía solo «coincide en texto con "operadores"».
 * Misma normalización que el índice (`to_tsvector('spanish', unaccent(document))`).
 */
async function fulltextFragments(sql: Sql, phrase: string, ids: string[]): Promise<Map<string, { words: string[]; fragment: string }>> {
	const out = new Map<string, { words: string[]; fragment: string }>();
	if (ids.length === 0) return out;
	const rows = await sql<{ id: number; frag: string }[]>`
		select empresa_id as id,
			ts_headline('spanish', unaccent(document), websearch_to_tsquery('spanish', unaccent(${phrase})),
				'StartSel=«, StopSel=», MaxFragments=2, MaxWords=12, MinWords=4, FragmentDelimiter=" … "') as frag
		from empresa_search_documents
		where empresa_id in ${sql(ids)}
	`;
	for (const r of rows) {
		const frag = String(r.frag ?? '').replace(/\s+/g, ' ').trim();
		const words = Array.from(new Set(Array.from(frag.matchAll(/«([^»]+)»/g), (m) => m[1].toLowerCase())));
		out.set(String(r.id), { words, fragment: frag.slice(0, 220) });
	}
	return out;
}

/**
 * Explicación para cada empresa de `orderedIds` (en el orden mostrado). `phraseDetails[i]` corresponde
 * a `phrases[i]`. `scores` es el puntaje fusionado con el que se ordenó.
 */
export async function buildExplanations(
	sql: Sql,
	phrases: string[],
	phraseDetails: PhraseEvidenceDetail[],
	orderedIds: string[],
	scores: Map<string, number>
): Promise<Map<string, Explain>> {
	const out = new Map<string, Explain>();
	if (orderedIds.length === 0) return out;
	const top = scores.get(orderedIds[0]) ?? 0;

	// Detalle de campo para la lista structured, una consulta por frase y solo si hace falta.
	const structuredByPhrase = await Promise.all(
		phraseDetails.map((d, i) => {
			const ids = orderedIds.filter((id) => d.namedLists.structured.some((r) => String(r.empresa_id) === id));
			return ids.length ? structuredFields(sql, phrases[i], ids) : Promise.resolve(new Map<string, { fuente: string; detalle: string }[]>());
		})
	);
	const fulltextByPhrase = await Promise.all(
		phraseDetails.map((d, i) => {
			const ids = orderedIds.filter((id) => d.namedLists.fulltext.some((r) => String(r.empresa_id) === id));
			return ids.length ? fulltextFragments(sql, phrases[i], ids) : Promise.resolve(new Map<string, { words: string[]; fragment: string }>());
		})
	);
	const positions = phraseDetails.map(positionsByList);
	const contributionsByPhrase = phraseDetails.map((d) => new Map(Array.from(d.perEmpresaContributions.entries()).map(([k, v]) => [String(k), v])));

	orderedIds.forEach((id, idx) => {
		const score = scores.get(id) ?? 0;
		const fuentes: ExplainSource[] = [];
		phraseDetails.forEach((d, i) => {
			const contributions = contributionsByPhrase[i].get(id) ?? {};
			for (const [list, aporte] of Object.entries(contributions) as [EvidenceList, number][]) {
				const p = positions[i].get(list)?.get(id);
				if (!p) continue;
				// `perEmpresaContributions` viene redondeado a 4 decimales; con el peso oficial y la posición
				// se reconstruye el valor exacto. `canonical_related` puede llevar una penalización
				// configurable, así que su peso se deduce del aporte guardado.
				const peso = list === 'canonical_related' ? aporte * (RRF_K + p.pos) : LIST_WEIGHTS[list];
				const exacto = list === 'canonical_related' ? aporte : peso / (RRF_K + p.pos);
				const base = {
					lista: list,
					tipo: kindOf(list),
					frase: phrases[i],
					peso: round(peso, 3),
					posicion_en_fuente: p.pos,
					aporte: round(exacto, 5),
					aporte_pct: score > 0 ? round((exacto / score) * 100, 1) : 0,
				};
				const fields = list === 'structured' ? structuredByPhrase[i].get(id) : undefined;
				const ft = list === 'fulltext' ? fulltextByPhrase[i].get(id) : undefined;
				if (ft && ft.words.length) {
					const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
					const phraseWords = new Set(fold(phrases[i]).split(/[^\p{L}\p{N}]+/u).filter(Boolean));
					const exact = ft.words.every((w) => phraseWords.has(fold(w)));
					fuentes.push({
						...base,
						fuente: FUENTE[list],
						detalle: exact
							? `coincide en texto con "${phrases[i]}": ${ft.fragment}`
							: `coincide en texto con "${phrases[i]}" por la palabra ${ft.words.map((w) => `«${w}»`).join(', ')} (misma raíz): ${ft.fragment}`,
					});
				} else if (fields && fields.length) {
					fuentes.push({
						...base,
						fuente: Array.from(new Set(fields.map((f) => f.fuente))).join(' y '),
						detalle: `coincide con "${phrases[i]}": ` + fields.map((f) => `${f.fuente.toLowerCase()} ${f.detalle}`).join('; '),
					});
				} else {
					fuentes.push({ ...base, fuente: FUENTE[list], detalle: p.label });
				}
			}
		});
		fuentes.sort((a, b) => b.aporte - a.aporte);
		out.set(id, {
			posicion: idx + 1,
			puntaje: round(score, 5),
			puntaje_relativo: top > 0 ? Math.round((score / top) * 100) : 0,
			fuentes,
			formula: `puntaje = suma de peso / (${RRF_K} + posición en cada fuente)`,
		});
	});
	return out;
}
