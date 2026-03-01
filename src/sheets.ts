import { exec } from "node:child_process";
import http from "node:http";
import net from "node:net";
import chalk from "chalk";
import type { OAuth2Client } from "google-auth-library";
import { google } from "googleapis";
import { getGoogleOAuthTokens, saveGoogleOAuthTokens } from "./config.js";
import type { EppoFlag, MigrationFile } from "./types.js";

// ─── OAuth Configuration ──────────────────────────────────────────────────────
// These credentials identify this CLI tool to Google's OAuth system.
// Desktop app credentials are safe to bundle per Google's guidance:
// https://developers.google.com/identity/protocols/oauth2/native-app
const OAUTH_CLIENT_ID = "REPLACE_WITH_YOUR_GOOGLE_OAUTH_CLIENT_ID";
const OAUTH_CLIENT_SECRET = "REPLACE_WITH_YOUR_GOOGLE_OAUTH_CLIENT_SECRET";
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];

// ─── Port Selection ───────────────────────────────────────────────────────────

async function getFreePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.listen(0, () => {
			const addr = server.address();
			if (!addr || typeof addr === "string") {
				reject(new Error("Could not determine free port"));
				return;
			}
			const port = addr.port;
			server.close(() => resolve(port));
		});
		server.on("error", reject);
	});
}

// ─── OAuth Flow ───────────────────────────────────────────────────────────────

async function waitForOAuthCode(port: number): Promise<string> {
	return new Promise((resolve, reject) => {
		const server = http.createServer((req, res) => {
			try {
				const url = new URL(req.url ?? "/", `http://localhost:${port}`);
				const code = url.searchParams.get("code");
				const error = url.searchParams.get("error");

				res.writeHead(200, { "Content-Type": "text/html" });
				if (error) {
					res.end(
						`<html><body style="font-family:sans-serif;padding:2rem"><h2>Authorization failed</h2><p>${error}</p><p>You can close this tab.</p></body></html>`,
					);
					server.close(() => reject(new Error(`OAuth error: ${error}`)));
				} else if (code) {
					res.end(
						`<html><body style="font-family:sans-serif;padding:2rem"><h2>Authorization successful!</h2><p>You can close this tab and return to the terminal.</p></body></html>`,
					);
					server.close(() => resolve(code));
				} else {
					res.end(
						`<html><body style="font-family:sans-serif;padding:2rem"><h2>Unexpected response</h2><p>You can close this tab.</p></body></html>`,
					);
					server.close(() =>
						reject(new Error("No code or error in OAuth callback")),
					);
				}
			} catch (err) {
				res.writeHead(500);
				res.end();
				server.close(() => reject(err));
			}
		});

		server.listen(port, () => {});
		server.on("error", reject);
	});
}

function openBrowser(url: string): void {
	const opener = process.platform === "darwin" ? "open" : "xdg-open";
	exec(`${opener} "${url}"`);
}

async function getAuthenticatedClient(): Promise<OAuth2Client> {
	const port = await getFreePort();
	const redirectUri = `http://localhost:${port}/oauth2callback`;

	const oauth2Client = new google.auth.OAuth2(
		OAUTH_CLIENT_ID,
		OAUTH_CLIENT_SECRET,
		redirectUri,
	);

	// Persist refreshed access tokens automatically
	oauth2Client.on("tokens", (newTokens) => {
		const current = getGoogleOAuthTokens();
		if (current || newTokens.refresh_token) {
			saveGoogleOAuthTokens({
				access_token: newTokens.access_token ?? current?.access_token ?? "",
				refresh_token: newTokens.refresh_token ?? current?.refresh_token ?? "",
				token_type: newTokens.token_type ?? current?.token_type ?? "Bearer",
				expiry_date: newTokens.expiry_date ?? current?.expiry_date ?? 0,
			});
		}
	});

	// Check for saved tokens
	const saved = getGoogleOAuthTokens();
	if (saved?.access_token) {
		oauth2Client.setCredentials({
			access_token: saved.access_token,
			refresh_token: saved.refresh_token,
			token_type: saved.token_type,
			expiry_date: saved.expiry_date,
		});
		// If not expired (with 60s buffer), use saved tokens directly
		if (saved.expiry_date > Date.now() + 60_000) {
			return oauth2Client;
		}
		// Expired but have refresh token — googleapis will auto-refresh on first API call
		if (saved.refresh_token) {
			return oauth2Client;
		}
	}

	// No valid tokens — run browser OAuth flow
	const authUrl = oauth2Client.generateAuthUrl({
		access_type: "offline",
		scope: SCOPES,
		prompt: "consent", // ensures refresh_token is issued
	});

	console.log();
	console.log(chalk.bold("Opening browser for Google sign-in..."));
	console.log(chalk.gray(`  If the browser doesn't open, visit: ${authUrl}`));

	openBrowser(authUrl);
	const code = await waitForOAuthCode(port);

	const { tokens } = await oauth2Client.getToken(code);
	oauth2Client.setCredentials(tokens);

	saveGoogleOAuthTokens({
		access_token: tokens.access_token ?? "",
		refresh_token: tokens.refresh_token ?? "",
		token_type: tokens.token_type ?? "Bearer",
		expiry_date: tokens.expiry_date ?? 0,
	});

	return oauth2Client;
}

// ─── Spreadsheet Data Builder ─────────────────────────────────────────────────

type RowStatus = "Created" | "Failed" | "Skipped" | "Not Migrated";

interface SheetRow {
	flag: EppoFlag;
	status: RowStatus;
	error: string;
}

function buildRows(migration: MigrationFile): SheetRow[] {
	const failedKeys = new Set(migration.failures.map((f) => f.key));
	const skippedKeys = new Set((migration.skippedFlags ?? []).map((f) => f.key));
	const errorByKey = new Map(migration.failures.map((f) => [f.key, f.error]));

	const rows: SheetRow[] = [];

	for (const flag of migration.flags) {
		if (failedKeys.has(flag.key)) {
			rows.push({
				flag,
				status: "Failed",
				error: errorByKey.get(flag.key) ?? "",
			});
		} else if (skippedKeys.has(flag.key)) {
			rows.push({ flag, status: "Skipped", error: "" });
		} else {
			rows.push({ flag, status: "Created", error: "" });
		}
	}

	for (const flag of migration.unmigrated ?? []) {
		rows.push({ flag, status: "Not Migrated", error: "" });
	}

	const byTeamThenName = (a: SheetRow, b: SheetRow) => {
		const teamA = a.flag.owner?.name ?? "";
		const teamB = b.flag.owner?.name ?? "";
		return teamA.localeCompare(teamB) || a.flag.name.localeCompare(b.flag.name);
	};

	return rows.sort(byTeamThenName);
}

function toDataRow(row: SheetRow): string[] {
	const { flag, status, error } = row;
	const variations =
		flag.variations?.map((v) => v.variant_key).join(", ") ?? "";
	const team = flag.owner?.name ?? "";
	const tags = flag.tag_names.join(", ");
	const actionRequired =
		status === "Created"
			? `Update your code to reference Datadog flag key: ${flag.key}`
			: "";

	return [
		flag.name,
		flag.key,
		flag.variation_type,
		variations,
		team,
		tags,
		status,
		error,
		actionRequired,
	];
}

// ─── Color Helpers ────────────────────────────────────────────────────────────

function hexToRgb(hex: string): { red: number; green: number; blue: number } {
	const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
	const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
	const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
	return { red: r, green: g, blue: b };
}

const COLORS = {
	headerBg: hexToRgb("#efefef"),
	created: hexToRgb("#d9ead3"),
	failed: hexToRgb("#fce8e6"),
	skipped: hexToRgb("#fff2cc"),
	notMigrated: hexToRgb("#e8eaf6"), // light indigo
	white: { red: 1, green: 1, blue: 1 },
	black: { red: 0, green: 0, blue: 0 },
};

// ─── Sheets API Helpers ───────────────────────────────────────────────────────

function rowColorRequest(
	sheetId: number,
	startRow: number,
	endRow: number,
	color: { red: number; green: number; blue: number },
) {
	return {
		repeatCell: {
			range: {
				sheetId,
				startRowIndex: startRow,
				endRowIndex: endRow,
				startColumnIndex: 0,
				endColumnIndex: 9,
			},
			cell: {
				userEnteredFormat: {
					backgroundColor: color,
				},
			},
			fields: "userEnteredFormat.backgroundColor",
		},
	};
}

// ─── Public Entry Point ───────────────────────────────────────────────────────

export async function exportMigrationToSheets(
	migration: MigrationFile,
): Promise<void> {
	try {
		const spinner = (await import("ora")).default;
		const ora = spinner({ text: "Signing in to Google..." }).start();

		let auth: OAuth2Client;
		try {
			auth = await getAuthenticatedClient();
			ora.succeed("Signed in to Google");
		} catch (err) {
			ora.fail("Google sign-in failed");
			throw err;
		}

		const sheets = google.sheets({ version: "v4", auth });

		ora.start("Creating spreadsheet...");
		const migratedAt = new Date(migration.migratedAt);
		const dateLabel = migratedAt.toLocaleDateString("en-US", {
			year: "numeric",
			month: "short",
			day: "numeric",
		});

		const createRes = await sheets.spreadsheets.create({
			requestBody: {
				properties: { title: `Flag Migration — ${dateLabel}` },
				sheets: [{ properties: { title: "Migration Results" } }],
			},
		});
		const spreadsheetId = createRes.data.spreadsheetId ?? "";
		if (!spreadsheetId) throw new Error("Failed to create spreadsheet");
		const sheetId = createRes.data.sheets?.[0].properties?.sheetId ?? 0;
		ora.succeed("Spreadsheet created");

		// Build data
		const rows = buildRows(migration);
		const dataRows = rows.map(toDataRow);

		const title = "Flag Migration Report — Eppo → Datadog";
		const instructions =
			"Flags with status 'Created' require a code change: update your flag evaluation calls to reference the Datadog flag key shown in the 'Action Required' column. Flags with status 'Skipped' were not migrated (unsupported type or allocation).";
		const headerRow = [
			"Flag Name",
			"Flag Key",
			"Flag Type",
			"Variations",
			"Team",
			"Tags",
			"Migration Status",
			"Error",
			"Action Required",
		];

		ora.start("Writing data...");
		await sheets.spreadsheets.values.batchUpdate({
			spreadsheetId,
			requestBody: {
				valueInputOption: "RAW",
				data: [
					{ range: "Migration Results!A1", values: [[title]] },
					{ range: "Migration Results!A2", values: [[instructions]] },
					{
						range: "Migration Results!A4",
						values: [headerRow, ...dataRows],
					},
				],
			},
		});
		ora.succeed("Data written");

		// Build formatting requests — rows are sorted by team+name so we color
		// each row individually based on its status.
		const createdCount = rows.filter((r) => r.status === "Created").length;
		const failedCount = rows.filter((r) => r.status === "Failed").length;
		const skippedCount = rows.filter((r) => r.status === "Skipped").length;
		const notMigratedCount = rows.filter(
			(r) => r.status === "Not Migrated",
		).length;

		const formatRequests = [
			// Merge title row
			{
				mergeCells: {
					range: {
						sheetId,
						startRowIndex: 0,
						endRowIndex: 1,
						startColumnIndex: 0,
						endColumnIndex: 9,
					},
					mergeType: "MERGE_ALL",
				},
			},
			// Merge instructions row
			{
				mergeCells: {
					range: {
						sheetId,
						startRowIndex: 1,
						endRowIndex: 2,
						startColumnIndex: 0,
						endColumnIndex: 9,
					},
					mergeType: "MERGE_ALL",
				},
			},
			// Title formatting: bold, large, white bg
			{
				repeatCell: {
					range: {
						sheetId,
						startRowIndex: 0,
						endRowIndex: 1,
						startColumnIndex: 0,
						endColumnIndex: 9,
					},
					cell: {
						userEnteredFormat: {
							textFormat: { bold: true, fontSize: 14 },
							verticalAlignment: "MIDDLE",
							wrapStrategy: "WRAP",
							backgroundColor: COLORS.white,
						},
					},
					fields:
						"userEnteredFormat(textFormat,verticalAlignment,wrapStrategy,backgroundColor)",
				},
			},
			// Instructions formatting: italic, wrap, white bg
			{
				repeatCell: {
					range: {
						sheetId,
						startRowIndex: 1,
						endRowIndex: 2,
						startColumnIndex: 0,
						endColumnIndex: 9,
					},
					cell: {
						userEnteredFormat: {
							textFormat: { italic: true },
							wrapStrategy: "WRAP",
							backgroundColor: COLORS.white,
						},
					},
					fields: "userEnteredFormat(textFormat,wrapStrategy,backgroundColor)",
				},
			},
			// Header row: bold, gray background
			{
				repeatCell: {
					range: {
						sheetId,
						startRowIndex: 3,
						endRowIndex: 4,
						startColumnIndex: 0,
						endColumnIndex: 9,
					},
					cell: {
						userEnteredFormat: {
							textFormat: { bold: true },
							backgroundColor: COLORS.headerBg,
						},
					},
					fields: "userEnteredFormat(textFormat,backgroundColor)",
				},
			},
			// Freeze rows 1–4
			{
				updateSheetProperties: {
					properties: {
						sheetId,
						gridProperties: { frozenRowCount: 4 },
					},
					fields: "gridProperties.frozenRowCount",
				},
			},
			// Auto-resize all columns
			{
				autoResizeDimensions: {
					dimensions: {
						sheetId,
						dimension: "COLUMNS",
						startIndex: 0,
						endIndex: 9,
					},
				},
			},
		];

		// Row color coding — one request per row since rows are sorted by team+name
		// and same-status rows are not necessarily contiguous.
		// Data starts at row index 4 (0-based): title(0), instructions(1), spacer(2), header(3)
		const statusColor: Record<RowStatus, (typeof COLORS)[keyof typeof COLORS]> =
			{
				Created: COLORS.created,
				Failed: COLORS.failed,
				Skipped: COLORS.skipped,
				"Not Migrated": COLORS.notMigrated,
			};
		for (let i = 0; i < rows.length; i++) {
			formatRequests.push(
				rowColorRequest(
					sheetId,
					4 + i,
					5 + i,
					statusColor[rows[i].status],
				) as never,
			);
		}

		ora.start("Applying formatting...");
		await sheets.spreadsheets.batchUpdate({
			spreadsheetId,
			requestBody: { requests: formatRequests },
		});
		ora.succeed("Formatting applied");

		const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
		console.log();
		console.log(chalk.green("  Google Sheet created successfully!"));
		console.log(`  ${chalk.cyan(url)}`);
		console.log(
			chalk.gray(
				`  ${rows.length} flag${rows.length === 1 ? "" : "s"} exported (${createdCount} created, ${failedCount} failed, ${skippedCount} skipped, ${notMigratedCount} not migrated)`,
			),
		);
		console.log();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		console.log();
		console.log(chalk.red(`  Google Sheets export failed: ${msg}`));
		console.log(chalk.gray("  Your migration was still saved locally."));
		console.log();
	}
}
