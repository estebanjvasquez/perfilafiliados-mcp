/**
 * TASK-0029 (PerfilAfiliadosCPV, Issue #2 `6914028986`): alternativa B de la auditoría TASK-0028.
 *
 * `search_empresas` con `grupos: true` devuelve dos grupos en una sola lista (primero uno, después el otro):
 *  - `grupo: "capacidad"`: empresas con evidencia de catálogo (servicio, sector, categoría CPV, nombre,
 *    certificación, sostenibilidad o texto del perfil que coincide SIN contar sus experiencias). Se ordenan
 *    solo con esa evidencia: la experiencia no suma puntaje aquí. Cada una trae `capacidad` (qué coincidió, de
 *    qué tipo y con qué origen) y, si también tiene experiencias que coinciden, `experiencias_relacionadas`.
 *  - `grupo: "experiencia"`: empresas que solo coinciden por experiencias (literal, por significado o texto del
 *    perfil que solo coincide en experiencias), ordenadas con esa evidencia. Nunca repite una empresa del grupo
 *    de capacidades.
 *
 * Sin `grupos`, `search_empresas` no cambia: ningún cliente que no lo pida ve otra respuesta.
 *
 * Rol (fabricante, distribuidor, mantenedor...): no existe un dato de rol en el perfil (TASK-0028 §4.4), así
 * que `capacidad.rol` es siempre `null` con la nota «Rol no acreditado en el perfil».
 */
import type { getSql } from './db';
import type { Env } from './index';
import {
	computePhraseEvidence,
	countDirectCompanies,
	mergePhraseEvidence,
	rankedIds,
	TIER_NAME,
	type Evidence,
	type EvidenceList,
	type FusedEvidence,
	type GroupEvidence,
	type PhraseEvidenceDetail,
} from './hybrid-search';
import { buildExplanations, type Explain, type ExplainSource } from './search-explain';

type Sql = ReturnType<typeof getSql>;

/** Máximo del grupo de experiencias (el mismo de la variante B medida en TASK-0028 §4). */
export const EXPERIENCE_GROUP_LIMIT = 20;
/** Máximo de experiencias complementarias por tarjeta. */
export const MAX_RELATED_EXPERIENCES = 3;

export const ROL_NOTA = 'Rol no acreditado en el perfil';
export const EXPERIENCIA_NOTA = 'La experiencia no acredita por sí sola fabricación o comercialización';

const fold = (s: string) =>
	s
		.normalize('NFD')
		.replace(/\p{M}/gu, '')
		.toLowerCase()
		.replace(/\s+/g, ' ')
		.trim();
const marks = (s: string) => (s.normalize('NFD').match(/\p{M}/gu) ?? []).length;

/**
 * Frases sin repetir variantes que solo difieren en tildes, mayúsculas o espacios (TASK-0028 §3.2: `balancin` y
 * `balancín` se puntuaban dos veces). Conserva el orden de aparición (la primera sigue siendo la de `query`) y,
 * de cada variante, la escrita con tildes, que es la que mejor representa el embedding en español.
 */
export function dedupPhrases(phrases: string[]): { frase: string; variantes: string[] }[] {
	const byKey = new Map<string, string[]>();
	for (const raw of phrases) {
		if (typeof raw !== 'string') continue;
		const p = raw.trim().replace(/\s+/g, ' ');
		if (!p) continue;
		const k = fold(p);
		const arr = byKey.get(k) ?? [];
		if (!arr.includes(p)) arr.push(p);
		byKey.set(k, arr);
	}
	return Array.from(byKey.values()).map((all) => {
		const frase = all.reduce((best, p) => (marks(p) > marks(best) ? p : best), all[0]);
		return { frase, variantes: all.filter((p) => p !== frase) };
	});
}

export type Capacidad = {
	tipo: 'categoria_cpv' | 'servicio' | 'sector' | 'nombre' | 'certificacion' | 'sostenibilidad' | 'texto_perfil';
	/** directa: coincide lo escrito; parecida: por significado o posible error de tipeo; relacionada: familia CPV vecina. */
	coincidencia: 'directa' | 'parecida' | 'relacionada';
	nombre: string;
	codigo: string | null;
	tipo_oferta: string | null;
	/** Categorías CPV: `empresa_taxonomy_category.origen` (self_declared, validated, suggested). Servicios y sectores: `perfil`. */
	origen: string | null;
	rol: null;
	rol_nota: string;
	lista: EvidenceList;
};

export type ExperienciaRelacionada = { experiencia_id: number | null; fragmento: string; via: 'literal' | 'similar' };

type CategoryRow = { empresa_id: number; code: string; name: string; tipo_oferta: string | null; origen: string | null };

const CATEGORY_LISTS: ReadonlySet<EvidenceList> = new Set(['lexical_taxonomy', 'canonical_cpv', 'taxonomy', 'canonical_related']);

const COINCIDENCIA: Record<EvidenceList, Capacidad['coincidencia']> = {
	structured: 'directa',
	sector_focus: 'directa',
	lexical_taxonomy: 'directa',
	canonical_cpv: 'directa',
	fulltext: 'directa',
	service: 'parecida',
	taxonomy: 'parecida',
	name_typo: 'parecida',
	canonical_related: 'relacionada',
	lexical_experiencia: 'directa',
	experiencia: 'parecida',
};

const STRUCTURED_TIPO: Record<string, Capacidad['tipo']> = {
	Servicio: 'servicio',
	Sector: 'sector',
	'Sector principal': 'sector',
	'Sector secundario': 'sector',
	'Nombre de la empresa': 'nombre',
	Certificación: 'certificacion',
	'Área de sostenibilidad': 'sostenibilidad',
};

/** Categorías CPV de las empresas del grupo de capacidades, con código, tipo de oferta y origen del vínculo. */
async function categoriesOf(sql: Sql, ids: string[]): Promise<Map<string, CategoryRow[]>> {
	const out = new Map<string, CategoryRow[]>();
	if (ids.length === 0) return out;
	const rows = await sql<CategoryRow[]>`
		select etc.empresa_id, tc.code, coalesce(tt.name, tc.code) as name, tc.tipo_oferta, etc.origen
		from empresa_taxonomy_category etc
		join taxonomy_categories tc on tc.id = etc.category_id
		left join taxonomy_category_translations tt on tt.category_id = tc.id and tt.locale = 'es'
		where etc.empresa_id in ${sql(ids)}
		order by etc.empresa_id, tc.code
	`;
	for (const r of rows) {
		const k = String(r.empresa_id);
		const arr = out.get(k) ?? [];
		arr.push(r);
		out.set(k, arr);
	}
	return out;
}

const categoryNameIn = (label: string) => label.match(/categoría CPV: (.+)\)\s*$/)?.[1]?.trim() ?? null;

/**
 * Qué capacidad coincidió, a partir de las fuentes de la explicación (ya ordenadas: lo declarado primero y, dentro
 * del nivel, mayor aporte). Una entrada por capacidad distinta.
 */
function capacidadesOf(
	fuentes: ExplainSource[],
	labels: Map<EvidenceList, string>,
	cats: CategoryRow[],
	directCodes: Set<string>,
	relatedCodes: Set<string>
): Capacidad[] {
	const out: Capacidad[] = [];
	const seen = new Set<string>();
	const push = (c: Omit<Capacidad, 'rol' | 'rol_nota'>) => {
		const key = `${c.tipo}|${c.codigo ?? ''}|${fold(c.nombre)}`;
		if (seen.has(key)) return;
		seen.add(key);
		out.push({ ...c, rol: null, rol_nota: ROL_NOTA });
	};
	for (const f of fuentes) {
		const coincidencia = COINCIDENCIA[f.lista];
		if (CATEGORY_LISTS.has(f.lista)) {
			let matched: CategoryRow[] = [];
			if (f.lista === 'canonical_cpv') matched = cats.filter((c) => directCodes.has(c.code));
			else if (f.lista === 'canonical_related') matched = cats.filter((c) => relatedCodes.has(c.code));
			else {
				const name = categoryNameIn(f.detalle) ?? categoryNameIn(labels.get(f.lista) ?? '');
				if (name) matched = cats.filter((c) => fold(c.name) === fold(name) || c.code === name);
			}
			for (const c of matched.slice(0, 2)) {
				push({ tipo: 'categoria_cpv', coincidencia, nombre: String(c.name).trim(), codigo: c.code, tipo_oferta: c.tipo_oferta, origen: c.origen, lista: f.lista });
			}
			if (matched.length === 0) {
				const name = categoryNameIn(f.detalle);
				if (name) push({ tipo: 'categoria_cpv', coincidencia, nombre: name, codigo: null, tipo_oferta: null, origen: null, lista: f.lista });
			}
			continue;
		}
		if (f.lista === 'structured') {
			// detalle: `coincide con "x": servicio NOMBRE; sector NOMBRE` (ver `structuredFields`).
			const body = f.detalle.replace(/^coincide con "[^"]*":\s*/, '');
			const parts = body.split('; ');
			const kinds = Object.keys(STRUCTURED_TIPO).sort((a, b) => b.length - a.length);
			let any = false;
			for (const part of parts) {
				const kind = kinds.find((k) => part.toLowerCase().startsWith(k.toLowerCase() + ' '));
				if (!kind) continue;
				any = true;
				push({ tipo: STRUCTURED_TIPO[kind], coincidencia, nombre: part.slice(kind.length + 1).trim(), codigo: null, tipo_oferta: null, origen: 'perfil', lista: f.lista });
			}
			if (!any) push({ tipo: 'servicio', coincidencia, nombre: body.slice(0, 160), codigo: null, tipo_oferta: null, origen: 'perfil', lista: f.lista });
			continue;
		}
		if (f.lista === 'sector_focus') {
			push({ tipo: 'sector', coincidencia, nombre: f.detalle.replace(/^especializada en "[^"]*":\s*/, ''), codigo: null, tipo_oferta: null, origen: 'perfil', lista: f.lista });
			continue;
		}
		if (f.lista === 'service') {
			const name = f.detalle.match(/servicio: (.+)\)\s*$/)?.[1]?.trim() ?? f.detalle;
			push({ tipo: 'servicio', coincidencia, nombre: name, codigo: null, tipo_oferta: null, origen: 'perfil', lista: f.lista });
			continue;
		}
		if (f.lista === 'name_typo') {
			push({ tipo: 'nombre', coincidencia, nombre: f.detalle, codigo: null, tipo_oferta: null, origen: 'perfil', lista: f.lista });
			continue;
		}
		if (f.lista === 'fulltext') {
			push({ tipo: 'texto_perfil', coincidencia, nombre: `texto del perfil (sin experiencias): "${f.frase}"`, codigo: null, tipo_oferta: null, origen: 'perfil', lista: f.lista });
		}
	}
	return out;
}

/** Experiencias que coincidieron, por empresa: primero las literales, después las parecidas por significado. */
function experiencesByCompany(details: PhraseEvidenceDetail[]): Map<string, ExperienciaRelacionada[]> {
	const out = new Map<string, ExperienciaRelacionada[]>();
	const keys = new Map<string, Set<string>>();
	const add = (rows: Evidence[], via: ExperienciaRelacionada['via']) => {
		for (const r of rows) {
			if (!r.fragmento) continue;
			const id = String(r.empresa_id);
			const seen = keys.get(id) ?? new Set<string>();
			const key = r.experienciaId != null ? `id:${r.experienciaId}` : `t:${fold(r.fragmento)}`;
			if (seen.has(key)) continue;
			seen.add(key);
			keys.set(id, seen);
			const arr = out.get(id) ?? [];
			arr.push({ experiencia_id: r.experienciaId ?? null, fragmento: r.fragmento, via });
			out.set(id, arr);
		}
	};
	for (const d of details) add(d.groups!.experiencia.namedLists.lexical_experiencia, 'literal');
	for (const d of details) add(d.groups!.experiencia.namedLists.experiencia, 'similar');
	return out;
}

/** Detalle de frase con la evidencia de UN grupo, para reutilizar `buildExplanations` tal cual. */
function asDetail(d: PhraseEvidenceDetail, g: GroupEvidence): PhraseEvidenceDetail {
	return { ...d, namedLists: g.namedLists, perEmpresaContributions: g.perEmpresaContributions, result: g.result };
}

export type TwoGroupRow<R> = R & {
	grupo: 'capacidad' | 'experiencia';
	match_type: string;
	matched_via: string;
	match_level: string;
	capacidad: Capacidad | null;
	capacidades: Capacidad[];
	experiencias_relacionadas: ExperienciaRelacionada[];
	nota_experiencia: string | null;
	explain?: Explain | null;
};

/**
 * Búsqueda de dos grupos. `fetchRows(ids)` devuelve las filas de empresa ya filtradas (activas y filtros
 * estructurados del pedido); el orden lo decide esta función.
 */
export async function searchTwoGroups<R extends { id: number | string }>(
	sql: Sql,
	env: Env,
	query: string,
	resolvedPhrases: string[] | undefined,
	limits: { max: number; exactMax: number },
	fetchRows: (ids: string[]) => Promise<R[]>,
	explain: boolean
): Promise<TwoGroupRow<R>[]> {
	const groupsOfPhrases = dedupPhrases([query, ...(resolvedPhrases ?? [])]);
	if (groupsOfPhrases.length === 0) return [];
	const phrases = groupsOfPhrases.map((g) => g.frase);
	const details = await Promise.all(groupsOfPhrases.map((g) => computePhraseEvidence(sql, env, g.frase, { grupos: true, variantes: g.variantes })));

	const capMerged = mergePhraseEvidence(details.map((d) => d.groups!.capacidad.result));
	const expMerged = mergePhraseEvidence(details.map((d) => d.groups!.experiencia.result));
	const capRanked = rankedIds(capMerged);
	const expRanked = Array.from(expMerged.entries())
		.map(([empresa_id, e]) => ({ empresa_id, score: e.score }))
		.sort((a, b) => b.score - a.score);
	if (capRanked.length === 0 && expRanked.length === 0) return [];

	const directCompanyCount = countDirectCompanies(details[0].groups!.capacidad.namedLists);
	const capLimit = directCompanyCount > limits.max ? limits.exactMax : limits.max;

	const candidateIds = Array.from(new Set([...capRanked, ...expRanked].map((r) => String(r.empresa_id))));
	const rows = await fetchRows(candidateIds);
	const rowById = new Map(rows.map((r) => [String(r.id), r]));

	const group1 = capRanked.filter((r) => rowById.has(String(r.empresa_id))).slice(0, capLimit);
	const g1Ids = new Set(group1.map((r) => String(r.empresa_id)));
	const group2 = expRanked.filter((r) => rowById.has(String(r.empresa_id)) && !g1Ids.has(String(r.empresa_id))).slice(0, EXPERIENCE_GROUP_LIMIT);

	const g1Order = group1.map((r) => String(r.empresa_id));
	const g2Order = group2.map((r) => String(r.empresa_id));
	const [exp1, exp2, cats] = await Promise.all([
		buildExplanations(
			sql,
			phrases,
			details.map((d) => asDetail(d, d.groups!.capacidad)),
			g1Order,
			new Map(group1.map((r) => [String(r.empresa_id), r.score])),
			{ fuente: { fulltext: 'Texto del perfil (sin experiencias)' }, fulltextFragments: false }
		),
		buildExplanations(
			sql,
			phrases,
			details.map((d) => asDetail(d, d.groups!.experiencia)),
			g2Order,
			new Map(group2.map((r) => [String(r.empresa_id), r.score])),
			{ fuente: { fulltext: 'Texto del perfil (experiencias)' } }
		),
		categoriesOf(sql, g1Order),
	]);

	const directCodes = new Set(details.flatMap((d) => d.canonicalCtx.directCpvCodes));
	const relatedCodes = new Set(details.flatMap((d) => d.canonicalCtx.relatedCpvCodes));
	const experiences = experiencesByCompany(details);
	const capLabels = new Map<string, Map<EvidenceList, string>>();
	for (const d of details) {
		for (const [list, evs] of Object.entries(d.groups!.capacidad.namedLists) as [EvidenceList, Evidence[]][]) {
			for (const ev of evs) {
				const m = capLabels.get(String(ev.empresa_id)) ?? new Map<EvidenceList, string>();
				if (!m.has(list)) m.set(list, ev.label);
				capLabels.set(String(ev.empresa_id), m);
			}
		}
	}

	const fused = (m: Map<number, FusedEvidence>, id: string) => m.get(id as unknown as number) ?? m.get(Number(id) as number);

	const out: TwoGroupRow<R>[] = [];
	for (const id of g1Order) {
		const e = fused(capMerged, id)!;
		const ex = exp1.get(id) ?? null;
		const caps = ex ? capacidadesOf(ex.fuentes, capLabels.get(id) ?? new Map(), cats.get(id) ?? [], directCodes, relatedCodes) : [];
		out.push({
			...rowById.get(id)!,
			grupo: 'capacidad',
			match_type: e.matchType,
			matched_via: e.matchedVia,
			match_level: TIER_NAME[e.tier],
			capacidad: caps[0] ?? null,
			capacidades: caps.slice(0, 4),
			experiencias_relacionadas: (experiences.get(id) ?? []).slice(0, MAX_RELATED_EXPERIENCES),
			nota_experiencia: experiences.has(id) ? EXPERIENCIA_NOTA : null,
			...(explain ? { explain: ex } : {}),
		});
	}
	for (const id of g2Order) {
		const e = fused(expMerged, id)!;
		out.push({
			...rowById.get(id)!,
			grupo: 'experiencia',
			match_type: e.matchType,
			matched_via: e.matchedVia,
			match_level: TIER_NAME[e.tier],
			capacidad: null,
			capacidades: [],
			experiencias_relacionadas: (experiences.get(id) ?? []).slice(0, MAX_RELATED_EXPERIENCES),
			nota_experiencia: EXPERIENCIA_NOTA,
			...(explain ? { explain: exp2.get(id) ?? null } : {}),
		});
	}
	return out;
}
