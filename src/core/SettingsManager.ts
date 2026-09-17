import { createDefaultSettings, cryptoRandomId, HubSettings, SETTINGS_SCHEMA_VERSION } from "./types";
import type { ConfigValidationIssue, HubModule, ModuleId } from "./ModuleContract";

type Persist = (data: HubSettings) => Promise<void>;
type Load = () => Promise<HubSettings | null>;

/**
 * MIGRAÇÕES
 * ---------
 * Cada entrada migra do schemaVersion (chave) para o próximo. Quando o
 * formato de configuração de algum módulo precisar mudar no futuro, a
 * migração correspondente entra aqui — nunca alterando createDefaultSettings
 * silenciosamente, o que perderia configuração de quem já tinha o plugin
 * instalado.
 */
const migrations: Record<number, (old: HubSettings) => HubSettings> = {
	// Exemplo de como uma futura migração de v1 -> v2 ficaria:
	// 1: (old) => ({ ...old, schemaVersion: 2, algumCampoNovo: "valor-padrao" }),
};

const INSTANCE_ID = cryptoRandomId();

export class SettingsManager {
	private current: HubSettings;
	private modules: Map<ModuleId, HubModule> = new Map();
	/**
	 * Serializa as gravações (fila de promises encadeada). O read-modify-write
	 * em si é atômico (entre ler e escrever `current` não há await), mas dois
	 * saves concorrentes disparam dois persist FORA DE ORDEM: se o persist do
	 * save antigo terminar DEPOIS do novo (disco lento/variável), o disco
	 * termina com a versão antiga — lost update que só aparece ao reiniciar o
	 * Obsidian. Histórico/Notificações chamam updateSettings a cada evento, e
	 * dois eventos quase simultâneos são o caso comum, não a exceção.
	 */
	private writeQueue: Promise<unknown> = Promise.resolve();

	constructor(private load: Load, private persist: Persist) {
		this.current = createDefaultSettings();
	}

	/** Registrado pelo HubCore para que o SettingsManager consiga validar conflitos entre módulos. */
	registerModuleForValidation(module: HubModule): void {
		this.modules.set(module.manifest.id, module);
	}


	async init(): Promise<HubSettings> {
		const loaded = await this.load();
		if (!loaded) {
			this.current = createDefaultSettings();
			await this.persist(this.current);
			return this.current;
		}

		this.current = this.runMigrations(loaded);

		// Detecção de conflito de sync: se o arquivo no disco foi escrito por
		// outra instância (outro dispositivo) depois da última vez que ESTA
		// instância escreveu, avisamos em vez de sobrescrever silenciosamente
		// na próxima gravação. Isso só sinaliza — quem decide o que fazer é a
		// camada de UI (Lobby), não o SettingsManager.
		this.current.sync = this.current.sync ?? { lastWrittenBy: INSTANCE_ID, lastWrittenAt: 0 };

		return this.current;
	}

	private runMigrations(settings: HubSettings): HubSettings {
		let result = settings;
		let guard = 0;
		while (result.schemaVersion < SETTINGS_SCHEMA_VERSION && guard < 50) {
			const migrate = migrations[result.schemaVersion];
			if (!migrate) break; // não há caminho de migração conhecido; segue com o que tem
			result = migrate(result);
			guard++;
		}
		return result;
	}

	get(): HubSettings {
		return this.current;
	}

	/**
	 * Detecta se o data.json em disco mudou desde o último load feito por
	 * ESTA instância — sinal de outro dispositivo tendo sincronizado uma
	 * mudança enquanto este Obsidian estava aberto.
	 */
	async detectExternalChange(): Promise<boolean> {
		const onDisk = await this.load();
		if (!onDisk) return false;
		return (
			onDisk.sync?.lastWrittenAt > this.current.sync?.lastWrittenAt &&
			onDisk.sync?.lastWrittenBy !== INSTANCE_ID
		);
	}

	/**
	 * Valida a configuração completa contra todos os módulos registrados —
	 * incluindo a checagem transversal de conflito de caminhos (dois módulos
	 * configurados para escrever/ler exatamente na mesma pasta de forma que
	 * um pisaria no outro).
	 */
	validate(next: HubSettings): ConfigValidationIssue[] {
		const issues: ConfigValidationIssue[] = [];

		for (const module of this.modules.values()) {
			if (module.validateSettings) {
				issues.push(...module.validateSettings(next));
			}
		}

		issues.push(...this.checkPathConflicts(next));

		return issues;
	}

	/** Checagem de conflito de caminho entre módulos (requisito técnico da auditoria final). */
	private checkPathConflicts(settings: HubSettings): ConfigValidationIssue[] {
		const issues: ConfigValidationIssue[] = [];
		const seen = new Map<string, string>(); // caminho normalizado -> quem já usa

		const normalize = (p: string) => p.trim().replace(/\/+$/, "").toLowerCase();

		const entries = Object.entries(settings.paths);
		for (const [key, path] of entries) {
			if (!path) continue;
			const normalized = normalize(path);
			const owner = seen.get(normalized);
			if (owner && owner !== key) {
				issues.push({
					field: key,
					level: "error",
					message: `O caminho "${path}" já está em uso por "${owner}". Módulos diferentes não devem apontar para a mesma pasta.`,
				});
			} else {
				seen.set(normalized, key);
			}
		}

		return issues;
	}

	async save(next: HubSettings, options?: { skipValidation?: boolean }): Promise<ConfigValidationIssue[]> {
		// A validação roda FORA da fila (síncrona e barata): um save bloqueado
		// não pode ficar preso atrás de um persist lento de outro chamador.
		if (!options?.skipValidation) {
			const issues = this.validate(next);
			const blocking = issues.filter((i) => i.level === "error");
			if (blocking.length > 0) {
				return issues; // não persiste se houver erro bloqueante
			}
		}

		next.sync = { lastWrittenBy: INSTANCE_ID, lastWrittenAt: Date.now() };
		this.current = next;

		// Enfileira APENAS a persistência: mesmo que o persist de um save
		// anterior esteja lento, este save grava DEPOIS dele — o disco sempre
		// termina com a última versão aceita.
		const operation = this.writeQueue.then(() => this.persist(next));
		this.writeQueue = operation.catch(() => undefined); // falha não quebra a fila para os próximos
		await operation;
		return [];
	}

	async updateModuleSettings(
		moduleId: ModuleId,
		patch: Record<string, unknown>
	): Promise<ConfigValidationIssue[]> {
		const next: HubSettings = {
			...this.current,
			modules: {
				...this.current.modules,
				[moduleId]: { ...(this.current.modules[moduleId] ?? {}), ...patch },
			},
		};
		// Retorna as issues para o chamador (HubCore) saber se a gravação foi
		// bloqueada — antes o retorno era engolido aqui e um patch inválido
		// desaparecia em silêncio.
		return this.save(next);
	}

	getModuleSettings<T = Record<string, unknown>>(moduleId: ModuleId): T {
		return (this.current.modules[moduleId] ?? {}) as T;
	}

	/**
	 * Volta a CONFIGURAÇÃO inteira ao padrão — módulos habilitados, caminhos,
	 * fatias por módulo. É o que os níveis "config" e "all" do Lobby usam;
	 * a diferença entre eles é orquestrada pelo HubCore.resetAll (que chama
	 * este método e, nos níveis com dados, também o hook onResetData dos
	 * módulos — o manager não conhece os módulos, então dados gerados não
	 * passam por aqui).
	 */
	async reset(): Promise<void> {
		const fresh = createDefaultSettings();
		await this.save(fresh, { skipValidation: true });
	}
}
