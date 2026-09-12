import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Env } from './index';
import { getSql } from './db';
import { extractEmbeddingVectors } from './taxonomy-tools';

/**
 * Fase MCP-3 (ver docs/taxonomia/plan_mcp_cira.md de PerfilAfiliadosCPV): `search_empresas` y
 * `get_empresa`, contra las tablas reales de Postgres/Supabase que ya usa el panel Filament
 * (`empresas`, `empresa_sector_service`, `services`, `sectors`, `cities`, `states`, `countries`) -
 * NO contra la vista MySQL `ChatView` vieja que usa hoy CIRA en producción.
 *
 * Verificado contra Supabase real (11 sep 2026) antes de escribir esto:
 * - `empresa_taxonomy_category` (homologación empresa<->categoría CPV, Fase 3/4 del plan de
 *   taxonomía) sigue en 0 filas - el filtro `categoria_codigo`/`tipo_oferta` de `search_empresas`
 *   queda armado y funcional, pero no va a devolver nada hasta que esa homologación cargue datos.
 *   No bloquea el resto: `query`/`sector`/`ciudad` SÍ tienen datos reales hoy.
 * - El sector/servicio real de cada empresa NO sale de `empresas.sector_principal_id` (está NULL
 *   en muchas filas, ej. las primeras empresas insertadas) sino de la tabla pivote
 *   `empresa_sector_service` (950 filas reales) -> `services` (112 filas) -> `services.sectors_id`
 *   -> `sectors` (8 filas) - el mismo join que ya usa `Empresa::distinctSectorIds()` en Laravel.
 *   Replicado acá para no inventar una fuente de verdad distinta a la que ya usa el panel.
 * - `status_id` en `empresas` es el flag "Activo" que ya controla Filament (ver
 *   `EmpresaResource.php`, columna "Activo", TernaryFilter) - decisión #4 pendiente en la sección 9
 *   del plan ("¿todas las 406, o solo las activas?"): se resuelve acá exponiendo SOLO
 *   `status_id = 1` (hoy coincide con las 406, pero es la semántica correcta a futuro).
 * - `cities.states_id` -> `states.state_name` da el "estado" venezolano (ej. ZULIA) que ChatView
 *   exponía como columna separada (`state`) - el parámetro `ciudad` matchea contra AMBOS
 *   (ciudad o estado) para no complicar el schema del tool con un parámetro más.
 * - Deliberadamente NO se expone contacto personal (tabla `contacts`/`principalContact()`) - esta
 *   tool es un directorio público equivalente a lo que ya expone `ChatView` hoy (datos a nivel de
 *   empresa: teléfono, sitio web, dirección), no datos personales de la persona de contacto.
 *
 * Todo el matching de texto usa `unaccent(columna) ilike unaccent(termino)` en ambos lados -
 * Postgres, a diferencia de MySQL, distingue tildes en ILIKE (bug real encontrado y corregido acá
 * y en `search_taxonomy` de Fase MCP-1 - ver ese archivo).
 *
 * `search_empresas` es HIBRIDO en 3 niveles, cada uno solo se activa si el anterior no devolvio
 * NADA (nunca cambia el resultado de una busqueda que ya funciona - mismo principio que el hibrido
 * lexico+semantico de `search_taxonomy`, Fase MCP-1):
 *
 * 1. EXACTO - `unaccent(columna) ilike unaccent(termino)` de siempre. `match_type: 'exact'`.
 *
 * 2. DIFUSO (11 sep 2026, `pg_trgm`, YA estaba instalado en este proyecto de Supabase v1.6 - no
 *    hubo que habilitarlo) - tolera errores de tipeo: transposiciones/letras de mas o de menos
 *    ("consturccion" -> CONSTRUCCIÓN). Usa `word_similarity()` (no `similarity()` a secas) para
 *    comparar el termino del usuario contra nombres de empresa/servicio/sector, que son frases
 *    LARGAS - `similarity()` normaliza por el total de trigramas de ambos strings y castiga
 *    injustamente a un termino corto contra una frase larga (bug real encontrado y corregido acá
 *    mismo: la primera version de este fallback usaba `similarity()` para servicios/sectores y
 *    NO detectaba "soldadura" -> "MATERIALES, EQUIPOS Y ACCESORIOS PARA SOLDAR" pese a ser la
 *    misma raiz). Umbral 0.5 (subido de un 0.35 inicial): calibrado para que seguir aceptando
 *    todos los typos reales verificados (0.53-1.0) pero RECHAZAR falsos positivos por coincidencia
 *    de trigramas sin relacion real - ej. "grua" contra "CEMENTACIÓN Y EMPAQUE CON GRAVA" da 0.4,
 *    una coincidencia de letras sin ninguna relacion semantica (grava != grua). `match_type: 'fuzzy'`.
 *    No se creo indice GIN de trigramas: con este volumen de filas (cientos, no millones) un
 *    sequential scan es instantaneo, un indice seria complejidad sin beneficio medible.
 *
 *    IMPORTANTE - el fallback difuso de `query` compara SOLO contra servicio/sector, NO contra
 *    `e.name` (nombre de empresa). Se probo y se saco a proposito: con 406 nombres de empresa
 *    reales, un termino corto de 4-5 letras choca por coincidencia con MUCHOS nombres sin relacion
 *    (ej. "grua" contra "GRUPO PROMARGON, C.A." da 0.6 - EL MISMO score que el match genuino
 *    "soldadura"->"SOLDAR" - no hay forma de separarlos con un solo umbral). El catalogo de
 *    servicios (112 filas, frases descriptivas) no tiene ese problema. Buscar una empresa por
 *    nombre con errores de tipeo es lo que ya hace `get_empresa` (comparacion 1-a-1 mas acotada,
 *    ahi si sigue aplicando word_similarity contra `e.name`).
 *
 * 3. SEMANTICO (rediseñado 12 sep 2026, Fase MCP-4.3 - la v1 del 11 sep embebia el `query`
 *    COMPLETO como un solo vector; ver "Bug de dilucion semantica" mas abajo para por que se
 *    reemplazo) - inspirado en el approach hibrido de Mercadona Tech
 *    (https://newsletter.gemba.es/p/como-construimos-nuestro-buscador, se tomo SOLO la idea de
 *    hibrido lexico+semantico adaptada a nuestra escala real de cientos de empresas, no su stack
 *    de ranking con ML). Solo para el parametro `query` (`sector`/`ciudad` son vocabulario
 *    cerrado/geografico, no texto conceptual libre). 3 pasos:
 *
 *    a) DESCOMPONER `query` en frases candidatas cortas (`extractCandidatePhrases`) - palabras
 *       significativas sueltas + bigramas de palabras adyacentes, quitando conectores/verbos de
 *       intencion en español ("necesito", "busco", "de", "para", etc.). Nunca se embebe la
 *       oracion completa como un solo vector.
 *
 *    b) RESOLVER cada frase de forma INDEPENDIENTE, en UNA sola llamada al modelo
 *       `@cf/baai/bge-m3` (Workers AI acepta un array de textos y devuelve un vector por cada
 *       uno - ver `extractEmbeddingVectors`), contra DOS catalogos con embedding propio:
 *       - `service_embeddings` (112 servicios + su sector, Fase MCP-4.2) - la fuente que
 *         encuentra empresas HOY, via el pivote `empresa_sector_service` ya poblado.
 *       - `taxonomy_category_embeddings` (3.483 nodos CPV, Fase MCP-1, ya generados y usados por
 *         `search_taxonomy`) - reusada tal cual, sin generar nada nuevo. Hoy NO encuentra ninguna
 *         empresa porque `empresa_taxonomy_category` (homologacion empresa<->categoria nueva,
 *         Fase 3/4 del proyecto de taxonomia) sigue en 0 filas - pero la consulta ya esta armada
 *         contra ella, asi que el dia que esa homologacion cargue datos, `search_empresas`
 *         empieza a encontrar mas empresas por esa via SIN tocar este codigo de nuevo. Esta es la
 *         parte "escalable para cuando las empresas agreguen sus servicios/productos de la
 *         taxonomia" que se pidio explicitamente - dos fuentes de concepto desde el dia uno, una
 *         ya usable y otra lista para cuando tenga datos.
 *       Cada catalogo se resuelve en UNA query SQL (`UNION ALL` de un `ORDER BY <=> LIMIT 1` por
 *       frase, no N round-trips) - 2 queries totales sin importar cuantas frases haya. Umbral de
 *       distancia coseno 0.60 (igual que la v1, sigue calibrado contra los mismos casos reales).
 *
 *    c) UNIR (no intersectar) las empresas encontradas via cualquier concepto resuelto de
 *       cualquiera de las 2 fuentes - "no dejar oportunidades fuera": si "soldadura" resuelve a
 *       un servicio y "tuberia" a otro, el resultado son las empresas de AMBOS servicios, no solo
 *       de uno. Cada fila devuelta trae `match_type: 'semantic'` Y `matched_via` (ej.
 *       `similar a "soldadura" (servicio: MATERIALES, EQUIPOS Y ACCESORIOS PARA SOLDAR)`) -
 *       le dice a quien consuma la tool (el agente de CIRA, o quien sea) POR QUE aparecio esa
 *       empresa. `matched_via` (12 sep 2026, Fase MCP-4.4) no es exclusivo del nivel semantico:
 *       los niveles exacto/difuso TAMBIEN lo traen (mismo texto para todas las filas de esa
 *       respuesta, ej. `sector: servicios a pozos`), porque un `sector` amplio puede agrupar
 *       empresas por motivos bien distintos entre si (ver Fase MCP-4.4 mas abajo) y sin esta
 *       referencia no habia forma de saber, mirando la respuesta, si el match era literal o
 *       aproximado - pedido explicito del usuario ("incluye en todas las consultas una
 *       referencia de proximidad").
 *
 *    No resuelve "grua" (equipos de izamiento): es un hueco real del catalogo, ningun servicio ni
 *    categoria CPV existente cubre eso - ni la v1 ni esta v2 deberian inventar una respuesta ahi,
 *    y no la dan (verificado).
 *
 *    BUG DE DILUCION SEMANTICA encontrado en producción (11-12 sep 2026, reportado por el
 *    usuario probando "sordadura" -> tras corregirse el bug de publicacion de n8n, encontro que
 *    "necesito quien me suelde tuberias" devolvia 20 empresas con la v1 de este nivel) - causa
 *    raiz: el agente de CIRA resume la frase del usuario a un `query` compuesto de 2 conceptos
 *    ("soldadura tuberia"), y un embedding de ESE STRING COMPLETO cae semanticamente cerca de
 *    "TORNILLERÍA" (0.508) - ninguno de los 3 servicios mas cercanos al vector COMBINADO
 *    mencionaba siquiera soldadura. Verificado que descomponer en "soldadura" (solo) SI encuentra
 *    el servicio correcto (0.499, "...PARA SOLDAR") - el problema no era el catalogo ni el
 *    umbral, era comparar un vector que mezcla 2 significados distintos contra catalogos de
 *    conceptos unicos. La v2 de arriba resuelve esto de raiz (nunca embebe mas de un concepto por
 *    vector) en vez de parchear el umbral o pedirle al prompt que no combine terminos (fragil:
 *    dependeria de que el LLM nunca vuelva a hacerlo).
 */

/**
 * Palabras que no aportan significado de busqueda (conectores, pronombres, verbos de intencion) -
 * se descartan al armar las frases candidatas del nivel semantico para no diluir el embedding de
 * cada concepto real con ruido ("necesito quien me suelde tuberias" -> el ruido es "necesito",
 * "quien", "me", no "suelde"/"tuberias").
 */
const SPANISH_STOPWORDS = new Set([
	'de', 'del', 'la', 'el', 'los', 'las', 'un', 'una', 'unos', 'unas', 'y', 'o', 'u', 'que',
	'quien', 'quienes', 'para', 'por', 'con', 'sin', 'en', 'a', 'al', 'me', 'te', 'se', 'lo',
	'su', 'sus', 'mi', 'mis', 'tu', 'tus', 'es', 'son', 'esta', 'estan', 'hay', 'como',
	'necesito', 'necesita', 'busco', 'busca', 'buscamos', 'quiero', 'quiere', 'quisiera',
	'dame', 'deme', 'favor', 'porfavor', 'empresa', 'empresas', 'afiliada', 'afiliadas',
]);

/**
 * Descompone texto libre en frases candidatas cortas para el nivel semantico: palabras
 * significativas sueltas + bigramas de palabras adyacentes. Deliberadamente NO incluye la frase
 * original completa cuando tiene mas de 2 palabras significativas - es justo lo que causaba el
 * bug de dilucion semantica (ver docblock de arriba). Tope defensivo de 8 frases: una consulta
 * real de un usuario nunca necesita mas que eso, y cada frase extra es una fila mas al embedding
 * batch (barato, pero sin motivo para no acotarlo).
 */
export function extractCandidatePhrases(text: string, maxPhrases = 8): string[] {
	const normalized = text
		.toLowerCase()
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^a-z0-9\s]/g, ' ');

	const words = normalized.split(/\s+/).filter((w) => w.length > 2 && !SPANISH_STOPWORDS.has(w));

	if (words.length === 0) {
		return [];
	}

	const phrases = new Set<string>();
	for (const w of words) {
		phrases.add(w);
	}
	for (let i = 0; i < words.length - 1; i++) {
		phrases.add(`${words[i]} ${words[i + 1]}`);
	}

	return Array.from(phrases).slice(0, maxPhrases);
}

type ResolvedConcept = {
	source: 'service' | 'taxonomy';
	id: number;
	name: string;
	phrase: string;
	distance: number;
};

/**
 * Resuelve cada frase candidata contra `service_embeddings` y `taxonomy_category_embeddings` -
 * UNA query SQL por catalogo (UNION ALL de un nearest-neighbor por frase), sin importar cuantas
 * frases haya. Devuelve los conceptos que pasan el umbral, deduplicados por (fuente, id) quedando
 * con la mejor (menor) distancia si una misma fila fue la mas cercana para mas de una frase.
 */
async function resolveSemanticConcepts(
	sql: ReturnType<typeof getSql>,
	env: Env,
	phrases: string[],
	threshold: number
): Promise<ResolvedConcept[]> {
	const embeddingResult = await env.AI.run('@cf/baai/bge-m3', { text: phrases });
	const vectors = extractEmbeddingVectors(embeddingResult);

	const usable = phrases.map((phrase, i) => ({ phrase, vector: vectors[i] })).filter((p): p is { phrase: string; vector: string } => !!p.vector);

	if (usable.length === 0) {
		return [];
	}

	const serviceParts = usable.map(
		({ vector }, i) => sql`(
			select ${i}::int as phrase_idx, sv.id, sv.name, (se.embedding <=> ${vector}::vector) as distance
			from service_embeddings se
			join services sv on sv.id = se.service_id
			order by se.embedding <=> ${vector}::vector asc
			limit 1
		)`
	);
	const taxonomyParts = usable.map(
		({ vector }, i) => sql`(
			select ${i}::int as phrase_idx, tc.id, coalesce(tt.name, tc.code) as name, (tce.embedding <=> ${vector}::vector) as distance
			from taxonomy_category_embeddings tce
			join taxonomy_categories tc on tc.id = tce.category_id
			left join taxonomy_category_translations tt on tt.category_id = tc.id and tt.locale = 'es'
			order by tce.embedding <=> ${vector}::vector asc
			limit 1
		)`
	);

	const [serviceMatches, taxonomyMatches] = await Promise.all([
		sql<{ phrase_idx: number; id: number; name: string; distance: number }[]>`${serviceParts.reduce((acc, p) => sql`${acc} union all ${p}`)}`,
		sql<{ phrase_idx: number; id: number; name: string; distance: number }[]>`${taxonomyParts.reduce((acc, p) => sql`${acc} union all ${p}`)}`,
	]);

	const resolved: ResolvedConcept[] = [];
	for (const m of serviceMatches) {
		if (m.distance < threshold) resolved.push({ source: 'service', id: m.id, name: m.name, phrase: usable[m.phrase_idx].phrase, distance: m.distance });
	}
	for (const m of taxonomyMatches) {
		if (m.distance < threshold) resolved.push({ source: 'taxonomy', id: m.id, name: m.name, phrase: usable[m.phrase_idx].phrase, distance: m.distance });
	}

	const bestByKey = new Map<string, ResolvedConcept>();
	for (const r of resolved) {
		const key = `${r.source}:${r.id}`;
		const existing = bestByKey.get(key);
		if (!existing || r.distance < existing.distance) bestByKey.set(key, r);
	}

	return Array.from(bestByKey.values()).sort((a, b) => a.distance - b.distance);
}

/** Columnas + joins compartidos entre las 3 queries de este archivo - evita repetir el mismo SQL 3 veces. */
function empresaSelectAndJoins(sql: ReturnType<typeof getSql>) {
	return sql`
		select
			e.id, e.rif, e.name, e.phone, e.website, e.street, e.ano_fund,
			c.city_name, st.state_name, co.country_name,
			(
				select string_agg(distinct s.name, ', ' order by s.name)
				from empresa_sector_service ess
				join services sv on sv.id = ess.service_id
				join sectors s on s.id = sv.sectors_id
				where ess.empresa_id = e.id
			) as sectores,
			(
				select string_agg(distinct sv.name, ', ' order by sv.name)
				from empresa_sector_service ess
				join services sv on sv.id = ess.service_id
				where ess.empresa_id = e.id
			) as servicios
		from empresas e
		left join cities c on c.id = e.city_id
		left join states st on st.id = c.states_id
		left join countries co on co.id = c.country_id
	`;
}

export function registerEmpresaTools(server: McpServer, env: Env): void {
	server.registerTool(
		'search_empresas',
		{
			description:
				'Busca empresas afiliadas a la Cámara Petrolera de Venezuela. Requiere al menos un filtro ' +
				'(query, sector, ciudad o categoria_codigo) - no permite listar todas las empresas sin filtrar. ' +
				'"query" busca por nombre de empresa, servicio o sector en texto libre. "ciudad" matchea ciudad o ' +
				'estado venezolano. "categoria_codigo" filtra por la taxonomía CPV nueva, pero esa homologación ' +
				'todavía no tiene datos cargados (Fase 3/4 del proyecto de taxonomía), así que hoy puede no ' +
				'devolver nada - usar query/sector/ciudad mientras tanto.',
			inputSchema: {
				query: z.string().min(2).optional().describe('Texto libre: nombre de empresa, servicio o sector'),
				sector: z.string().optional().describe('Nombre (parcial) de uno de los 8 sectores institucionales, ej. "construccion"'),
				ciudad: z.string().optional().describe('Nombre (parcial) de ciudad o estado, ej. "maracaibo" o "zulia"'),
				categoria_codigo: z
					.string()
					.optional()
					.describe('Código CPV (prefijo, ej. "CPV-05") de la taxonomía nueva - sin datos reales todavía, ver descripción'),
				tipo_oferta: z
					.string()
					.optional()
					.describe('Filtra además por tipo de oferta de la categoría CPV - solo aplica junto con categoria_codigo'),
				limit: z.number().int().min(1).max(50).optional().describe('Máximo de resultados (default 20)'),
			},
		},
		async ({ query, sector, ciudad, categoria_codigo, tipo_oferta, limit }) => {
			if (!query && !sector && !ciudad && !categoria_codigo) {
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({
								error: 'Debe indicar al menos un filtro (query, sector, ciudad o categoria_codigo) - no se puede listar todas las empresas sin filtrar.',
							}),
						},
					],
				};
			}

			const max = limit ?? 20;
			const sql = getSql(env);

			// Umbral de pg_trgm - ver docblock de arriba para la calibracion (0.5, subido desde un
			// 0.35 inicial que dejaba pasar falsos positivos tipo "grua"/"grava").
			const TRGM_THRESHOLD = 0.5;
			// Umbral de distancia coseno para el fallback semantico - ver docblock de arriba.
			const SEMANTIC_DISTANCE_THRESHOLD = 0.6;

			/** Arma el WHERE - `fuzzy=false` es el ILIKE exacto de siempre; `fuzzy=true` es el fallback por similitud. */
			function buildConditions(fuzzy: boolean) {
				const conditions = [sql`e.status_id = 1`];

				if (query) {
					conditions.push(
						fuzzy
							? sql`(
								exists (
									select 1 from empresa_sector_service ess
									join services sv on sv.id = ess.service_id
									where ess.empresa_id = e.id and word_similarity(unaccent(${query}), unaccent(sv.name)) > ${TRGM_THRESHOLD}
								)
								or exists (
									select 1 from empresa_sector_service ess
									join services sv on sv.id = ess.service_id
									join sectors s on s.id = sv.sectors_id
									where ess.empresa_id = e.id and word_similarity(unaccent(${query}), unaccent(s.name)) > ${TRGM_THRESHOLD}
								)
							)`
							: sql`(
								unaccent(e.name) ilike unaccent(${'%' + query + '%'})
								or exists (
									select 1 from empresa_sector_service ess
									join services sv on sv.id = ess.service_id
									where ess.empresa_id = e.id and unaccent(sv.name) ilike unaccent(${'%' + query + '%'})
								)
								or exists (
									select 1 from empresa_sector_service ess
									join services sv on sv.id = ess.service_id
									join sectors s on s.id = sv.sectors_id
									where ess.empresa_id = e.id and unaccent(s.name) ilike unaccent(${'%' + query + '%'})
								)
							)`
					);
				}

				if (sector) {
					conditions.push(
						fuzzy
							? sql`exists (
								select 1 from empresa_sector_service ess
								join services sv on sv.id = ess.service_id
								join sectors s on s.id = sv.sectors_id
								where ess.empresa_id = e.id and similarity(unaccent(s.name), unaccent(${sector})) > ${TRGM_THRESHOLD}
							)`
							: sql`exists (
								select 1 from empresa_sector_service ess
								join services sv on sv.id = ess.service_id
								join sectors s on s.id = sv.sectors_id
								where ess.empresa_id = e.id and unaccent(s.name) ilike unaccent(${'%' + sector + '%'})
							)`
					);
				}

				if (ciudad) {
					conditions.push(
						fuzzy
							? sql`(
								similarity(unaccent(c.city_name), unaccent(${ciudad})) > ${TRGM_THRESHOLD}
								or similarity(unaccent(st.state_name), unaccent(${ciudad})) > ${TRGM_THRESHOLD}
							)`
							: sql`(unaccent(c.city_name) ilike unaccent(${'%' + ciudad + '%'}) or unaccent(st.state_name) ilike unaccent(${'%' + ciudad + '%'}))`
					);
				}

				if (categoria_codigo) {
					conditions.push(sql`exists (
						select 1 from empresa_taxonomy_category etc
						join taxonomy_categories tc on tc.id = etc.category_id
						where etc.empresa_id = e.id
							and tc.code like ${categoria_codigo + '%'}
							${tipo_oferta ? sql`and unaccent(tc.tipo_oferta) ilike unaccent(${tipo_oferta})` : sql``}
					)`);
				}

				return conditions.reduce((acc, c) => sql`${acc} and ${c}`);
			}

			// Explica CADA respuesta (no solo la semantica) - pedido explicito del usuario tras ver
			// que una busqueda por `sector` (46 empresas de "SERVICIOS A POZOS" para "perforacion",
			// de las cuales solo 14 tienen perforacion literal entre sus servicios - las otras 32
			// estan ahi por cementacion/wireline/otros servicios del mismo sector institucional, no
			// por perforacion en si) no dejaba ver POR QUE aparecia cada empresa. Uniforme para
			// exacto/difuso: no hace falta un round-trip extra, ya sabemos que parametros se usaron
			// y son los mismos para TODAS las filas de una misma respuesta (a diferencia del
			// semantico, donde cada fila puede venir de un concepto distinto - ver `matchedConceptFor`
			// mas abajo, que sigue siendo por-fila).
			function describeMatch(tier: 'exact' | 'fuzzy'): string {
				const parts: string[] = [];
				if (query) parts.push(tier === 'exact' ? `coincide con "${query}"` : `similar a "${query}" (posible diferencia de tipeo)`);
				if (sector) parts.push(`sector: ${sector}`);
				if (ciudad) parts.push(`ciudad o estado: ${ciudad}`);
				return parts.join(' · ');
			}

			try {
				const exactRows = await sql`
					${empresaSelectAndJoins(sql)}
					where ${buildConditions(false)}
					order by e.name
					limit ${max}
				`;

				if (exactRows.length > 0) {
					const matchedVia = describeMatch('exact');
					const tagged = exactRows.map((r) => ({ ...r, match_type: 'exact' as const, matched_via: matchedVia }));
					return { content: [{ type: 'text' as const, text: JSON.stringify(tagged, null, 2) }] };
				}

				// Nivel 2 (difuso) y 3 (semantico) solo tienen sentido si el usuario dio texto libre
				// para tolerar (categoria_codigo es un codigo exacto, no aplica a ninguno de los 2).
				// Nunca se activan si el ILIKE ya encontro algo - mismo principio que el hibrido de
				// `search_taxonomy` (lexico primero, semantico solo de respaldo).
				if (query || sector || ciudad) {
					const fuzzyRows = await sql`
						${empresaSelectAndJoins(sql)}
						where ${buildConditions(true)}
						order by e.name
						limit ${max}
					`;

					if (fuzzyRows.length > 0) {
						const matchedVia = describeMatch('fuzzy');
						const tagged = fuzzyRows.map((r) => ({ ...r, match_type: 'fuzzy' as const, matched_via: matchedVia }));
						return { content: [{ type: 'text' as const, text: JSON.stringify(tagged, null, 2) }] };
					}
				}

				// Nivel 3: semantico, solo para `query` (sector/ciudad son vocabulario cerrado/
				// geografico, no texto conceptual libre) - ver docblock de arriba para el diseno v2
				// (descomposicion en frases + 2 fuentes de concepto + union, en vez de un solo
				// embedding del query completo contra un solo catalogo).
				if (query) {
					const phrases = extractCandidatePhrases(query);
					const resolved = phrases.length > 0 ? await resolveSemanticConcepts(sql, env, phrases, SEMANTIC_DISTANCE_THRESHOLD) : [];

					if (resolved.length > 0) {
						const serviceIds = resolved.filter((r) => r.source === 'service').map((r) => r.id);
						const taxonomyIds = resolved.filter((r) => r.source === 'taxonomy').map((r) => r.id);

						const semanticRows = await sql`
							${empresaSelectAndJoins(sql)}
							where e.status_id = 1 and (
								${serviceIds.length > 0 ? sql`exists (select 1 from empresa_sector_service ess where ess.empresa_id = e.id and ess.service_id in ${sql(serviceIds)})` : sql`false`}
								or
								${taxonomyIds.length > 0 ? sql`exists (select 1 from empresa_taxonomy_category etc where etc.empresa_id = e.id and etc.category_id in ${sql(taxonomyIds)})` : sql`false`}
							)
							order by e.name
							limit ${max}
						`;

						if (semanticRows.length > 0) {
							// Para explicar CADA fila (no dejar que se preste a confusion): que concepto
							// resuelto es el que realmente la trajo. 2 lookups baratos (acotados a los
							// pocos ids de `resolved`, no a todo el directorio) en vez de N+1 por fila.
							const [serviceLinks, taxonomyLinks] = await Promise.all([
								serviceIds.length > 0
									? sql<{ empresa_id: number; service_id: number }[]>`select empresa_id, service_id from empresa_sector_service where service_id in ${sql(serviceIds)}`
									: Promise.resolve([] as { empresa_id: number; service_id: number }[]),
								taxonomyIds.length > 0
									? sql<{ empresa_id: number; category_id: number }[]>`select empresa_id, category_id from empresa_taxonomy_category where category_id in ${sql(taxonomyIds)}`
									: Promise.resolve([] as { empresa_id: number; category_id: number }[]),
							]);

							const bestByKey = new Map(resolved.map((r) => [`${r.source}:${r.id}`, r]));

							// postgres.js devuelve columnas bigint como STRING (evita perder precision) - comparar
							// con `!==` estricto contra un Number, como se hacia antes, nunca matchea ("88" !== 88)
							// y esta funcion siempre caia al texto generico de abajo (bug real encontrado al
							// verificar en vivo: toda fila semantica mostraba "similar por servicio o categoria
							// relacionada" en vez del concepto real). Fix: normalizar ambos lados con String().
							function matchedViaFor(empresaId: string): string {
								let best: ResolvedConcept | null = null;
								for (const link of serviceLinks) {
									if (String(link.empresa_id) !== empresaId) continue;
									const r = bestByKey.get(`service:${link.service_id}`);
									if (r && (!best || r.distance < best.distance)) best = r;
								}
								for (const link of taxonomyLinks) {
									if (String(link.empresa_id) !== empresaId) continue;
									const r = bestByKey.get(`taxonomy:${link.category_id}`);
									if (r && (!best || r.distance < best.distance)) best = r;
								}
								if (!best) return 'similar por servicio o categoría relacionada';
								return `similar a "${best.phrase}" (${best.source === 'service' ? 'servicio' : 'categoría'}: ${best.name})`;
							}

							const tagged = semanticRows.map((r) => ({
								...r,
								match_type: 'semantic' as const,
								matched_via: matchedViaFor(String(r.id)),
							}));
							return { content: [{ type: 'text' as const, text: JSON.stringify(tagged, null, 2) }] };
						}
					}
				}

				return { content: [{ type: 'text' as const, text: JSON.stringify([], null, 2) }] };
			} finally {
				await sql.end({ timeout: 1 });
			}
		}
	);

	server.registerTool(
		'get_empresa',
		{
			description:
				'Devuelve la ficha completa de UNA empresa afiliada, por RIF exacto o por nombre (parcial). ' +
				'Requiere al menos uno de los dos parámetros. Si el nombre es ambiguo puede devolver varias ' +
				'coincidencias - en ese caso hay que pedirle al usuario que precise cuál.',
			inputSchema: {
				rif: z.string().optional().describe('RIF exacto, ej. J070093501 (con o sin guiones/espacios/letra minúscula)'),
				nombre: z.string().optional().describe('Nombre o parte distintiva del nombre de la empresa'),
			},
		},
		async ({ rif, nombre }) => {
			if (!rif && !nombre) {
				return {
					content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Debe indicar rif o nombre.' }) }],
				};
			}

			const sql = getSql(env);

			try {
				// Misma normalizacion que Empresa::setRifAttribute() en Laravel: mayusculas, sin
				// guiones/espacios/simbolos - para que "j-07-040984-3"/"J070409843" matcheen igual.
				const normalizedRif = rif ? rif.toUpperCase().replace(/[^A-Z0-9]/g, '') : null;

				let rows = normalizedRif
					? await sql`
						${empresaSelectAndJoins(sql)}
						where e.status_id = 1 and e.rif = ${normalizedRif}
						limit 1
					`
					: await sql`
						${empresaSelectAndJoins(sql)}
						where e.status_id = 1 and unaccent(e.name) ilike unaccent(${'%' + nombre + '%'})
						order by e.name
						limit 5
					`;

				// Mismo fallback de tolerancia a errores de tipeo que search_empresas (ver docblock de
				// arriba) - solo aplica a busqueda por nombre, un RIF exacto no tiene "aproximado".
				if (rows.length === 0 && nombre) {
					rows = await sql`
						${empresaSelectAndJoins(sql)}
						where e.status_id = 1 and word_similarity(unaccent(${nombre}), unaccent(e.name)) > 0.5
						order by e.name
						limit 5
					`;
				}

				if (rows.length === 0) {
					return {
						content: [
							{
								type: 'text' as const,
								text: JSON.stringify({ found: false, message: 'No se encontró ninguna empresa afiliada que coincida.' }),
							},
						],
					};
				}

				return { content: [{ type: 'text' as const, text: JSON.stringify(rows, null, 2) }] };
			} finally {
				await sql.end({ timeout: 1 });
			}
		}
	);
}
