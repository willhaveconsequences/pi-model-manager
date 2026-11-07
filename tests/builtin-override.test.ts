// 内置接入覆写：纯函数边界测试。
// 不依赖 pi runtime（模型清单与认证仍由 pi 管理，插件只写 models.json 局部节点）。

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const agentDir = await mkdtemp(join(tmpdir(), "pi-model-manager-builtin-override-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

const { applyNativeOverrideInDoc, stripNativeOverrideInDoc, getProviderNativeOverrideFields } = await import("../models-json-manager.ts");
const { buildNativeOverrideProviderPatch } = await import("../models-json-sync.ts");
const {
	createModelOverrideDraft,
	buildModelOverridePatch,
	mergeModelOverrideIn,
	patchNativeOverrideInDocument,
	createNativeOverrideProviderDraft,
	createProviderDraftFromStored,
	buildNativeOverrideFromDraft,
	validateNativeOverrideDraft,
	upsertProviderInDocument,
} = await import("../state-document.ts");
const { buildStateDocumentFromModelsJson } = await import("../state-store.ts");
import type { ModelsJsonDocument, ModelsJsonProviderEntry } from "../models-json-manager.ts";
import type { BuiltinChatModelBaseline, ModelOverrideDraft } from "../state-document.ts";
import type { MetadataDocument } from "../state-metadata-store.ts";
import type { StoredProvider } from "../types.ts";

function emptyDoc(): ModelsJsonDocument {
	return { providers: {} };
}

function metadataWithManaged(providerId: string): MetadataDocument {
	return {
		version: 5,
		managedProviderIds: [providerId],
		providers: {},
		models: {},
		requestHeaderProfiles: {},
		clientHeaderCaptures: {},
	} as unknown as MetadataDocument;
}

test("覆写补丁非空字段写入、空字段同时清除并记录 fields 清单", () => {
	const applied = applyNativeOverrideInDoc(emptyDoc(), "anthropic", {
		baseUrl: "https://gateway.example.com",
		apiKey: "$ANTHROPIC_API_KEY",
		authHeader: false,
	});
	const entry = applied.providers.anthropic!;
	assert.equal(entry.baseUrl, "https://gateway.example.com");
	assert.equal(entry.apiKey, "$ANTHROPIC_API_KEY");
	assert.equal("authHeader" in entry, false);
	assert.deepEqual(getProviderNativeOverrideFields(entry), ["baseUrl", "apiKey"]);
	assert.equal("name" in entry, false);
});

test("覆写补丁保留节点中用户自己的未知字段", () => {
	const source = emptyDoc();
	source.providers.anthropic = {
		name: "用户显示名",
		models: [{ id: "claude-manual", contextWindow: 100000, maxTokens: 8000 }],
		note: "keep me",
	};
	const applied = applyNativeOverrideInDoc(source, "anthropic", { baseUrl: "https://relay.example.com/v1" });
	const entry = applied.providers.anthropic!;
	assert.equal(entry.baseUrl, "https://relay.example.com/v1");
	assert.deepEqual(entry.models, [{ id: "claude-manual", contextWindow: 100000, maxTokens: 8000 }]);
	assert.equal((entry as Record<string, unknown>).note, "keep me");
});

test("取消覆写剥离插件字段、保留用户内容；空节点整体删除", () => {
	let doc = applyNativeOverrideInDoc(emptyDoc(), "anthropic", { baseUrl: "https://gateway.example.com" });
	doc = stripNativeOverrideInDoc(doc, "anthropic");
	assert.equal(doc.providers.anthropic, undefined);

	const source = emptyDoc();
	source.providers.anthropic = { models: [{ id: "m1" }] } as ModelsJsonProviderEntry;
	doc = applyNativeOverrideInDoc(source, "anthropic", { apiKey: "sk-test" });
	doc = stripNativeOverrideInDoc(doc, "anthropic");
	const entry = doc.providers.anthropic!;
	assert.deepEqual(Object.keys(entry), ["models"]);
});

test("取消覆写不打扰无覆写标记的节点", () => {
	const source = emptyDoc();
	source.providers.openai = { baseUrl: "https://manual.example.com" };
	assert.equal(stripNativeOverrideInDoc(source, "openai"), source);
});

test("覆写视图合成：双重所有权齐全时可见，缺标记或非内置 ID 不可见", async () => {
	// stub 环境内置目录为空：builtinDefaults 注入 undefined → 不可见（不可劫持非内置 ID）。
	const doc = applyNativeOverrideInDoc(emptyDoc(), "anthropic", { baseUrl: "https://gateway.example.com" });
	const state = await buildStateDocumentFromModelsJson(doc, metadataWithManaged("anthropic"));
	assert.equal(state.providers.anthropic, undefined);
});

test("内置覆写补丁转换：地址转 SDK 原生形式，未设字段缺省", () => {
	const stored: StoredProvider = {
		name: "Fed Anthropic",
		api: "anthropic-messages",
		// runtime 形式（SDK 拼 /v1），保存前应转回原生根地址
		baseUrl: "https://gateway.example.com/v1",
		managed: true,
		nativeOverride: true,
		clientHeaderProfile: "recommended",
		models: [],
		apiKey: "$ANTHROPIC_API_KEY",
		authHeader: true,
	};
	assert.deepEqual(buildNativeOverrideProviderPatch("anthropic", stored), {
		name: "Fed Anthropic",
		baseUrl: "https://gateway.example.com",
		apiKey: "$ANTHROPIC_API_KEY",
		authHeader: true,
	});
	// 名称与内置 ID 相同时视为未覆盖
	const sameName = { ...stored, name: "anthropic" };
	const patch = buildNativeOverrideProviderPatch("anthropic", sameName);
	assert.equal("name" in patch, false);
});

test("覆写草稿与校验：ID 固定；Base URL 可留空", () => {
	const draft = createNativeOverrideProviderDraft("anthropic", "anthropic-messages");
	assert.equal(draft.nativeOverride, true);
	assert.equal(draft.baseUrl, "");
	assert.deepEqual(validateNativeOverrideDraft(draft), []);
	draft.baseUrl = "not a url";
	assert.equal(validateNativeOverrideDraft(draft).length, 1);
});

test("覆写 stored 视图读取回 draft 再构建保持字段不变", () => {
	const draft = createNativeOverrideProviderDraft("anthropic", "anthropic-messages");
	draft.providerName = "Fed Anthropic";
	draft.baseUrl = "https://gateway.example.com/v1";
	draft.apiKey = "$ANTHROPIC_API_KEY";
	draft.authHeader = true;
	const stored = buildNativeOverrideFromDraft(undefined, draft);
	assert.equal(stored.nativeOverride, true);
	assert.deepEqual(stored.models, []);
	assert.equal(stored.baseUrl, "https://gateway.example.com/v1");
	const roundTrip = createProviderDraftFromStored("anthropic", stored);
	assert.equal(roundTrip.nativeOverride, true);
	assert.equal(roundTrip.providerName, "Fed Anthropic");
	assert.equal(roundTrip.baseUrl, "https://gateway.example.com/v1");
	assert.equal(roundTrip.apiKey, "$ANTHROPIC_API_KEY");
	assert.equal(roundTrip.authHeader, true);
});

test("覆写 upsert 会登记 managedProviderIds 以便序列化", () => {
	const state = upsertProviderInDocument(
		{ version: 2, providers: {}, managedProviderIds: [], requestHeaderProfiles: {}, clientHeaderCaptures: {} },
		undefined,
		(() => {
			const draft = createNativeOverrideProviderDraft("anthropic", "anthropic-messages");
			draft.baseUrl = "https://gateway.example.com/v1";
			return draft;
		})(),
	);
	assert.deepEqual(state.managedProviderIds, ["anthropic"]);
	const stored = state.providers.anthropic!;
	assert.equal(stored.nativeOverride, true);
});

// ========== 内置模型级覆盖 ==========

const MODEL_BASELINE: BuiltinChatModelBaseline = {
	name: "GPT X",
	reasoning: true,
	contextWindow: 400_000,
	maxTokens: 32_000,
};

function draftFrom(draft: Partial<ModelOverrideDraft>): ModelOverrideDraft {
	const base = createModelOverrideDraft("gpt-x", MODEL_BASELINE, {
		name: "GPT X",
		reasoning: true,
		contextWindow: 400_000,
		maxTokens: 32_000,
	});
	return { ...base, ...draft };
}

test("模型覆盖 diff：与内置默认相同不写，改动字段精确写入", () => {
	assert.deepEqual(buildModelOverridePatch(draftFrom({}), MODEL_BASELINE), {});
	assert.deepEqual(
		buildModelOverridePatch(draftFrom({ contextWindow: 1_000_000, reasoning: false }), MODEL_BASELINE),
		{ contextWindow: 1_000_000, reasoning: false },
	);
	assert.deepEqual(
		buildModelOverridePatch(draftFrom({ modelName: "我的 GPT X" }), MODEL_BASELINE),
		{ name: "我的 GPT X" },
	);
	// 显示名清空（跟随内置）不写 name；无内置名称时改 ID 等价也不写
	assert.deepEqual(buildModelOverridePatch(draftFrom({ modelName: "" }), MODEL_BASELINE), {});
	assert.deepEqual(
		buildModelOverridePatch(draftFrom({ modelName: "gpt-x" }), { ...MODEL_BASELINE, name: undefined }),
		{},
	);
});

test("modelOverrides 的合并/摘除与覆写节点写入", () => {
	let doc = applyNativeOverrideInDoc(emptyDoc(), "openai-codex", {
		baseUrl: "https://gateway.example.com",
		modelOverrides: { "gpt-x": { contextWindow: 1_000_000 } },
	});
	const entry = doc.providers["openai-codex"]!;
	assert.deepEqual((entry.modelOverrides as Record<string, unknown>)["gpt-x"], { contextWindow: 1_000_000 });
	assert.deepEqual(getProviderNativeOverrideFields(entry), ["baseUrl", "modelOverrides"]);

	// 空 modelOverrides 补丁 = 清除该字段
	doc = applyNativeOverrideInDoc(doc, "openai-codex", { baseUrl: "https://gateway.example.com", modelOverrides: {} });
	assert.equal(doc.providers["openai-codex"]!.modelOverrides, undefined);

	// 取消覆写剥离 modelOverrides
	doc = applyNativeOverrideInDoc(doc, "openai-codex", { modelOverrides: { "gpt-x": { reasoning: false } } });
	doc = stripNativeOverrideInDoc(doc, "openai-codex");
	assert.equal(doc.providers["openai-codex"], undefined);
});

test("覆写补丁透传 modelOverrides", () => {
	const stored: StoredProvider = {
		name: "openai-codex",
		api: "openai-codex-responses",
		baseUrl: "",
		managed: true,
		nativeOverride: true,
		clientHeaderProfile: "recommended",
		modelOverrides: { "gpt-x": { contextWindow: 500_000 } },
		models: [],
	};
	const patch = buildNativeOverrideProviderPatch("openai-codex", stored);
	assert.deepEqual(patch.modelOverrides, { "gpt-x": { contextWindow: 500_000 } });
	assert.equal("baseUrl" in patch, false);
});

test("patchNativeOverrideInDocument 只改覆写记录", () => {
	const state = upsertProviderInDocument(
		{ version: 2, providers: {}, managedProviderIds: [], requestHeaderProfiles: {}, clientHeaderCaptures: {} },
		undefined,
		createNativeOverrideProviderDraft("openai-codex", "openai-codex-responses"),
	);
	const next = patchNativeOverrideInDocument(state, "openai-codex", (record) => {
		record.modelOverrides = mergeModelOverrideIn(record.modelOverrides, "gpt-x", { maxTokens: 64_000 });
	});
	const record = next.providers["openai-codex"]!;
	assert.deepEqual((record.modelOverrides as Record<string, unknown>)["gpt-x"], { maxTokens: 64_000 });
	assert.equal(next === state, false);
});
