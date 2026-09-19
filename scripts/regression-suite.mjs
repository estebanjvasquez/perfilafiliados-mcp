#!/usr/bin/env node
/**
 * Fase 24 (docs/taxonomia en PerfilAfiliadosCPV, Fase 7 del pedido - "regression strategy"):
 * batería reusable contra `/debug-search` para comparar CURRENT vs NEW antes de aceptar cualquier
 * cambio a `canonical-expansion.ts`/`hybrid-search.ts`/`debug-search.ts`. Los términos de prueba
 * viven en `fixtures/regression-cases.json` (datos), nunca en este archivo (lógica).
 *
 * Uso:
 *   node scripts/regression-suite.mjs --url <base> --token <debug_token> --save baseline.json
 *   node scripts/regression-suite.mjs --url <base> --token <debug_token> --compare baseline.json
 *
 * No requiere ningún test runner nuevo (este repo no tenía ninguno antes de esta fase) - un script
 * plano es suficiente para lo que hace falta: correr N queries y diffear una foto estructural.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'regression-cases.json'), 'utf8'));

function parseArgs(argv) {
	const args = { url: null, token: null, save: null, compare: null };
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--url') args.url = argv[++i];
		else if (argv[i] === '--token') args.token = argv[++i];
		else if (argv[i] === '--save') args.save = argv[++i];
		else if (argv[i] === '--compare') args.compare = argv[++i];
	}
	return args;
}

async function runQuery(baseUrl, token, query) {
	const res = await fetch(`${baseUrl}/debug-search`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
		body: JSON.stringify({ query }),
	});
	if (!res.ok) return { query, error: `HTTP ${res.status}` };
	const j = await res.json();
	return {
		query,
		candidates_after_dedup: j.candidate_generation?.candidates_after_dedup ?? null,
		direct_company_count: j.direct_company_count ?? null,
		detected_intent: j.query_understanding?.detected_intent ?? null,
		regional_terms: j.query_understanding?.regional_terms ?? [],
		canonical_concepts: j.query_understanding?.canonical_concepts ?? [],
		cpv_relations: (j.cpv_relations ?? []).map((r) => r.cpv_code).sort(),
		diagnostic_flags: (j.diagnostic_flags ?? []).slice().sort(),
		// top-5 empresa_ids en orden - lo que de verdad importa para "no regresionó el ranking",
		// no el score exacto (que puede moverse por redondeo sin ser una regresión real).
		top_empresa_ids: (j.candidates ?? []).slice(0, 5).map((c) => c.empresa_id),
		top_evidence_strengths: (j.candidates ?? []).slice(0, 5).map((c) => c.evidence_strength),
	};
}

function diffSnapshot(before, after) {
	const changes = [];
	const fields = [
		'candidates_after_dedup',
		'direct_company_count',
		'detected_intent',
		'regional_terms',
		'canonical_concepts',
		'cpv_relations',
		'diagnostic_flags',
		'top_empresa_ids',
		'top_evidence_strengths',
	];
	for (const f of fields) {
		const b = JSON.stringify(before?.[f]);
		const a = JSON.stringify(after?.[f]);
		if (b !== a) changes.push({ field: f, before: before?.[f], after: after?.[f] });
	}
	return changes;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (!args.url || !args.token) {
		console.error('Uso: node regression-suite.mjs --url <base> --token <debug_token> [--save out.json | --compare baseline.json]');
		process.exit(1);
	}

	const allQueries = Object.values(fixtures.groups).flat();
	const results = {};
	for (const [group, queries] of Object.entries(fixtures.groups)) {
		for (const query of queries) {
			results[query] = { group, ...(await runQuery(args.url, args.token, query)) };
		}
	}

	if (args.save) {
		writeFileSync(args.save, JSON.stringify(results, null, 2));
		console.log(`Guardado snapshot de ${allQueries.length} queries en ${args.save}`);
		return;
	}

	if (args.compare) {
		const baseline = JSON.parse(readFileSync(args.compare, 'utf8'));
		let anyChange = false;
		for (const query of allQueries) {
			const changes = diffSnapshot(baseline[query], results[query]);
			if (changes.length > 0) {
				anyChange = true;
				console.log(`\n[${results[query].group}] "${query}" cambió:`);
				for (const c of changes) {
					console.log(`  ${c.field}: ${JSON.stringify(c.before)} -> ${JSON.stringify(c.after)}`);
				}
			}
		}
		if (!anyChange) console.log('Sin cambios en ninguna de las', allQueries.length, 'queries del fixture.');
		return;
	}

	console.log(JSON.stringify(results, null, 2));
}

main();
