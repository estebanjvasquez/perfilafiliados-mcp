import postgres from 'postgres';
import type { Env } from './index';

/**
 * Un cliente de postgres.js por request (no un singleton global de modulo) - `env` en Workers es
 * por-request, y Hyperdrive ya poolea las conexiones reales del lado de Cloudflare, asi que crear
 * uno nuevo acá es barato y es el patron recomendado (no hay conexion TCP persistente que
 * mantener viva entre invocaciones del Worker).
 */
export function getSql(env: Env) {
	return postgres(env.HYPERDRIVE.connectionString, {
		// Hyperdrive ya hace su propio pooling - postgres.js no necesita mantener muchas conexiones
		// propias por invocacion, y el pooler de Supabase (modo sesion) no siempre soporta bien
		// muchas prepared statements simultaneas desde el edge.
		max: 5,
		fetch_types: false,
	});
}
