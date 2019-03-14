import * as acorn from 'acorn';
import injectDynamicImportPlugin from 'acorn-dynamic-import';
import injectImportMeta from 'acorn-import-meta';
import * as ESTree from 'estree';
import GlobalScope from './ast/scopes/GlobalScope';
import { EntityPathTracker } from './ast/utils/EntityPathTracker';
import Chunk from './Chunk';
import ExternalModule from './ExternalModule';
import Module, { defaultAcornOptions } from './Module';
import { ModuleLoader } from './ModuleLoader';
import {
	Asset,
	InputOptions,
	IsExternal,
	ModuleJSON,
	OutputBundle,
	RollupCache,
	RollupWarning,
	RollupWatcher,
	SerializablePluginCache,
	TreeshakingOptions,
	WarningHandler
} from './rollup/types';
import { finaliseAsset } from './utils/assetHooks';
import { assignChunkColouringHashes } from './utils/chunkColouring';
import { Uint8ArrayToHexString } from './utils/entryHashing';
import { error } from './utils/error';
import { analyseModuleExecution, sortByExecutionOrder } from './utils/executionOrder';
import { resolve } from './utils/path';
import { createPluginDriver, PluginDriver } from './utils/pluginDriver';
import relativeId from './utils/relativeId';
import { timeEnd, timeStart } from './utils/timers';

function makeOnwarn() {
	const warned = Object.create(null);

	return (warning: any) => {
		const str = warning.toString();
		if (str in warned) return;
		console.error(str); //eslint-disable-line no-console
		warned[str] = true;
	};
}

// TODO Lukas extract type for entry module
function normalizeEntryModules(
	entryModules: string | string[] | Record<string, string>
): { alias: string | null; unresolvedId: string }[] {
	if (typeof entryModules === 'string') {
		return [{ alias: null, unresolvedId: entryModules }];
	}
	if (Array.isArray(entryModules)) {
		return entryModules.map(unresolvedId => ({ alias: null, unresolvedId }));
	}
	return Object.keys(entryModules).map(alias => ({ alias, unresolvedId: entryModules[alias] }));
}

function detectDuplicateEntryPoints(
	entryModulesWithAliases: { alias: string | null; module: Module }[]
) {
	const foundEntryModules = new Set<Module>();
	for (let i = 0; i < entryModulesWithAliases.length; i++) {
		const entryModule = entryModulesWithAliases[i].module;
		if (foundEntryModules.has(entryModule)) {
			error({
				code: 'DUPLICATE_ENTRY_POINTS',
				message: `Duplicate entry points detected. The input entries ${
					entryModulesWithAliases[i].alias
				} and ${
					entryModulesWithAliases.find(({ module }) => module === entryModule).alias
				} both point to the same module, ${entryModule.id}`
			});
		}
		foundEntryModules.add(entryModule);
	}
}

export default class Graph {
	acornOptions: acorn.Options;
	acornParser: typeof acorn.Parser;
	assetsById = new Map<string, Asset>();
	cachedModules: Map<string, ModuleJSON>;
	cacheExpiry: number;
	context: string;
	contextParse: (code: string, acornOptions?: acorn.Options) => ESTree.Program;
	curChunkIndex = 0;
	deoptimizationTracker: EntityPathTracker;
	externalModules: ExternalModule[] = [];
	// track graph build status as each graph instance is used only once
	finished = false;
	getModuleContext: (id: string) => string;
	isExternal: IsExternal;
	isPureExternalModule: (id: string) => boolean;
	moduleById = new Map<string, Module | ExternalModule>();
	moduleLoader: ModuleLoader;
	modules: Module[] = [];
	needsTreeshakingPass: boolean = false;
	onwarn: WarningHandler;
	pluginCache: Record<string, SerializablePluginCache>;
	pluginDriver: PluginDriver;
	preserveModules: boolean;
	scope: GlobalScope;
	shimMissingExports: boolean;
	// deprecated
	treeshake: boolean;
	treeshakingOptions: TreeshakingOptions;
	watchFiles: Record<string, true> = Object.create(null);

	constructor(options: InputOptions, watcher?: RollupWatcher) {
		this.curChunkIndex = 0;
		this.deoptimizationTracker = new EntityPathTracker();
		this.cachedModules = new Map();
		if (options.cache) {
			if (options.cache.modules)
				for (const module of options.cache.modules) this.cachedModules.set(module.id, module);
		}
		if (options.cache !== false) {
			this.pluginCache = (options.cache && options.cache.plugins) || Object.create(null);

			// increment access counter
			for (const name in this.pluginCache) {
				const cache = this.pluginCache[name];
				for (const key of Object.keys(cache)) cache[key][0]++;
			}
		}
		this.preserveModules = options.preserveModules;

		this.cacheExpiry = options.experimentalCacheExpiry;

		if (!options.input) {
			throw new Error('You must supply options.input to rollup');
		}

		this.treeshake = options.treeshake !== false;
		if (this.treeshake) {
			this.treeshakingOptions = options.treeshake
				? {
						annotations: (<TreeshakingOptions>options.treeshake).annotations !== false,
						propertyReadSideEffects:
							(<TreeshakingOptions>options.treeshake).propertyReadSideEffects !== false,
						pureExternalModules: (<TreeshakingOptions>options.treeshake).pureExternalModules
				  }
				: { propertyReadSideEffects: true, annotations: true, pureExternalModules: false };
			if (this.treeshakingOptions.pureExternalModules === true) {
				this.isPureExternalModule = () => true;
			} else if (typeof this.treeshakingOptions.pureExternalModules === 'function') {
				this.isPureExternalModule = this.treeshakingOptions.pureExternalModules;
			} else if (Array.isArray(this.treeshakingOptions.pureExternalModules)) {
				const pureExternalModules = new Set(this.treeshakingOptions.pureExternalModules);
				this.isPureExternalModule = id => pureExternalModules.has(id);
			} else {
				this.isPureExternalModule = () => false;
			}
		} else {
			this.isPureExternalModule = () => false;
		}

		this.contextParse = (code: string, options: acorn.Options = {}) =>
			this.acornParser.parse(code, {
				...defaultAcornOptions,
				...options,
				...this.acornOptions
			}) as any;

		this.pluginDriver = createPluginDriver(this, options, this.pluginCache, watcher);

		if (watcher) {
			const handleChange = (id: string) => this.pluginDriver.hookSeqSync('watchChange', [id]);
			watcher.on('change', handleChange);
			watcher.once('restart', () => {
				watcher.removeListener('change', handleChange);
			});
		}

		// TODO Lukas move this to the module loader
		if (typeof options.external === 'function') {
			const external = options.external;
			this.isExternal = (id, parentId, isResolved) =>
				!id.startsWith('\0') && external(id, parentId, isResolved);
		} else {
			const external = options.external;
			const ids = new Set(Array.isArray(external) ? external : external ? [external] : []);
			this.isExternal = id => ids.has(id);
		}

		this.shimMissingExports = options.shimMissingExports;
		this.scope = new GlobalScope();
		this.context = String(options.context);

		const optionsModuleContext = options.moduleContext;
		if (typeof optionsModuleContext === 'function') {
			this.getModuleContext = id => optionsModuleContext(id) || this.context;
		} else if (typeof optionsModuleContext === 'object') {
			const moduleContext = new Map();
			for (const key in optionsModuleContext) {
				moduleContext.set(resolve(key), optionsModuleContext[key]);
			}
			this.getModuleContext = id => moduleContext.get(id) || this.context;
		} else {
			this.getModuleContext = () => this.context;
		}

		this.onwarn = options.onwarn || makeOnwarn();
		this.acornOptions = options.acorn || {};
		const acornPluginsToInject = [];

		acornPluginsToInject.push(injectDynamicImportPlugin);
		acornPluginsToInject.push(injectImportMeta);

		if (options.experimentalTopLevelAwait) {
			(<any>this.acornOptions).allowAwaitOutsideFunction = true;
		}

		const acornInjectPlugins = options.acornInjectPlugins;
		acornPluginsToInject.push(
			...(Array.isArray(acornInjectPlugins)
				? acornInjectPlugins
				: acornInjectPlugins
				? [acornInjectPlugins]
				: [])
		);
		this.acornParser = <any>acorn.Parser.extend(...acornPluginsToInject);
		this.moduleLoader = new ModuleLoader(this, this.moduleById, this.pluginDriver);
	}

	build(
		entryModules: string | string[] | Record<string, string>,
		manualChunks: Record<string, string[]> | void,
		inlineDynamicImports: boolean
	): Promise<Chunk[]> {
		// Phase 1 – discovery. We load the entry module and find which
		// modules it imports, and import those, until we have all
		// of the entry module's dependencies

		timeStart('parse modules', 2);

		if (manualChunks) {
			this.moduleLoader.addManualChunks(manualChunks);
		}
		return this.moduleLoader
			.addEntryModules(normalizeEntryModules(entryModules))
			.then(({ entryModulesWithAliases, manualChunkModulesByAlias }) => {
				for (const module of Array.from(this.moduleById.values())) {
					if (module instanceof Module) {
						this.modules.push(module);
						this.watchFiles[module.id] = true;
					} else {
						this.externalModules.push(module);
					}
				}
				timeEnd('parse modules', 2);

				// Phase 2 - linking. We populate the module dependency links and
				// determine the topological execution order for the bundle
				timeStart('analyse dependency graph', 2);

				detectDuplicateEntryPoints(entryModulesWithAliases);

				this.link();

				const { orderedModules, cyclePaths } = analyseModuleExecution(
					entryModulesWithAliases.map(({ module }) => module)
				);
				for (const cyclePath of cyclePaths) {
					this.warn({
						code: 'CIRCULAR_DEPENDENCY',
						importer: cyclePath[0],
						message: `Circular dependency: ${cyclePath.join(' -> ')}`
					});
				}

				timeEnd('analyse dependency graph', 2);

				// Phase 3 – marking. We include all statements that should be included
				timeStart('mark included statements', 2);

				if (inlineDynamicImports) {
					if (entryModulesWithAliases.length > 1) {
						throw new Error(
							'Internal Error: can only inline dynamic imports for single-file builds.'
						);
					}
				}
				for (const { module } of entryModulesWithAliases) {
					module.includeAllExports();
				}
				this.includeMarked(orderedModules);

				// check for unused external imports
				for (const externalModule of this.externalModules) externalModule.warnUnusedImports();

				timeEnd('mark included statements', 2);

				// Phase 4 – we construct the chunks, working out the optimal chunking using
				// entry point graph colouring, before generating the import and export facades
				timeStart('generate chunks', 2);

				// TODO Lukas can we move the alias assigment into the colouring?
				if (!this.preserveModules && !inlineDynamicImports) {
					assignChunkColouringHashes(
						entryModulesWithAliases.map(({ module }) => module),
						manualChunkModulesByAlias
					);
				}

				for (let i = entryModulesWithAliases.length - 1; i >= 0; i--) {
					entryModulesWithAliases[i].module.chunkAlias = entryModulesWithAliases[i].alias;
				}

				// TODO: there is one special edge case unhandled here and that is that any module
				//       exposed as an unresolvable export * (to a graph external export *,
				//       either as a namespace import reexported or top-level export *)
				//       should be made to be its own entry point module before chunking
				let chunks: Chunk[] = [];
				if (this.preserveModules) {
					for (const module of orderedModules) {
						const chunk = new Chunk(this, [module]);
						if (module.isEntryPoint || !chunk.isEmpty) {
							chunk.entryModules = [module];
						}
						chunks.push(chunk);
					}
				} else {
					const chunkModules: { [entryHashSum: string]: Module[] } = {};
					for (const module of orderedModules) {
						const entryPointsHashStr = Uint8ArrayToHexString(module.entryPointsHash);
						const curChunk = chunkModules[entryPointsHashStr];
						if (curChunk) {
							curChunk.push(module);
						} else {
							chunkModules[entryPointsHashStr] = [module];
						}
					}

					for (const entryHashSum in chunkModules) {
						const chunkModulesOrdered = chunkModules[entryHashSum];
						sortByExecutionOrder(chunkModulesOrdered);
						const chunk = new Chunk(this, chunkModulesOrdered);
						chunks.push(chunk);
					}
				}

				// for each chunk module, set up its imports to other
				// chunks, if those variables are included after treeshaking
				for (const chunk of chunks) {
					chunk.link();
				}

				// filter out empty dependencies
				chunks = chunks.filter(
					chunk => !chunk.isEmpty || chunk.entryModules.length > 0 || chunk.isManualChunk
				);

				// then go over and ensure all entry chunks export their variables
				for (const chunk of chunks) {
					if (this.preserveModules || chunk.entryModules.length > 0) {
						chunk.generateEntryExportsOrMarkAsTainted();
					}
				}

				// create entry point facades for entry module chunks that have tainted exports
				const facades = [];
				if (!this.preserveModules) {
					for (const chunk of chunks) {
						for (const entryModule of chunk.entryModules) {
							if (chunk.facadeModule !== entryModule) {
								const entryPointFacade = new Chunk(this, []);
								entryPointFacade.turnIntoFacade(entryModule);
								facades.push(entryPointFacade);
							}
						}
					}
				}

				timeEnd('generate chunks', 2);

				this.finished = true;
				return chunks.concat(facades);
			});
	}

	finaliseAssets(assetFileNames: string) {
		const outputBundle: OutputBundle = Object.create(null);
		this.assetsById.forEach(asset => {
			if (asset.source !== undefined) finaliseAsset(asset, outputBundle, assetFileNames);
		});
		return outputBundle;
	}

	getCache(): RollupCache {
		// handle plugin cache eviction
		for (const name in this.pluginCache) {
			const cache = this.pluginCache[name];
			let allDeleted = true;
			for (const key of Object.keys(cache)) {
				if (cache[key][0] >= this.cacheExpiry) delete cache[key];
				else allDeleted = false;
			}
			if (allDeleted) delete this.pluginCache[name];
		}

		return <any>{
			modules: this.modules.map(module => module.toJSON()),
			plugins: this.pluginCache
		};
	}

	includeMarked(modules: Module[]) {
		if (this.treeshake) {
			let treeshakingPass = 1;
			do {
				timeStart(`treeshaking pass ${treeshakingPass}`, 3);
				this.needsTreeshakingPass = false;
				for (const module of modules) {
					if (module.isExecuted) module.include();
				}
				timeEnd(`treeshaking pass ${treeshakingPass++}`, 3);
			} while (this.needsTreeshakingPass);
		} else {
			// Necessary to properly replace namespace imports
			for (const module of modules) module.includeAllInBundle();
		}
	}

	warn(warning: RollupWarning) {
		warning.toString = () => {
			let str = '';

			if (warning.plugin) str += `(${warning.plugin} plugin) `;
			if (warning.loc)
				str += `${relativeId(warning.loc.file)} (${warning.loc.line}:${warning.loc.column}) `;
			str += warning.message;

			return str;
		};

		this.onwarn(warning);
	}

	private link() {
		for (const module of this.modules) {
			module.linkDependencies();
		}
		for (const module of this.modules) {
			module.bindReferences();
		}
		this.warnForMissingExports();
	}

	private warnForMissingExports() {
		for (const module of this.modules) {
			for (const importName of Object.keys(module.importDescriptions)) {
				const importDescription = module.importDescriptions[importName];
				if (
					importDescription.name !== '*' &&
					!importDescription.module.getVariableForExportName(importDescription.name)
				) {
					module.warn(
						{
							code: 'NON_EXISTENT_EXPORT',
							message: `Non-existent export '${
								importDescription.name
							}' is imported from ${relativeId(importDescription.module.id)}`,
							name: importDescription.name,
							source: importDescription.module.id
						},
						importDescription.start
					);
				}
			}
		}
	}
}
