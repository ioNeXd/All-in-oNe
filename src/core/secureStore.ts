/**
 * OFUSCAÇÃO DE CAMPOS SENSÍVEIS
 * ------------------------------
 * O data.json de um plugin do Obsidian é um arquivo de texto puro dentro do
 * vault. Não existe, no ambiente de um plugin (sandbox do Electron renderer),
 * uma forma de guardar segredos com segurança real de "cofre de sistema"
 * multiplataforma — então isto NÃO é criptografia forte, é ofuscação: evita
 * que o token do MCP apareça em texto legível se alguém abrir o data.json
 * casualmente (ex.: sincronizado sem querer, capturado em print de tela,
 * enviado num relatório de bug). Isso é documentado explicitamente para
 * quem for revisar/depurar o plugin no futuro.
 *
 * Se algum dia isso precisar de segurança de verdade (ex.: múltiplos
 * usuários no mesmo computador), a troca teria que vir de fora do plugin
 * (ex.: pedir a senha do SO via um approach nativo do Electron).
 */

const XOR_KEY = "ione-hub-local-obfuscation-v1";

export function obfuscate(value: string): string {
	const bytes = Array.from(value).map((char, i) =>
		char.charCodeAt(0) ^ XOR_KEY.charCodeAt(i % XOR_KEY.length)
	);
	return Buffer.from(bytes).toString("base64");
}

export function deobfuscate(stored: string): string {
	try {
		const bytes = Buffer.from(stored, "base64");
		return Array.from(bytes)
			.map((byte, i) => String.fromCharCode(byte ^ XOR_KEY.charCodeAt(i % XOR_KEY.length)))
			.join("");
	} catch {
		return "";
	}
}
