import path from 'node:path';
import spawn from 'nano-spawn';
import type { PackageManager } from '../utils/detect-package-manager.ts';
import { getStdout } from '../utils/get-stdout.ts';
import type { Workspace, WorkspacePackage } from './discover.ts';

type CatalogConfiguration = {
	catalog?: Record<string, string>;
	catalogs?: Record<string, Record<string, string>>;
};

const parseCatalogJson = (output: string, manager: string): unknown => {
	try {
		return JSON.parse(output);
	} catch {
		throw new Error(`Could not read ${manager} catalog configuration.`);
	}
};

const isObject = (entry: unknown): entry is Record<string, unknown> => (
	entry !== null && typeof entry === 'object' && !Array.isArray(entry)
);
const isStringMap = (entry: unknown): entry is Record<string, string> => (
	isObject(entry) && Object.values(entry).every(item => typeof item === 'string')
);
const isCatalogs = (entry: unknown): entry is Record<string, Record<string, string>> => (
	isObject(entry) && Object.values(entry).every(isStringMap)
);

const assertCatalogConfiguration = (value: unknown, manager: string): CatalogConfiguration => {
	if (!isObject(value)
		|| (value.catalog !== undefined && !isStringMap(value.catalog))
		|| (value.catalogs !== undefined && !isCatalogs(value.catalogs))) {
		throw new Error(`Could not read ${manager} catalog configuration.`);
	}
	return value as CatalogConfiguration;
};

const parseCatalogConfiguration = (output: string, manager: string) => (
	assertCatalogConfiguration(parseCatalogJson(output, manager), manager)
);

const findCatalogReferences = (candidate: WorkspacePackage) => (
	(['dependencies', 'optionalDependencies', 'peerDependencies'] as const).flatMap(field => (
		Object.values(candidate.packageJson[field] ?? {}).filter((value): value is string => (
			typeof value === 'string' && value.startsWith('catalog:')
		))
	))
);

// Yarn resolves catalogs per package, so each referencing package queries its own configuration
const loadYarnCatalogs = async (
	directory: string,
	references: string[],
): Promise<CatalogConfiguration> => {
	const queries = [
		...(references.includes('catalog:') ? ['catalog'] : []),
		...(references.some(reference => reference !== 'catalog:') ? ['catalogs'] : []),
	] as const;
	const results = await Promise.all(queries.map(async (query) => {
		const output = await getStdout(spawn('yarn', ['config', 'get', query, '--json'], { cwd: directory }));
		return { [query]: parseCatalogJson(output, 'Yarn') };
	}));
	return assertCatalogConfiguration(Object.assign({}, ...results), 'Yarn');
};

const readBunCatalogs = (rootPackage: WorkspacePackage | undefined): CatalogConfiguration => {
	const root = rootPackage?.packageJson as (CatalogConfiguration & {
		workspaces?: string[] | CatalogConfiguration;
	}) | undefined;
	const workspaces = root?.workspaces;
	return {
		catalog: {
			...root?.catalog,
			...(Array.isArray(workspaces) ? undefined : workspaces?.catalog),
		},
		catalogs: {
			...root?.catalogs,
			...(Array.isArray(workspaces) ? undefined : workspaces?.catalogs),
		},
	};
};

/**
 * Loads catalog configuration only when a package references a catalog.
 * Returns the configuration that applies to a package directory.
 */
const loadCatalogs = async (
	packageManager: PackageManager,
	workspace: Workspace,
	candidates: WorkspacePackage[],
): Promise<(directory: string) => CatalogConfiguration> => {
	const referencesByPackage = candidates.map(candidate => (
		[candidate, findCatalogReferences(candidate)] as const
	));
	if (!referencesByPackage.some(([, references]) => references.length > 0)) {
		return () => ({});
	}
	if (packageManager === 'pnpm') {
		const catalogs = parseCatalogConfiguration(await getStdout(spawn('pnpm', ['config', 'list', '--json'], { cwd: workspace.rootDirectory })), 'pnpm');
		return () => catalogs;
	}
	if (packageManager === 'yarn') {
		const yarnCatalogs = new Map(await Promise.all(
			referencesByPackage
				.filter(([, references]) => references.length > 0)
				.map(async ([candidate, references]) => [
					candidate.dir,
					await loadYarnCatalogs(candidate.dir, references),
				] as const),
		));
		// Only packages with catalog references reach catalog resolution
		return directory => yarnCatalogs.get(directory)!;
	}
	if (packageManager === 'bun') {
		const catalogs = readBunCatalogs(workspace.rootPackage);
		return () => catalogs;
	}
	return () => ({});
};

const findCatalogRange = (
	packageManager: PackageManager,
	catalogs: CatalogConfiguration,
	catalogName: string,
	key: string,
) => {
	const name = packageManager === 'bun' ? catalogName.trim() : catalogName;
	if (!name || (packageManager !== 'yarn' && name === 'default')) {
		return catalogs.catalog?.[key] ?? (packageManager === 'yarn' ? undefined : catalogs.catalogs?.default?.[key]);
	}
	return catalogs.catalogs?.[name]?.[key];
};

// Catalog paths are relative to the workspace root; dependency paths are relative to the package
const rebaseCatalogPath = (range: string, from: WorkspacePackage, rootDirectory: string) => {
	const [, protocol, entry] = /^(?:(file|link|workspace):)?(.*)$/.exec(range)!;
	if (protocol !== 'file' && protocol !== 'link' && !/^\.{1,2}\//.test(entry!)) {
		return range;
	}
	const relative = path.relative(from.dir, path.resolve(rootDirectory, entry!));
	return `${protocol ?? 'file'}:${relative.startsWith('.') ? relative : `./${relative}`}`;
};

export const createCatalogResolver = async (
	packageManager: PackageManager,
	workspace: Workspace,
	candidates: WorkspacePackage[],
) => {
	const getCatalogs = await loadCatalogs(packageManager, workspace, candidates);
	const workspaceNames = new Set(candidates.map(candidate => candidate.name));
	return (from: WorkspacePackage, key: string, specification: string): string => {
		if (!specification.startsWith('catalog:')) {
			return specification;
		}
		const range = findCatalogRange(packageManager, getCatalogs(from.dir), specification.slice('catalog:'.length), key);
		if (typeof range === 'string') {
			return rebaseCatalogPath(range, from, workspace.rootDirectory);
		}
		if (workspaceNames.has(key)) {
			throw new Error(`Cannot resolve catalog reference ${JSON.stringify(specification)} for dependency ${JSON.stringify(key)} in package ${JSON.stringify(from.name)}.`);
		}
		return specification;
	};
};
