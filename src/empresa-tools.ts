import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Env } from './index';
import { getSql } from './db';

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
 * Fallback de tolerancia a errores de tipeo (11 sep 2026, inspirado en el approach hibrido de
 * Mercadona Tech - https://newsletter.gemba.es/p/como-construimos-nuestro-buscador, adaptado a
 * nuestra escala real de 406 empresas/112 servicios, muy lejos de sus millones de busquedas):
 * `search_empresas`/`get_empresa` intentan primero el match exacto/parcial de siempre (ILIKE). Si
 * esa pasada no devuelve NADA y el usuario dio texto libre (query/sector/ciudad/nombre), se repite
 * la misma busqueda con `similarity()`/`word_similarity()` de la extension `pg_trgm` (YA estaba
 * instalada en este proyecto de Supabase, v1.6 - no fue necesario habilitarla) - tolera
 * transposiciones/letras de mas o de menos ("consturccion" -> CONSTRUCCIÓN) sin necesidad de un
 * modelo de embeddings para esto (eso ya lo resuelve `search_taxonomy` para sinonimos/conceptos,
 * que es un problema distinto al de errores de tipeo). No se creo indice GIN de trigramas: con
 * este volumen de filas un sequential scan es instantaneo, un indice seria complejidad sin
 * beneficio medible. Cada fila devuelta en modo fallback trae `match_type: 'fuzzy'` (las del modo
 * normal traen `match_type: 'exact'`) para que quien consuma la tool pueda distinguir un match
 * literal de uno aproximado - mismo patron que `match_type` en `search_taxonomy`.
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

			// Umbral de similitud de pg_trgm - 0.35 es mas permisivo que el default de la extension
			// (0.3 para similarity(), pero word_similarity() suele pedir un poco mas para no generar
			// falsos positivos con nombres de empresa largos). Ajustado a mano contra los sectores/
			// servicios/empresas reales de este proyecto, no es un valor de libreria.
			const TRGM_THRESHOLD = 0.35;

			/** Arma el WHERE - `fuzzy=false` es el ILIKE exacto de siempre; `fuzzy=true` es el fallback por similitud. */
			function buildConditions(fuzzy: boolean) {
				const conditions = [sql`e.status_id = 1`];

				if (query) {
					conditions.push(
						fuzzy
							? sql`(
								word_similarity(unaccent(${query}), unaccent(e.name)) > ${TRGM_THRESHOLD}
								or exists (
									select 1 from empresa_sector_service ess
									join services sv on sv.id = ess.service_id
									where ess.empresa_id = e.id and similarity(unaccent(sv.name), unaccent(${query})) > ${TRGM_THRESHOLD}
								)
								or exists (
									select 1 from empresa_sector_service ess
									join services sv on sv.id = ess.service_id
									join sectors s on s.id = sv.sectors_id
									where ess.empresa_id = e.id and similarity(unaccent(s.name), unaccent(${query})) > ${TRGM_THRESHOLD}
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

				// El fallback difuso solo tiene sentido si el usuario dio texto libre para tolerar
				// (categoria_codigo es un codigo exacto, no aplica). Nunca se activa si el ILIKE ya
				// encontro algo - evita cambiar el comportamiento/orden de las busquedas que hoy
				// funcionan bien, igual que el hibrido de `search_taxonomy` (lexico primero, semantico
				// solo de respaldo).
				if (exactRows.length === 0 && (query || sector || ciudad)) {
					const fuzzyRows = await sql`
						${empresaSelectAndJoins(sql)}
						where ${buildConditions(true)}
						order by e.name
						limit ${max}
					`;

					const tagged = fuzzyRows.map((r) => ({ ...r, match_type: 'fuzzy' as const }));
					return { content: [{ type: 'text' as const, text: JSON.stringify(tagged, null, 2) }] };
				}

				const tagged = exactRows.map((r) => ({ ...r, match_type: 'exact' as const }));
				return { content: [{ type: 'text' as const, text: JSON.stringify(tagged, null, 2) }] };
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
						where e.status_id = 1 and word_similarity(unaccent(${nombre}), unaccent(e.name)) > 0.35
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
