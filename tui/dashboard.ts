// tui/dashboard.ts
//
// 主 dashboard：列出 state 中所有接入/模型，操作通过快捷键触发。
//
// 流程：
//   dashboard → n → 接入编辑器 → 模型编辑器 → save & register
//   dashboard → [接入行] → 接入菜单 → Enter 编辑模型 / a 添加模型 / e 编辑接入
//   dashboard → h → 请求头面板
//
// 保存/删除事务委托给 model-mutations.ts，dashboard 只保留交互与校验流程。

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatUnknownError } from "../common.ts";
import { DEFAULT_COMPACTION_RESERVE_TOKENS, readCompactionSettings, resolveAutoCompactionReserve, resolveCompactionReserveChoice, saveModelCompactionOverride } from "../compaction-settings.ts";
import { getUiLanguage, setUiLanguage, t, type UiLanguage } from "../i18n.ts";
import { writeUiLanguage } from "../ui-language-settings.ts";
import {
	deleteModelConfiguration,
	deleteProviderConfiguration,
	saveModelConfiguration,
	saveNewProviderWithModelConfiguration,
	saveProviderConfiguration,
} from "../model-mutations.ts";
import {
	createModelDraftForStoredProvider,
	createModelDraftFromStoredModel,
	createModelOverrideDraft,
	createNativeOverrideProviderDraft,
	createProviderDraft,
	createProviderDraftFromStored,
	getModelFullId,
	getProviderChangeWarnings,
	getProviderDisplayName,
	upsertProviderInDocument,
	buildModelOverridePatch,
	mergeModelOverrideIn,
	patchNativeOverrideInDocument,
	validateModelDraft,
	validateNativeOverrideDraft,
	validateProviderDraft,
} from "../state-document.ts";
import { readState } from "../state-store.ts";
import { persistNativeOverrideConfiguration } from "../configuration-persistence.ts";
import { isModelEnabledPatterns, readEnabledModelStateForNextPiStart, type EnabledModelState } from "../models-json-sync.ts";
import { getBuiltinChatModelDefaults, getBuiltinProviderDefaults, getBuiltinProviderIds, getBuiltinProviderName, getBuiltinProviderRawDefaults } from "../builtin-model-catalog.ts";
import type { CompactionReserveChoice, ModelDraft, StateDocument, StoredModel, StoredProvider } from "../types.ts";
import { editModel } from "./editor-model.ts";
import { editModelOverride } from "./editor-model-override.ts";
import { editProvider } from "./editor-provider.ts";
import { showOptionPicker, showPersistentShortcutMenu, type MenuCursor } from "./persistent-menu.ts";
import { runScreenFlow } from "./screen-host.ts";
import { describeVisibilityTag, readScopedHiddenSet, toggleScopedModelVisibility } from "./scoped-model-visibility.ts";
import {
	formatModelListHeader,
	formatModelListRow,
	formatProviderConsoleHeader,
	formatProviderConsoleRow,
	formatProviderDetailLines,
	formatProviderEndpointLine,
	formatContextWindowShorthand,
	formatProviderSummaryLine,
	getModelColumnWidths,
	getProviderDisplayLabel,
	getProviderNameColumnWidth,
} from "./ui-helpers.ts";
import { runHeaderProfilesPanel } from "./header-profiles-panel.ts";

interface DashboardRow {
	providerId: string;
	label: string;
	searchText: string;
}

interface ProviderMenuRow {
	modelId: string;
	model: StoredModel;
	label: string;
	searchText: string;
}

function buildRows(document: StateDocument, builtInProviderIds: ReadonlySet<string>): DashboardRow[] {
	return Object.keys(document.providers)
		// 内置覆写视图同样入列；其余内置目录节点保持不可见。
		.filter((providerId) => !builtInProviderIds.has(providerId) || document.providers[providerId]!.nativeOverride === true)
		.sort((a, b) => a.localeCompare(b))
		.map((providerId) => {
			const provider = document.providers[providerId]!;
			const label = formatProviderConsoleRow(providerId, provider, 81, { requestHeaderProfiles: document.requestHeaderProfiles });
			// [喵喵喵]: label 已被列宽截断，搜索需要补上完整的接入 ID 与名称。
			return { providerId, label, searchText: `${providerId} ${getProviderDisplayName(providerId, provider)} ${label}` };
		});
}

function buildProviderMenuRows(provider: StoredProvider): ProviderMenuRow[] {
	return [...provider.models]
		.sort((a, b) => a.id.localeCompare(b.id))
		.map((model) => {
			const label = formatModelListRow(provider, model);
			return { modelId: model.id, model, label, searchText: `${model.id} ${model.name ?? ""} ${label}` };
		});
}

function notifyValidationErrors(ctx: ExtensionCommandContext, title: string, errors: string[]): void {
	ctx.ui.notify(t("{title}：\n{errors}", { title, errors: errors.map((error) => `- ${error}`).join("\n") }), "warning");
}

async function confirmWarnings(ctx: ExtensionCommandContext, warnings: string[]): Promise<boolean> {
	if (warnings.length === 0) return true;
	return ctx.ui.confirm(t("请确认改动"), t("{warnings}\n\n继续保存？", { warnings: warnings.join("\n") }));
}

async function selectUiLanguage(ctx: ExtensionCommandContext): Promise<void> {
	const currentLanguage = getUiLanguage();
	const choice = await showOptionPicker<{ id: UiLanguage; label: string }>(
		ctx,
		"语言 / Language",
		[
			{ id: "zh-CN", label: "简体中文 / Simplified Chinese" },
			{ id: "en", label: "English" },
		],
		currentLanguage,
	);
	if (!choice || choice.id === currentLanguage) return;
	try {
		await writeUiLanguage(choice.id);
		setUiLanguage(choice.id);
		ctx.ui.notify(t("语言已切换为 {language}", { language: choice.id === "en" ? "English" : "简体中文" }), "info");
	} catch (error) {
		ctx.ui.notify(t("语言设置保存失败：{error}", { error: formatUnknownError(error) }), "error");
	}
}


// ========== save 流程 ==========

async function saveProviderDraft(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	draft: ReturnType<typeof createProviderDraft>,
	oldProviderId: string | undefined,
): Promise<boolean> {
	try {
		const state = await readState();
		const builtInIds = await getBuiltinProviderIds();
		// 内置覆写没有“Base URL 必填/重命名检查”语义，使用独立校验。
		const errors = draft.nativeOverride
			? validateNativeOverrideDraft(draft)
			: validateProviderDraft(draft, state, builtInIds, oldProviderId);
		if (errors.length > 0) {
			notifyValidationErrors(ctx, t("接入配置无效"), errors);
			return false;
		}
		const current = oldProviderId ? state.providers[oldProviderId] : state.providers[draft.providerId];
		if (!(await confirmWarnings(ctx, getProviderChangeWarnings(current, draft)))) return false;

		await saveProviderConfiguration(pi, ctx, state, draft, oldProviderId);
		return true;
	} catch (error) {
		ctx.ui.notify(t("保存失败：{error}", { error: formatUnknownError(error) }), "error");
		return false;
	}
}

async function saveModelDraft(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	draft: ReturnType<typeof createModelDraftForStoredProvider>,
	replacedModelId: string | undefined,
): Promise<boolean> {
	try {
		const state = await readState();
		const errors = validateModelDraft(draft, state, replacedModelId);
		if (errors.length > 0) {
			notifyValidationErrors(ctx, t("模型配置无效"), errors);
			return false;
		}
		await saveModelConfiguration(pi, ctx, state, draft, replacedModelId);
		return true;
	} catch (error) {
		ctx.ui.notify(t("保存失败：{error}", { error: formatUnknownError(error) }), "error");
		return false;
	}
}

async function saveNewProviderAndModelDraft(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	providerDraft: ReturnType<typeof createProviderDraft>,
	modelDraft: ReturnType<typeof createModelDraftForStoredProvider>,
): Promise<boolean> {
	try {
		const state = await readState();
		const builtInIds = await getBuiltinProviderIds();
		const providerErrors = validateProviderDraft(providerDraft, state, builtInIds, undefined);
		if (providerErrors.length > 0) {
			notifyValidationErrors(ctx, t("接入配置无效"), providerErrors);
			return false;
		}
		const providerState = upsertProviderInDocument(state, undefined, providerDraft);
		const modelErrors = validateModelDraft(modelDraft, providerState, undefined);
		if (modelErrors.length > 0) {
			notifyValidationErrors(ctx, t("模型配置无效"), modelErrors);
			return false;
		}
		await saveNewProviderWithModelConfiguration(pi, ctx, providerState, providerDraft, modelDraft);
		return true;
	} catch (error) {
		ctx.ui.notify(t("保存失败：{error}", { error: formatUnknownError(error) }), "error");
		return false;
	}
}

// ========== delete 流程 ==========

async function deleteProvider(pi: ExtensionAPI, ctx: ExtensionCommandContext, providerId: string, provider: StoredProvider): Promise<boolean> {
	if (provider.nativeOverride) {
		const ok = await ctx.ui.confirm(
			t("取消内置接入覆写 {providerId}", { providerId }),
			t("将从 models.json 移除插件写入的覆写字段；该内置接入继续以 pi 内置定义工作。"),
		);
		if (!ok) return false;
		try {
			await deleteProviderConfiguration(pi, ctx, providerId, provider);
			return true;
		} catch (error) {
			ctx.ui.notify(t("取消覆写失败：{error}", { error: formatUnknownError(error) }), "error");
			return false;
		}
	}
	const ok = await ctx.ui.confirm(
		t("删除接入 {providerId}", { providerId }),
		t("将删除 {name} 下全部 {count} 个模型。", { name: getProviderDisplayName(providerId, provider), count: provider.models.length }),
	);
	if (!ok) return false;
	try {
		await deleteProviderConfiguration(pi, ctx, providerId, provider);
		return true;
	} catch (error) {
		ctx.ui.notify(t("删除失败：{error}", { error: formatUnknownError(error) }), "error");
		return false;
	}
}

async function deleteModel(pi: ExtensionAPI, ctx: ExtensionCommandContext, providerId: string, modelId: string): Promise<boolean> {
	const fullId = getModelFullId(providerId, modelId);
	const stateForPrompt = await readState();
	const currentProvider = stateForPrompt.providers[providerId];
	const removesLastModel = (currentProvider?.models.length ?? 0) <= 1;
	const ok = await ctx.ui.confirm(
		t("删除模型 {fullId}", { fullId }),
		removesLastModel ? t("这是该接入下最后一个模型；删除后接入也会从 models.json 中移除。") : t("只删除该模型，接入保留。"),
	);
	if (!ok) return false;
	try {
		await deleteModelConfiguration(pi, ctx, providerId, modelId);
		return true;
	} catch (error) {
		ctx.ui.notify(t("删除失败：{error}", { error: formatUnknownError(error) }), "error");
		return false;
	}
}

// ========== 内置接入覆写流程 ==========

/** 菜单行 id == 模型 id；Enter/搜索路径都按 id 反查，禁止索引猜测。 */
export function resolveOverrideMenuModel<TModel extends { id: string }>(
	chatModels: readonly TModel[],
	rowId: string,
): TModel | undefined {
	return chatModels.find((model) => model.id === rowId);
}

function formatOverrideModelLabel(
	model: { id: string; name?: string; contextWindow?: number; maxTokens?: number },
	overridden: boolean,
	hidden: boolean,
): string {
	const context = typeof model.contextWindow === "number"
		? formatContextWindowShorthand(model.contextWindow)
		: t("未知");
	const maxOutput = typeof model.maxTokens === "number"
		? formatContextWindowShorthand(model.maxTokens)
		: t("未知");
	const name = model.name && model.name !== model.id ? ` · ${model.name}` : "";
	const tags = [
		overridden ? t("已覆盖") : "",
		hidden ? t("已隐藏") : "",
	].filter(Boolean).join(" · ");
	return `${model.id}${name} · ${context} / ${maxOutput}${tags ? ` · ${tags}` : ""}`;
}

async function saveNativeOverrideModelOverride(
	ctx: ExtensionCommandContext,
	providerId: string,
	modelId: string,
	patch: Record<string, unknown>,
): Promise<boolean> {
	try {
		await persistNativeOverrideConfiguration(ctx, (latest) => ({
			document: patchNativeOverrideInDocument(latest, providerId, (stored) => {
				stored.modelOverrides = mergeModelOverrideIn(stored.modelOverrides, modelId, patch);
			}),
			changedProviderIds: [providerId],
			removedProviderIds: [],
			mergeProviderIds: [providerId],
		}));
		const fullId = getModelFullId(providerId, modelId);
		ctx.ui.notify(
			Object.keys(patch).length === 0
				? t("已移除该模型的覆盖 {fullId}", { fullId })
				: t("已保存模型覆盖 {fullId}", { fullId }),
			"info",
		);
		return true;
	} catch (error) {
		ctx.ui.notify(t("保存失败：{error}", { error: formatUnknownError(error) }), "error");
		return false;
	}
}

async function editNativeOverrideModel(
	ctx: ExtensionCommandContext,
	providerId: string,
	model: { id: string; name?: string; reasoning: boolean; contextWindow?: number; maxTokens?: number },
): Promise<boolean> {
	const pristine = await getBuiltinChatModelDefaults(providerId, model.id);
	if (!pristine) {
		ctx.ui.notify(t("内置目录中找不到该模型的默认值，无法计算覆盖差异：{fullId}", { fullId: getModelFullId(providerId, model.id) }), "warning");
		return false;
	}
	const draft = createModelOverrideDraft(model.id, pristine, model);
	draft.providerId = providerId;
	// [喵喵喵]: 压缩预留不在 modelOverrides 里（它在 Pi settings.json），但同样按 diff 语义保存。
	const fullModelId = getModelFullId(providerId, model.id);
	try {
		const snapshot = await readCompactionSettings(ctx.cwd);
		draft.compactionReserveGlobal = snapshot.reserveTokens;
		const reserveOverride = snapshot.modelOverrides[fullModelId]?.reserveTokens;
		if (typeof reserveOverride === "number") draft.compactionReserve = reserveOverride;
		else draft.compactionReserve = "global";
	} catch {
		draft.compactionReserve = "global";
		draft.compactionReserveWritable = false;
	}
	draft.compactionReserveInitial = draft.compactionReserve;
	// [喵喵喵]: scoped 可见性同样 diff —— 编辑器内的「显示」行与 X 快捷键共用状态。
	let scopedHiddenSet: Set<string>;
	try {
		scopedHiddenSet = await readScopedHiddenSet();
	} catch {
		scopedHiddenSet = new Set();
	}
	const scopedHiddenInitial = scopedHiddenSet.has(`${providerId}/${model.id}`.toLowerCase());
	draft.scopedHidden = scopedHiddenInitial;
	draft.scopedHiddenInitial = scopedHiddenInitial;
	// [喵喵喵]: diff 为空 => 该模型的覆盖会被摘除；保存失败保留草稿继续编辑。
	while (true) {
		const outcome = await editModelOverride(ctx, draft, pristine, t("模型覆盖 {providerId}/{modelId}", { providerId, modelId: model.id }));
		if (outcome.action !== "save") return false;
		const patch = buildModelOverridePatch(outcome.draft, pristine);
		if (!await saveNativeOverrideModelOverride(ctx, providerId, model.id, patch)) continue;
		await persistNativeOverrideModelCompaction(ctx, draft);
		if ((outcome.draft.scopedHidden ?? false) !== scopedHiddenInitial) {
			try {
				const hidden = await toggleScopedModelVisibility(ctx, providerId, model.id);
				ctx.ui.notify(t("{fullId} 已设为{visibility}（重启 Pi 后生效）", {
					fullId: getModelFullId(providerId, model.id),
					visibility: hidden ? t("隐藏") : t("显示"),
				}), "info");
			} catch (error) {
				ctx.ui.notify(formatUnknownError(error), "error");
			}
		}
		return true;
	}
}

async function persistNativeOverrideModelCompaction(
	ctx: ExtensionCommandContext,
	draft: { modelId: string; providerId: string; compactionReserve?: CompactionReserveChoice; compactionReserveInitial?: CompactionReserveChoice; compactionReserveWritable?: boolean; contextWindow: number },
): Promise<void> {
	const initial = draft.compactionReserveInitial ?? "global";
	const next = draft.compactionReserve ?? initial;
	if (!draft.compactionReserveWritable || initial === next) return;
	const fullModelId = getModelFullId(draft.providerId, draft.modelId);
	try {
		const reserveTokens = resolveCompactionReserveChoice(next, draft.contextWindow);
		const changed = await saveModelCompactionOverride({ fullModelId, reserveTokens });
		if (!changed) return;
		ctx.ui.notify(reserveTokens === undefined
			? t("已清除 {fullModelId} 的压缩预留覆盖；/reload 或重启 Pi 后生效", { fullModelId })
			: t("已设置 {fullModelId} 的压缩预留为 {tokens}；/reload 或重启 Pi 后生效", { fullModelId, tokens: reserveTokens }), "info");
	} catch (error) {
		ctx.ui.notify(t("压缩预留写入失败：{error}", { error: formatUnknownError(error) }), "warning");
	}
}

async function showNativeOverrideMenu(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	providerId: string,
): Promise<boolean> {
	const cursor: MenuCursor = { index: 0 };
	type OverrideMenuShortcut = "edit-provider" | "clear-override" | "toggle-hidden";
	while (true) {
		const state = await readState();
		const provider = state.providers[providerId];
		if (!provider?.nativeOverride) {
			ctx.ui.notify(t("接入配置已不存在：{providerId}", { providerId }), "warning");
			return true;
		}
		const overridden = new Set(Object.keys(provider.modelOverrides ?? {}));
		let enabledModelState: EnabledModelState = { configured: false, scope: undefined, patterns: [] };
		try {
			enabledModelState = await readEnabledModelStateForNextPiStart(ctx.cwd);
		} catch {
			enabledModelState = { configured: false, scope: undefined, patterns: [] };
		}
		const chatModels = [...(ctx.modelRegistry.getModelsOfType("chat", providerId) ?? [])]
			.sort((a, b) => a.id.localeCompare(b.id));
		const rows = chatModels.map((model) => {
			const hidden = enabledModelState.configured
				&& !isModelEnabledPatterns(enabledModelState.patterns, getModelFullId(providerId, model.id));
			return {
				id: model.id,
				label: formatOverrideModelLabel(model, overridden.has(model.id), hidden),
				searchText: `${model.id} ${model.name ?? ""}`,
			};
		});
		const action = await showPersistentShortcutMenu<OverrideMenuShortcut>(
			ctx,
			`/model-manager / ${getProviderDisplayName(providerId, provider)}`,
			"",
			rows,
			cursor,
			[
				{ input: "e", shortcut: "edit-provider" },
				{ input: "r", shortcut: "clear-override" },
				{ input: "x", shortcut: "toggle-hidden" },
			],
			{
				summaryLines: [
					t("{count} 项模型覆盖 · 模型清单来自 pi 当前注册表", { count: overridden.size }),
					t("Enter 修改单个模型的覆盖；r 恢复该模型为内置默认；e 编辑接入级覆写"),
					formatProviderEndpointLine(provider),
				],
				hints: [
					{ key: "↑↓", label: t("选择") },
					{ key: "Enter", label: t("模型覆盖") },
					{ key: "R", label: t("恢复默认") },
					{ key: "X", label: t("隐藏/显示") },
					{ key: "E", label: t("编辑接入") },
					{ key: "Esc", label: t("返回") },
				],
				emptyLabel: t("当前 pi 会话里该内置接入没有注册任何模型"),
			},
		);
		if (action.type === "cancel") return false;
		if (action.type === "shortcut") {
			if (action.shortcut === "clear-override") {
				const selectedId = rows[cursor.index]?.id;
				if (!selectedId || !overridden.has(selectedId)) {
					ctx.ui.notify(t("该模型没有可直接恢复的覆盖。"), "info");
					continue;
				}
				if (await saveNativeOverrideModelOverride(ctx, providerId, selectedId, {})) {
					try {
						if (await saveModelCompactionOverride({ fullModelId: getModelFullId(providerId, selectedId), reserveTokens: undefined })) {
							ctx.ui.notify(t("已清除该模型的压缩预留覆盖；/reload 或重启 Pi 后生效"), "info");
						}
					} catch (error) {
						ctx.ui.notify(t("压缩预留清理失败：{error}", { error: formatUnknownError(error) }), "warning");
					}
				}
				continue;
			}
			if (action.shortcut === "toggle-hidden") {
				await toggleScopedModelVisibility(ctx, providerId, rows[cursor.index]?.id ?? "").catch((error) => ctx.ui.notify(formatUnknownError(error), "error"));
				continue;
			}
			if (action.shortcut === "edit-provider") {
				await editOverrideStoredProvider(pi, ctx, providerId, provider);
				continue;
			}
			continue;
		}
		// [喵喵喵]: 行 id 就是模型 ID；过滤/滚动窗口里都应按 id 反查，避免索引错位。
		const selectedModel = resolveOverrideMenuModel(chatModels, action.id);
		if (!selectedModel) continue;
		await editNativeOverrideModel(ctx, providerId, selectedModel);
	}
}

async function editBuiltInOverride(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	draft: ReturnType<typeof createProviderDraft>,
): Promise<boolean> {
	// [喵喵喵]: 保存失败时保留草稿继续编辑
	while (true) {
		const outcome = await editProvider(ctx, draft, t("覆写内置接入 {providerId}", { providerId: draft.providerId }), {});
		if (outcome.action !== "save") return false;
		if (await saveProviderDraft(pi, ctx, outcome.draft, outcome.draft.providerId)) return true;
	}
}

async function editOverrideStoredProvider(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	providerId: string,
	stored: StoredProvider,
): Promise<boolean> {
	const draft = createProviderDraftFromStored(providerId, stored);
	draft.providerId = providerId;
	const defaults = await getBuiltinProviderDefaults(providerId);
	if (defaults?.baseUrl) draft.builtinBaseUrlHint = defaults.baseUrl;
	return editBuiltInOverride(pi, ctx, draft);
}

async function createBuiltinOverride(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<boolean> {
	const state = await readState();
	const builtInIds = [...(await getBuiltinProviderIds())].sort((a, b) => a.localeCompare(b));
	if (builtInIds.length === 0) {
		ctx.ui.notify(t("pi 内置接入目录不可用，暂无法覆写内置接入。"), "warning");
		return false;
	}
	const choices: { id: string; label: string; authed: boolean; hasOverride: boolean; name: string }[] = [];
	for (const providerId of builtInIds) {
		const name = (await getBuiltinProviderName(providerId)) ?? providerId;
		const hasOverride = state.providers[providerId]?.nativeOverride === true;
		// [喵喵喵]: 以当前 credentials（env/auth.json）判断内置接入是否已可用，已可用的排前面并提供标识。
		let authed = false;
		try {
			authed = ctx.modelRegistry.getProviderAuthStatus(providerId).configured === true;
		} catch {
			authed = false;
		}
		const base = `${name} (${providerId})`;
		const tags = [
			authed ? t("已连接") : "",
			hasOverride ? t("已有覆写") : "",
		].filter(Boolean).join(" · ");
		choices.push({ id: providerId, label: tags ? `${base} · ${tags}` : base, authed, hasOverride, name });
	}
	choices.sort((a, b) => Number(b.authed) - Number(a.authed)
		|| Number(b.hasOverride) - Number(a.hasOverride)
		|| a.name.localeCompare(b.name));
	// 无“当前选择”语义：新建覆写时不标 ● 当前，避免首行被误标。
	const choice = await showOptionPicker(ctx, t("选择内置接入进行覆写"), choices, "");
	if (!choice) return false;
	const providerId = choice.id;
	const storedOverride = state.providers[providerId]?.nativeOverride
		? state.providers[providerId]!
		: undefined;
	if (storedOverride) return editOverrideStoredProvider(pi, ctx, providerId, storedOverride);
	// [喵喵喵]: 用原始协议默认值（如 openai-codex-responses）：覆写只覆盖静态凭据/地址字段，协议不再受扩展支持面限制。
	const defaults = await getBuiltinProviderRawDefaults(providerId);
	if (!defaults?.api) {
		ctx.ui.notify(t("pi 内置目录中缺少该接入的默认协议信息，暂无法覆写：{providerId}", { providerId }), "warning");
		return false;
	}
	return editBuiltInOverride(pi, ctx, createNativeOverrideProviderDraft(providerId, defaults.api, defaults.baseUrl));
}

// ========== 子菜单 ==========

type ProviderShortcut = "add-model" | "edit-provider" | "delete-model" | "toggle-visibility";

// [喵喵喵]: 压缩预留保存在 Pi 的 settings.json，不在 models.json；
// 打开模型编辑器时先读回已有覆盖，否则保存会把用户之前设的值当成“跟随全局”清掉。
// 返回值是全局预留，供编辑器显示 global 档位的实际 token。
async function loadCompactionDraftState(
	ctx: ExtensionCommandContext,
	draft: ModelDraft,
	fullModelId?: string,
): Promise<number> {
	try {
		const snapshot = await readCompactionSettings(ctx.cwd);
		for (const warning of snapshot.warnings) ctx.ui.notify(`[pi-model-manager] ${warning}`, "warning");
		draft.compactionReserveWritable = true;
		if (fullModelId) {
			const stored = snapshot.modelOverrides[fullModelId]?.reserveTokens;
			// 存下来的值正好是 12% 公式的结果，就继续按 auto 处理：改上下文窗口时跟着变。
			draft.compactionReserve = stored === undefined
				? "global"
				: stored === resolveAutoCompactionReserve(draft.contextWindow) ? "auto" : stored;
		} else {
			// 新建模型默认按上下文窗口 12% 预留（不低于 16K）。
			draft.compactionReserve = "auto";
		}
		return snapshot.reserveTokens;
	} catch (error) {
		// 读不到就不写：保留 undefined 但禁用写入，避免误删已有覆盖。
		draft.compactionReserveWritable = false;
		ctx.ui.notify(t("读取压缩设置失败，本次不会修改压缩预留：{error}", { error: formatUnknownError(error) }), "warning");
		return DEFAULT_COMPACTION_RESERVE_TOKENS;
	}
}

async function editStoredModel(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	providerId: string,
	provider: StoredProvider,
	modelId: string,
	requestHeaderProfiles: StateDocument["requestHeaderProfiles"],
	clientHeaderCaptures: StateDocument["clientHeaderCaptures"],
): Promise<boolean> {
	const model = provider.models.find((m) => m.id === modelId);
	if (!model) {
		ctx.ui.notify(t("模型不存在：{fullId}", { fullId: getModelFullId(providerId, modelId) }), "error");
		return false;
	}
	const draft = createModelDraftFromStoredModel(providerId, provider, model);
	const inheritedCompactionReserve = await loadCompactionDraftState(ctx, draft, getModelFullId(providerId, modelId));
	// [喵喵喵]: 保存失败时保留草稿继续编辑，防止用户修改的 contextWindow/maxTokens 等配置丢失
	while (true) {
		const outcome = await editModel(
			ctx,
			draft,
			t("编辑模型 {fullId}", { fullId: getModelFullId(providerId, modelId) }),
			requestHeaderProfiles,
			clientHeaderCaptures,
			inheritedCompactionReserve,
		);
		if (outcome.action !== "save") return false;
		const saved = await saveModelDraft(pi, ctx, outcome.draft, modelId);
		if (saved) return true;
	}
}

async function showProviderMenu(pi: ExtensionAPI, ctx: ExtensionCommandContext, providerId: string): Promise<boolean> {
	const cursor: MenuCursor = { index: 0 };
	while (true) {
		const state = await readState();
		const currentProvider = state.providers[providerId];
		if (!currentProvider) {
			ctx.ui.notify(t("接入配置已不存在：{providerId}", { providerId }), "warning");
			return true;
		}
		let scopedHiddenSet: Set<string>;
		try {
			scopedHiddenSet = await readScopedHiddenSet();
		} catch {
			scopedHiddenSet = new Set();
		}
		const rows = buildProviderMenuRows(currentProvider).map((row) => ({
			...row,
			label: `${row.label}${describeVisibilityTag(scopedHiddenSet.has(`${providerId}/${row.modelId}`.toLowerCase())) ? ` · ${t("已隐藏")}` : ""}`,
		}));
		const modelColumns = getModelColumnWidths(currentProvider.models);
		const action = await showPersistentShortcutMenu<ProviderShortcut>(
			ctx,
			`/model-manager / ${getProviderDisplayName(providerId, currentProvider)}`,
			"",
			rows.map((row, index) => ({ id: `${index}`, label: row.label, searchText: row.searchText })),
			cursor,
			[
				{ input: "a", shortcut: "add-model" },
				{ input: "e", shortcut: "edit-provider" },
				{ input: "d", shortcut: "delete-model" },
				{ input: "v", shortcut: "toggle-visibility" },
			],
			{
				summaryLines: [
					formatProviderSummaryLine(currentProvider, state.requestHeaderProfiles),
					formatProviderEndpointLine(currentProvider),
				],
				tableHeader: (width) => formatModelListHeader(currentProvider, width, modelColumns),
				formatRow: (menuRow, width, theme) => {
					const row = rows[Number.parseInt(menuRow.id, 10)];
					return row ? formatModelListRow(currentProvider, row.model, width, { ...modelColumns, theme }) : menuRow.label;
				},
				visibleRows: Math.min(12, Math.max(1, rows.length)),
				hints: [
					{ key: "↑↓", label: t("选择") },
					{ key: "Enter", label: t("编辑模型") },
					{ key: "A", label: t("添加模型") },
					{ key: "E", label: t("编辑接入") },
					{ key: "D", label: t("删除模型") },
					{ key: "V", label: t("显示/隐藏") },
					{ key: "Esc", label: t("返回") },
				],
				emptyLabel: t("暂无模型；按 a 添加第一个模型"),
			},
		);
		if (action.type === "cancel") return false;
		if (action.type === "shortcut") {
			if (action.shortcut === "add-model") {
				const draft = createModelDraftForStoredProvider(providerId, currentProvider);
				const inheritedCompactionReserve = await loadCompactionDraftState(ctx, draft);
				// [喵喵喵]: 新增模型校验或保存失败时保留草稿
				while (true) {
					const outcome = await editModel(
						ctx,
						draft,
						t("添加模型到 {providerId}", { providerId }),
						state.requestHeaderProfiles,
						state.clientHeaderCaptures,
						inheritedCompactionReserve,
					);
					if (outcome.action !== "save") break;
					const saved = await saveModelDraft(pi, ctx, outcome.draft, undefined);
					if (saved) break;
				}
				continue;
			}
			if (action.shortcut === "edit-provider") {
				const draft = createProviderDraftFromStored(providerId, currentProvider);
				// [喵喵喵]: 编辑接入保存失败或重命名冲突时保留草稿，不退回主面板
				while (true) {
					const outcome = await editProvider(ctx, draft, t("编辑接入 {providerId}", { providerId }), state.requestHeaderProfiles);
					if (outcome.action !== "save") break;
					const saved = await saveProviderDraft(pi, ctx, outcome.draft, providerId);
					if (saved) {
						if (outcome.draft.providerId !== providerId) return true;
						break;
					}
				}
				continue;
			}
			if (action.shortcut === "toggle-visibility") {
				const selectedModelId = rows[cursor.index]?.modelId;
				if (!selectedModelId) {
					ctx.ui.notify(t("没有可切换的模型。"), "info");
					continue;
				}
				try {
					const hidden = await toggleScopedModelVisibility(ctx, providerId, selectedModelId);
					ctx.ui.notify(t("{fullId} 已设为{visibility}（重启 Pi 后生效）", {
						fullId: getModelFullId(providerId, selectedModelId),
						visibility: hidden ? t("隐藏") : t("显示"),
					}), "info");
				} catch (error) {
					ctx.ui.notify(formatUnknownError(error), "error");
				}
				continue;
			}
			const selectedModelId = rows[cursor.index]?.modelId;
			if (!selectedModelId) {
				ctx.ui.notify(t("没有可删除的模型；删除接入请返回上一级按 d。"), "info");
				continue;
			}
			await deleteModel(pi, ctx, providerId, selectedModelId);
			continue;
		}
		const row = rows[Number.parseInt(action.id, 10)];
		if (!row) return false;
		await editStoredModel(pi, ctx, providerId, currentProvider, row.modelId, state.requestHeaderProfiles, state.clientHeaderCaptures);
	}
}

async function createProviderAndModel(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<boolean> {
	const stateBeforeEdit = await readState();
	const builtInIds = await getBuiltinProviderIds();
	const providerDraft = createProviderDraft();
	providerDraft.providerName = "";
	while (true) {
		const providerOutcome = await editProvider(
			ctx,
			providerDraft,
			t("新建接入配置"),
			stateBeforeEdit.requestHeaderProfiles,
		);
		if (providerOutcome.action !== "save") return false;
		const providerErrors = validateProviderDraft(providerOutcome.draft, stateBeforeEdit, builtInIds, undefined);
		if (providerErrors.length > 0) {
			notifyValidationErrors(ctx, t("接入配置无效"), providerErrors);
			continue;
		}

		const stagedState = upsertProviderInDocument(stateBeforeEdit, undefined, providerOutcome.draft);
		const stored = stagedState.providers[providerOutcome.draft.providerId]!;
		ctx.ui.notify(t("请继续添加第一个模型；取消模型编辑则不会创建该接入。"), "info");
		const modelDraft = createModelDraftForStoredProvider(providerOutcome.draft.providerId, stored);
		const inheritedCompactionReserve = await loadCompactionDraftState(ctx, modelDraft);
		while (true) {
			const modelOutcome = await editModel(
				ctx,
				modelDraft,
				t("添加模型到 {providerId}", { providerId: providerOutcome.draft.providerId }),
				stagedState.requestHeaderProfiles,
				stagedState.clientHeaderCaptures,
				inheritedCompactionReserve,
			);
			if (modelOutcome.action !== "save") return false;
			const saved = await saveNewProviderAndModelDraft(pi, ctx, providerOutcome.draft, modelOutcome.draft);
			if (saved) return true;
		}
	}
}

// ========== 入口 ==========

type DashboardShortcut = "new-provider" | "edit-builtin" | "header-profiles" | "delete-provider" | "language";

export async function runDashboard(pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<void> {
	const cursor: MenuCursor = { index: 0 };
	// [喵喵喵]: 整条 dashboard 流程共用一个 ctx.ui.custom 对话框（见 screen-host.ts），
	// 页面切换只在宿主动态换屏，不再先退回主输入框再重开，终端上不会闪。
	await runScreenFlow(ctx, (hostCtx) => runDashboardLoop(pi, hostCtx, cursor));
}

async function runDashboardLoop(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	cursor: MenuCursor,
): Promise<void> {
	while (true) {
		const state = await readState();
		const builtInProviderIds = await getBuiltinProviderIds();
		const rows = buildRows(state, builtInProviderIds);
		const nameWidth = getProviderNameColumnWidth(
			rows.map((row) => getProviderDisplayLabel(row.providerId, state.providers[row.providerId]!)),
		);
		const modelCount = rows.reduce((sum, row) => sum + (state.providers[row.providerId]?.models.length ?? 0), 0);
		const profileCount = Object.keys(state.requestHeaderProfiles).length;
		const captureCount = Object.keys(state.clientHeaderCaptures).length;
		const menuRows = rows.map((r, index) => ({ id: `${index}`, label: r.label, searchText: r.searchText }));
		const action = await showPersistentShortcutMenu<DashboardShortcut>(
			ctx,
			"/model-manager",
			"",
			menuRows,
			cursor,
			[
				{ input: "n", shortcut: "new-provider" },
				{ input: "b", shortcut: "edit-builtin" },
				{ input: "h", shortcut: "header-profiles" },
				{ input: "d", shortcut: "delete-provider" },
				{ input: "l", shortcut: "language" },
			],
			{
				summaryLines: [t("{providers} 接入 · {models} 模型 · {captures} 内置抓包 · {profiles} 自定义请求头", {
					providers: rows.length,
					models: modelCount,
					captures: captureCount,
					profiles: profileCount,
				})],
				tableHeader: (width) => formatProviderConsoleHeader(width, { nameWidth }),
				formatRow: (menuRow, width, theme) => {
					const row = rows[Number.parseInt(menuRow.id, 10)];
					const provider = row ? state.providers[row.providerId] : undefined;
					return row && provider
						? formatProviderConsoleRow(row.providerId, provider, width, { requestHeaderProfiles: state.requestHeaderProfiles, theme, nameWidth })
						: menuRow.label;
				},
				getDetailLines: (selectedRow, theme) => {
					const row = rows[Number.parseInt(selectedRow?.id ?? "", 10)];
					const provider = row ? state.providers[row.providerId] : undefined;
					return row && provider
						? formatProviderDetailLines(row.providerId, provider, { requestHeaderProfiles: state.requestHeaderProfiles, theme })
						: [];
				},
				hints: [
					{ key: "↑↓", label: t("选择") },
					{ key: "Enter", label: t("进入") },
					{ key: "N", label: t("新建接入") },
					{ key: "B", label: t("内置接入") },
					{ key: "D", label: t("删除接入") },
					{ key: "H", label: t("请求头管理") },
					{ key: "L", label: "语言 / Language" },
					{ key: "Esc", label: t("退出") },
				],
				emptyLabel: t("暂无自定义接入；按 n 新建，按 b 覆写内置接入"),
			},
		);
		if (action.type === "cancel") return;
		if (action.type === "shortcut") {
			if (action.shortcut === "new-provider") await createProviderAndModel(pi, ctx);
			if (action.shortcut === "edit-builtin") await createBuiltinOverride(pi, ctx);
			if (action.shortcut === "header-profiles") await runHeaderProfilesPanel(pi, ctx);
			if (action.shortcut === "language") await selectUiLanguage(ctx);
			if (action.shortcut === "delete-provider") {
				const selectedProviderId = rows[cursor.index]?.providerId;
				const selectedProvider = selectedProviderId ? state.providers[selectedProviderId] : undefined;
				if (selectedProviderId && selectedProvider) await deleteProvider(pi, ctx, selectedProviderId, selectedProvider);
				else ctx.ui.notify(t("没有可删除的接入。"), "info");
			}
			continue;
		}
		const index = Number.parseInt(action.id, 10);
		if (!Number.isFinite(index) || index < 0 || index >= rows.length) continue;
		const row = rows[index]!;
		const provider = state.providers[row.providerId];
		if (!provider) {
			ctx.ui.notify(t("接入配置已不存在：{providerId}", { providerId: row.providerId }), "warning");
			continue;
		}
		// 内置覆写没有模型菜单，直接进入覆写编辑器。
		if (provider.nativeOverride) {
			await showNativeOverrideMenu(pi, ctx, row.providerId);
			continue;
		}
		await showProviderMenu(pi, ctx, row.providerId);
	}
}
