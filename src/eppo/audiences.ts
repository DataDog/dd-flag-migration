import axios from 'axios';
import chalk from 'chalk';
import { createSavedFilter, listSavedFilters } from '../datadog.js';
import { createSpinner } from '../spinner.js';
import type {
	DatadogTargetingRule,
	EppoSavedFilterMigrationMetadata,
	SavedFilterSummary,
} from '../types.js';
import { fetchEppoAudiences } from './api.js';
import { fingerprintConditions, mapOperator } from './migration.js';
import type { EppoAudience } from './types.js';

// ─── Rule Building ────────────────────────────────────────────────────────────

function buildAudienceTargetingRules(
	audience: EppoAudience,
): DatadogTargetingRule[] | null {
	const rules: DatadogTargetingRule[] = [];
	for (const rule of audience.targeting_rules) {
		const conditions = rule.conditions ?? [];
		if (conditions.length === 0) continue;
		rules.push({
			conditions: conditions.map((cond) => ({
				operator: mapOperator(cond.operator, cond.values),
				attribute: cond.attribute,
				value: cond.values ?? [],
			})),
		});
	}
	return rules.length > 0 ? rules : null;
}

// ─── Error Formatting ─────────────────────────────────────────────────────────

function formatAxiosError(err: unknown): string {
	if (!axios.isAxiosError(err)) return String(err);
	const status = err.response?.status;
	const data = err.response?.data;
	const detail = (data as { errors?: Array<{ detail?: string }> })?.errors?.[0]
		?.detail;
	if (detail) return detail;
	const method = err.config?.method?.toUpperCase() ?? '?';
	const url = err.config?.url ?? '';
	const body = data ? JSON.stringify(data).slice(0, 300) : 'no body';
	return `${method} ${url} — ${status ?? 'no status'}: ${body}`;
}

// ─── migrateAudiences ────────────────────────────────────────────────────────

export interface AudienceMigrationStats {
	discovered: number;
	created: number;
	skipped: number;
	reused: number;
	failures: Array<{ audienceId: number; name: string; error: string }>;
}

export interface AudienceDryRunRequest {
	method: string;
	path: string;
	body: unknown;
}

export interface AudienceMigrationResult {
	/** audienceId → savedFilterId */
	savedFilterLookup: Map<number, string>;
	/**
	 * conditions fingerprint → savedFilterId
	 * Used to detect which allocation targeting rules came from an audience,
	 * since the Eppo flags API expands audience conditions inline without
	 * exposing audience_id.
	 */
	fingerprintLookup: Map<string, string>;
	stats: AudienceMigrationStats;
	/**
	 * Recorded requests when dryRun is true — empty otherwise. Caller merges
	 * these into the migration's overall dry-run output.
	 */
	dryRunRequests: AudienceDryRunRequest[];
}

/**
 * Phase 1 of Eppo migration: migrate all active Eppo audiences as Datadog
 * saved filters. Returns fingerprint and audience-id lookups used in Phase 2
 * (flag migration) to replace inline conditions with saved_filter_id refs.
 *
 * When `dryRun` is true, no saved filters are created; synthetic IDs are
 * substituted so that Phase 2's dry-run output still shows fingerprint→
 * saved-filter replacement, and the planned POSTs are recorded in
 * `dryRunRequests`.
 */
export async function migrateAudiences(params: {
	eppoApiKey: string;
	ddApiKey: string;
	ddAppKey: string;
	ddSite: string;
	dryRun?: boolean;
}): Promise<AudienceMigrationResult> {
	const { eppoApiKey, ddApiKey, ddAppKey, ddSite, dryRun = false } = params;
	const savedFilterLookup = new Map<number, string>();
	const fingerprintLookup = new Map<string, string>();
	const dryRunRequests: AudienceDryRunRequest[] = [];
	const stats: AudienceMigrationStats = {
		discovered: 0,
		created: 0,
		skipped: 0,
		reused: 0,
		failures: [],
	};

	// ── Step 1: Fetch active audiences from Eppo ──────────────────────────────
	const fetchSpinner = createSpinner('Fetching audiences from Eppo…').start();
	const audiences = await fetchEppoAudiences(eppoApiKey);
	stats.discovered = audiences.length;
	fetchSpinner.succeed(`Found ${audiences.length} active audience(s) in Eppo`);

	if (audiences.length === 0) {
		return { savedFilterLookup, fingerprintLookup, stats, dryRunRequests };
	}

	// ── Step 2: List existing DD saved filters for idempotency ────────────────
	const idempotencySpinner = createSpinner(
		'Checking for already-migrated saved filters…',
	).start();
	const existingFilters: SavedFilterSummary[] = [];
	let offset = 0;
	let total = Number.POSITIVE_INFINITY;
	while (existingFilters.length < total) {
		const page = await listSavedFilters(ddApiKey, ddAppKey, { offset }, ddSite);
		existingFilters.push(...page.data);
		total = page.total;
		if (page.data.length === 0) break;
		offset += page.data.length;
	}

	const existingByTuple = new Map<string, string>(); // "eppo:<audienceId>" → savedFilterId
	const existingByName = new Map<string, string>(); // name → savedFilterId
	for (const sf of existingFilters) {
		existingByName.set(sf.name, sf.id);
		if (sf.migration_metadata?.provider === 'eppo') {
			existingByTuple.set(`eppo:${sf.migration_metadata.audience_id}`, sf.id);
		}
	}
	idempotencySpinner.succeed(
		`Loaded ${existingFilters.length} existing saved filter(s)`,
	);

	// ── Step 3: Create saved filters for new audiences ────────────────────────
	const savedFilterSpinner = createSpinner(
		dryRun
			? 'Planning saved filters for audiences…'
			: 'Creating saved filters for audiences…',
	).start();

	for (const audience of audiences) {
		if (audience.targeting_rules.length === 0) {
			savedFilterSpinner.warn(
				`Skipped "${audience.name}" — audience has no targeting rules`,
			);
			stats.skipped++;
			continue;
		}

		const tupleKey = `eppo:${audience.id}`;

		// Idempotency: already migrated. Only the first run creates saved filters;
		// re-runs reuse the existing filter without updating its targeting rules.
		// To force a refresh, delete the existing saved filter and re-run.
		if (existingByTuple.has(tupleKey)) {
			// biome-ignore lint/style/noNonNullAssertion: safe after .has() check above
			const savedFilterId = existingByTuple.get(tupleKey)!;
			savedFilterLookup.set(audience.id, savedFilterId);
			for (const rule of audience.targeting_rules) {
				if (rule.conditions.length === 0) continue;
				const fp = fingerprintConditions(rule.conditions);
				if (!fingerprintLookup.has(fp))
					fingerprintLookup.set(fp, savedFilterId);
			}
			stats.reused++;
			continue;
		}

		const targetingRules = buildAudienceTargetingRules(audience);
		if (!targetingRules) {
			savedFilterSpinner.warn(
				`Skipped "${audience.name}" — no mappable targeting rules`,
			);
			stats.skipped++;
			continue;
		}

		// Resolve name collision by appending the audience ID
		let name = audience.name;
		if (existingByName.has(name)) {
			name = `${audience.name} (${audience.id})`;
		}

		const metadata: EppoSavedFilterMigrationMetadata = {
			provider: 'eppo',
			audience_id: audience.id,
		};

		const attributes = {
			name,
			...(audience.description ? { description: audience.description } : {}),
			creation_type: 'RULES' as const,
			targeting_rules: targetingRules,
			migration_metadata: metadata,
		};

		if (dryRun) {
			// Synthetic ID lets Phase 2's dry-run output show fingerprint→
			// saved-filter replacement without hitting Datadog.
			const id = `dry-run-eppo-audience-${audience.id}`;
			dryRunRequests.push({
				method: 'POST',
				path: '/api/v2/feature-flags/saved-filters',
				body: { data: { type: 'saved-filters', attributes } },
			});
			savedFilterLookup.set(audience.id, id);
			existingByName.set(name, id);
			for (const rule of audience.targeting_rules) {
				if (rule.conditions.length === 0) continue;
				const fp = fingerprintConditions(rule.conditions);
				if (!fingerprintLookup.has(fp)) fingerprintLookup.set(fp, id);
			}
			stats.created++;
			continue;
		}

		try {
			const { id } = await createSavedFilter(
				ddApiKey,
				ddAppKey,
				attributes,
				ddSite,
			);
			savedFilterLookup.set(audience.id, id);
			existingByName.set(name, id);
			for (const rule of audience.targeting_rules) {
				if (rule.conditions.length === 0) continue;
				const fp = fingerprintConditions(rule.conditions);
				if (!fingerprintLookup.has(fp)) fingerprintLookup.set(fp, id);
			}
			stats.created++;
		} catch (err) {
			const error = formatAxiosError(err);
			savedFilterSpinner.warn(
				`Failed to create saved filter for "${audience.name}": ${error}`,
			);
			stats.failures.push({
				audienceId: audience.id,
				name: audience.name,
				error,
			});
		}
	}

	const createdVerb = dryRun ? 'Would create' : 'Created';
	savedFilterSpinner.succeed(
		`${createdVerb} ${stats.created} audience saved filter(s) (${stats.reused} reused, ${stats.skipped} skipped)`,
	);

	if (stats.failures.length > 0) {
		console.log();
		for (const f of stats.failures) {
			console.log(
				`  ${chalk.red('✗')} Audience "${f.name}" (id: ${f.audienceId}): ${f.error}`,
			);
		}
	}

	return { savedFilterLookup, fingerprintLookup, stats, dryRunRequests };
}
