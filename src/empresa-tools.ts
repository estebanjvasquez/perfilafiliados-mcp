import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Env } from './index';
import { getSql } from './db';

/**
 * Fase MCP-3 (ver docs/taxonomia/plan_mcp_cira.md de PerfilAfiliadosCPV): `search_empresas` y
 * `get_empresa`, contra las tablas reales de Postgres/Supabase que ya usa el panel Filament
 * (`empresas`, `empresa_sector_service`, `services`, `sectors`, `cities`, `countries`) - NO contra
 * la vista MySQL `ChatView` vieja que usa hoy CIRA en producción.
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
 * - Deliberadamente NO se expone contacto personal (tabla `contacts`/`principalContact()`) - esta
 *   tool es un directorio público equivalente a lo que ya expone `ChatView` hoy (datos a nivel de
 *   empresa: teléfono, sitio web, dirección), no datos personales de la persona de contacto.
 */
export function registerEmpresaTools(server: McpServer, env: Env): void {
	server.registerTool(
		'search_empresas',
		{
			description:
				'Busca empresas afiliadas a la Cámara Petrolera de Venezuela. Requiere al menos un filtro ' +
				'(query, sector, ciudad o categoria_codigo) - no permite listar todas las empresas sin filtrar. ' +
				'"query" busca por nombre de empresa, servicio o sector en texto libre. "categoria_codigo" filtra ' +
				'por la taxonomía CPV nueva, pero esa homologación todavía no tiene datos cargados (Fase 3/4 del ' +
				'proyecto de taxonomía), así que hoy puede no devolver nada - usar query/sector/ciudad mientras tanto.',
			inputSchema: {
				query: z.string().min(2).optional().describe('Texto libre: nombre de empresa, servicio o sector'),
				sector: z.string().optional().describe('Nombre (parcial) de uno de los 8 sectores institucionales, ej. "construccion"'),
				ciudad: z.string().optional().describe('Nombre (parcial) de ciudad, ej. "maracaibo"'),
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

			try {
				const conditions = [sql`e.status_id = 1`];

				if (query) {
					const like = `%${query}%`;
					conditions.push(sql`(
						unaccent(e.name) ilike unaccent(${like})
						or exists (
							select 1 from empresa_sector_service ess
							join services sv on sv.id = ess.service_id
							where ess.empresa_id = e.id and unaccent(sv.name) ilike unaccent(${like})
						)
						or exists (
							select 1 from empresa_sector_service ess
							join services sv on sv.id = ess.service_id
							join sectors s on s.id = sv.sectors_id
							where ess.empresa_id = e.id and unaccent(s.name) ilike unaccent(${like})
						)
					)`);
				}

				if (sector) {
					const like = `%${sector}%`;
					conditions.push(sql`exists (
						select 1 from empresa_sector_service ess
						join services sv on sv.id = ess.service_id
						join sectors s on s.id = sv.sectors_id
						where ess.empresa_id = e.id and unaccent(s.name) ilike unaccent(${like})
					)`);
				}

				if (ciudad) {
					conditions.push(sql`unaccent(c.city_name) ilike unaccent(${'%' + ciudad + '%'})`);
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

				const where = conditions.reduce((acc, c) => sql`${acc} and ${c}`);

				const rows = await sql`
					select
						e.id, e.rif, e.name, e.phone, e.website, e.street, e.ano_fund,
						c.city_name, co.country_name,
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
					left join countries co on co.id = c.country_id
					where ${where}
					order by e.name
					limit ${max}
				`;

				return { content: [{ type: 'text' as const, text: JSON.stringify(rows, null, 2) }] };
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

				const rows = normalizedRif
					? await sql`
						select
							e.id, e.rif, e.name, e.phone, e.website, e.street, e.ano_fund,
							c.city_name, co.country_name,
							(
								select string_agg(distinct s.name, ', ' order by s.name)
								from empresa_sector_service ess join services sv on sv.id = ess.service_id
								join sectors s on s.id = sv.sectors_id where ess.empresa_id = e.id
							) as sectores,
							(
								select string_agg(distinct sv.name, ', ' order by sv.name)
								from empresa_sector_service ess join services sv on sv.id = ess.service_id
								where ess.empresa_id = e.id
							) as servicios
						from empresas e
						left join cities c on c.id = e.city_id
						left join countries co on co.id = c.country_id
						where e.status_id = 1 and e.rif = ${normalizedRif}
						limit 1
					`
					: await sql`
						select
							e.id, e.rif, e.name, e.phone, e.website, e.street, e.ano_fund,
							c.city_name, co.country_name,
							(
								select string_agg(distinct s.name, ', ' order by s.name)
								from empresa_sector_service ess join services sv on sv.id = ess.service_id
								join sectors s on s.id = sv.sectors_id where ess.empresa_id = e.id
							) as sectores,
							(
								select string_agg(distinct sv.name, ', ' order by sv.name)
								from empresa_sector_service ess join services sv on sv.id = ess.service_id
								where ess.empresa_id = e.id
							) as servicios
						from empresas e
						left join cities c on c.id = e.city_id
						left join countries co on co.id = c.country_id
						where e.status_id = 1 and unaccent(e.name) ilike unaccent(${'%' + nombre + '%'})
						order by e.name
						limit 5
					`;

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
