// 菜单交互契约回归：锁定「模型覆盖菜单」的 Enter 分发链路。
//
// 背景（2026-11-07 信号）：曾把 Enter 事件返回的行 id 当作数字索引 parseInt，
// 恒为 NaN 后静默 continue，用户按 Enter 没有任何反应。此组测试钉住：
//   1. showPersistentShortcutMenu 的 Enter 分发返回"被选中行的原始 id"；
//   2. 该 id 必须经 resolveOverrideMenuModel 反查到底层模型——两环节合约合一。
// 这类合约此前只存在于直觉里，没有护栏。

import assert from "node:assert/strict";
import test from "node:test";
import { Key } from "@earendil-works/pi-tui";

const { showPersistentShortcutMenu } = await import("../tui/persistent-menu.ts");
const { resolveOverrideMenuModel } = await import("../tui/dashboard.ts");

const CHAT_MODELS = [
	{ id: "gpt-6-astra", name: "Astra", contextWindow: 400_000, maxTokens: 32_000 },
	{ id: "gpt-6.1-sol", name: undefined, contextWindow: 1_000_000, maxTokens: 512_000 },
	{ id: "gpt-6-luna", name: "Luna", contextWindow: 262_144, maxTokens: 16_000 },
];

function buildMenuHarness(rows: readonly { id: string; label: string; searchText: string }[], entries: string[][]) {
	let component: {
		focused: boolean;
		handleInput: (input: string) => void;
		render: (width: number) => string[];
	} | undefined;
	const ctx = {
		ui: {
			custom(factory: (args: unknown, theme: unknown, data: unknown, resolve: (value: unknown) => void) => unknown) {
				return new Promise((resolve) => {
					component = factory(
						{ requestRender() {} },
						{ fg: (_c: unknown, t: string) => t, bg: (_c: unknown, t: string) => t, bold: (t: string) => t },
						{},
						resolve,
					);
				});
			},
		},
	} as unknown as Parameters<typeof showPersistentShortcutMenu>[0];

	const outcome = showPersistentShortcutMenu(
		ctx,
		"覆盖模型菜单",
		"",
		rows,
		{ index: 0 },
		entries as never,
		{ emptyLabel: "暂无" },
	);
	return { component: component!, outcome };
}

test("Enter 返回被选中菜单行的原始 id（模型 ID 而非索引）", async () => {
	const rows = CHAT_MODELS.map((model) => ({
		id: model.id,
		label: model.id,
		searchText: model.id,
	}));
	const { component, outcome } = buildMenuHarness(rows, []);
	component.focused = true;
	// 下移到第二行（gpt-6.1-sol），Enter 选择
	component.handleInput(Key.down);
	component.handleInput(Key.enter);
	const action = await outcome;
	assert.deepEqual(action, { type: "pick", id: "gpt-6.1-sol" });
});

test("Enter 分发 → resolveOverrideMenuModel 全链约束能取到正确模型", async () => {
	const rows = CHAT_MODELS.map((model) => ({
		id: model.id,
		label: model.id,
		searchText: `${model.id} ${model.name ?? ""}`,
	}));
	const { component, outcome } = buildMenuHarness(rows, []);
	component.focused = true;
	component.handleInput(Key.down);
	component.handleInput(Key.down);
	component.handleInput(Key.enter);
	const action = await outcome;
	if (action.type !== "cancel") {
		const resolved = resolveOverrideMenuModel(CHAT_MODELS, (action as { id: string }).id);
		assert.ok(resolved, "选中行必须能反查到模型");
		assert.equal(resolved.id, "gpt-6-luna");
	}
});

test("快捷键（r/x）同样按行 id 语义不得破坏 Enter 路径", async () => {
	const rows = CHAT_MODELS.map((model) => ({
		id: model.id,
		label: model.id,
		searchText: model.id,
	}));
	const { component, outcome } = buildMenuHarness(rows, [
		{ input: "e", shortcut: "edit-provider" },
		{ input: "r", shortcut: "clear-override" },
		{ input: "x", shortcut: "toggle-hidden" },
	]);
	component.focused = true;
	component.handleInput(Key.enter);
	const action = await outcome;
	// 无 shortcut 命中时 Enter 走行选择而不是回落 default 分支抛错
	assert.equal((action as { type: string }).type, "pick");
});
