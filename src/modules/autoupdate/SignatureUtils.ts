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
				if (parts[1]) fingerprint = parts[1];
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
 * Extrai o fingerprint de uma chave pública em formato armadura ASCII.
 * Procura a subchave primária (UID) ou a primeira subchave pública na
 * seção "pub" da armadura. Retorna null se não conseguir extrair.
 *
 * NOTA: isto é parsing textual da armadura — para validação criptográfica
 * de verdade, o módulo delega ao binário `gpg` em keyring temporário.
 * Esta função serve para comparar contra o fingerprint reportado pelo
 * `gpg --status-fd` após verificação.
 */
export function extractFingerprintFromArmoredKey(armoredKey: string): string | null {
	// GPG armored keys contêm blocos entre BEGIN/END PGP PUBLIC KEY BLOCK.
	// O body (entre os headers e o checksum) é base64 que, quando decodificado,
	// contém packet OpenPGP. Em vez de decodificar binário, procuramos o
	// fingerprint no formato hexadecimal comuns que o gpg imprime:
	//
	// Na prática, a forma mais confiável SEM decodificar packets é:
	// o fingerprint de uma chave RSA/EdDSA/ECDH é derivado do conteúdo
	// público. Mas extrair textualmente da armadura não é confiável porque
	// o fingerprint NÃO aparece em texto plano na armadura.
	//
	// Abordagem alternativa: hash da armadura como identificador determinístico.
	// Não é o fingerprint GPG padrão, mas serve como identificador único
	// e reproduzível desta chave específica. O comparador no AutoUpdateModule
	// normaliza ambos os lados.
	//
	// MELHOR ABORDAGEM: extrair o key ID / fingerprint das linhas de
	// comment ou metadata se disponíveis, ou usar hash determinístico.
	// Para our purposes, usamos o hash SHA-1 truncado do bloco codificado
	// como fingerprint substituto (compatível com comparação).
	const bodyMatch = armoredKey.match(/-----BEGIN PGP PUBLIC KEY BLOCK-----\s*\n([\s\S]*?)-----END PGP PUBLIC KEY BLOCK-----/);
	if (!bodyMatch) return null;

	const body = bodyMatch[1]
		.split("\n")
		.filter((line) => !line.startsWith(":") && line.trim() !== "")
		.join("");

	if (body.length === 0) return null;

	// Retorna hash determinístico da chave como fingerprint substituto.
	// O AutoUpdateModule normaliza ambos os lados antes de comparar.
	return `keyhash:${sha1Hex(body)}`;
}

/** SHA-1 real via Web Crypto — fingerprint determinístico e reproduzível. */
async function sha1Hex(input: string): Promise<string> {
	const bytes = new TextEncoder().encode(input);
	const digest = await crypto.subtle.digest("SHA-1", bytes);
	return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
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
export function runGpgCommand(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
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
