/**
 * VERIFICAÇÃO DE ASSINATURA DOS ASSETS DO AUTO-UPDATE — PURO, SEM I/O
 * ---------------------------------------------------------------------
 * Regras de decisão do check de assinatura GPG (opt-in) do módulo de
 * Auto-update, ao lado do módulo no padrão do projeto (como ReleaseUtils).
 * O I/O de verdade (baixar o .sig, rodar o binário `gpg` num keyring
 * temporário isolado) vive no módulo — aqui só entra TEXTO de saída do gpg
 * e saem DECISÕES testáveis.
 *
 * FILOSOFIA (a mesma do checksum SHA-256 existente):
 *   - Verificação ligada + assinatura ausente no release → FALHA (aborta).
 *   - Verificação ligada + gpg indisponível/falhou → FALHA (aborta).
 *   - Verificação desligada → null; fluxo segue como hoje (checksum).
 *   - Release sem assinatura + verificação desligada → como hoje.
 *
 * PARSE: usamos APENAS as linhas de status `--status-fd` (`[GNUPG:] ...`),
 * que são estáveis e não dependem do idioma.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

export interface SignatureAsset {
	name: string;
	url: string;
}

/** Procura o asset de assinatura de `assetName` num release do GitHub. */
export function findSignatureAsset(
	assets: { name: string; browser_download_url: string }[],
	assetName: string
): SignatureAsset | undefined {
	const candidates = [".sig", ".sig.asc", ".asc"].map((suffix) => assetName + suffix);
	for (const candidate of candidates) {
		const found = assets.find((a) => a.name === candidate);
		if (found) return { name: found.name, url: found.browser_download_url };
	}
	return undefined;
}

export type SignatureDecision =
	| { action: "skip"; reason?: string }
	| { action: "abort"; reason: string };

/**
 * Decide o que fazer com base na config e na presença da assinatura.
 */
export function decideSignatureVerification(opts: {
	enabled: boolean;
	signaturePresent: boolean;
	verificationAvailable: boolean;
	verificationProblem?: string;
	assetName: string;
}): SignatureDecision {
	if (!opts.enabled) return { action: "skip" };

	if (!opts.signaturePresent) {
		return {
			action: "abort",
			reason:
				`Verificação de assinatura está LIGADA, mas o release não publica assinatura para "${opts.assetName}" ` +
				`(procurado: ${opts.assetName}.sig / .asc). Instalação abortada por segurança. ` +
				`Desligue a verificação no painel do módulo se confia neste release.`,
		};
	}
	if (!opts.verificationAvailable) {
		return {
			action: "abort",
			reason:
				`Verificação de assinatura está LIGADA, mas não foi possível executá-la` +
				(opts.verificationProblem ? `: ${opts.verificationProblem}` : ".") +
				` Instalação abortada — habilitar a verificação cria a obrigação de cumpri-la.`,
		};
	}
	return { action: "skip" };
}

export interface SignatureCheckOutcome {
	valid: boolean;
	/** Motivo legível (em português) quando inválida ou indeterminada. */
	reason?: string;
	/** Fingerprint da chave que assinou, quando o gpg reportou. */
	keyFingerprint?: string;
}

/**
 * Interpreta a saída de `gpg --status-fd` para um arquivo. Linhas que
 * decidem: GOODSIG/BADSIG/ERRSIG/EXPKEYSIG/REVKEYSIG/NO_PUBKEY.
 */
export function interpretGpgStatusOutput(output: string): SignatureCheckOutcome {
	const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
	let sawGood = false;
	let sawTerminalBad = false;
	let sawNoPubkey = false;
	let fingerprint: string | undefined;
	let errsigReason: string | undefined;

	for (const line of lines) {
		if (!line.startsWith("[GNUPG:] ")) continue;
		const parts = line.slice("[GNUPG:] ".length).split(/\s+/);
		const code = parts[0];
		switch (code) {
			case "GOODSIG":
				sawGood = true;
				break;
			case "BADSIG":
			case "EXPKEYSIG":
			case "EXPSIG":
			case "REVKEYSIG":
				sawTerminalBad = true;
				break;
			case "ERRSIG":
				errsigReason =
					parts[6] === "4"
						? "algoritmo não suportado"
						: parts[6] === "5"
							? "dados criptográficos inválidos"
							: "erro ao processar a assinatura";
				sawTerminalBad = true;
				break;
			case "NO_PUBKEY":
				sawNoPubkey = true;
				break;
			case "VALIDSIG":
				if (parts[10]) fingerprint = parts[10];
				else if (parts[1]) fingerprint = parts[1];
				break;
		}
	}

	if (sawGood && !sawTerminalBad) return { valid: true, keyFingerprint: fingerprint };
	if (sawNoPubkey)
		return {
			valid: false,
			reason:
				"Assinatura não verificada: a chave pública configurada não contém a chave que assinou o arquivo (NO_PUBKEY).",
		};
	if (errsigReason)
		return { valid: false, reason: `Assinatura inválida: ${errsigReason}.` };
	if (sawTerminalBad) return { valid: false, reason: "Assinatura inválida (BADSIG/EXPKEYSIG/REVKEYSIG)." };
	return {
		valid: false,
		reason:
			"Saída do gpg não contém veredicto de assinatura reconhecível (GOODSIG/BADSIG) — tratamento como inválida.",
	};
}

/**
 * Extrai o fingerprint GPG real de uma chave pública em formato armadura ASCII.
 * Importa a chave num keyring temporário e usa `gpg --list-keys --with-colons`
 * para obter o fingerprint do subkey primário — o mesmo formato que o GPG
 * reporta em VALIDSIG durante verificação de assinatura.
 *
 * Retorna null se:
 *   - a armadura não contém uma chave válida;
 *   - o GPG não está disponível;
 *   - não for possível extrair o fingerprint.
 *
 * IMPORTANTE: função assíncrona — requer o binário `gpg` no PATH.
 */
export async function extractFingerprintFromArmoredKey(armoredKey: string): Promise<string | null> {
	if (!armoredKey.includes("-----BEGIN PGP PUBLIC KEY BLOCK-----")) return null;

	const tempDir = await mkdtemp(path.join(tmpdir(), "all-in-one-fp-"));
	try {
		const keyPath = path.join(tempDir, "key.asc");
		await writeFile(keyPath, armoredKey);

		const gnupghome = path.join(tempDir, "gnupg");
		const env = { ...process.env, GNUPGHOME: gnupghome };

		const importResult = await runGpgCommand(["--batch", "--import", keyPath], env);
		if (importResult.code !== 0) return null;

		const listResult = await runGpgCommand(
			["--batch", "--with-colons", "--list-keys"],
			env
		);
		if (listResult.code !== 0) return null;

		// Formato --with-colons (linhas separadas por :):
		//   pub:...:fingerprint:...
		//   fpr:...:fingerprint:...
		// Procura fpr primeiro (preferido), depois pub.
		for (const line of listResult.stdout.split("\n")) {
			const fields = line.split(":");
			if (fields[0] === "fpr" && fields[9]) return fields[9];
		}
		for (const line of listResult.stdout.split("\n")) {
			const fields = line.split(":");
			if (fields[0] === "pub" && fields[9]) return fields[9];
		}

		return null;
	} catch {
		return null;
	} finally {
		await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
	}
}

/**
 * Detecta instalação via BRAT (TfTHacker/obsidian42-brat).
 */
export function detectBratInstallation(
	bratDataJson: string | undefined,
	pluginRepo: string
): { managedByBrat: boolean; reason?: string } {
	if (!bratDataJson) return { managedByBrat: false };

	let parsed: unknown;
	try {
		parsed = JSON.parse(bratDataJson);
	} catch {
		return { managedByBrat: false, reason: "data.json do BRAT ilegível (JSON inválido)." };
	}

	const list = (parsed as { pluginList?: unknown })?.pluginList;
	if (!Array.isArray(list)) return { managedByBrat: false };

	const normalize = (value: unknown): string => String(value ?? "").toLowerCase().trim();
	const target = normalize(pluginRepo);
	const managed = list.some((entry) => {
		const repo = typeof entry === "string" ? entry : (entry as { repo?: unknown })?.repo;
		if (!repo) return false;
		const value = normalize(repo);
		const cleaned = value
			.replace(/^https?:\/\/(www\.)?github\.com\//, "")
			.replace(/\.git$/, "")
			.replace(/\/+$/, "");
		return cleaned === target;
	});

	return managed
		? { managedByBrat: true, reason: `O plugin "${pluginRepo}" está na lista do BRAT.` }
		: { managedByBrat: false };
}

export function shouldYieldToBrat(bratInstalled: boolean, detection: { managedByBrat: boolean }): boolean {
	return bratInstalled && detection.managedByBrat;
}

/** Executa o binário `gpg` capturando stdout/stderr. */
export function runGpgCommand(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn("gpg", args, { env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
		child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
		child.on("error", (err: Error) => reject(err));
		child.on("close", (code: number | null) => resolve({ code: code ?? -1, stdout, stderr }));
	});
}
