import ExternalModule from './ExternalModule';
import Graph from './Graph';
import Module from './Module';
import { ModuleJSON, ResolvedId, ResolveIdResult, SourceDescription } from './rollup/types';
import { error } from './utils/error';
import { isRelative, resolve } from './utils/path';
import { PluginDriver } from './utils/pluginDriver';
import relativeId, { getAliasName } from './utils/relativeId';
import { timeEnd, timeStart } from './utils/timers';
import transform from './utils/transform';

interface ModuleWithAlias {
	alias: string;
	module: Module;
}

interface UnresolvedModuleWithAlias {
	alias: string | null;
	unresolvedId: string;
}

export class ModuleLoader {
	private currentLoadModulesPromise: Promise<any> = Promise.resolve();
	private readonly entryModules: ModuleWithAlias[] = [];
	private readonly graph: Graph;
	private readonly manualChunkModules: Record<string, Module[]> = {};
	private readonly modulesById: Map<string, Module | ExternalModule>;
	private readonly pluginDriver: PluginDriver;

	// TODO Lukas get rid of graph dependency
	constructor(
		graph: Graph,
		modulesById: Map<string, Module | ExternalModule>,
		pluginDriver: PluginDriver
	) {
		this.graph = graph;
		this.modulesById = modulesById;
		this.pluginDriver = pluginDriver;
	}

	addEntryModules(
		unresolvedEntryModules: UnresolvedModuleWithAlias[]
	): Promise<{
		entryModulesWithAliases: ModuleWithAlias[];
		manualChunkModulesByAlias: Record<string, Module[]>;
	}> {
		const loadNewEntryModulesPromise = Promise.all(
			unresolvedEntryModules.map(this.loadEntryModule)
		).then(entryModules => this.entryModules.push(...entryModules));

		this.currentLoadModulesPromise = Promise.all([
			this.currentLoadModulesPromise,
			loadNewEntryModulesPromise
		]);
		return this.currentLoadModulesPromise.then(() => ({
			entryModulesWithAliases: this.entryModules,
			manualChunkModulesByAlias: this.manualChunkModules
		}));
	}

	addManualChunks(manualChunks: Record<string, string[]>): void {
		const unresolvedManualChunks: UnresolvedModuleWithAlias[] = [];
		for (const alias of Object.keys(manualChunks)) {
			const manualChunkIds = manualChunks[alias];
			for (const unresolvedId of manualChunkIds) {
				unresolvedManualChunks.push({ unresolvedId, alias });
			}
		}
		const loadNewManualChunkModulesModulesPromise = Promise.all(
			unresolvedManualChunks.map(this.loadEntryModule)
		).then(manualChunkModules => {
			for (const { alias, module } of manualChunkModules) {
				if (!this.manualChunkModules[alias]) {
					this.manualChunkModules[alias] = [];
				}
				this.manualChunkModules[alias].push(module);
			}
		});

		this.currentLoadModulesPromise = Promise.all([
			this.currentLoadModulesPromise,
			loadNewManualChunkModulesModulesPromise
		]);
	}

	private fetchAllDependencies(module: Module) {
		const fetchDynamicImportsPromise = Promise.all(
			module.getDynamicImportExpressions().map((dynamicImportExpression, index) =>
				this.pluginDriver
					.hookFirst('resolveDynamicImport', [dynamicImportExpression, module.id])
					.then(replacement => {
						if (!replacement) return;
						const dynamicImport = module.dynamicImports[index];
						dynamicImport.alias = getAliasName(replacement);
						if (typeof dynamicImportExpression !== 'string') {
							dynamicImport.resolution = replacement;
						} else if (this.graph.isExternal(replacement, module.id, true)) {
							let externalModule;
							if (!this.modulesById.has(replacement)) {
								externalModule = new ExternalModule({
									graph: this.graph,
									id: replacement
								});
								this.modulesById.set(replacement, module);
							} else {
								externalModule = <ExternalModule>this.modulesById.get(replacement);
							}
							dynamicImport.resolution = externalModule;
							externalModule.exportsNamespace = true;
						} else {
							return this.fetchModule(replacement, module.id).then(depModule => {
								dynamicImport.resolution = depModule;
							});
						}
					})
			)
		);
		fetchDynamicImportsPromise.catch(() => {});

		return Promise.all(
			module.sources.map(source => this.resolveAndFetchDependency(module, source))
		).then(() => fetchDynamicImportsPromise);
	}

	private fetchModule(id: string, importer: string): Promise<Module> {
		const existingModule = this.modulesById.get(id);
		if (existingModule) {
			if (existingModule.isExternal) throw new Error(`Cannot fetch external module ${id}`);
			return Promise.resolve(<Module>existingModule);
		}

		const module: Module = new Module(this.graph, id);
		this.modulesById.set(id, module);

		timeStart('load modules', 3);
		return Promise.resolve(this.pluginDriver.hookFirst('load', [id]))
			.catch((err: Error) => {
				timeEnd('load modules', 3);
				let msg = `Could not load ${id}`;
				if (importer) msg += ` (imported by ${importer})`;

				msg += `: ${err.message}`;
				throw new Error(msg);
			})
			.then(source => {
				timeEnd('load modules', 3);
				if (typeof source === 'string') return source;
				if (source && typeof source === 'object' && typeof source.code === 'string') return source;

				error({
					code: 'BAD_LOADER',
					message: `Error loading ${relativeId(
						id
					)}: plugin load hook should return a string, a { code, map } object, or nothing/null`
				});
			})
			.then(source => {
				const sourceDescription: SourceDescription =
					typeof source === 'string'
						? {
								ast: null,
								code: source
						  }
						: source;

				const cachedModule = this.graph.cachedModules.get(id);
				if (
					cachedModule &&
					!cachedModule.customTransformCache &&
					cachedModule.originalCode === sourceDescription.code
				) {
					// re-emit transform assets
					if (cachedModule.transformAssets) {
						for (const asset of cachedModule.transformAssets)
							this.pluginDriver.emitAsset(asset.name, asset.source);
					}
					return cachedModule;
				}

				return transform(this.graph, sourceDescription, module);
			})
			.then((source: ModuleJSON) => {
				module.setSource(source);

				this.modulesById.set(id, module);

				return this.fetchAllDependencies(module).then(() => {
					for (const name in module.exports) {
						if (name !== 'default') {
							module.exportsAll[name] = module.id;
						}
					}
					module.exportAllSources.forEach(source => {
						const id = module.resolvedIds[source].id;
						const exportAllModule = this.modulesById.get(id);
						if (exportAllModule.isExternal) return;

						for (const name in (<Module>exportAllModule).exportsAll) {
							if (name in module.exportsAll) {
								this.graph.warn({
									code: 'NAMESPACE_CONFLICT',
									message: `Conflicting namespaces: ${relativeId(
										module.id
									)} re-exports '${name}' from both ${relativeId(
										module.exportsAll[name]
									)} and ${relativeId(
										(<Module>exportAllModule).exportsAll[name]
									)} (will be ignored)`,
									name,
									reexporter: module.id,
									sources: [module.exportsAll[name], (<Module>exportAllModule).exportsAll[name]]
								});
							} else {
								module.exportsAll[name] = (<Module>exportAllModule).exportsAll[name];
							}
						}
					});
					return module;
				});
			});
	}

	private loadEntryModule = ({
		alias,
		unresolvedId
	}: UnresolvedModuleWithAlias): Promise<ModuleWithAlias> => {
		return this.pluginDriver
			.hookFirst<string | false | void>('resolveId', [unresolvedId, undefined])
			.then(id => {
				if (id === false) {
					error({
						code: 'UNRESOLVED_ENTRY',
						message: `Entry module cannot be external`
					});
				}

				if (id == null) {
					error({
						code: 'UNRESOLVED_ENTRY',
						message: `Could not resolve entry (${unresolvedId})`
					});
				}

				return this.fetchModule(<string>id, undefined).then(module => ({
					alias: alias || getAliasName(module.id),
					module
				}));
			});
	};

	private normalizeResolveIdResult(
		resolveIdResult: ResolveIdResult,
		module: Module,
		source: string
	): ResolvedId {
		if (resolveIdResult) {
			if (typeof resolveIdResult === 'object') {
				return resolveIdResult;
			}
			return {
				external: this.graph.isExternal(resolveIdResult, module.id, true),
				id: resolveIdResult
			};
		}
		const externalId = isRelative(source) ? resolve(module.id, '..', source) : source;
		if (resolveIdResult !== false && !this.graph.isExternal(externalId, module.id, true)) {
			if (isRelative(source)) {
				error({
					code: 'UNRESOLVED_IMPORT',
					message: `Could not resolve '${source}' from ${relativeId(module.id)}`
				});
			}
			this.graph.warn({
				code: 'UNRESOLVED_IMPORT',
				importer: relativeId(module.id),
				message: `'${source}' is imported by ${relativeId(
					module.id
				)}, but could not be resolved – treating it as an external dependency`,
				source,
				url: 'https://rollupjs.org/guide/en#warning-treating-module-as-external-dependency'
			});
		}
		return { id: externalId, external: true };
	}

	private resolveAndFetchDependency(module: Module, source: string) {
		return Promise.resolve(
			module.resolvedIds[source] ||
				(this.graph.isExternal(source, module.id, false)
					? { id: source, external: true }
					: this.pluginDriver
							.hookFirst<ResolveIdResult>('resolveId', [source, module.id])
							.then(result => this.normalizeResolveIdResult(result, module, source)))
		).then((resolvedId: ResolvedId) => {
			module.resolvedIds[source] = resolvedId;
			if (resolvedId.external) {
				if (!this.modulesById.has(resolvedId.id)) {
					this.modulesById.set(
						resolvedId.id,
						new ExternalModule({ graph: this.graph, id: resolvedId.id })
					);
				}

				const externalModule = this.modulesById.get(resolvedId.id);
				if (externalModule instanceof ExternalModule === false) {
					error({
						code: 'INVALID_EXTERNAL_ID',
						message: `'${source}' is imported as an external by ${relativeId(
							module.id
						)}, but is already an existing non-external module id.`
					});
				}
			} else {
				return this.fetchModule(resolvedId.id, module.id);
			}
		});
	}
}
