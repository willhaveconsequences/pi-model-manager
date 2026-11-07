// Pi 内置模型 catalog 边界。
//
// [喵喵喵]: Pi 0.80.8 移除 AuthStorage 且目录运行时异步化，必须隔离读取内置目录 (2026-07-17)
// 仅为读取 Pi 内置目录创建运行时，不读取用户 auth.json/models.json，
// 也不允许目录读取触发模型网络请求。

import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ApiKind, ProviderApiId } from "./types.ts";

interface BuiltinProviderDefaults {
	api?: ApiKind;
	baseUrl?: string;
}

interface BuiltinCatalogModel {
	provider: string;
	api: string;
	baseUrl: string;
	id?: string;
	name?: string;
	reasoning?: boolean;
	contextWindow?: number;
	maxTokens?: number;
}

interface BuiltinCatalog {
	models: readonly BuiltinCatalogModel[];
	providerIds: ReadonlySet<string>;
	providerNames: ReadonlyMap<string, string>;
}

export interface BuiltinProviderRawDefaults {
	/** pi 原生接入的第一优先协议，不做扩展支持面过滤（如 openai-codex-responses）。 */
	api: ProviderApiId;
	baseUrl?: string;
}

const SUPPORTED_API_KINDS = new Set<ApiKind>([
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
]);

const emptyCredentialStore = {
	async read(): Promise<undefined> {
		return undefined;
	},
	async list(): Promise<readonly []> {
		return [];
	},
	async modify(): Promise<undefined> {
		return undefined;
	},
	async delete(): Promise<void> {
		return undefined;
	},
};

let builtinCatalogPromise: Promise<BuiltinCatalog> | undefined;

function getBuiltinCatalog(): Promise<BuiltinCatalog> {
	builtinCatalogPromise ??= ModelRuntime.create({
		credentials: emptyCredentialStore,
		modelsPath: null,
		allowModelNetwork: false,
	}).then((runtime) => ({
		models: runtime.getModels().map((model) => ({
			provider: String(model.provider),
			api: String(model.api),
			baseUrl: model.baseUrl,
			id: typeof model.id === "string" ? model.id : undefined,
			name: typeof model.name === "string" ? model.name : undefined,
			reasoning: typeof model.reasoning === "boolean" ? model.reasoning : undefined,
			contextWindow: typeof model.contextWindow === "number" && model.contextWindow > 0 ? model.contextWindow : undefined,
			maxTokens: typeof model.maxTokens === "number" && model.maxTokens > 0 ? model.maxTokens : undefined,
		})),
		// [喵喵喵]: 聊天目录不包含仅提供生图或分类器的接入；保护 ID 必须取完整接入目录。
		providerIds: new Set(runtime.getProviders().map((provider) => provider.id)),
		providerNames: new Map(runtime.getProviders().map((provider) => [provider.id, provider.name])),
	}));

	return builtinCatalogPromise;
}

export async function getBuiltinProviderIds(): Promise<ReadonlySet<string>> {
	return (await getBuiltinCatalog()).providerIds;
}

export async function getBuiltinProviderName(providerId: string): Promise<string | undefined> {
	return (await getBuiltinCatalog()).providerNames.get(providerId);
}

export async function isBuiltinProviderId(providerId: string): Promise<boolean> {
	return (await getBuiltinProviderIds()).has(providerId);
}

function asSupportedApiKind(value: string | undefined): ApiKind | undefined {
	return value && SUPPORTED_API_KINDS.has(value as ApiKind)
		? (value as ApiKind)
		: undefined;
}

export async function getBuiltinProviderDefaults(
	providerId: string,
): Promise<BuiltinProviderDefaults | undefined> {
	const firstModel = (await getBuiltinCatalog()).models.find(
		(model) => model.provider === providerId,
	);
	if (!firstModel) return undefined;

	return {
		api: asSupportedApiKind(firstModel.api),
		baseUrl: firstModel.baseUrl,
	};
}

/** [喵喵喵]: 覆写视图需要携带 pi 原生接入的真实协议（codex-responses 等扩展不干预的 api 也允许覆写凭据/地址）。 */
export interface BuiltinChatModelDefaults {
	name?: string;
	reasoning: boolean;
	contextWindow: number | undefined;
	maxTokens: number | undefined;
}

/** 内置模型未受任何覆盖时的默认值；模型级覆写仅写入与该值不同的字段。 */
export async function getBuiltinChatModelDefaults(
	providerId: string,
	modelId: string,
): Promise<BuiltinChatModelDefaults | undefined> {
	const builtin = (await getBuiltinCatalog()).models.find(
		(model) => model.provider === providerId && model.id === modelId,
	);
	if (!builtin) return undefined;
	return {
		name: builtin.name,
		reasoning: builtin.reasoning ?? false,
		contextWindow: builtin.contextWindow,
		maxTokens: builtin.maxTokens,
	};
}

/** [喵喵喵]: 覆写视图需要携带 pi 原生接入的真实协议（codex-responses 等扩展不干预的 api 也允许覆写凭据/地址）。 */
export async function getBuiltinProviderRawDefaults(providerId: string): Promise<BuiltinProviderRawDefaults | undefined> {
	const firstModel = (await getBuiltinCatalog()).models.find(
		(model) => model.provider === providerId,
	);
	if (!firstModel) return undefined;
	return { api: firstModel.api, baseUrl: firstModel.baseUrl };
}
