// tui/editor-model-override.ts
//
// 内置接入的模型级覆盖编辑器：改动的字段写入 models.json 覆写节点 modelOverrides；
// 未改动字段通过 diff 自动排除，改回内置值即解除覆盖。

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { t } from "../i18n.ts";
import type { CompactionReserveChoice, ModelOverrideDraft } from "../types.ts";
import { DEFAULT_COMPACTION_RESERVE_TOKENS, resolveAutoCompactionReserve, resolveCompactionReserveChoice } from "../compaction-settings.ts";
import type { BuiltinChatModelBaseline } from "../state-document.ts";
import { COMPACTION_RESERVE_PRESETS, cycleNumericPreset, parseNonNegativeTokenCount } from "./editor-model.ts";
import { formatContextWindowShorthand } from "./ui-helpers.ts";
import {
	markAdjustableValue,
	padLabel,
	showOptionPicker,
	showPersistentFormMenu,
	type HorizontalDirection,
	type MenuCursor,
} from "./persistent-menu.ts";

interface FieldRow {
	id: string;
	label: string;
	value: string;
	adjustable?: boolean;
}

const REASONING_ORDER: readonly boolean[] = [true, false];
const COMPACT_RESERVE_STOPS: readonly CompactionReserveChoice[] = ["global", "auto", ...COMPACTION_RESERVE_PRESETS];

function cycleReasoning(current: boolean, direction: HorizontalDirection): boolean {
	const index = REASONING_ORDER.indexOf(current);
	const offset = direction === "right" ? 1 : -1;
	return REASONING_ORDER[(index + offset + REASONING_ORDER.length) % REASONING_ORDER.length]!;
}

function formatKeepBuiltin(value: number, pristine: number | undefined): string {
	if (pristine !== undefined && value === pristine) return t("跟随内置");
	return String(value);
}

function describeReserve(draft: ModelOverrideDraft): string {
	const choice = draft.compactionReserve ?? "global";
	if (choice === "global") {
		// [喵喵喵]: 明确标出"未覆盖"——这个数值是 pi 的全局回落，不是本模型的独立预算。
		return `${draft.compactionReserveGlobal ?? DEFAULT_COMPACTION_RESERVE_TOKENS} · ${t("全局（未覆盖）")}`;
	}
	// auto 和固定值都可能算出同样的 token，标出档位才能区分。
	if (choice === "auto") return `${resolveAutoCompactionReserve(draft.contextWindow)} · auto`;
	return `${choice} · ${t("已覆盖")}`;
}

function describeReserveThreshold(draft: ModelOverrideDraft): string {
	const reserve = resolveCompactionReserveChoice(draft.compactionReserve ?? "global", draft.contextWindow)
		?? draft.compactionReserveGlobal ?? DEFAULT_COMPACTION_RESERVE_TOKENS;
	return t("压缩阈值 {threshold} = 上下文 {context} − 预留 {reserve}", {
		threshold: Math.max(0, draft.contextWindow - reserve),
		context: draft.contextWindow,
		reserve,
	});
}

function buildRows(draft: ModelOverrideDraft, pristine: BuiltinChatModelBaseline): FieldRow[] {
	const pristineContext = pristine.contextWindow !== undefined ? formatContextWindowShorthand(pristine.contextWindow) : t("未知");
	const pristineMax = pristine.maxTokens !== undefined ? formatContextWindowShorthand(pristine.maxTokens) : t("未知");
	// [喵喵喵]: 行序对齐自建模型编辑器的心智：身份 → 命名 → 可见性 → 能力 → 预算。
	return [
		{ id: "modelId", label: t("模型 ID"), value: draft.modelId },
		{
			id: "modelName",
			label: t("显示名"),
			value: draft.modelName.trim()
				? draft.modelName.trim()
				: (pristine.name && pristine.name !== draft.modelId ? `${t("跟随内置")}（${pristine.name}）` : t("跟随内置")),
		},
		{ id: "scopedVisible", label: t("显示"), value: draft.scopedHidden ? `${t("隐藏")}（${t("已隐藏")}）` : t("显示"), adjustable: true },
		{
			id: "reasoning",
			label: t("推理"),
			value: `${draft.reasoning ? t("开") : t("关")}（${t("内置")} ${pristine.reasoning ? t("开") : t("关")}）`,
			adjustable: true,
		},
		{ id: "contextWindow", label: t("上下文窗口"), value: `${formatKeepBuiltin(draft.contextWindow, pristine.contextWindow)}（${t("内置")} ${pristineContext}）` },
		{ id: "maxTokens", label: t("最大输出"), value: `${formatKeepBuiltin(draft.maxTokens, pristine.maxTokens)}（${t("内置")} ${pristineMax}）` },
		{
			id: "compactionReserve",
			label: t("压缩预留"),
			value: describeReserve(draft),
			adjustable: true,
		},
	];
}

function applyHorizontalToggle(draft: ModelOverrideDraft, fieldId: string, direction: HorizontalDirection): boolean {
	if (fieldId === "scopedVisible") {
		draft.scopedHidden = !draft.scopedHidden;
		return true;
	}
	if (fieldId === "reasoning") {
		draft.reasoning = cycleReasoning(draft.reasoning, direction);
		return true;
	}
	if (fieldId === "compactionReserve") {
		const current = draft.compactionReserve ?? "global";
		const index = COMPACT_RESERVE_STOPS.indexOf(current);
		if (index >= 0) {
			const offset = direction === "left" ? -1 : 1;
			draft.compactionReserve = COMPACT_RESERVE_STOPS[(index + offset + COMPACT_RESERVE_STOPS.length) % COMPACT_RESERVE_STOPS.length]!;
		} else {
			// 手填值不在档位上：按数值吸附到相邻固定档位。
			draft.compactionReserve = cycleNumericPreset(current as number, COMPACTION_RESERVE_PRESETS, direction);
		}
		return true;
	}
	return false;
}

async function editIntField(
	ctx: ExtensionCommandContext,
	draft: ModelOverrideDraft,
	field: "contextWindow" | "maxTokens",
	pristine: BuiltinChatModelBaseline,
): Promise<void> {
	const label = field === "contextWindow" ? t("上下文窗口") : t("最大输出");
	const builtinValue = pristine[field];
	const raw = await ctx.ui.input(t(
		"{label}（正整数；当前：{current}；留空还原为内置默认 {pristine}）",
		{
			label,
			current: String(draft[field]),
			pristine: builtinValue !== undefined ? String(builtinValue) : t("未知"),
		},
	), "");
	if (raw === undefined) return;
	const trimmed = raw.trim();
	if (!trimmed) {
		if (builtinValue !== undefined) draft[field] = builtinValue;
		return;
	}
	const parsed = Number.parseInt(trimmed, 10);
	if (Number.isInteger(parsed) && parsed > 0) draft[field] = parsed;
	else ctx.ui.notify(t("{label} 必须是正整数", { label }), "warning");
}

async function editReasoningField(ctx: ExtensionCommandContext, draft: ModelOverrideDraft): Promise<void> {
	const choice = await showOptionPicker(ctx, t("推理"), [
		{ id: "on", label: t("开") },
		{ id: "off", label: t("关") },
	], draft.reasoning ? "on" : "off");
	if (!choice) return;
	draft.reasoning = choice.id === "on";
}

export type ModelOverrideEditOutcome =
	| { action: "save"; draft: ModelOverrideDraft }
	| { action: "cancel" };

export async function editModelOverride(
	ctx: ExtensionCommandContext,
	draft: ModelOverrideDraft,
	pristine: BuiltinChatModelBaseline,
	title: string,
): Promise<ModelOverrideEditOutcome> {
	const cursor: MenuCursor = { index: 0 };
	while (true) {
		const toMenuRows = (fieldRows: FieldRow[]) => fieldRows.map((row) => ({
			id: row.id,
			label: `${padLabel(row.label, 16)}${row.adjustable ? markAdjustableValue(row.value) : row.value}`,
			adjustable: row.adjustable,
		}));
		const action = await showPersistentFormMenu(
			ctx,
			title,
			"",
			toMenuRows(buildRows(draft, pristine)),
			cursor,
			{
				getSummaryLines: () => [
					t("「显示」控制模型是否进入 /model（写 scoped 可见性状态），与模型覆盖相互独立。"),
					t("模型覆盖只写入与内置默认不同的字段；全部还原后该模型的覆盖会被移除。"),
					t("内置默认：上下文 {context} / 最大输出 {max}", {
						context: pristine.contextWindow !== undefined ? formatContextWindowShorthand(pristine.contextWindow) : t("未知"),
						max: pristine.maxTokens !== undefined ? formatContextWindowShorthand(pristine.maxTokens) : t("未知"),
					}),
					t("显示名只影响 /model 列表文本；模型级覆盖无法覆盖 baseUrl。"),
			describeReserveThreshold(draft),
				],
				onAdjust: (id, direction) => {
					if (!applyHorizontalToggle(draft, id, direction)) return undefined;
					return toMenuRows(buildRows(draft, pristine));
				},
				hints: [
					{ key: "↑↓", label: t("选择") },
					{ key: "←→", label: t("切换选项") },
					{ key: "Enter", label: t("编辑") },
					{ key: "Ctrl+S", label: t("保存并同步") },
					{ key: "Esc", label: t("返回") },
				],
			},
		);
		if (action.type === "cancel") return { action: "cancel" };
		if (action.type === "save") return { action: "save", draft };
		const fieldId = action.id;
		if (fieldId === "contextWindow") {
			await editIntField(ctx, draft, "contextWindow", pristine);
			continue;
		}
		if (fieldId === "maxTokens") {
			await editIntField(ctx, draft, "maxTokens", pristine);
			continue;
		}
		if (fieldId === "scopedVisible") {
			const choice = await showOptionPicker(ctx, t("显示"), [
				{ id: "show", label: t("显示 — 出现在 /model 与 Ctrl+P") },
				{ id: "hide", label: t("隐藏 — 从模型列表屏蔽（保留模型定义）") },
			], draft.scopedHidden ? "hide" : "show");
			if (choice) draft.scopedHidden = choice.id === "hide";
			continue;
		}
		if (fieldId === "reasoning") {
			await editReasoningField(ctx, draft);
			continue;
		}
		if (fieldId === "compactionReserve") {
			if (draft.compactionReserveWritable === false) {
				ctx.ui.notify(t("Pi 的 settings.json 当前不可读写，本次跳过压缩预留编辑。"), "warning");
				continue;
			}
			const current = resolveCompactionReserveChoice(draft.compactionReserve ?? "global", draft.contextWindow)
				?? draft.compactionReserveGlobal ?? DEFAULT_COMPACTION_RESERVE_TOKENS;
			const rawValue = await ctx.ui.input(t(
				"压缩预留 token（支持 200k / 1m 写法；当前：{current}；留空跟随全局设置）",
				{ current: String(current) },
			), String(current));
			if (rawValue === undefined) continue;
			const reserveInput = rawValue.trim();
			if (!reserveInput) {
				draft.compactionReserve = "global";
				continue;
			}
			const parsed = parseNonNegativeTokenCount(reserveInput);
			if (parsed === undefined) {
				ctx.ui.notify(t("压缩预留必须是非负整数"), "warning");
				continue;
			}
			draft.compactionReserve = parsed;
			continue;
		}
		if (fieldId === "modelName") {
			const current = draft.modelName.trim() || (pristine.name && pristine.name !== draft.modelId ? pristine.name : "");
			const value = await ctx.ui.input(
				t("显示名（留空 = 跟随内置名称「{pristine}」）", { pristine: pristine.name ?? draft.modelId }),
				current,
			);
			if (value !== undefined) draft.modelName = value.trim();
			continue;
		}
		// modelId 只读，忽略其它 key。
	}
}
