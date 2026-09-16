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
function significantWords(text: string): string[] {
	const normalized = text
		.toLowerCase()
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^a-z0-9\s]/g, ' ');

	return normalized.split(/\s+/).filter((w) => w.length > 2 && !SPANISH_STOPWORDS.has(w));
}

export function extractCandidatePhrases(text: string, maxPhrases = 8): string[] {
	const words = significantWords(text);

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

/**
 * Variante SOLO para el lado taxonomía (nunca para servicios - ver "bug de dilución semántica" mas
 * abajo en este archivo): además de palabras sueltas y bigramas, agrega la SECUENCIA COMPLETA de
 * palabras significativas cuando son pocas (2 a 5) - las categorías CPV suelen tener nombres
 * compuestos de 3+ palabras (ej. "Válvulas de Cabezal de Pozo API 6A"), y un usuario que describe
 * exactamente eso con 3 palabras clave necesita esas 3 juntas para resolver bien, no de a pares.
 *
 * Encontrado en vivo (Fase MCP-4.6, 15 sep 2026) probando una empresa cargada con esa categoría
 * exacta vía el buscador de autocarga del panel: "valvula cabezal pozo" como frase COMPLETA
 * resuelve a "Válvulas de Cabezal de Pozo API 6A" (distancia 0.4519) como el MEJOR match de los
 * 3.497 nodos - ni la palabra "cabezal" sola (ni siquiera entre los 8 más cercanos) ni el bigrama
 * "cabezal pozo" (resuelve a nodos temáticamente cercanos pero no al correcto) lo encontraban.
 *
 * No se aplica al catálogo de servicios: sus 112 nombres ya son cortos y específicos (no hace
 * falta), y el riesgo de reintroducir el bug de dilución semántica (2 CONCEPTOS DISTINTOS
 * combinados en un solo vector, ej. "soldadura tuberia") es real ahí. Acá el riesgo es menor porque
 * los nombres CPV son compuestos por diseño (un solo concepto con varias palabras), no una oración
 * con conectores mezclando 2 pedidos distintos.
 */
export function extractCandidatePhrasesForTaxonomy(text: string, maxPhrases = 8): string[] {
	const words = significantWords(text);
	const phrases = new Set(extractCandidatePhrases(text, maxPhrases));

	if (words.length >= 3 && words.length <= 5) {
		phrases.add(words.join(' '));
	}

	return Array.from(phrases).slice(0, maxPhrases + 1);
}

type ResolvedConcept = {
	source: 'service' | 'taxonomy' | 'experiencia';
	id: number;
	name: string;
	phrase: string;
	distance: number;
};

type LexicalTaxonomyMatch = { id: number; name: string };

/**
 * Certificaciones reales del módulo "Gestión" (`management`, MySQL) sincronizadas a
 * `empresa_certifications` (Fase MCP-5.1, ver `SyncEmpresaCertifications.php`). Detecta la columna
 * booleana que corresponde a lo que escribió el usuario, tolerando las formas comunes de escribir
 * un código ISO ("ISO 9001", "iso-9001", "ISO9001") - se normaliza sacando todo lo que no sea
 * letra/número antes de buscar el token. `dun`/`ovid`/`pmi` son códigos cortos pero reales del
 * propio formulario de Gestión del panel - riesgo de colisión bajo (a diferencia de "grua", no son
 * fragmentos que aparezcan sueltos dentro de otras palabras de uso común en español).
 */
const CERTIFICATION_TOKEN_TO_COLUMN: Record<string, string> = {
	iso9001: 'iso9001',
	iso14001: 'iso14001',
	iso45001: 'iso45001',
	iso27001: 'iso27001',
	iso50001: 'iso50001',
	iso17025: 'iso17025',
	iso37001: 'iso37001',
	dun: 'dun',
	ovid: 'ovid',
	pmi: 'pmi',
};

function detectCertificationColumn(query: string): string | null {
	const normalized = query.toLowerCase().replace(/[^a-z0-9]/g, '');

	for (const [token, column] of Object.entries(CERTIFICATION_TOKEN_TO_COLUMN)) {
		if (normalized.includes(token)) {
			return column;
		}
	}

	return null;
}

/**
 * Condición SQL para la columna booleana detectada - por `switch` explícito (no interpolación
 * dinámica de identificador) porque `column` sale de un Record con un set fijo y chico de claves
 * conocidas, no hace falta ni conviene la complejidad de armar el nombre de columna en runtime.
 */
function certificationFlagCondition(sql: ReturnType<typeof getSql>, column: string | null) {
	switch (column) {
		case 'iso9001':
			return sql`ec.iso9001 = true`;
		case 'iso14001':
			return sql`ec.iso14001 = true`;
		case 'iso45001':
			return sql`ec.iso45001 = true`;
		case 'iso27001':
			return sql`ec.iso27001 = true`;
		case 'iso50001':
			return sql`ec.iso50001 = true`;
		case 'iso17025':
			return sql`ec.iso17025 = true`;
		case 'iso37001':
			return sql`ec.iso37001 = true`;
		case 'dun':
			return sql`ec.dun = true`;
		case 'ovid':
			return sql`ec.ovid = true`;
		case 'pmi':
			return sql`ec.pmi = true`;
		default:
			return sql`false`;
	}
}

/** Recorta texto libre largo (ej. descripción de un proyecto) para no inflar `matched_via`. */
function truncateText(text: string, max = 100): string {
	return text.length > max ? text.slice(0, max).trimEnd() + '…' : text;
}

/**
 * Fase MCP-5.5 - cantidad de palabras significativas de una frase, usada como desempate de
 * "qué tan específica" es una coincidencia (ver el merge final de `search_empresas`). Reusa
 * `significantWords` (la misma función que arma las frases candidatas del nivel semántico) para
 * que el criterio de "palabra significativa" sea uno solo en todo el archivo.
 */
function phraseSpecificity(phrase: string): number {
	return significantWords(phrase).length;
}

/**
 * Familias CPV "agujero negro" - nombre lo bastante genérico como para atraer coincidencias léxicas
 * o semánticas sin relación temática real. Mismo problema, mismo criterio de exclusión puntual por
 * código (no un umbral, no excluir todo un nivel) ya usado en `HomologateServicesTaxonomy.php`
 * (Fase 3, Laravel) para `CPV-29.02`/`CPV-12.04` - acá se replica esa misma lista porque el
 * problema es el MISMO dato (`taxonomy_category_embeddings`), solo que consultado desde otro
 * lugar. `CPV-48.02` "Accesorios" (Grupo 48, Textil/Cuero/Confección) sumado acá el 15 sep 2026,
 * Fase MCP-4.6: 15 empresas reales quedaron vinculadas a esa Familia por la homologación automática
 * de Fase 3, y su embedding cae dentro del umbral para la palabra suelta "cabezal" sin relación
 * temática real (textil vs. pozos petroleros) - encontrado en vivo probando el fix de esta fase,
 * exactamente el mismo síntoma que motivó excluir las 2 familias anteriores.
 */
const GENERIC_ATTRACTOR_FAMILY_CODES = ['CPV-29.02', 'CPV-12.04', 'CPV-48.02'];

/**
 * Forma exacta de las filas de `empresaSelectAndJoins()` - anotada explícita (mismo criterio que
 * ya usa `resolveSemanticConcepts` para sus propias queries) porque sin esto TypeScript no infería
 * bien el tipo de fila de `sql\`...\`` cuando la query se declaraba como promesa suelta antes de un
 * `Promise.all` en vez de un `await` directo - encontrado compilando el fix de Fase MCP-4.6.
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

/**
 * Match léxico DIRECTO de `query` completo contra nombre/sinónimo de una categoría CPV (nivel
 * Familia u hoja, nunca Grupo) - mismo criterio que el nivel léxico de `search_taxonomy` (Fase
 * MCP-1), pero acá contra la frase COMPLETA que mandó el agente, no descompuesta en frases cortas
 * (a diferencia de `resolveSemanticConcepts`, que sí descompone para el embedding). Sirve para el
 * caso real que motivó Fase MCP-4.6 abajo: una empresa cargó la categoría "Válvulas de Cabezal de
 * Pozo API 6A" vía el buscador de autocarga (Fase 4 del panel) - un usuario de CIRA preguntando
 * literalmente por "válvulas de cabezal de pozo" matchea esto por ILIKE simple, sin necesitar el
 * modelo de embeddings para un caso que ya es casi idéntico en texto.
 */
async function resolveLexicalTaxonomyMatches(sql: ReturnType<typeof getSql>, query: string): Promise<LexicalTaxonomyMatch[]> {
	const rows = await sql<{ id: number; name: string }[]>`
		select distinct on (tc.id) tc.id, coalesce(tt.name, tc.code) as name
		from taxonomy_categories tc
		left join taxonomy_category_translations tt on tt.category_id = tc.id and tt.locale = 'es'
		left join taxonomy_category_translations tt_en on tt_en.category_id = tc.id and tt_en.locale = 'en'
		left join taxonomy_category_synonyms syn on syn.category_id = tc.id
		where tc.level != 0 and tc.is_active = true
			and tc.code not in ${sql(GENERIC_ATTRACTOR_FAMILY_CODES)}
			and (
				unaccent(coalesce(tt.name, '')) ilike unaccent(${'%' + query + '%'})
				or unaccent(coalesce(tt_en.name, '')) ilike unaccent(${'%' + query + '%'})
				or unaccent(coalesce(syn.term, '')) ilike unaccent(${'%' + query + '%'})
			)
		limit 10
	`;

	return rows;
}

type LexicalSustainabilityMatch = { area_id: number; name: string };

/**
 * Match léxico contra el catálogo cerrado de 8 áreas de sostenibilidad (`sustainability_areas`,
 * Fase MCP-5.2) - contra el NOMBRE real del área (técnico, poco probable que un usuario lo escriba
 * tal cual) y contra sus `synonyms` curados a mano (la forma coloquial real, ej. "reciclaje").
 */
async function resolveLexicalSustainabilityAreas(sql: ReturnType<typeof getSql>, query: string): Promise<LexicalSustainabilityMatch[]> {
	const rows = await sql<{ area_id: number; name: string }[]>`
		select id as area_id, name
		from sustainability_areas
		where unaccent(name) ilike unaccent(${'%' + query + '%'})
			or unaccent(coalesce(synonyms, '')) ilike unaccent(${'%' + query + '%'})
	`;

	return rows;
}

type LexicalExperienciaMatch = { id: number; empresa_id: number; descripcion: string };

/**
 * Match léxico DIRECTO (frase completa, no descompuesta) contra la descripción libre de un
 * proyecto ejecutado (`empresa_experiencias`, Fase MCP-5.3) - mismo criterio que
 * `resolveLexicalTaxonomyMatches`: cubre el caso en que el usuario ya usa casi las mismas palabras
 * que la empresa puso en su descripción, sin necesitar el modelo de embeddings para eso.
 */
async function resolveLexicalExperiencias(sql: ReturnType<typeof getSql>, query: string): Promise<LexicalExperienciaMatch[]> {
	const rows = await sql<{ id: number; empresa_id: number; descripcion: string }[]>`
		select id, empresa_id, descripcion
		from empresa_experiencias
		where unaccent(descripcion) ilike unaccent(${'%' + query + '%'})
		limit 20
	`;

	return rows;
}

/**
 * Resuelve cada frase candidata contra `service_embeddings` y `taxonomy_category_embeddings` -
 * UNA query SQL por catalogo (UNION ALL de un nearest-neighbor por frase), sin importar cuantas
 * frases haya. Devuelve los conceptos que pasan el umbral, deduplicados por (fuente, id) quedando
 * con la mejor (menor) distancia si una misma fila fue la mas cercana para mas de una frase.
 *
 * 2 correcciones reales encontradas probando el fix de Fase MCP-4.6 en vivo (15 sep 2026):
 *
 * 1. `service_embeddings` incluye TODOS los 112 servicios sin excepción (`GenerateServiceEmbeddings.php`
 *    nunca excluyó los placeholders "X"/"OTROS" del catálogo viejo, a diferencia de la homologación
 *    de Fase 3 que sí los excluye) - su texto embebido es "X | Sector: <sector>", así que un
 *    servicio "X" queda semánticamente cerca de CUALQUIER término relacionado con su sector (ej.
 *    "cabezal"/"pozo" -> cerca de "X | Sector: SERVICIOS A POZOS"). Verificado en vivo: buscar
 *    "válvulas de cabezal de pozo" devolvía 20 empresas, TODAS con `matched_via: similar a "cabezal"
 *    (servicio: X)` - ninguna coincidencia real. Se excluyen acá (no en Laravel, para no tener que
 *    regenerar embeddings) con `sv.name not in ('X','OTROS')`.
 *
 * 2. Tomar el nearest-neighbor ÚNICO (`limit 1`) por frase funciona bien contra el catálogo de 112
 *    servicios (poco denso), pero la taxonomía CPV tiene 3.497+ nodos - varios muy próximos entre sí
 *    temáticamente (ej. "Cabezal de Inyección", "Cabezal de Escape" y "Válvulas de Cabezal de Pozo"
 *    conviven cerca). Con `limit 1`, una palabra como "cabezal" resolvía al nodo más cercano
 *    cualquiera (no necesariamente el correcto para lo que la empresa cargó), y si NINGUNA empresa
 *    estaba vinculada a ESE nodo puntual, la taxonomía nueva de Fase MCP-4.6 igual no encontraba
 *    nada - cayendo al fallback de servicio del punto 1. Fix: la taxonomía toma los 5 más cercanos
 *    por frase (no 1), todos los que pasen el umbral - le da a la categoría realmente vinculada una
 *    chance real de aparecer sin tener que ser la campeona absoluta de un espacio mucho más denso.
 *    El catálogo de servicios se deja en `limit 1` sin cambios (ya calibrado, sin evidencia de que
 *    haga falta ensancharlo, y ensancharlo sin necesidad sería solo un riesgo más).
 */
async function resolveSemanticConcepts(
	sql: ReturnType<typeof getSql>,
	env: Env,
	servicePhrases: string[],
	taxonomyPhrases: string[],
	experienciaPhrases: string[],
	threshold: number,
	experienciaThreshold: number
): Promise<ResolvedConcept[]> {
	// UNA sola llamada al modelo para las frases de LOS 3 catálogos (aunque sean listas distintas -
	// ver docblock de `extractCandidatePhrasesForTaxonomy`) - se embebe la unión sin duplicados, y
	// cada catálogo busca su vector por texto en el mapa resultante.
	const allPhrases = Array.from(new Set([...servicePhrases, ...taxonomyPhrases, ...experienciaPhrases]));

	if (allPhrases.length === 0) {
		return [];
	}

	const embeddingResult = await env.AI.run('@cf/baai/bge-m3', { text: allPhrases });
	const vectors = extractEmbeddingVectors(embeddingResult);
	const vectorByPhrase = new Map(allPhrases.map((phrase, i) => [phrase, vectors[i]]));

	const usableService = servicePhrases
		.map((phrase) => ({ phrase, vector: vectorByPhrase.get(phrase) }))
		.filter((p): p is { phrase: string; vector: string } => !!p.vector);
	const usableTaxonomy = taxonomyPhrases
		.map((phrase) => ({ phrase, vector: vectorByPhrase.get(phrase) }))
		.filter((p): p is { phrase: string; vector: string } => !!p.vector);
	const usableExperiencia = experienciaPhrases
		.map((phrase) => ({ phrase, vector: vectorByPhrase.get(phrase) }))
		.filter((p): p is { phrase: string; vector: string } => !!p.vector);

	if (usableService.length === 0 && usableTaxonomy.length === 0 && usableExperiencia.length === 0) {
		return [];
	}

	const serviceParts = usableService.map(
		({ vector }, i) => sql`(
			select ${i}::int as phrase_idx, sv.id, sv.name, (se.embedding <=> ${vector}::vector) as distance
			from service_embeddings se
			join services sv on sv.id = se.service_id
			where upper(sv.name) not in ('X', 'OTROS')
			order by se.embedding <=> ${vector}::vector asc
			limit 1
		)`
	);
	const taxonomyParts = usableTaxonomy.map(
		({ vector }, i) => sql`(
			select ${i}::int as phrase_idx, tc.id, coalesce(tt.name, tc.code) as name, (tce.embedding <=> ${vector}::vector) as distance
			from taxonomy_category_embeddings tce
			join taxonomy_categories tc on tc.id = tce.category_id
			left join taxonomy_category_translations tt on tt.category_id = tc.id and tt.locale = 'es'
			where tc.code not in ${sql(GENERIC_ATTRACTOR_FAMILY_CODES)}
			order by tce.embedding <=> ${vector}::vector asc
			limit 5
		)`
	);
	// Fase MCP-5.3: mismo criterio que la taxonomía (limit 5, no 1) - las descripciones de proyectos
	// son texto libre idiosincrático, mucho menos denso que servicios (112) pero con más variación de
	// redacción por proyecto que categorías CPV - dar varias chances por frase reduce el riesgo de
	// perder el proyecto correcto por no ser el vecino más cercano absoluto.
	const experienciaParts = usableExperiencia.map(
		({ vector }, i) => sql`(
			select ${i}::int as phrase_idx, ee.id, ee.descripcion as name, (eee.embedding <=> ${vector}::vector) as distance
			from empresa_experiencia_embeddings eee
			join empresa_experiencias ee on ee.id = eee.experiencia_id
			order by eee.embedding <=> ${vector}::vector asc
			limit 5
		)`
	);

	const [serviceMatches, taxonomyMatches, experienciaMatches] = await Promise.all([
		serviceParts.length > 0
			? sql<{ phrase_idx: number; id: number; name: string; distance: number }[]>`${serviceParts.reduce((acc, p) => sql`${acc} union all ${p}`)}`
			: Promise.resolve([]),
		taxonomyParts.length > 0
			? sql<{ phrase_idx: number; id: number; name: string; distance: number }[]>`${taxonomyParts.reduce((acc, p) => sql`${acc} union all ${p}`)}`
			: Promise.resolve([]),
		experienciaParts.length > 0
			? sql<{ phrase_idx: number; id: number; name: string; distance: number }[]>`${experienciaParts.reduce((acc, p) => sql`${acc} union all ${p}`)}`
			: Promise.resolve([]),
	]);

	const resolved: ResolvedConcept[] = [];
	for (const m of serviceMatches) {
		if (m.distance < threshold) resolved.push({ source: 'service', id: m.id, name: m.name, phrase: usableService[m.phrase_idx].phrase, distance: m.distance });
	}
	for (const m of taxonomyMatches) {
		if (m.distance < threshold) resolved.push({ source: 'taxonomy', id: m.id, name: m.name, phrase: usableTaxonomy[m.phrase_idx].phrase, distance: m.distance });
	}
	for (const m of experienciaMatches) {
		if (m.distance < experienciaThreshold) resolved.push({ source: 'experiencia', id: m.id, name: m.name, phrase: usableExperiencia[m.phrase_idx].phrase, distance: m.distance });
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
							'"search_phrases" (una frase compuesta única, o varios conceptos independientes). Reemplaza ' +
							'la descomposición automática en palabras sueltas para la búsqueda de taxonomía/experiencias, ' +
							'evitando que una frase compuesta específica pierda prioridad frente a coincidencias genéricas ' +
							'de una sola palabra. Si no llamaste a resolve_search_intent, omitilo - "query" solo sigue ' +
							'funcionando igual que siempre.'
					),
			},
		},
		async ({ query, sector, ciudad, categoria_codigo, tipo_oferta, limit, queryIntent, resolvedPhrases }) => {
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
			// Fase MCP-5.3 (16 sep 2026) - bug real encontrado en vivo probando esta misma fase: con el
			// umbral general (0.6), consultas de certificacion/sostenibilidad ("ISO 9001", "reciclaje")
			// tambien activaban el nivel semantico de experiencias y devolvian empresas sin relacion
			// real (ej. "iso" resolvia a "Esta es una carga de prueba" a distancia 0.54). Medido en vivo
			// contra datos reales: coincidencias GENUINAS de experiencia caen entre 0.38 ("construccion"
			// -> "CONSTRUCCION EDIFICIO...") y 0.49 ("vialidad" -> "REHABILITACION VIAL..."); el ruido
			// ("iso"/"9001"/"represas", este ultimo un hueco real del catalogo que debe dar vacio) cae
			// entre 0.50 y 0.57 - separacion limpia. Las descripciones de proyecto son texto libre mucho
			// mas variado que nombres de servicio/categoria CPV (que SI se quedan en 0.6, ya calibrados,
			// sin evidencia de que haga falta tocarlos), así que el nivel de experiencias usa su PROPIO
			// umbral, mas estricto.
			const EXPERIENCIA_SEMANTIC_DISTANCE_THRESHOLD = 0.5;

			// Fase MCP-6.1 (16 sep 2026) - bug real encontrado en vivo en producción DESPUES de publicar
			// Fase MCP-6: "represas" volvió a colisionar con "REPRESENTACIONES..." - esta vez no via el
			// nivel de tipeo de nombre (ya blindado en Fase MCP-5.4), sino via el nivel EXACTO mismo: la
			// REGLA UNICA del prompt de n8n (pre-existente, no tocada hoy) le pide al modelo mandar la
			// "raiz" de la palabra en "query" (ej. "perforaciones" -> "perforac"), y esa raiz no es
			// determinista - esa vez el modelo trunco a "repres" (en vez de "represa" como en pruebas
			// anteriores), y "repres" SI es substring literal de "representaciones" (ILIKE exacto real,
			// no un falso positivo de similitud). El nivel EXACTO nunca tuvo esta proteccion porque
			// siempre se documento como "ganador unico, cero riesgo, no tocar" - pero antes de esta fase
			// no existia una alternativa mejor que ofrecerle. Ahora si: `resolvedPhrases` (cuando
			// `resolve_search_intent` devolvio una unica frase compuesta) es la frase COMPLETA que el
			// propio usuario/especialista valido, sin el truncamiento no-determinista de la REGLA UNICA -
			// se usa esa frase para el chequeo de NOMBRE DE EMPRESA especificamente ("represas" no es
			// substring de "representaciones"), dejando sin tocar el chequeo de servicio/sector (que sigue
			// usando la raiz corta de `query` a proposito - ahi SI conviene, cataloga cerrado y chico,
			// sin el riesgo de 406 nombres propios arbitrarios).
			const nameMatchTerm = resolvedPhrases && resolvedPhrases.length === 1 ? resolvedPhrases[0] : query;

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
								unaccent(e.name) ilike unaccent(${'%' + nameMatchTerm + '%'})
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
				// El nivel EXACTO usa un default MAS ALTO que el resto (150, no 20) - ver docblock del
				// archivo, bloque fechado "Fase MCP-4.9". Un ILIKE exacto contra sector/servicio/nombre
				// nunca es "ruido": una consulta que coincide con un sector institucional completo puede
				// legitimamente tener 100+ empresas reales (ej. "construccion" -> 84, "SERVICIOS
				// ASOCIADOS" tiene 114 empresas activas) - recortar a 20 con `order by e.name` no reduce
				// ruido, descarta resultados reales por orden alfabetico (una empresa como "VINCCLER",
				// bien atras en el alfabeto, quedaba afuera pese a pertenecer genuinamente al sector).
				// Los demas niveles (difuso/taxonomia/tipeo/semantico) SI necesitan quedarse en el
				// default bajo (20) - ahi mas resultados SI es mas ruido, por diseño (ver docblock).
				const exactMax = limit ?? 150;
				const exactRows = await sql`
					${empresaSelectAndJoins(sql)}
					where ${buildConditions(false)}
					order by e.name
					limit ${exactMax}
				`;

				if (exactRows.length > 0) {
					const matchedVia = describeMatch('exact');
					const tagged = exactRows.map((r) => ({ ...r, match_type: 'exact' as const, matched_via: matchedVia }));
					return { content: [{ type: 'text' as const, text: JSON.stringify(tagged, null, 2) }] };
				}

				// Nivel 2 (difuso), taxonomía y nivel 3 (semántico por servicio) solo tienen sentido
				// si el usuario dio texto libre para tolerar (categoria_codigo es un código exacto,
				// no aplica a ninguno). Todos abajo solo se evalúan cuando el ILIKE exacto NO
				// encontró nada - eso sí se mantiene igual que siempre (barato, cubre la mayoría de
				// los casos ya verificados en la batería de regresión de Fase MCP-4.5).
				//
				// FASE MCP-4.6 (15 sep 2026) - bug real encontrado por el usuario probando una
				// empresa de prueba cargada SOLO con categorías de la taxonomía nueva (sin ningún
				// servicio del catálogo viejo, vía el buscador de autocarga del panel, Fase 4): esa
				// empresa NUNCA podía aparecer en CIRA, para NINGUNA búsqueda, mientras el catálogo
				// VIEJO tuviera aunque sea una coincidencia floja en OTRA empresa cualquiera del
				// directorio - porque antes la taxonomía (`empresa_taxonomy_category`) solo se
				// consultaba como nivel 3, y el nivel 2 (difuso) cortaba la cascada apenas
				// encontraba algo, sin importar qué tan bueno fuera ese algo. Con 406 empresas reales,
				// el nivel difuso casi siempre encuentra ALGO para cualquier término de varias
				// letras - la taxonomía nueva quedaba efectivamente inalcanzable desde CIRA pese a
				// tener datos reales (las 756 filas de Fase 3 + lo que cargue Fase 4). Fix: la
				// taxonomía (léxico completo + semántico) se resuelve en PARALELO al nivel difuso,
				// no después - se devuelven las empresas de AMBAS fuentes juntas, nunca se deja que
				// el catálogo viejo silencie a la taxonomía nueva.
				if (query || sector || ciudad) {
					// Cada promesa se declara ANTES de esperar ninguna (no todas juntas dentro de un
					// solo array literal de `Promise.all`) - encontrado necesario acá: TypeScript
					// perdía el tipo de fila real de `sql` cuando la query iba como elemento de un
					// array mixto con otras promesas, dejando `fuzzyRows`/`taxonomyRows` sin `.id` ni
					// el resto de columnas al compilar. Declarar cada una por separado y esperarlas
					// juntas con `Promise.all` da la misma concurrencia real sin ese problema de tipos.
					const fuzzyRowsPromise = sql<EmpresaSearchRow[]>`
						${empresaSelectAndJoins(sql)}
						where ${buildConditions(true)}
						order by e.name
						limit ${max}
					`;
					const lexicalTaxonomyPromise: Promise<LexicalTaxonomyMatch[]> = query
						? resolveLexicalTaxonomyMatches(sql, query)
						: Promise.resolve([]);
					const semanticResolvedPromise: Promise<ResolvedConcept[]> = query
						? (() => {
								const servicePhrases = extractCandidatePhrases(query);
								// Fase MCP-6 (16 sep 2026): si `resolve_search_intent` ya interpretó la frase (una
								// necesidad compuesta única, o varios conceptos independientes reales), esas frases
								// reemplazan la descomposición mecánica SOLO para taxonomía/experiencia - es
								// exactamente donde se diagnosticó el ruido de Fase MCP-5.5 ("perforación" suelta
								// compitiendo con "tratamiento aguas"). El catálogo de SERVICIOS (112 frases cortas)
								// NO se toca acá a propósito: sigue con su propia descomposición de siempre, porque
								// embeber una frase larga completa como un solo vector es justo el "bug de dilución
								// semántica" ya documentado más arriba para ese catálogo en particular - resolvedPhrases
								// no está probado como seguro ahí todavía.
								const taxonomyPhrases =
									resolvedPhrases && resolvedPhrases.length > 0 ? resolvedPhrases : extractCandidatePhrasesForTaxonomy(query);
								// Fase MCP-5.3: mismas frases candidatas que la taxonomía (misma lógica de
								// descomposición aplica - la descomposición es una propiedad de la CONSULTA del
								// usuario, no del catálogo contra el que se compara).
								return servicePhrases.length > 0 || taxonomyPhrases.length > 0
									? resolveSemanticConcepts(
										sql,
										env,
										servicePhrases,
										taxonomyPhrases,
										taxonomyPhrases,
										SEMANTIC_DISTANCE_THRESHOLD,
										EXPERIENCIA_SEMANTIC_DISTANCE_THRESHOLD
									)
									: Promise.resolve([]);
							})()
						: Promise.resolve([]);
					// FASE MCP-5 (16 sep 2026, ver docs/taxonomia/plan_mcp_cira.md): certificaciones
					// (Gestión), áreas de sostenibilidad y experiencias de proyectos - 3 fuentes reales que
					// hasta hoy CIRA no consultaba en absoluto (viven en MySQL, nunca se replicaron a
					// pgsql). Mismo criterio arquitectónico que la taxonomía en Fase MCP-4.6: se resuelven
					// en PARALELO, nunca detrás del catálogo viejo.
					const certificationColumn = query ? detectCertificationColumn(query) : null;
					const certificationRowsPromise: Promise<EmpresaSearchRow[]> = query
						? sql<EmpresaSearchRow[]>`
							${empresaSelectAndJoins(sql)}
							where e.status_id = 1
								and exists (
									select 1 from empresa_certifications ec
									where ec.empresa_id = e.id
										and (
											${certificationFlagCondition(sql, certificationColumn)}
											or unaccent(coalesce(ec.otras_certificaciones, '')) ilike unaccent(${'%' + query + '%'})
										)
								)
							order by e.name
							limit ${max}
						`
						: Promise.resolve([]);
					const lexicalSustainabilityPromise: Promise<LexicalSustainabilityMatch[]> = query
						? resolveLexicalSustainabilityAreas(sql, query)
						: Promise.resolve([]);
					const lexicalExperienciaPromise: Promise<LexicalExperienciaMatch[]> = query
						? resolveLexicalExperiencias(sql, query)
						: Promise.resolve([]);
					// FASE MCP-4.7 (15 sep 2026) - bug real: "Vincler" (typo de "VINCCLER", la empresa
					// real) sin sufijo legal ni frase de "dame información sobre..." hace que el
					// clasificador de intención de CIRA lo mande a `search_empresas` en vez de
					// `get_empresa` (que SÍ tiene esta misma tolerancia a tipeos, pero contra el
					// nombre - ver esa tool más abajo). Sin este nivel acá, `search_empresas` NUNCA
					// intenta de nuevo por nombre con tipos si el ILIKE exacto falla (el difuso de
					// arriba compara solo servicio/sector, nunca `e.name` - a propósito, ver docblock
					// del archivo) y termina devolviendo ruido semántico sin relación real (verificado
					// en vivo: "vincler" resolvía a "TORNILLERÍA" por pura coincidencia de embedding,
					// 4 empresas ajenas).
					//
					// UMBRAL 0.7 (no el 0.5 de `get_empresa`) + longitud mínima 5 - encontrado en vivo
					// que 0.5 (el de `get_empresa`) es SEGURO ahí porque esa tool ya asume una
					// intención de "buscar ESTA empresa puntual", pero acá en `search_empresas` (que
					// recibe términos de negocio genéricos todo el tiempo) 0.5 reintroduce EXACTAMENTE
					// la colisión ya documentada arriba: "grua" (hueco real del catálogo, nunca debe
					// dar respuesta) dio 0.6 de similitud contra CUALQUIER nombre con "GRUPO" ("GRUPO
					// PROMARGON", "GRUPO SISEVENCA", etc. - 8 empresas ajenas, regresión real
					// encontrada probando este mismo fix). "vincler"~"VINCCLER" da 0.70, sin ningún
					// competidor cercano (el siguiente candidato real queda en 0.25) - 0.65 separa
					// limpio los 2 casos verificados. Nota: "vincler"~"VINCCLER" da EXACTAMENTE 0.7 -
					// probado en vivo con el umbral en 0.7 y `>` estricto, quedó afuera por ese
					// límite exacto (bug real de este mismo fix, encontrado antes de darlo por
					// terminado) - 0.65 deja margen real en vez de depender de un límite exacto. La
					// longitud mínima 5 es una segunda barrera barata contra palabras cortas tipo
					// "grua" (4 letras), independiente del score.
					// FASE MCP-4.10 (16 sep 2026) - bug real: "represas" (sin coincidencia real en el
					// catálogo - ni servicio, ni sector, ni categoría CPV para construcción/mantenimiento
					// de represas) activaba igual este nivel y devolvía 6 empresas cuyo nombre empieza con
					// "REPRESENTACIONES..." - la misma familia de colisión que "grua"~"GRUPO" (documentada
					// arriba), pero esta vez el umbral 0.65 no alcanzaba a separarla porque "represa" y
					// "representaciones" comparten un prefijo de 6 letras.
					//
					// FASE MCP-5.4 (16 sep 2026) - EL FIX DE ARRIBA (gatear por `queryIntent`) VOLVIÓ A
					// FALLAR EN VIVO: "represas" volvió a devolver "REPRESENTACIONES..." - encontrado por
					// el usuario, que señaló correctamente la causa de fondo: `queryIntent` lo calcula el
					// mismo clasificador de intención cuya NO-determinismo ya está documentado (Fase
					// MCP-4.8) - la MISMA palabra puede llegar clasificada distinto en llamadas distintas,
					// así que gatear la seguridad de este nivel en esa clasificación es, en el mejor caso,
					// una reducción de probabilidad, no una garantía. El usuario lo planteó como principio
					// general, no solo para "represas": CIRA tiene que actuar sobre la INTENCIÓN real del
					// texto (¿esto describe una capacidad/experiencia de negocio - pozos, taladros, obras,
					// camiones, transporte, represas, lo que sea -, o esto describe el nombre propio de UNA
					// empresa puntual?), no lanzar el mismo tipo de comparación de texto para cualquier
					// palabra y confiar en que un clasificador externo la etiquete bien cada vez.
					//
					// FIX DE FONDO (no otro parche reactivo): este nivel deja de ser un filtro en PARALELO
					// sin condiciones - pasa a ser el ÚLTIMO recurso de TODOS, evaluado solo si NINGÚN otro
					// nivel (difuso, certificación, sostenibilidad, taxonomía, experiencia) encontró YA una
					// coincidencia de concepto real (ver `hasConceptMatch` más abajo, después del
					// `Promise.all`). Esto no depende de que ningún clasificador externo etiquete bien la
					// intención: es evidencia objetiva, calculada acá mismo, sobre si la palabra YA
					// resolvió a algo real como concepto de negocio. Para "represas" en particular: el
					// nivel de experiencias (Fase MCP-5.3) SÍ encuentra proyectos reales que mencionan
					// "represa" en su descripción (ver Fase MCP-5, "Montaje de los Empotrados de las Rejas
					// de Tomas...") - esa coincidencia real ahora suprime este nivel automáticamente, sin
					// necesitar saber de antemano que "represas" es un concepto y no un nombre. Generaliza
					// sin cambios a "pozos"/"taladros"/"camiones"/"transporte"/etc.: cualquier término que
					// ya tenga cobertura real en servicios/taxonomía/experiencia queda protegido igual,
					// automáticamente, sin necesitar una lista de palabras a mano por caso.
					// `queryIntent` NO se descarta - sigue siendo una señal adicional válida (si el
					// clasificador SÍ identificó SECTOR/SERVICE/CITY, es una razón más para no tratarlo
					// como nombre propio), pero ya no es la ÚNICA barrera.
					const NAME_TYPO_THRESHOLD = 0.65;
					const queryIntentSaysBusinessTerm = queryIntent === 'SECTOR' || queryIntent === 'SERVICE' || queryIntent === 'CITY';
					const nameTypoRowsPromise: Promise<EmpresaSearchRow[]> = query && query.length >= 5
						? sql<EmpresaSearchRow[]>`
							${empresaSelectAndJoins(sql)}
							where e.status_id = 1 and word_similarity(unaccent(${query}), unaccent(e.name)) > ${NAME_TYPO_THRESHOLD}
							order by e.name
							limit ${max}
						`
						: Promise.resolve([]);

					const [fuzzyRows, lexicalTaxonomy, semanticResolved, nameTypoRows, certificationRows, lexicalSustainability, lexicalExperiencia] =
						await Promise.all([
							fuzzyRowsPromise,
							lexicalTaxonomyPromise,
							semanticResolvedPromise,
							nameTypoRowsPromise,
							certificationRowsPromise,
							lexicalSustainabilityPromise,
							lexicalExperienciaPromise,
						]);

					const semanticTaxonomy = semanticResolved.filter((r) => r.source === 'taxonomy');
					const taxonomyIds = Array.from(new Set([...lexicalTaxonomy.map((r) => r.id), ...semanticTaxonomy.map((r) => r.id)]));

					const taxonomyRows =
						taxonomyIds.length > 0
							? await sql<EmpresaSearchRow[]>`
								${empresaSelectAndJoins(sql)}
								where e.status_id = 1
									and exists (select 1 from empresa_taxonomy_category etc where etc.empresa_id = e.id and etc.category_id in ${sql(taxonomyIds)})
								order by e.name
								limit ${max}
							`
							: ([] as EmpresaSearchRow[]);

					const sustainabilityAreaIds = Array.from(new Set(lexicalSustainability.map((r) => r.area_id)));
					const sustainabilityRows =
						sustainabilityAreaIds.length > 0
							? await sql<EmpresaSearchRow[]>`
								${empresaSelectAndJoins(sql)}
								where e.status_id = 1
									and exists (select 1 from empresa_sustainability_areas esa where esa.empresa_id = e.id and esa.area_id in ${sql(sustainabilityAreaIds)})
								order by e.name
								limit ${max}
							`
							: ([] as EmpresaSearchRow[]);

					const semanticExperiencia = semanticResolved.filter((r) => r.source === 'experiencia');
					const experienciaIds = Array.from(new Set([...lexicalExperiencia.map((r) => r.id), ...semanticExperiencia.map((r) => r.id)]));
					const experienciaRows =
						experienciaIds.length > 0
							? await sql<EmpresaSearchRow[]>`
								${empresaSelectAndJoins(sql)}
								where e.status_id = 1
									and exists (select 1 from empresa_experiencias ee where ee.empresa_id = e.id and ee.id in ${sql(experienciaIds)})
								order by e.name
								limit ${max}
							`
							: ([] as EmpresaSearchRow[]);

					// FASE MCP-5.4 - ver docblock largo más arriba (junto a `nameTypoRowsPromise`): el
					// nivel de tipeo de nombre pasa a ser el ÚLTIMO recurso de TODOS, no un filtro en
					// paralelo sin condiciones. Si CUALQUIER otro nivel ya resolvió esta consulta como un
					// concepto de negocio real (servicio, certificación, sostenibilidad, taxonomía o
					// experiencia), la palabra NO se trata como intento de nombre propio - sin importar el
					// score de similitud de texto contra `e.name`. Objetivo, no depende de que ningún
					// clasificador externo haya etiquetado bien la intención.
					const hasConceptMatch =
						fuzzyRows.length > 0 ||
						taxonomyRows.length > 0 ||
						certificationRows.length > 0 ||
						sustainabilityRows.length > 0 ||
						experienciaRows.length > 0;
					const effectiveNameTypoRows = hasConceptMatch || queryIntentSaysBusinessTerm ? [] : nameTypoRows;

					if (effectiveNameTypoRows.length > 0 || hasConceptMatch) {
						const nameTypoMatchedVia = `similar a "${query}" (nombre de empresa, posible diferencia de tipeo)`;
						const fuzzyMatchedVia = describeMatch('fuzzy');
						const certificationMatchedVia = certificationColumn
							? `coincide con la certificación ${certificationColumn.toUpperCase()}`
							: `coincide con "${query}" (otras certificaciones)`;
						const lexicalByCategoryId = new Map(lexicalTaxonomy.map((r) => [r.id, r]));
						const semanticByCategoryId = new Map(semanticTaxonomy.map((r) => [r.id, r]));
						const sustainabilityAreaById = new Map(lexicalSustainability.map((r) => [r.area_id, r]));
						const lexicalExperienciaById = new Map(lexicalExperiencia.map((r) => [r.id, r]));
						const semanticExperienciaById = new Map(semanticExperiencia.map((r) => [r.id, r]));

						// Igual que en el nivel semántico de más abajo: acotado a los pocos ids
						// resueltos, no a todo el directorio.
						const taxonomyLinks =
							taxonomyIds.length > 0
								? await sql<{ empresa_id: number; category_id: number }[]>`
									select empresa_id, category_id from empresa_taxonomy_category where category_id in ${sql(taxonomyIds)}
								`
								: [];
						const sustainabilityLinks =
							sustainabilityAreaIds.length > 0
								? await sql<{ empresa_id: number; area_id: number }[]>`
									select empresa_id, area_id from empresa_sustainability_areas where area_id in ${sql(sustainabilityAreaIds)}
								`
								: [];
						const experienciaLinks =
							experienciaIds.length > 0
								? await sql<{ empresa_id: number; id: number }[]>`
									select empresa_id, id from empresa_experiencias where id in ${sql(experienciaIds)}
								`
								: [];

						// FASE MCP-5.5 (16 sep 2026) - bug real reportado por el usuario: "tratamiento de aguas
						// de perforacion" mostraba primero empresas que SOLO hacen "Equipos de Perforación"
						// (sin ninguna relación con tratamiento de agua) por encima de las pocas empresas que
						// SÍ hacen exactamente lo pedido (ej. "PROYECTO DE EXPANSION SISTEMA DE TRATAMIENTO DE
						// AGUA EN PLANTA DESHIDRATADORA"). Causa raíz señalada por el usuario: la descomposición
						// en palabras sueltas ("perforacion", "tratamiento", "aguas") hace que una coincidencia
						// GENÉRICA de una sola palabra ("perforacion" a secas) compita en igualdad de
						// condiciones con una coincidencia ESPECÍFICA de la frase compuesta completa
						// ("tratamiento aguas perforacion") - el orden de prioridad por NIVEL (taxonomía antes
						// que experiencia) no tiene ninguna relación con qué tan específico es el match real.
						// Fix: cada coincidencia de taxonomía/experiencia ahora carga su propia
						// `specificity` (cantidad de palabras significativas de la frase que la encontró - 1
						// para "perforacion", 3 para "tratamiento aguas perforacion") y el merge final se
						// ordena por especificidad ANTES que por nivel/fuente - una coincidencia por la frase
						// compuesta completa siempre gana, sin importar de qué nivel venga. Los niveles que
						// SIEMPRE comparan contra el `query` completo (difuso/certificación/sostenibilidad/
						// tipeo de nombre) usan la especificidad del `query` completo como línea base - ya son
						// al menos tan específicos como cualquier fragmento descompuesto.
						//
						// Esto no es entendimiento de intención real (eso queda pendiente como fase aparte,
						// ver "Fase MCP-5.5" en plan_mcp_cira.md) - es un desempate determinista que evita que
						// el ruido de una palabra genérica opaque a la coincidencia específica cuando AMBAS
						// existen, sin agregar ninguna llamada nueva de IA ni otra fuente de variabilidad.
						const baseQuerySpecificity = query ? Math.max(phraseSpecificity(query), 1) : 1;

						function taxonomyMatchFor(empresaId: string): { text: string; specificity: number } {
							const categoryIds = taxonomyLinks.filter((l) => String(l.empresa_id) === empresaId).map((l) => l.category_id);
							let best: { text: string; specificity: number } | null = null;
							for (const id of categoryIds) {
								const lex = lexicalByCategoryId.get(id);
								if (lex) {
									const specificity = baseQuerySpecificity;
									if (!best || specificity > best.specificity) {
										best = { text: `coincide con "${query}" (categoría CPV: ${lex.name})`, specificity };
									}
								}
								const sem = semanticByCategoryId.get(id);
								if (sem) {
									const specificity = phraseSpecificity(sem.phrase);
									if (!best || specificity > best.specificity) {
										best = { text: `similar a "${sem.phrase}" (categoría CPV: ${sem.name})`, specificity };
									}
								}
							}
							return best ?? { text: 'coincide con la taxonomía CPV', specificity: 0 };
						}

						function sustainabilityMatchedViaFor(empresaId: string): string {
							const areaIds = sustainabilityLinks.filter((l) => String(l.empresa_id) === empresaId).map((l) => l.area_id);
							for (const id of areaIds) {
								const area = sustainabilityAreaById.get(id);
								if (area) return `coincide con "${query}" (área de sostenibilidad: ${area.name})`;
							}
							return 'coincide con un área de sostenibilidad';
						}

						function experienciaMatchFor(empresaId: string): { text: string; specificity: number } {
							const ids = experienciaLinks.filter((l) => String(l.empresa_id) === empresaId).map((l) => l.id);
							let best: { text: string; specificity: number } | null = null;
							for (const id of ids) {
								const lex = lexicalExperienciaById.get(id);
								if (lex) {
									const specificity = baseQuerySpecificity;
									if (!best || specificity > best.specificity) {
										best = { text: `coincide con "${query}" (experiencia: ${truncateText(lex.descripcion)})`, specificity };
									}
								}
								const sem = semanticExperienciaById.get(id);
								if (sem) {
									const specificity = phraseSpecificity(sem.phrase);
									if (!best || specificity > best.specificity) {
										best = { text: `similar a "${sem.phrase}" (experiencia: ${truncateText(sem.name)})`, specificity };
									}
								}
							}
							return best ?? { text: 'coincide con un proyecto ejecutado', specificity: 0 };
						}

						type TaggedRow = EmpresaSearchRow & {
							match_type: 'fuzzy' | 'certification' | 'sustainability' | 'taxonomy' | 'experiencia';
							matched_via: string;
						};
						type Candidate = { row: TaggedRow; specificity: number; tierRank: number };

						const candidates: Candidate[] = [
							...effectiveNameTypoRows.map(
								(r): Candidate => ({
									row: { ...r, match_type: 'fuzzy', matched_via: nameTypoMatchedVia },
									specificity: baseQuerySpecificity,
									tierRank: 0,
								})
							),
							...fuzzyRows.map(
								(r): Candidate => ({
									row: { ...r, match_type: 'fuzzy', matched_via: fuzzyMatchedVia },
									specificity: baseQuerySpecificity,
									tierRank: 1,
								})
							),
							...certificationRows.map(
								(r): Candidate => ({
									row: { ...r, match_type: 'certification', matched_via: certificationMatchedVia },
									specificity: baseQuerySpecificity,
									tierRank: 2,
								})
							),
							...sustainabilityRows.map((r): Candidate => {
								const text = sustainabilityMatchedViaFor(String(r.id));
								return { row: { ...r, match_type: 'sustainability', matched_via: text }, specificity: baseQuerySpecificity, tierRank: 3 };
							}),
							...taxonomyRows.map((r): Candidate => {
								const { text, specificity } = taxonomyMatchFor(String(r.id));
								return { row: { ...r, match_type: 'taxonomy', matched_via: text }, specificity, tierRank: 4 };
							}),
							...experienciaRows.map((r): Candidate => {
								const { text, specificity } = experienciaMatchFor(String(r.id));
								return { row: { ...r, match_type: 'experiencia', matched_via: text }, specificity, tierRank: 5 };
							}),
						];

						// Una sola fila por empresa: entre todas las coincidencias de esa empresa (sin
						// importar de qué nivel vengan), gana la más ESPECÍFICA; a igual especificidad, gana
						// el nivel de mayor confianza (mismo orden que antes: nombre > catálogo viejo >
						// certificación/sostenibilidad > taxonomía > experiencia).
						const bestByEmpresaId = new Map<number, Candidate>();
						for (const c of candidates) {
							const existing = bestByEmpresaId.get(c.row.id);
							if (!existing || c.specificity > existing.specificity || (c.specificity === existing.specificity && c.tierRank < existing.tierRank)) {
								bestByEmpresaId.set(c.row.id, c);
							}
						}

						const merged = Array.from(bestByEmpresaId.values())
							.sort((a, b) => b.specificity - a.specificity || a.tierRank - b.tierRank)
							.map((c) => c.row);

						if (merged.length > 0) {
							return { content: [{ type: 'text' as const, text: JSON.stringify(merged, null, 2) }] };
						}
					}

					// Último recurso: semántico por SERVICIO viejo únicamente (la taxonomía ya se
					// evaluó arriba y no encontró nada) - mismo criterio que ya existía, sin cambios
					// de comportamiento para este caso (ej. "necesito quien me suelde tuberias").
					if (query) {
						const serviceIds = semanticResolved.filter((r) => r.source === 'service').map((r) => r.id);

						if (serviceIds.length > 0) {
							const semanticRows = await sql`
								${empresaSelectAndJoins(sql)}
								where e.status_id = 1
									and exists (select 1 from empresa_sector_service ess where ess.empresa_id = e.id and ess.service_id in ${sql(serviceIds)})
								order by e.name
								limit ${max}
							`;

							if (semanticRows.length > 0) {
								const bestByServiceId = new Map(semanticResolved.filter((r) => r.source === 'service').map((r) => [r.id, r]));
								const serviceLinks = await sql<{ empresa_id: number; service_id: number }[]>`
									select empresa_id, service_id from empresa_sector_service where service_id in ${sql(serviceIds)}
								`;

								function serviceMatchedViaFor(empresaId: string): string {
									let best: ResolvedConcept | null = null;
									for (const link of serviceLinks) {
										if (String(link.empresa_id) !== empresaId) continue;
										const r = bestByServiceId.get(link.service_id);
										if (r && (!best || r.distance < best.distance)) best = r;
									}
									if (!best) return 'similar por servicio relacionado';
									return `similar a "${best.phrase}" (servicio: ${best.name})`;
								}

								const tagged = semanticRows.map((r) => ({
									...r,
									match_type: 'semantic' as const,
									matched_via: serviceMatchedViaFor(String(r.id)),
								}));
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
