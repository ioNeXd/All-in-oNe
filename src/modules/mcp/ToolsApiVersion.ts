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
	/** Versão acordada: a pedida (compatível) ou a suportada (incompatível). */
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

	const supportedMajor = parseMajor(supported) ?? 0;
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

	// Major menor ou igual: compatível. A versão acordada é a pedida (o
	// servidor se compromete a não quebrar dentro do mesmo major).
	return { compatible: true, version: requested };
}

function parseMajor(version: string): number | undefined {
	// Formato completo exigido: major.minor[.patch] numérico — "1.x.0" ou "v1" não passam.
	if (!/^\d+\.\d+(\.\d+)?$/.test(version)) return undefined;
	const major = Number.parseInt(version.split(".")[0] ?? "", 10);
	return Number.isFinite(major) && major >= 0 ? major : undefined;
}
