import { createDefaultSettings, randomId, HubSettings, SETTINGS_SCHEMA_VERSION } from "./types";
import type { ConfigValidationIssue, HubModule, ModuleId } from "./ModuleContract";
import { SPLIT_MODULE_IDS, type SplitPersistenceHandle } from "./SplitPersistence";

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
	// v1 -> v2: remove `activeProfileId`/`profiles`. Os campos existiam no
	// schema desde a v0.1.0 mas NUNCA tiveram implementação (nenhuma UI de
	// perfis, nenhum leitor em SettingsManager/HubCore/Lobby) — config morta.
	// A migração descarta os campos; a configuração REAL sempre viveu em
	// `modules`/`enabledModules`/`paths`, que a migração preserva intacta.
	1: (old) => {
		const { activeProfileId: _a, profiles: _p, ...rest } = old as HubSettings & {
			activeProfileId?: string;
			profiles?: unknown;
		};
		void _a;
		void _p;
		return { ...rest, schemaVersion: 2 };
	},
};

const INSTANCE_ID = randomId();

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

	/**
	 * Persistência SPLIT (opcional): quando presente, as fatias dos módulos
	 * em SPLIT_MODULE_IDS vão para ARQUIVO PRÓPRIO e o data.json principal
	 * grava só o resto (stubs no lugar das fatias). É o que evita que o
	 * write-behind do Histórico/Notificações regrave o JSON inteiro a cada
	 * ~2s num vault ativo (ver core/SplitPersistence.ts). Sem o handle —
	 * nos testes — o comportamento monolítico é preservado.
	 */
	private split?: SplitPersistenceHandle;
	/** Última config efetivamente NO DISCO — base do diff do persistAll. */
	private persistedSnapshot?: HubSettings;

	constructor(private load: Load, private persist: Persist) {
		this.current = createDefaultSettings();
	}

	/** Chamado pelo main.ts após criar o handle (usa o adapter do app). */
	setSplitPersistence(handle: SplitPersistenceHandle): void {
		this.split = handle;
	}

	/** Registrado pelo HubCore para que o SettingsManager consiga validar conflitos entre módulos. */
	registerModuleForValidation(module: HubModule): void {
		this.modules.set(module.manifest.id, module);
	}


	async init(): Promise<HubSettings> {
		const loaded = this.split ? await this.split.loadMain() : await this.load();
		if (!loaded) {
			this.current = createDefaultSettings();
			await this.persistAll(this.current);
			this.persistedSnapshot = JSON.parse(JSON.stringify(this.current)) as HubSettings;
			return this.current;
		}

		const before = loaded.schemaVersion ?? 0;
		this.current = this.runMigrations(loaded);

		// A migração também vai ao DISCO: sem isto, toda inicialização
		// re-migraria os mesmos dados (o arquivo ficaria v1 para sempre) e a
		// validação/leitura nos módulos veria o formato velho. Só persiste se
		// de fato migrou — boot normal não reescreve o data.json.
		if ((this.current.schemaVersion ?? 0) !== before) {
			await this.persistAll(this.current);
		}
		// Estado que está no disco agora (base do diff do persistAll):
		this.persistedSnapshot = JSON.parse(JSON.stringify(this.current)) as HubSettings;

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
		const operation = this.writeQueue.then(() => this.persistAll(next));
		this.writeQueue = operation.catch(() => undefined); // falha não quebra a fila para os próximos
		await operation;
		return [];
	}

	/** Fatias splitadas removidas — a projeção do principal para o diff. */
	private stripSlices(s: HubSettings): HubSettings {
		const modules: Record<string, Record<string, unknown>> = {};
		for (const [id, slice] of Object.entries(s.modules)) {
			if (!(SPLIT_MODULE_IDS as readonly string[]).includes(id)) modules[id] = slice;
		}
		return { ...s, modules };
	}

	/**
	 * Persiste a configuração. Com persistência split: o data.json principal
	 * só é regravado quando algo FORA das fatias splitadas mudou, e a fatia
	 * de cada módulo splitado só quando ELA mudou (deep-equal) — o write-
	 * behind do Histórico/Notificações deixa de regravar o JSON inteiro.
	 */
	private async persistAll(next: HubSettings): Promise<void> {
		if (!this.split) {
			await this.persist(next);
			return;
		}

		const prev = this.persistedSnapshot;
		const splitIds = SPLIT_MODULE_IDS;

		// Fatias splitadas: grava só a(s) que mudou.
		for (const id of splitIds) {
			const slice = next.modules[id] ?? {};
			if (JSON.stringify(prev?.modules?.[id] ?? {}) === JSON.stringify(slice)) continue;
			await this.split.persistModule(id, slice);
		}

		// Principal: grava só se algo fora das fatias splitadas mudou. O
		// carimbo de sync NÃO entra no diff (muda em todo save — compará-lo
		// faria qualquer save parecer mudança do principal); ele é atualizado
		// no DISCO quando o principal de fato é regravado (persistMain), e o
		// snapshot da memória segue o current de qualquer forma.
		const mainChanged =
			!prev ||
			(() => {
				const { sync: _sn, ...restNext } = this.stripSlices(next);
				const { sync: _sp, ...restPrev } = this.stripSlices(prev);
				void _sn;
				void _sp;
				return JSON.stringify(restPrev) !== JSON.stringify(restNext);
			})();
		if (mainChanged) {
			await this.split.persistMain(next);
		}
		this.persistedSnapshot = JSON.parse(JSON.stringify(next)) as HubSettings;
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
