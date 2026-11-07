// models-json-manager.ts
//
// 管理 pi 的 ~/.pi/agent/models.json：读 / 写 / 增 / 删 / 改。
//
// 主保存流程通过 models-json-sync.ts 同步 StateDocument；原始节点 mutation 在这里保留未知字段。
// 写入后由调用方执行 ctx.modelRegistry.refresh()，保持 pi 原生 models.json 语义。

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { cloneJson, isObjectRecord, stripJsonNoise } from "./common.ts";
import { readStableTextFileSnapshot, type FileSignature } from "./file-snapshot.ts";
import { t } from "./i18n.ts";
import type { TokenCost } from "./types.ts";

export const MODELS_JSON_PATH = join(getAgentDir(), "models.json");

// ========== schema ==========

export interface ModelsJsonModelEntry {
	id: string;
	name?: string;
	api?: string;
	baseUrl?: string;
	reasoning?: boolean;
	thinkingLevelMap?: Record<string, string | null>;
	input?: ("text" | "image")[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: TokenCost;
	headers?: Record<string, string>;
	compat?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface ModelsJsonProviderEntry {
	name?: string;
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	authHeader?: boolean;
	headers?: Record<string, string>;
	models?: ModelsJsonModelEntry[];
	modelOverrides?: Record<string, unknown>;
	compat?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface ModelsJsonDocument {
	providers: Record<string, ModelsJsonProviderEntry>;
	[key: string]: unknown;
}

const PLUGIN_PROVIDER_METADATA_KEY = "piModelManager";

export function hasPluginManagedProviderMarker(entry: ModelsJsonProviderEntry): boolean {
	const metadata = entry[PLUGIN_PROVIDER_METADATA_KEY];
	return isObjectRecord(metadata) && metadata.managed === true;
}

export function markProviderEntryAsPluginManaged(entry: ModelsJsonProviderEntry): ModelsJsonProviderEntry {
	const next = cloneJson(entry);
	const existing = isObjectRecord(next[PLUGIN_PROVIDER_METADATA_KEY])
		? next[PLUGIN_PROVIDER_METADATA_KEY] as Record<string, unknown>
		: {};
	next[PLUGIN_PROVIDER_METADATA_KEY] = { ...existing, managed: true };
	return next;
}

export function markManagedProvidersInDoc(
	doc: ModelsJsonDocument,
	providerIds: readonly string[],
): ModelsJsonDocument {
	let next = doc;
	for (const providerId of providerIds) {
		const entry = next.providers[providerId];
		if (!entry || hasPluginManagedProviderMarker(entry)) continue;
		// 内置覆写节点使用 nativeOverride 标记（不含 managed），不得在此补 managed:true。
		if (getProviderNativeOverrideFields(entry) !== undefined) continue;
		if (next === doc) next = cloneJson(doc);
		next.providers[providerId] = markProviderEntryAsPluginManaged(entry);
	}
	return next;
}

// ========== 内置接入覆写（局部节点，不带 models，pi 自行叠加在内置目录之上） ==========

export interface NativeOverrideProviderPatch {
	name?: string;
	baseUrl?: string;
	apiKey?: string;
	authHeader?: boolean;
	/** 内置模型覆盖表（键 = 模型 ID；非空对象才写入，空/缺失则清除）。 */
	modelOverrides?: Record<string, unknown>;
}

/**
 * [喵喵喵]: 覆写节点与整盘托管节点不同，不能带 managed:true —— 用户往覆写节点里手动加 models 后，
 * 应退回“非插件所有”状态，以免被整盘托管同步误改。
 */
export function getProviderNativeOverrideFields(entry: ModelsJsonProviderEntry): readonly string[] | undefined {
	const metadata = entry[PLUGIN_PROVIDER_METADATA_KEY];
	if (!isObjectRecord(metadata) || metadata.nativeOverride !== true) return undefined;
	const fields = metadata.fields;
	return Array.isArray(fields) ? fields.filter((field): field is string => typeof field === "string") : [];
}

const NATIVE_OVERRIDE_FIELD_NAMES = ["name", "baseUrl", "apiKey", "authHeader", "modelOverrides"] as const;

/** 把覆写字段写入 models.json 节点：每个字段非空则写、空则清除，同时记录当前覆写的字段清单。 */
export function applyNativeOverrideInDoc(
	doc: ModelsJsonDocument,
	providerId: string,
	patch: NativeOverrideProviderPatch,
): ModelsJsonDocument {
	const next = cloneJson(doc);
	const existing = isObjectRecord(next.providers[providerId]) ? next.providers[providerId]! : {};
	const marker = isObjectRecord(existing[PLUGIN_PROVIDER_METADATA_KEY])
		? existing[PLUGIN_PROVIDER_METADATA_KEY] as Record<string, unknown>
		: {};
	const written: string[] = [];
	const name = patch.name;
	if (typeof name === "string" && name.trim()) {
		existing.name = name.trim();
		written.push("name");
	} else delete existing.name;
	const baseUrl = patch.baseUrl;
	if (typeof baseUrl === "string" && baseUrl.trim()) {
		existing.baseUrl = baseUrl.trim();
		written.push("baseUrl");
	} else delete existing.baseUrl;
	const apiKey = patch.apiKey;
	if (typeof apiKey === "string" && apiKey.trim()) {
		existing.apiKey = apiKey.trim();
		written.push("apiKey");
	} else delete existing.apiKey;
	if (patch.authHeader === true) {
		existing.authHeader = true;
		written.push("authHeader");
	} else delete existing.authHeader;
	const modelOverrides = patch.modelOverrides;
	if (modelOverrides !== undefined && Object.keys(modelOverrides).length > 0) {
		existing.modelOverrides = cloneJson(modelOverrides);
		written.push("modelOverrides");
	} else delete existing.modelOverrides;
	next.providers[providerId] = {
		...existing,
		[PLUGIN_PROVIDER_METADATA_KEY]: { ...marker, nativeOverride: true, fields: written },
	};
	return next;
}

/** 取消覆写：剥离插件写入的覆写字段；节点里仍留有用户其它内容（如 models）则保留节点。 */
export function stripNativeOverrideInDoc(doc: ModelsJsonDocument, providerId: string): ModelsJsonDocument {
	const entry = doc.providers[providerId];
	if (!entry) return doc;
	if (getProviderNativeOverrideFields(entry) === undefined) return doc;
	// [喵喵喵]: 与 apply 对称 —— 这 4 个字段一经插件接管即为插件所有，取消时全部还原。
	const next = cloneJson(doc);
	const nextEntry = cloneJson(next.providers[providerId]!);
	for (const field of NATIVE_OVERRIDE_FIELD_NAMES) if (Object.hasOwn(nextEntry, field)) delete nextEntry[field];
	const marker = nextEntry[PLUGIN_PROVIDER_METADATA_KEY];
	const restMarker = isObjectRecord(marker) ? cloneJson(marker) as Record<string, unknown> : {};
	delete restMarker.nativeOverride;
	delete restMarker.fields;
	if (Object.keys(restMarker).length > 0) nextEntry[PLUGIN_PROVIDER_METADATA_KEY] = restMarker;
	else delete nextEntry[PLUGIN_PROVIDER_METADATA_KEY];
	const removableKeys = new Set<string>([...NATIVE_OVERRIDE_FIELD_NAMES, PLUGIN_PROVIDER_METADATA_KEY]);
	const remainingKeys = Object.keys(nextEntry).filter((key) => !removableKeys.has(key));
	if (remainingKeys.length === 0) delete next.providers[providerId];
	else next.providers[providerId] = nextEntry;
	return next;
}


export interface ModelsJsonSnapshot {
	document: ModelsJsonDocument;
	source: string | undefined;
	signature: FileSignature;
	contentHash: string;
}

// ========== IO ==========

function createEmpty(): ModelsJsonDocument {
	return { providers: {} };
}


function parseModelsJson(source: string): ModelsJsonDocument {
	const parsed = JSON.parse(stripJsonNoise(source));
	if (!isObjectRecord(parsed)) throw new Error(t("models.json 根节点必须是对象"));
	// [喵喵喵]: 字段缺失可以初始化；已有字段类型损坏必须拒写，不能把原始内容当空目录覆盖。
	if (Object.hasOwn(parsed, "providers") && !isObjectRecord(parsed.providers)) {
		throw new Error(t("{path} 必须是对象", { path: "models.json.providers" }));
	}
	const providers = parsed.providers ?? {};
	return { ...parsed, providers: providers as Record<string, ModelsJsonProviderEntry> };
}

export async function readModelsJsonSnapshot(): Promise<ModelsJsonSnapshot> {
	const snapshot = await readStableTextFileSnapshot(MODELS_JSON_PATH);
	return {
		document: snapshot.source === undefined ? createEmpty() : parseModelsJson(snapshot.source),
		source: snapshot.source,
		signature: snapshot.signature,
		contentHash: snapshot.contentHash,
	};
}
export function getModelsJsonPath(): string {
	return MODELS_JSON_PATH;
}

// ========== 文档操作（纯函数，深拷贝后改） ==========

export function setProviderInDoc(
	doc: ModelsJsonDocument,
	providerId: string,
	entry: ModelsJsonProviderEntry,
): ModelsJsonDocument {
	const next = cloneJson(doc);
	next.providers[providerId] = entry;
	return next;
}

export function deleteProviderInDoc(doc: ModelsJsonDocument, providerId: string): ModelsJsonDocument {
	const next = cloneJson(doc);
	delete next.providers[providerId];
	return next;
}

/** [喵喵喵]: 重命名直接移动原始节点，避免未知原生字段在 StateDocument 往返时丢失 (2026-07-17) */
export function renameProviderInDoc(
	doc: ModelsJsonDocument,
	oldProviderId: string,
	newProviderId: string,
): ModelsJsonDocument {
	const next = cloneJson(doc);
	if (oldProviderId === newProviderId) return next;
	const source = next.providers[oldProviderId];
	if (!source) throw new Error(t("models.json 中不存在待重命名接入：{providerId}", { providerId: oldProviderId }));
	if (next.providers[newProviderId]) throw new Error(t("models.json 中已存在接入：{providerId}", { providerId: newProviderId }));
	next.providers[newProviderId] = source;
	delete next.providers[oldProviderId];
	return next;
}

export function setModelInDoc(
	doc: ModelsJsonDocument,
	providerId: string,
	model: ModelsJsonModelEntry,
	replacedModelId?: string,
): ModelsJsonDocument {
	const next = cloneJson(doc);
	const provider = next.providers[providerId];
	if (!provider) throw new Error(t("models.json 中不存在接入：{providerId}", { providerId }));
	let replaced = false;
	const models = (provider.models ?? []).flatMap((current) => {
		if (current.id !== model.id && current.id !== replacedModelId) return [current];
		if (replaced) return [];
		replaced = true;
		return [model];
	});
	if (!replaced) models.push(model);
	provider.models = models;
	return next;
}

export function renameModelInDoc(
	doc: ModelsJsonDocument,
	providerId: string,
	oldModelId: string,
	newModelId: string,
): ModelsJsonDocument {
	const next = cloneJson(doc);
	if (oldModelId === newModelId) return next;
	const provider = next.providers[providerId];
	if (!provider) throw new Error(t("models.json 中不存在接入：{providerId}", { providerId }));
	const models = provider.models ?? [];
	const source = models.find((model) => model.id === oldModelId);
	if (!source) throw new Error(t("models.json 中不存在待重命名模型：{fullId}", { fullId: `${providerId}/${oldModelId}` }));
	if (models.some((model) => model.id === newModelId)) {
		throw new Error(t("models.json 中已存在模型：{fullId}", { fullId: `${providerId}/${newModelId}` }));
	}
	source.id = newModelId;
	return next;
}

export function deleteModelInDoc(
	doc: ModelsJsonDocument,
	providerId: string,
	modelId: string,
): ModelsJsonDocument {
	const next = cloneJson(doc);
	const provider = next.providers[providerId];
	if (!provider) return next;
	provider.models = (provider.models ?? []).filter((m) => m.id !== modelId);
	return next;
}
