// tui/model-visibility-panel.ts
//
// scoped-model 可见性接管面板。
//
// pi 的 enabledModels 是纯正向 allowlist（无取反），手编白名单体验很差；
// 本面板把“模型可见性”变成状态清单：hidden 集合存在 state.json，
// enabledModels 由扩展按“当前注册表 − hidden”推导重算：
//   - 未隐藏模型的 provider 写 provider/*（pi 升级的新模型默认可见）；
//   - 有隐藏模型的 provider 逐个枚举可见模型。
// 会话启动时也会重算一次，保证 pi 升级后新模型自动纳入。

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatUnknownError } from "../common.ts";
import { t } from "../i18n.ts";
import {
	buildEnabledPatternsFromVisibility,
	readEnabledModelStateForNextPiStart,
} from "../models-json-sync.ts";
import { persistScopedModelVisibility } from "../models-json-sync.ts";
import { readState } from "../state-store.ts";
import { showPersistentShortcutMenu, type MenuCursor } from "./persistent-menu.ts";
import { formatApiShort } from "./ui-helpers.ts";

const API_HINT = "Api";

interface PanelModelRow { provider: string; id: string; name?: string; api?: string }

function collectChatModels(ctx: ExtensionCommandContext): PanelModelRow[] {
	const models = (ctx.modelRegistry.getAll() ?? []) as { provider: string; id: string; name?: string; api?: string }[];
	return models.filter((model) => typeof model.provider === "string" && typeof model.id === "string");
}

function collectProviderBlocks(ctx: ExtensionCommandContext): { providerId: string; chatModelIds: string[] }[] {
	const map = new Map<string, Set<string>>();
	for (const model of collectChatModels(ctx)) {
		if (!map.has(model.provider)) map.set(model.provider, new Set());
		map.get(model.provider)!.add(model.id);
	}
	return [...map.entries()]
		.map(([providerId, ids]) => ({ providerId, chatModelIds: [...ids].sort((a, b) => a.localeCompare(b)) }))
		.sort((a, b) => a.providerId.localeCompare(b.providerId));
}

function formatVisibilityLine(
	providerId: string,
	modelId: string,
	name: string | undefined,
	api: string | undefined,
	hidden: boolean,
): string {
	const namePart = name && name !== modelId ? ` · ${name}` : "";
	const apiPart = api ? ` · ${formatApiShort(api as never)}` : ` · ${API_HINT}`;
	const tags = [hidden ? t("已隐藏") : t("已显示")].filter(Boolean).join(" · ");
	return `${providerId} · ${modelId}${namePart}${apiPart}${tags ? ` · ${tags}` : ""}`;
}

/** 单个模型的隐藏切换；接管语义下同时重算 enabledModels。 */
export async function toggleScopedModelVisibility(
	ctx: ExtensionCommandContext,
	providerId: string,
	modelId: string,
): Promise<boolean> {
	try {
		const document = await readState();
		const hidden = new Set(document.scopedModelVisibility?.hiddenModelIds ?? []);
		const fullModelId = `${providerId}/${modelId}`;
		let becameHidden: boolean;
		const lowerFullId = fullModelId.toLowerCase();
		const existing = [...hidden].find((id) => id.toLowerCase() === lowerFullId);
		if (existing !== undefined) {
			// [喵喵喵]: 删除时用已存储（小写）的那个 key，避免大小写差异留下僵尸条目。
			hidden.delete(existing);
			becameHidden = false;
		} else {
			hidden.add(fullModelId.toLowerCase());
			becameHidden = true;
		}
		// [喵喵喵]: 先写 hidden 集合（state.json），再按当前注册表全量重算 enabledModels（settings.json）。
		await persistScopedModelVisibility(ctx, [...hidden]);
		ctx.ui.notify(becameHidden
			? t("已隐藏 {fullModelId}（白名单已重算，重启后生效）", { fullModelId })
			: t("已恢复显示 {fullModelId}（白名单已重算，重启后生效）", { fullModelId }), "info");
		return becameHidden;
	} catch (error) {
		ctx.ui.notify(t("可见性切换失败：{error}", { error: formatUnknownError(error) }), "error");
		return false;
	}
}

export async function runModelVisibilityPanel(_pi: ExtensionAPI, ctx: ExtensionCommandContext): Promise<boolean> {
	const cursor: MenuCursor = { index: 0 };
	while (true) {
		const state = await readState();
		const hiddenRaw = state.scopedModelVisibility?.hiddenModelIds ?? [];
		const hidden = new Set(hiddenRaw.map((id) => id.toLowerCase()));
		const chatModels = collectChatModels(ctx)
			.sort((a, b) => (a.provider === b.provider ? a.id.localeCompare(b.id) : a.provider.localeCompare(b.provider)));
		const rows = chatModels.map((model) => {
			const isHidden = hidden.has(`${model.provider}/${model.id}`.toLowerCase());
			return {
				id: `${model.provider}/${model.id}`,
				label: formatVisibilityLine(model.provider, model.id, model.name, model.api, isHidden),
				searchText: `${model.provider}/${model.id} ${model.name ?? ""}`,
			};
		});
		const blocks = collectProviderBlocks(ctx);
		const projectedPatterns = buildEnabledPatternsFromVisibility(
			chatModels.filter((model) => hidden.has(`${model.provider}/${model.id}`.toLowerCase())).map((model) => `${model.provider}/${model.id}`),
			blocks,
		);
		let enabledState;
		try {
			enabledState = await readEnabledModelStateForNextPiStart(ctx.cwd);
		} catch {
			enabledState = { configured: false, scope: undefined, patterns: [] };
		}
		const action = await showPersistentShortcutMenu(
			ctx,
			t("模型可见性（scoped-model 接管）"),
			"",
			rows,
			cursor,
			[],
			{
				summaryLines: [
					t("接管中：enabledModels 由扩展按注册表 − 隐藏清单重算；· 已隐藏 = 白名单外"),
					t("Enter 切换显示/隐藏；重启 Pi 后生效。当前白名单 {count} 条（来源 {scope}）", {
						count: projectedPatterns.length,
						scope: enabledState.configured
							? (enabledState.scope === "project" ? t("项目 settings.json") : t("全局 settings.json"))
							: t("未配置"),
					}),
					state.scopedModelVisibility !== undefined
						? t("接管状态已启用；隐藏清单 {count} 项", { count: hidden.size })
						: t("尚未接管：首次隐藏某个模型即开启接管"),
				],
				hints: [
					{ key: "↑↓", label: t("选择") },
					{ key: "Enter", label: t("切换") },
					{ key: "/", label: t("搜索") },
					{ key: "Esc", label: t("返回") },
				],
				emptyLabel: t("当前注册表没有可选模型"),
			},
		);
		if (action.type === "cancel") return false;
		if (action.type === "shortcut") continue;
		// Enter：切换该行可见性
		const parts = String(action.id).split("/");
		const providerId = parts[0];
		const modelId = parts.slice(1).join("/");
		await toggleScopedModelVisibility(ctx, providerId, modelId);
	}
}
