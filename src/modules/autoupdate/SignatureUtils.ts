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
 *     O usuário pediu verificação; pular porque "o release não publicou" é
 *     exatamente o furo que a verificação existe para tapar.
 *   - Verificação ligada + gpg indisponível/falhou → FALHA (aborta), com
 *     motivo claro. Falha fechada: habilitar a opção cria a obrigação.
 *   - Verificação desligada → null; fluxo segue como hoje (checksum).
 *   - Release sem assinatura + verificação desligada → como hoje.
 *
 * PARSE: usamos APENAS as linhas de status `--status-fd` (`[GNUPG:] ...`),
 * que são estáveis e não dependem do idioma — a saída humana do gpg é
 * traduzida por locale e não serve para decidir nada.
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
	// Convenções que o GitHub/GPG costuma produzir, na ordem de preferência.
	const candidates = [".sig", ".sig.asc", ".asc"].map((suffix) => assetName + suffix);
	for (const candidate of candidates) {
		const found = assets.find((a) => a.name === candidate);
		if (found) return { name: found.name, url: found.browser_download_url };
	}
	// Varredura de fallback: "main.js.minisig" etc. NÃO conta como assinatura
	// do GPG — apenas .sig/.sig.asc/.asc exatos.
	return undefined;
}

export type SignatureDecision =
	| { action: "skip"; reason?: string }
	| { action: "abort"; reason: string };

/**
 * Decide o que fazer com base na config e na presença da assinatura.
 * `verificationAvailable: false` (gpg não instalado / execução falhou) com
 * verificação ligada é falha fechada — não é motivo para pular a checagem.
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
 * NO_PUBKEY é FALHA: sem a chave pública configurada corretamente, nada foi
 * verificado de fato — "não consegui verificar" não é "verificado".
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
				// gpg não conseguiu processar a assinatura (malformada, algoritmo
				// ausente etc.). Formato do gpg: ERRSIG <keyid> <pk_algo> <hash_algo>
				// <sig_class> <timestamp> <rc> — o reason code é o 6º campo.
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
 * Detecta instalação via BRAT (TfTHacker/obsidian42-brat): o BRAT guarda os
 * plugins que gerencia no PRÓPRIO data.json dele (campo `pluginList` —
 * histórico: já se chamou `pluginSubListFrozenVersion` em versões antigas).
 * Se este repo está lá, o BRAT cuida das atualizações — o módulo deve
 * CEDER, não competir (duas mãos escrevendo main.js no mesmo plugin é
 * corrida de escrita com rollback de dois donos).
 *
 * Pura: recebe o conteúdo bruto do data.json do BRAT (ou undefined quando
 * o plugin BRAT não está instalado) e decide.
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
		// data.json do BRAT corrompido: NÃO gerencia — mas avisa para alguém olhar.
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
		// aceita "ioNeXd/All-in-oNe", com/sem https://github.com/ e .git
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

/**
 * Decide se o módulo deve CEDER o controle de atualização ao BRAT.
 * A detecção roda no onEnable/na checagem; quando cede, a checagem automática
 * não roda e o painel mostra o aviso — o BRAT é o dono do ciclo de update.
 */
export function shouldYieldToBrat(bratInstalled: boolean, detection: { managedByBrat: boolean }): boolean {
	return bratInstalled && detection.managedByBrat;
}

/** Executa o binário `gpg` capturando stdout/stderr — I/O isolado aqui. */
export function runGpgCommand(args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn("gpg", args, { env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
		child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
		child.on("error", (err: Error) => reject(err)); // gpg não instalado (ENOENT) etc.
		child.on("close", (code: number | null) => resolve({ code: code ?? -1, stdout, stderr }));
	});
}
