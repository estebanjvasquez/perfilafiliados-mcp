import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { Env } from './index';

/**
 * Fase MCP-6 (ver docs/taxonomia/plan_mcp_cira.md de PerfilAfiliadosCPV, sección "Fase MCP-6 -
 * diseño: entendimiento real de intención"): tool AISLADA, llamada desde n8n ANTES de
 * `search_empresas`, que reemplaza la descomposición mecánica de la frase (palabras sueltas +
 * bigramas, ver empresa-tools.ts) por una interpretación real hecha por un modelo de IA, pensando
 * como lo haría un especialista de la industria petrolera venezolana, no un contador de palabras.
 *
 * Decisión de diseño (tomada con el usuario, 16 sep 2026): tool separada de `search_empresas` a
 * propósito - aísla el riesgo de esta pieza nueva (y su nueva fuente de no-determinismo, ya
 * documentada en Fase MCP-4.8/5.4 para el clasificador de n8n) del motor de búsqueda ya cargado y
 * probado. Se puede desplegar, probar y hacer rollback sin tocar `search_empresas` ni el workflow
 * de n8n.
 *
 * Reusa el mismo modelo que ya usa el nodo "OpenAI Chat Model" de n8n (`gpt-5.6-luna`, vía la
 * credencial "OpenAI CIRA - API", endpoint estándar `api.openai.com` - confirmado con el usuario).
 * Mismo gotcha ya sufrido en producción con ese modelo (Fase MCP-4.8): NO acepta el parámetro
 * `temperature` - un incidente real de esta sesión hizo caer el 100% de los chats de CIRA por ~2
 * minutos al mandarlo. Por eso acá tampoco se manda.
 *
 * Resiliencia (principio explícito del usuario para esta fase): si la llamada de IA falla, tarda
 * demasiado, o devuelve algo que no se puede interpretar, NUNCA bloquear la búsqueda - se devuelve
 * un resultado de fallback equivalente al comportamiento actual (Fase MCP-5.5: la frase completa
 * sin descomponer, dejando que `search_empresas` haga su propia descomposición mecánica interna
 * como hace hoy). Disponibilidad por encima de precisión de intención.
 */

const OPENAI_CHAT_MODEL = 'gpt-5.6-luna';
const OPENAI_TIMEOUT_MS = 8000;

const SYSTEM_PROMPT = `Eres un especialista de la Cámara Petrolera de Venezuela (CPV) que conoce a fondo qué servicios prestan las empresas afiliadas a la industria petrolera y energética venezolana (pozos, taladros, perforación, mantenimiento, construcción, transporte, logística, certificaciones, sostenibilidad, experiencia en proyectos, etc.).

IMPORTANTE: CIRA es un buscador de EMPRESAS AFILIADAS, nunca una fuente de información general. El usuario SIEMPRE está buscando una o más empresas que presten un servicio, tengan una certificación, o tengan experiencia relacionada con lo que describe - nunca interpretes la consulta como un pedido de información general sobre un tema. Por ejemplo, "represas" significa "empresas que trabajan en/con represas (construcción, mantenimiento, diseño)" - la lectura "información sobre una represa en particular" NO es una opción válida y nunca debe usarse como excusa para "ambiguous": ese término, igual que "pozos", "taladros", "camiones" o "transporte", tiene una sola lectura de negocio razonable y se busca directo.

Tu tarea: interpretar una frase de búsqueda de un usuario como lo haría un experto del rubro que escucha la pregunta - NO como un algoritmo que cuenta o rompe palabras. Clasificá la frase en EXACTAMENTE una de estas 3 categorías:

- "single_compound": la frase describe UNA necesidad específica, aunque tenga varias palabras. Ejemplos: "quien suelde tuberías" (un servicio: soldadura de tuberías), "tratamiento de aguas de perforación" (un servicio específico de tratamiento de agua), "mantenimiento de taladros", "represas", "camiones". NO la rompas en piezas sueltas - "search_phrases" debe traer la frase compuesta completa (podés limpiarla/normalizarla, pero sin fragmentarla en conceptos que pierdan el sentido compuesto).
- "multi_concept": la frase pide MÁS DE UNA necesidad genuinamente independiente, donde ninguna depende de la otra. Ejemplo: "necesito transporte y también alquiler de grúas" (dos servicios distintos). "search_phrases" trae cada concepto como una frase separada.
- "ambiguous": reservalo SOLO para cuando una lectura razonable cae CLARAMENTE FUERA del sector petrolero/energético venezolano y otra lectura razonable cae CLARAMENTE DENTRO, de forma que buscar con la lectura equivocada devolvería resultados irrelevantes o vacíos. Ejemplo real: "soldar tuberías de plástico para agua potable" podría ser parte de construir un campamento petrolero (dentro del sector) o plomería doméstica general fuera de la industria (fuera). Acá "search_phrases" va vacío y "clarification_question" trae UNA pregunta corta y concreta en español para aclarar antes de buscar.

Un matiz DENTRO de la misma industria (ej. "camiones" podría ser venta/alquiler de camiones o servicio de transporte en camiones - ambas lecturas siguen dentro del mismo rubro logístico/industrial) NO es un caso de "ambiguous" - elegí la lectura más natural (o "multi_concept" si de verdad aplican las dos a la vez) y buscá directo. "ambiguous" es un recurso raro, reservado para el riesgo real de cruzar la frontera entre "es de esta industria" y "no lo es" - no para cualquier matiz posible. CIRA debe sentirse como un especialista consultado, no como un interrogatorio.

Respondé ÚNICAMENTE con un objeto JSON, sin texto adicional antes ni después, con esta forma exacta:
{"interpretation": "single_compound" | "multi_concept" | "ambiguous", "search_phrases": string[], "clarification_question": string | null, "reasoning": string}

"search_phrases" va [] si interpretation es "ambiguous". "clarification_question" va null si interpretation NO es "ambiguous". "reasoning" es una frase corta en español explicando el porqué (uso interno, no se le muestra al usuario).`;

type IntentInterpretation = 'single_compound' | 'multi_concept' | 'ambiguous';

type ResolvedIntent = {
	interpretation: IntentInterpretation;
	search_phrases: string[];
	clarification_question: string | null;
	reasoning: string;
};

function fallbackIntent(query: string, reasoning: string): ResolvedIntent {
	return {
		interpretation: 'single_compound',
		search_phrases: [query],
		clarification_question: null,
		reasoning,
	};
}

/** Extrae el primer objeto JSON balanceado del texto - mismo tipo de tolerancia que ya hizo falta para `Parse Intent JSON3` en n8n (Fase MCP-4.x), por si el modelo agrega texto alrededor del JSON a pesar del prompt. */
function extractJsonObject(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		// sigue abajo
	}

	const start = text.indexOf('{');
	if (start === -1) throw new Error('no_json_found');

	let depth = 0;
	for (let i = start; i < text.length; i++) {
		if (text[i] === '{') depth++;
		if (text[i] === '}') depth--;
		if (depth === 0) {
			return JSON.parse(text.slice(start, i + 1));
		}
	}

	throw new Error('unbalanced_json');
}

function isValidResolvedIntent(value: unknown): value is ResolvedIntent {
	if (!value || typeof value !== 'object') return false;
	const v = value as Record<string, unknown>;

	if (!['single_compound', 'multi_concept', 'ambiguous'].includes(v.interpretation as string)) return false;
	if (!Array.isArray(v.search_phrases) || !v.search_phrases.every((p) => typeof p === 'string')) return false;
	if (v.clarification_question !== null && typeof v.clarification_question !== 'string') return false;

	return true;
}

async function callOpenAi(query: string, env: Env): Promise<ResolvedIntent> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

	try {
		const response = await fetch('https://api.openai.com/v1/chat/completions', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${env.OPENAI_API_KEY}`,
				'Content-Type': 'application/json',
			},
			// Sin "temperature" - gpt-5.6-luna no lo soporta (ver docblock de arriba, incidente real Fase MCP-4.8).
			body: JSON.stringify({
				model: OPENAI_CHAT_MODEL,
				response_format: { type: 'json_object' },
				messages: [
					{ role: 'system', content: SYSTEM_PROMPT },
					{ role: 'user', content: query },
				],
			}),
			signal: controller.signal,
		});

		if (!response.ok) {
			return fallbackIntent(query, `ai_call_failed_http_${response.status}`);
		}

		const body = (await response.json()) as any;
		const content = body?.choices?.[0]?.message?.content;

		if (typeof content !== 'string') {
			return fallbackIntent(query, 'ai_call_failed_no_content');
		}

		const parsed = extractJsonObject(content);

		if (!isValidResolvedIntent(parsed)) {
			return fallbackIntent(query, 'ai_call_failed_invalid_shape');
		}

		if (parsed.interpretation === 'ambiguous' && !parsed.clarification_question) {
			// Dijo "ambiguous" pero no trajo pregunta - no hay nada útil que devolver como aclaración,
			// se trata como fallback en vez de bloquear la búsqueda con una pregunta vacía.
			return fallbackIntent(query, 'ai_marked_ambiguous_without_question');
		}

		return parsed;
	} catch (err) {
		const reason = err instanceof Error && err.name === 'AbortError' ? 'ai_call_timeout' : 'ai_call_exception';
		return fallbackIntent(query, reason);
	} finally {
		clearTimeout(timeout);
	}
}

export function registerIntentTools(server: McpServer, env: Env): void {
	server.registerTool(
		'resolve_search_intent',
		{
			description:
				'Interpreta una frase de búsqueda ANTES de llamar a search_empresas, como lo haría un especialista de la ' +
				'industria petrolera venezolana, no un algoritmo de palabras sueltas. Devuelve si es una necesidad ' +
				'compuesta única (search_phrases con la frase completa, sin fragmentar), varias necesidades ' +
				'independientes (search_phrases con cada una por separado), o una intención ambigua que depende de ' +
				'contexto que no tenés (clarification_question con una pregunta corta para hacerle al usuario ANTES de ' +
				'buscar - en ese caso no llames a search_empresas todavía, respondé la pregunta directamente).',
			inputSchema: {
				query: z.string().min(2).describe('La frase de búsqueda tal como la escribió o la resumiste del usuario'),
			},
		},
		async ({ query }) => {
			const resolved = await callOpenAi(query, env);

			return {
				content: [{ type: 'text' as const, text: JSON.stringify(resolved) }],
			};
		}
	);
}
