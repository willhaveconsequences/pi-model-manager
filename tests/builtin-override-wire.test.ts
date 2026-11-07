// 真实 Pi 内置目录下的内置接入覆写端到端检查：
// 局部节点 → 运行时视图 → 覆写补丁往返 → 取消覆写还原。
// 断言不涉及网络与请求发送；覆写接入不注册动态 Provider。

import assert from "node:assert/strict";
import test from "node:test";

const realRuntime = process.env.PI_MODEL_MANAGER_REAL_RUNTIME === "1";

const { getBuiltinProviderDefaults, isBuiltinProviderId } = await import("../builtin-model-catalog.ts");
const { applyNativeOverrideInDoc, stripNativeOverrideInDoc } = await import("../models-json-manager.ts");
const { buildStateDocumentFromModelsJson } = await import("../state-store.ts");
const { buildNativeOverrideProviderPatch } = await import("../models-json-sync.ts");
import type { MetadataDocument } from "../state-metadata-store.ts";
import type { ModelsJsonDocument } from "../models-json-manager.ts";

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
	};
}

test("真实 Pi：anthropic 内置覆写局部节点合成视图并往返", { skip: !realRuntime, timeout: 15_000 }, async () => {
	assert.equal(await isBuiltinProviderId("anthropic"), true);
	const defaults = await getBuiltinProviderDefaults("anthropic");
	assert.ok(defaults?.api);
	assert.ok(defaults?.baseUrl);

	// 保存时写入的是 SDK 原生形式（toNativeBaseUrl 结果）；此处直接用内置默认等价值模拟。
	let doc = applyNativeOverrideInDoc(emptyDoc(), "anthropic", { baseUrl: "https://gateway.example.com", apiKey: "$ANTHROPIC_API_KEY" });
	assert.deepEqual(Object.keys(doc.providers), ["anthropic"]);

	const state = await buildStateDocumentFromModelsJson(doc, metadataWithManaged("anthropic"));
	const stored = state.providers.anthropic!;
	assert.ok(stored);
	assert.equal(stored.nativeOverride, true);
	assert.deepEqual(stored.models, []);
	assert.equal(stored.api, defaults.api);
	// 运行时视图还原为用户侧根地址；anthropic 官方根地址在 SDK 层本来就带 /v1（builtin 默认已是原生形态）。
	assert.ok(stored.baseUrl.startsWith("https://gateway.example.com"));

	// 保存路径：视图 → 原生补丁；地址回落为原生形式。
	const patch = buildNativeOverrideProviderPatch("anthropic", stored);
	assert.equal(patch.apiKey, "$ANTHROPIC_API_KEY");
	assert.ok(String(patch.baseUrl).startsWith("https://gateway.example.com"));

	// 取消覆写：局部节点整体消失，内置定义继续生效。
	doc = stripNativeOverrideInDoc(doc, "anthropic");
	assert.equal(doc.providers.anthropic, undefined);
});

test("真实 Pi：仅分类器的内置接入不可覆写，节点保留但不出现在视图中", { skip: !realRuntime, timeout: 15_000 }, async () => {
	assert.equal(await isBuiltinProviderId("typesafe"), true);
	assert.equal(await getBuiltinProviderDefaults("typesafe"), undefined);
	const doc = applyNativeOverrideInDoc(emptyDoc(), "typesafe", { apiKey: "x" });
	const state = await buildStateDocumentFromModelsJson(doc, metadataWithManaged("typesafe"));
	assert.equal(state.providers.typesafe, undefined);
	// 节点仍在 models.json 中；未获得插件视图意味着不可经 TUI 编辑。
	assert.ok(doc.providers.typesafe);
});
