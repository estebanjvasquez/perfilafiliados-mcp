import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Env } from './index';
import { getSql } from './db';
import { resolvePhraseEvidence, mergePhraseEvidence, rankedIds, countDirectMatches, debugCanonicalSearch } from './hybrid-search';

/**
 * Fase MCP-3 (ver docs/taxonomia/plan_mcp_cira.md de PerfilAfiliadosCPV): `search_empresas` y
 * `get_empresa`, contra las tablas reales de Postgres/Supabase que ya usa el panel Filament
 * (`empresas`, `empresa_sector_service`, `services`, `sectors`, `cities`, `states`, `countries`) -
 * NO contra la vista MySQL `ChatView` vieja que usa hoy CIRA en producción.
 *
 * Verificado contra Supabase real (11 sep 2026) antes de escribir esto:
 * - `empresa_taxonomy_category` (homologación empresa<->categoría CPV, Fase 3/4 del plan de
 *   taxonomía) estaba en 0 filas al escribir esto - el filtro `categoria_codigo`/`tipo_oferta` de
 *   `search_empresas` quedó armado y funcional para ese día. Tiene datos reales (756+ filas) desde
 *   el 15 sep 2026 - ver el bloque fechado "Fase MCP-4.6" más abajo para el bug de cascada que hizo
 *   falta corregir para que esos datos fueran alcanzables desde una búsqueda real.
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
 * `search_empresas` es HIBRIDO en niveles, pensado para no cambiar el resultado de una busqueda que
 * ya funciona (mismo principio que el hibrido lexico+semantico de `search_taxonomy`, Fase MCP-1) -
 * PERO desde Fase MCP-4.6 (ver mas abajo) la taxonomia CPV nueva YA NO es un ultimo recurso
 * exclusivo: se resuelve en PARALELO al nivel difuso, no despues de el.
 *
 * 1. EXACTO - `unaccent(columna) ilike unaccent(termino)` de siempre. `match_type: 'exact'`. Si
 *    esto encuentra algo, se devuelve tal cual - unico nivel que sigue "ganador unico" sin cambios.
 *    Default de `limit` 150 (no 20 - ver "Fase MCP-4.9" mas abajo), porque acá mas resultados NUNCA
 *    es ruido: es coincidencia literal.
 *
 * BUG REAL DE LIMITE ENCONTRADO EN VIVO (16 sep 2026, Fase MCP-4.9) - reportado por el usuario:
 * "construccion" devolvía 20 empresas, la version anterior de CIRA (SQL libre, sin este limite)
 * devolvía 72, y VINCCLER (que sí pertenece de verdad al sector CONSTRUCCIÓN - 5 servicios propios
 * en ese sector, verificado contra la tabla real) no aparecía. Causa raíz: el nivel EXACTO
 * reutilizaba el mismo `limit ?? 20` que los niveles aproximados (difuso/taxonomía/semántico),
 * donde SÍ tiene sentido un tope bajo (más resultados ahí es más ruido, por diseño). Pero el nivel
 * EXACTO no tiene ese problema - es ILIKE literal, cada fila es una coincidencia real, no una
 * aproximación. Verificado contra Supabase real: "construccion" (nombre/servicio/sector) tiene 84
 * empresas reales (más que las 72 de sector CONSTRUCCIÓN solo, porque también matchea nombre de
 * empresa) - con `order by e.name limit 20`, VINCCLER (posición 79 de 84 alfabéticamente) y otras
 * ~63 empresas reales quedaban cortadas sin ningún criterio de relevancia, solo por orden
 * alfabético. El sector institucional más grande (SERVICIOS ASOCIADOS) tiene 114 empresas activas
 * hoy - un límite de 20 nunca fue suficiente para una consulta de sector completo. Fix: el nivel
 * EXACTO usa su propio default de 150 (`exactMax`, separado de `max`), y el techo del parámetro
 * `limit` del schema sube de 50 a 200 - cubre con margen el sector más grande de hoy sin volverse
 * "traer toda la tabla" (universo total: 406 empresas activas). Los demás niveles NO se tocaron -
 * siguen en `max` (default 20), que es el comportamiento correcto para resultados aproximados.
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
 * 3. TAXONOMIA CPV (léxico completo + semántico) - se resuelve SIEMPRE que el nivel EXACTO no
 *    encontró nada, EN PARALELO con el nivel difuso de abajo, no como último recurso (Fase
 *    MCP-4.6, ver el bloque fechado 15 sep 2026 mas abajo). Léxico: `unaccent(nombre/sinonimo)
 *    ilike unaccent(query completo)` contra `taxonomy_categories` (`resolveLexicalTaxonomyMatches`).
 *    Semantico: la parte `source: 'taxonomy'` del paso 4 de abajo. Sus empresas
 *    (`empresa_taxonomy_category`) se UNEN (no reemplazan) a las del nivel difuso.
 *
 * 4. SEMANTICO (rediseñado 12 sep 2026, Fase MCP-4.3 - la v1 del 11 sep embebia el `query`
 *    COMPLETO como un solo vector; ver "Bug de dilucion semantica" mas abajo para por que se
 *    reemplazo) - inspirado en el approach hibrido de Mercadona Tech
 *    (https://newsletter.gemba.es/p/como-construimos-nuestro-buscador, se tomo SOLO la idea de
 *    hibrido lexico+semantico adaptada a nuestra escala real de cientos de empresas, no su stack
 *    de ranking con ML). Solo para el parametro `query` (`sector`/`ciudad` son vocabulario
 *    cerrado/geografico, no texto conceptual libre). Desde Fase MCP-4.6, la fuente `taxonomy` de
 *    este paso se usa arriba en el nivel 3 (paralelo al difuso) - lo que queda como ÚLTIMO recurso
 *    acá es solo la fuente `service` (catálogo viejo). 3 pasos:
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
 *       - `taxonomy_category_embeddings` (3.483+ nodos CPV, Fase MCP-1, ya generados y usados por
 *         `search_taxonomy`) - reusada tal cual, sin generar nada nuevo. `empresa_taxonomy_category`
 *         tiene datos reales desde el 15 sep 2026 (Fase 3/4 del proyecto de taxonomia, 756+ filas) -
 *         la fuente `taxonomy` de este paso encuentra empresas de verdad desde entonces, ver Fase
 *         MCP-4.6 para el bug que hizo falta corregir para que esas empresas fueran alcanzables.
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
 *
 * BUG REAL DE CASCADA ENCONTRADO EN VIVO (15 sep 2026, Fase MCP-4.6) - reportado por el usuario tras
 * cargar una empresa de prueba en el panel (Fase 4: buscador de autocarga) con categorías CPV
 * nuevas ("Válvulas de Cabezal de Pozo API 6A" y sus hijas) pero SIN ningún servicio del catálogo
 * viejo. Buscándola en CIRA con términos que coincidían exactamente con esas categorías, nunca
 * aparecía - CIRA mostraba en cambio resultados "aproximados" de OTRAS empresas via el catálogo
 * viejo. Causa raíz: la taxonomía (`empresa_taxonomy_category`) solo se consultaba en el nivel 3/4
 * (semántico), que es el ÚLTIMO recurso - si el nivel difuso (2) encontraba CUALQUIER cosa en
 * cualquier otra empresa del directorio (con 406 empresas reales, casi cualquier término de varias
 * letras encuentra algo por `word_similarity`), la cascada se detenía ahí y la taxonomía nunca se
 * llegaba a consultar. Una empresa que dependiera EXCLUSIVAMENTE de la taxonomía nueva (sin
 * servicios viejos) era, en la práctica, invisible para CIRA sin importar qué tan bien coincidiera
 * su categoría con la pregunta - defecto que anulaba el propósito completo de las Fases 3/4 del
 * proyecto de taxonomía. Fix: la taxonomía (léxico completo del `query` + semántico) se resuelve
 * en PARALELO al nivel difuso (`Promise.all`, sin round-trips extra secuenciales), y sus empresas
 * se UNEN a las del difuso en vez de necesitar que el difuso fallara primero. El nivel EXACTO (1)
 * no se tocó - sigue siendo un "ganador único" sin cambios, cero riesgo de regresión ahí.
 *
 * FASE MCP-5 (16 sep 2026, ver docs/taxonomia/plan_mcp_cira.md): 3 fuentes de datos reales que
 * hasta esta fecha CIRA no consultaba en absoluto, pese a existir en el sistema (perfil de afiliado,
 * módulos opcionales - `EmpresaModuleStatus.php` en Laravel) - viven en MySQL producción, se
 * sincronizan a pgsql con comandos Artisan nuevos (`empresas:sync-certifications`,
 * `empresas:sync-sustainability`, `empresas:sync-experiencias`), nunca se escribe en mysql desde
 * acá. Mismo criterio arquitectónico que la taxonomía (Fase MCP-4.6): las 3 se resuelven en
 * PARALELO, no como último recurso, y ninguna requiere un parámetro nuevo en la tool - todas
 * entran por el mismo `query` de siempre, consistente con la "REGLA UNICA" ya establecida en el
 * prompt de CIRA (no se tocó el prompt para esta fase).
 *
 * 1. CERTIFICACIONES (`empresa_certifications`, espejo de `management`/Gestión) - columnas
 *    booleanas reales (ISO9001, ISO14001, ISO45001, ISO27001, ISO50001, ISO17025, ISO37001, DUN,
 *    OVID, PMI). `detectCertificationColumn()` normaliza el `query` (saca todo lo que no sea
 *    letra/número) y busca el token - tolera "ISO 9001"/"iso-9001"/"ISO9001" por igual. También
 *    matchea por ILIKE contra `otras_certificaciones` (texto libre real de 38 empresas que
 *    reportaron una certificación propia no listada, ej. "SISTEMA DE GESTIÓN AMBIENTAL PROPIO").
 *
 * 2. SOSTENIBILIDAD (`empresa_sustainability_areas` + `sustainability_areas`, espejo de
 *    `sustainabilities`/Sostenibilidad) - catálogo cerrado de 8 áreas (modelo de economía circular).
 *    Los nombres reales son la descripción técnica del modelo (ej. "REORIENTACIÓN DEL OBJETO POR Y
 *    PARA LA SOCIEDAD O EL AMBIENTE") - nadie los escribe tal cual, así que cada área tiene
 *    `synonyms` curados a mano (ej. "reciclaje, residuos, desechos" para el área de valorización de
 *    desechos) contra los que también se matchea por ILIKE. Sin embeddings: 8 categorías no
 *    justifican esa complejidad.
 *
 * 3. EXPERIENCIAS (`empresa_experiencias` + `empresa_experiencia_embeddings`, aplanado de
 *    `experiences`/Experiencias) - cada fila es UN proyecto ejecutado (antes vivían todos juntos en
 *    un JSON por empresa). Híbrido léxico + semántico igual que la taxonomía: `resolveLexicalExperiencias`
 *    (ILIKE directo contra la descripción) y una tercera fuente dentro de `resolveSemanticConcepts`
 *    (`source: 'experiencia'`, mismas frases candidatas que ya se arman para la taxonomía - la
 *    descomposición es una propiedad del `query` del usuario, no del catálogo). Es la fuente más
 *    aproximada de las 6 (texto libre idiosincrático por proyecto) - va última en el orden de
 *    prioridad del merge final.
 *
 * Quedan afuera de esta fase (decisión explícita del usuario, revisar después): Presencia
 * (`presences` - oficinas por país, clientes reales) y Recursos/Activos (`assets` - maquinaria/
 * personal/instalaciones, códigos numéricos sin catálogo decodificador confirmado todavía).
 *
 * CALIBRACIÓN DEL UMBRAL SEMÁNTICO DE EXPERIENCIAS (16 sep 2026) - encontrado en vivo probando esta
 * misma fase: con el umbral general (0.6), "ISO 9001"/"reciclaje" (que YA tenían una respuesta
 * perfecta vía certificación/sostenibilidad) TAMBIÉN activaban ruido semántico de experiencias (ej.
 * "iso" resolvía a "Esta es una carga de prueba", distancia 0.54 - un registro de prueba real en la
 * tabla). Medido: coincidencias genuinas (`construccion` 0.38-0.42, `vialidad` 0.48-0.49) vs. ruido
 * (`iso`/`9001` 0.53-0.57, `represas` como hueco real del catálogo 0.50-0.53) - separación limpia en
 * 0.50, ver `EXPERIENCIA_SEMANTIC_DISTANCE_THRESHOLD`.
 *
 * HALLAZGO POSITIVO, NO UNA REGRESIÓN - "grua" (documentado en TODA esta sesión como "hueco real
 * del catálogo, nunca debe dar respuesta", ver `TRGM_THRESHOLD` más abajo) ahora SÍ devuelve 2
 * empresas reales vía coincidencia LÉXICA (no semántica) de experiencias: una tiene literalmente
 * "MANTENIMIENTO PREVENTIVO Y CORRECTIVO DE PUENTE DE GRUAS DE 5 Y 15 TONELADAS" en su historial de
 * proyectos. Esto es exactamente el propósito de esta fase: "grua" seguía siendo un hueco real del
 * catálogo de SERVICIOS (sectors/services nunca tuvo esa categoría), pero SÍ hay evidencia real de
 * experiencia con grúas que ningún otro nivel podía alcanzar. El test de regresión histórico "grua
 * debe dar []" queda actualizado: sigue valiendo para los niveles exacto/difuso/certificación/
 * sostenibilidad/taxonomía (que siguen dando vacío ahí, correctamente) pero YA NO para el conjunto
 * completo de `search_empresas` tras esta fase.
 *
 * LÍMITE ACEPTADO, NO PERSEGUIDO MÁS - una palabra suelta como "represa" o "rehabilitacion" (sin
 * más contexto) puede acercarse semánticamente a proyectos relacionados solo por vocabulario de
 * ingeniería civil compartido pero sin relación temática real (ej. "represa" ~ drenajes de relleno
 * sanitario a 0.49; "rehabilitacion" ~ reformación catalítica de una planta a 0.46) - ambos casos
 * DENTRO del umbral de 0.50 porque bajarlo más excluiría coincidencias genuinas de "vialidad"
 * (0.48-0.49). Mismo criterio ya aceptado en este archivo para "reciclaje"~"VIALIDAD Y DRENAJES"
 * (nivel semántico de servicios, Fase MCP-4.6): un límite documentado y conocido, no perseguido con
 * más ajuste de umbral porque la alternativa (subir el umbral) pierde valor real neto.
 */

/**
 * Fase MCP-7 (Fase A, ver docs/taxonomia/plan_mcp_cira.md): TODO el mecanismo de descomposición
 * mecánica en palabras/bigramas, resolución léxica/semántica por catálogo y merge por especificidad
 * (Fases MCP-1 a MCP-6.1, documentadas en el docblock de arriba) se REEMPLAZÓ por el buscador
 * híbrido de `hybrid-search.ts` (SQL estructurado + full-text nativo de Postgres + vectorial + RRF
 * ponderado) - ver ese archivo para el diseño y los parámetros calibrados. La historia completa de
 * por qué existió cada mecanismo anterior queda documentada arriba (no se borra, es la evidencia de
 * los bugs reales que motivaron este reemplazo), pero el código en sí ya no vive acá.
 */

/**
 * Forma exacta de las filas de `empresaSelectAndJoins()` - anotada explícita porque sin esto
 * TypeScript no infería bien el tipo de fila de `sql\`...\`` cuando la query se declaraba como
 * promesa suelta antes de un `Promise.all` en vez de un `await` directo.
 */
type EmpresaSearchRow = {
	id: number;
	rif: string;
	name: string;
	phone: string | null;
	website: string | null;
	street: string | null;
	ano_fund: number | null;
	city_name: string | null;
	state_name: string | null;
	country_name: string | null;
	sectores: string | null;
	servicios: string | null;
};

/** Columnas + joins compartidos entre las tools de este archivo - evita repetir el mismo SQL. */
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
				'"query" busca por nombre de empresa, servicio o sector en texto libre, y TAMBIÉN por ' +
				'certificaciones (ej. "ISO 9001"), áreas de sostenibilidad (ej. "reciclaje", "energías ' +
				'renovables") y experiencia en proyectos ejecutados (ej. "represas", "vialidad") - no hace ' +
				'falta ningún parámetro especial para esto, "query" ya lo resuelve todo junto. "ciudad" ' +
				'matchea ciudad o estado venezolano. "categoria_codigo" filtra por la taxonomía CPV nueva ' +
				'(con datos reales desde el 15 sep 2026, Fase 3/4 de taxonomía) - rara vez hace falta usarlo ' +
				'porque "query" en texto libre ya encuentra esas categorías automáticamente; reservarlo para ' +
				'cuando el usuario da un código CPV exacto o pide explícitamente navegar la taxonomía por código. ' +
				'Si antes llamaste a "resolve_search_intent" para esta misma consulta, pasá su resultado en ' +
				'"resolvedPhrases" (ver ese parámetro) - si te devolvió una pregunta de aclaración, no llames a ' +
				'esta tool todavía, respondé esa pregunta primero.',
			inputSchema: {
				query: z.string().min(2).optional().describe('Texto libre: nombre de empresa, servicio o sector'),
				sector: z.string().optional().describe('Nombre (parcial) de uno de los 8 sectores institucionales, ej. "construccion"'),
				ciudad: z.string().optional().describe('Nombre (parcial) de ciudad o estado, ej. "maracaibo" o "zulia"'),
				categoria_codigo: z
					.string()
					.optional()
					.describe('Código CPV (prefijo, ej. "CPV-05") de la taxonomía nueva - con datos reales desde el 15 sep 2026'),
				tipo_oferta: z
					.string()
					.optional()
					.describe('Filtra además por tipo de oferta de la categoría CPV - solo aplica junto con categoria_codigo'),
				limit: z
					.number()
					.int()
					.min(1)
					.max(200)
					.optional()
					.describe(
						'Máximo de resultados (default 20, o 150 para el nivel EXACTO cuando la coincidencia es amplia - ' +
							'ej. un sector institucional completo puede tener 100+ empresas reales, no es ruido a recortar)'
					),
				queryIntent: z
					.enum(['SECTOR', 'SERVICE', 'COMPANY', 'RIF', 'CITY', 'MIXED'])
					.optional()
					.describe(
						'La clasificación de intención que ya calculaste para este mensaje (mismo valor que ponés en ' +
							'tu JSON de salida) - úsala tal cual, no la repitas si no la tenés clara. Ayuda a la tool a no ' +
							'confundir un término de negocio genérico con un intento de nombre de empresa.'
					),
				resolvedPhrases: z
					.array(z.string())
					.optional()
					.describe(
						'Solo si llamaste antes a resolve_search_intent para este mensaje: pasá acá tal cual su ' +
							'"search_phrases" (una frase compuesta única, o varios conceptos independientes - cada uno se ' +
							'busca por separado y se combinan los resultados). Si no llamaste a resolve_search_intent, ' +
							'omitilo - "query" solo sigue funcionando igual que siempre.'
					),
				debug: z
					.boolean()
					.optional()
					.describe(
						'Fase 23A - uso interno de administración/benchmark, NUNCA para el flujo normal de CIRA. Si es ' +
							'true, en vez de buscar empresas devuelve el objeto de diagnóstico de expansión canónica ' +
							'(término detectado, conceptos, CPVs, conteo de candidatos por señal) para "query".'
					),
			},
		},
		async ({ query, sector, ciudad, categoria_codigo, tipo_oferta, limit, resolvedPhrases, debug }) => {
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
			// Mismo criterio que el nivel EXACTO del sistema anterior (Fase MCP-4.9): un match literal
			// nunca es ruido a recortar - un sector institucional completo puede tener 100+ empresas
			// reales.
			const exactMax = limit ?? 150;
			const sql = getSql(env);

			// Fase 23A: modo diagnóstico - nunca lo usa CIRA en el flujo normal (el prompt de n8n no lo
			// conoce), solo administración/benchmark vía curl/Postman con debug:true explícito.
			if (debug && query) {
				try {
					const diagnostics = await debugCanonicalSearch(sql, env, query);
					return { content: [{ type: 'text' as const, text: JSON.stringify(diagnostics, null, 2) }] };
				} finally {
					await sql.end({ timeout: 1 });
				}
			}

			/** Filtros estructurados (sector/ciudad/categoria_codigo) - iguales para el filtro puro y para acotar el resultado fusionado. */
			function structuredFilters() {
				const conditions: ReturnType<typeof sql>[] = [];
				if (sector) {
					conditions.push(sql`exists (
						select 1 from empresa_sector_service ess
						join services sv on sv.id = ess.service_id
						join sectors s on s.id = sv.sectors_id
						where ess.empresa_id = e.id and unaccent(s.name) ilike unaccent(${'%' + sector + '%'})
					)`);
				}
				if (ciudad) {
					conditions.push(
						sql`(unaccent(c.city_name) ilike unaccent(${'%' + ciudad + '%'}) or unaccent(st.state_name) ilike unaccent(${'%' + ciudad + '%'}))`
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
				return conditions;
			}

			try {
				// Sin "query": filtro estructurado puro (sector/ciudad/categoria_codigo) - no hay texto
				// libre que interpretar, no hace falta el buscador híbrido.
				if (!query) {
					const conditions = [sql`e.status_id = 1`, ...structuredFilters()];
					const where = conditions.reduce((acc, c) => sql`${acc} and ${c}`);
					const rows = await sql<EmpresaSearchRow[]>`
						${empresaSelectAndJoins(sql)}
						where ${where}
						order by e.name
						limit ${exactMax}
					`;
					const matchedVia = [
						sector ? `sector: ${sector}` : null,
						ciudad ? `ciudad o estado: ${ciudad}` : null,
						categoria_codigo ? `categoría CPV: ${categoria_codigo}` : null,
					]
						.filter((p): p is string => !!p)
						.join(' · ');
					const tagged = rows.map((r) => ({ ...r, match_type: 'exact' as const, matched_via: matchedVia }));
					return { content: [{ type: 'text' as const, text: JSON.stringify(tagged, null, 2) }] };
				}

				// Con "query": buscador híbrido de Fase MCP-7 (SQL estructurado + full-text + vectorial +
				// léxico, fusionados por RRF ponderado) - ver hybrid-search.ts para el diseño completo.
				// `resolvedPhrases` (de `resolve_search_intent`) SUMA conceptos - nunca reemplaza a
				// `query`. Bug real encontrado calibrando esta fase: "empresas de construccion en
				// maracaibo" -> el agente mandó query:"construccion" (la raíz correcta, REGLA UNICA) PERO
				// resolvedPhrases:["empresas de construcción en Maracaibo"] (la oración completa, con la
				// ciudad todavía pegada - resolve_search_intent no tiene forma de saber que "ciudad" ya se
				// extrajo aparte). Si resolvedPhrases reemplazaba a query, se perdía la raíz limpia que sí
				// encuentra a VINCCLER por substring (el caso de Fase MCP-4.9) - RRF es composicional,
				// sumar `query` como una frase más no tiene costo cuando ya coincide con resolvedPhrases,
				// y rescata la evidencia cuando no coincide.
				const phrases = Array.from(new Set([query, ...(resolvedPhrases ?? [])]));
				const evidenceMaps = await Promise.all(phrases.map((phrase) => resolvePhraseEvidence(sql, env, phrase)));
				const fusedEvidence = mergePhraseEvidence(evidenceMaps);
				const ranked = rankedIds(fusedEvidence);

				if (ranked.length === 0) {
					return { content: [{ type: 'text' as const, text: JSON.stringify([], null, 2) }] };
				}

				const directMatchCount = await countDirectMatches(sql, phrases[0]);
				const effectiveLimit = directMatchCount > max ? exactMax : max;

				const candidateIds = ranked.map((r) => r.empresa_id);
				const conditions = [sql`e.status_id = 1`, sql`e.id in ${sql(candidateIds)}`, ...structuredFilters()];
				const where = conditions.reduce((acc, c) => sql`${acc} and ${c}`);

				const rows = await sql<EmpresaSearchRow[]>`
					${empresaSelectAndJoins(sql)}
					where ${where}
				`;

				const evidenceByEmpresaId = new Map(ranked.map((r) => [r.empresa_id, r]));
				const tagged = rows
					.map((r) => {
						const evidence = evidenceByEmpresaId.get(r.id);
						return {
							row: { ...r, match_type: evidence?.matchType ?? 'exact', matched_via: evidence?.matchedVia ?? '' },
							score: evidence?.score ?? 0,
						};
					})
					.sort((a, b) => b.score - a.score)
					.slice(0, effectiveLimit)
					.map((c) => c.row);

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
