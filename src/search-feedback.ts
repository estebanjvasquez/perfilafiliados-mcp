/**
 * TASK-0013 (PerfilAfiliadosCPV, Issue #2): registro de búsquedas de CIRA y votos 👍/👎.
 *
 * Tablas `cira_search_log` y `cira_search_feedback` (migración de PerfilAfiliadosCPV
 * `2026_11_06_120000_create_cira_search_log_and_feedback_tables`, aplicada el 2026-11-06).
 *
 * Por qué en el Worker: la credencial Postgres de n8n apunta a otra base; el Worker ya llega a la base
 * compartida por Hyperdrive. Ambas rutas exigen el mismo Bearer que `/mcp` (MCP_TOKEN), que solo
 * tiene n8n: el navegador nunca llama a estas rutas directamente.
 *
 * Los votos NO cambian el ranking: quedan para revisión.
 */
import { getSql } from './db';
import type { Env } from './index';

const REASONS = new Set(['otro_sector', 'solo_coincide_palabra', 'empresa_inactiva', 'falta_empresa', 'otro']);
const VOTER_KINDS = new Set(['staff', 'affiliate', 'anonymous', 'evaluator']);
const SOURCES = new Set(['n8n_chat', 'evaluation', 'debug', 'other']);

const bad = (error: string, status = 400) => Response.json({ ok: false, error }, { status });
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const intOrNull = (v: unknown): number | null => {
	if (v === null || v === undefined || v === '') return null;
	const n = Number(v);
	return Number.isInteger(n) && n > 0 ? n : NaN;
};

/** Error de base: devuelve solo el código SQLSTATE y el mensaje de Postgres (sin datos ni credenciales). */
function dbError(e: unknown): Response {
	const err = e as { code?: string; message?: string };
	return Response.json({ ok: false, error: 'db_error', code: err?.code ?? null, message: String(err?.message ?? e).slice(0, 300) }, { status: 500 });
}

function authorized(request: Request, env: Env): boolean {
	return (request.headers.get('Authorization') ?? '') === `Bearer ${env.MCP_TOKEN}`;
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
	try {
		const body = await request.json();
		return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** POST /search-log — una fila por búsqueda. Devuelve { ok, id }. */
export async function handleSearchLog(request: Request, env: Env): Promise<Response> {
	if (!authorized(request, env)) return bad('unauthorized', 401);
	const b = await readJson(request);
	if (!b) return bad('invalid_json');

	const userInput = str(b.user_input, 2000);
	if (!userInput) return bad('user_input requerido');
	const source = str(b.source, 20) ?? 'n8n_chat';
	if (!SOURCES.has(source)) return bad('source inválido');

	const ids = Array.isArray(b.result_empresa_ids) ? b.result_empresa_ids.map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 500) : [];
	// Literal de arreglo de Postgres: los ids ya son enteros validados, no hay nada que escapar.
	const idsLiteral = '{' + ids.join(',') + '}';
	const responseMs = b.response_ms == null ? null : Math.max(0, Math.round(Number(b.response_ms)) || 0);

	let evidence: string | null = null;
	if (b.result_evidence != null) {
		evidence = JSON.stringify(b.result_evidence);
		if (evidence.length > 200_000) evidence = JSON.stringify({ truncated: true });
	}
	let params: string | null = null;
	if (b.agent_params != null) {
		params = JSON.stringify(b.agent_params);
		if (params.length > 20_000) params = JSON.stringify({ truncated: true });
	}

	const sql = getSql(env);
	try {
		const [row] = await sql<{ id: string }[]>`
			insert into cira_search_log
				(source, session_ref, visitor_ref, n8n_execution_id, user_input, agent_tool, agent_params,
				 interpretation, result_count, result_empresa_ids, result_evidence, engine_version, response_ms, error)
			values
				(${source}, ${str(b.session_ref, 200)}, ${str(b.visitor_ref, 200)}, ${str(b.n8n_execution_id, 100)},
				 ${userInput}, ${str(b.agent_tool, 50)}, ${params}::jsonb, ${str(b.interpretation, 50)}, ${ids.length},
				 ${idsLiteral}::bigint[], ${evidence}::jsonb, ${str(b.engine_version, 200)}, ${responseMs}, ${str(b.error, 2000)})
			returning id
		`;
		return Response.json({ ok: true, id: Number(row.id) });
	} catch (e) {
		return dbError(e);
	} finally {
		await sql.end({ timeout: 1 });
	}
}

/**
 * POST /search-feedback — un voto. Si el mismo votante ya votó esa empresa (o el resultado completo)
 * en esa búsqueda, se reemplaza: el usuario puede cambiar de opinión. Devuelve { ok, id, updated }.
 *
 * Validaciones además de las de la base:
 *  - la búsqueda tiene que existir;
 *  - la empresa votada tiene que estar entre las que esa búsqueda devolvió;
 *  - la posición se toma del registro de la búsqueda, no del navegador.
 */
export async function handleSearchFeedback(request: Request, env: Env): Promise<Response> {
	if (!authorized(request, env)) return bad('unauthorized', 401);
	const b = await readJson(request);
	if (!b) return bad('invalid_json');

	const logId = intOrNull(b.search_log_id);
	if (!logId) return bad('search_log_id inválido');
	const empresaId = intOrNull(b.empresa_id);
	if (Number.isNaN(empresaId)) return bad('empresa_id inválido');
	const vote = Number(b.vote);
	if (vote !== 1 && vote !== -1) return bad('vote debe ser 1 o -1');
	const reason = str(b.reason, 40);
	if (reason && !REASONS.has(reason)) return bad('reason inválido');
	if (reason && vote !== -1) return bad('el motivo solo acompaña a un voto negativo');
	if (reason === 'falta_empresa' && empresaId) return bad('falta_empresa se registra sobre el resultado completo, sin empresa_id');
	const voterKind = str(b.voter_kind, 20) ?? 'anonymous';
	if (!VOTER_KINDS.has(voterKind)) return bad('voter_kind inválido');
	const voterRef = str(b.voter_ref, 100);
	if (!voterRef) return bad('voter_ref requerido');
	const comment = str(b.comment, 1000);

	const sql = getSql(env);
	try {
		// La posición la calcula Postgres: por Hyperdrive el arreglo puede llegar como texto.
		const [log] = await sql<{ pos: number | null }[]>`
			select array_position(result_empresa_ids, ${empresaId ?? 0}::bigint) as pos
			from cira_search_log where id = ${logId}
		`;
		if (!log) return bad('búsqueda no encontrada', 404);

		let rank: number | null = null;
		if (empresaId) {
			if (log.pos == null) return bad('la empresa no está en los resultados de esa búsqueda', 422);
			rank = Number(log.pos);
		}

		const [row] = await sql<{ id: string; inserted: boolean }[]>`
			insert into cira_search_feedback (search_log_id, empresa_id, rank_position, vote, reason, comment, voter_kind, voter_ref)
			values (${logId}, ${empresaId}, ${rank}, ${vote}, ${reason}, ${comment}, ${voterKind}, ${voterRef})
			on conflict (search_log_id, (coalesce(empresa_id, 0)), (coalesce(voter_ref, '')))
			do update set vote = excluded.vote, reason = excluded.reason, comment = excluded.comment,
				voter_kind = excluded.voter_kind, rank_position = excluded.rank_position, created_at = now()
			returning id, (xmax = 0) as inserted
		`;
		return Response.json({ ok: true, id: Number(row.id), updated: !row.inserted, rank_position: rank });
	} catch (e) {
		return dbError(e);
	} finally {
		await sql.end({ timeout: 1 });
	}
}
