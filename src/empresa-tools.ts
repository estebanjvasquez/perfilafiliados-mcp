import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Env } from './index';
import { getSql } from './db';
import { extractEmbeddingVector } from './taxonomy-tools';

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
 * 3. SEMANTICO (11 sep 2026, inspirado en el approach hibrido de Mercadona Tech -
 *    https://newsletter.gemba.es/p/como-construimos-nuestro-buscador, adaptado a nuestra escala
 *    real de 406 empresas/112 servicios, muy lejos de sus millones de busquedas - se tomo SOLO la
 *    idea de hibrido lexico+semantico, no su stack de ranking con ML que no aplica acá) - solo
 *    para el parametro `query` (`sector`/`ciudad` son vocabulario cerrado/geografico, no se
 *    benefician de esto). Cuando ni el match exacto ni el difuso encuentran nada, embebe el
 *    `query` con el mismo modelo `@cf/baai/bge-m3` que ya usa `search_taxonomy` y lo compara
 *    contra `service_embeddings` (embedding de cada uno de los 112 servicios del catalogo +
 *    su sector, ver migracion `2026_09_11_150000_create_service_embeddings_table` y comando
 *    `empresas:generate-service-embeddings` en PerfilAfiliadosCPV) - encuentra el SERVICIO
 *    conceptualmente mas cercano aunque no comparta ninguna raiz literal (ej. "valvulas" no
 *    aparece en ningun `services.name`, pero cae semanticamente cerca de "TUBERÍAS, TUBOS Y
 *    CONEXIONES"), y devuelve las empresas vinculadas a ese servicio. Umbral de distancia coseno
 *    0.60, calibrado contra casos reales (matches genuinos "soldadura"/"valvulas"/consultas en
 *    lenguaje natural: 0.50-0.57; no-matches genuinos como "grua" - el catalogo simplemente no
 *    tiene equipo de izaje - o "clases de matematicas": 0.63+). Por que a nivel de SERVICIO y no
 *    de EMPRESA: el contenido semantico util esta en la descripcion del servicio, no en el nombre
 *    propio de la empresa que lo presta (ver docblock de la migracion para el detalle). No resuelve
 *    "grua": es un hueco real del catalogo (ningun servicio real es sobre equipos de izamiento),
 *    no un problema de busqueda - documentado tambien en el calibracion original de Fase MCP-2.
 *    `match_type: 'semantic'`.
 */

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

			try {
				const exactRows = await sql`
					${empresaSelectAndJoins(sql)}
					where ${buildConditions(false)}
					order by e.name
					limit ${max}
				`;

				if (exactRows.length > 0) {
					const tagged = exactRows.map((r) => ({ ...r, match_type: 'exact' as const }));
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
						const tagged = fuzzyRows.map((r) => ({ ...r, match_type: 'fuzzy' as const }));
						return { content: [{ type: 'text' as const, text: JSON.stringify(tagged, null, 2) }] };
					}
				}

				// Nivel 3: semantico, solo para `query` (sector/ciudad son vocabulario cerrado/
				// geografico, no texto conceptual libre) - ver docblock de arriba para el diseno.
				if (query) {
					const embeddingResult = await env.AI.run('@cf/baai/bge-m3', { text: [query] });
					const vector = extractEmbeddingVector(embeddingResult);

					if (vector) {
						// Los 3 servicios MAS cercanos, no "todos los que pasen el umbral" - para una
						// consulta larga en lenguaje natural, decenas de los 112 servicios pueden caer
						// por debajo del umbral sin ser realmente relevantes (la oracion completa se
						// embebe "generica" y queda cerca de casi todo) - acotar a un top-N fijo evita
						// que el resultado termine siendo "casi todo el directorio". El umbral igual se
						// aplica: si ni el MEJOR match esta por debajo, no hay servicios candidatos.
						const matchedServices = await sql<{ service_id: number }[]>`
							select sv.id as service_id
							from services sv
							join service_embeddings se on se.service_id = sv.id
							where (se.embedding <=> ${vector}::vector) < ${SEMANTIC_DISTANCE_THRESHOLD}
							order by (se.embedding <=> ${vector}::vector) asc
							limit 3
						`;

						if (matchedServices.length > 0) {
							const serviceIds = matchedServices.map((s) => s.service_id);
							const semanticRows = await sql`
								${empresaSelectAndJoins(sql)}
								where e.status_id = 1 and exists (
									select 1 from empresa_sector_service ess
									where ess.empresa_id = e.id and ess.service_id in ${sql(serviceIds)}
								)
								order by e.name
								limit ${max}
							`;

							if (semanticRows.length > 0) {
								const tagged = semanticRows.map((r) => ({ ...r, match_type: 'semantic' as const }));
								return { content: [{ type: 'text' as const, text: JSON.stringify(tagged, null, 2) }] };
							}
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
