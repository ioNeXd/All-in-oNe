/**
 * NEGOCIAÇÃO DA VERSÃO DA API DE FERRAMENTAS — PURO, SEM I/O
 * -----------------------------------------------------------
 * O campo `toolsApiVersion` (MCP_DEFAULTS.toolsApiVersion, hoje "1.0.0")
 * existia na configuração mas nada o consumia. A regra vivia em lugar
 * nenhum. Este arquivo é a fonte única dela, ao lado do módulo (padrão do
 * projeto: regras puras em arquivo próprio, com suíte própria).
 *
 * Semântica: a versão da API de ferramentas segue SemVer, mas a negociação
 * só olha o MAJOR. A API é considerada compatível quando o cliente pede um
 * major MENOR OU IGUAL ao que o servidor suporta — o servidor é quem diz
 * até onde entende. Minor/patch pedidos além do suportado são tolerados
 * (um cliente que fala 1.9.0 continua funcionando contra um servidor 1.0.0;
 * recursos que ele pedir e o servidor não tiver falham por ferramenta, com
 * erro claro, não no handshake).
 *
 * Cliente pedindo major MAIOR que o suportado é rejeitado no handshake com
 * erro claro — executar ferramentas contra uma API que o servidor não
 * conhece é exatamente o tipo de falha silenciosa que o projeto evita.
 */

export const TOOLS_API_VERSION = "1.0.0";

export interface ToolsApiNegotiation {
	/** true = handshake segue; false = cliente pediu major além do suportado. */
	compatible: boolean;
	/** Versão efetivamente acordada após a negociação. */
	version: string;
	/** Motivo da rejeição — texto em português para o erro JSON-RPC. */
	reason?: string;
}

export function negotiateToolsApiVersion(
	requested: string | undefined,
	supported: string
): ToolsApiNegotiation {
	if (!requested) {
		// Cliente não se importa — o servidor dita a versão.
		return { compatible: true, version: supported };
	}

	const requestedMajor = parseMajor(requested);
	if (requestedMajor === undefined) {
		// Formato não reconhecido: rejeitar com clareza em vez de adivinhar.
		return {
			compatible: false,
			version: supported,
			reason: `Versão da API de ferramentas em formato inválido: "${requested}". Formato esperado: major.minor.patch.`,
		};
	}

	const supportedMajor = parseMajor(supported);
	if (supportedMajor === undefined) {
		return {
			compatible: false,
			version: supported,
			reason: `Versão da API de ferramentas do servidor em formato inválido: "${supported}". Formato esperado: major.minor.patch.`,
		};
	}
	if (requestedMajor > supportedMajor) {
		return {
			compatible: false,
			version: supported,
			reason:
				`Cliente pediu a API de ferramentas ${requested}, mas este servidor suporta no máximo ` +
				`${supported} (major ${supportedMajor}). Atualize o plugin All iₙ oNe ou configure o cliente para ` +
				`pedir uma versão com major ${supportedMajor} ou menor.`,
		};
	}

	// Major menor: o servidor pode falar a versão pedida por compatibilidade
	// retroativa. No mesmo major, porém, nunca anuncie uma minor/patch que o
	// servidor não suporta: a versão acordada é a versão efetivamente suportada.
	const negotiatedVersion = requestedMajor === supportedMajor ? supported : requested;
	return { compatible: true, version: negotiatedVersion };
}

function parseMajor(version: string): number | undefined {
	// SemVer estrito para a forma numérica usada na negociação: major.minor.patch.
	// Leading zeroes e formas incompletas ("1.0", "01.0.0", "v1.0.0") não passam.
	if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) return undefined;
	const major = Number.parseInt(version.split(".")[0] ?? "", 10);
	return Number.isFinite(major) && major >= 0 ? major : undefined;
}
