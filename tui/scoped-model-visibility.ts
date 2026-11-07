// tui/scoped-model-visibility.ts
//
// scoped-model 可见性：显示/隐藏的共享逻辑。
// 状态放 state.json 的 scopedModelVisibility.hiddenModelIds（小写存储），
// enabledModels 由扩展按“注册表 − hidden”重算（未隐藏 provider 写 provider/*）。
// 入口分布在各 provider 的模型菜单/编辑器中，不再有独立的全局面板。

import { formatUnknownError } from "../common.ts";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { t } from "../i18n.ts";
import { persistScopedModelVisibility } from "../models-json-sync.ts";
import { readState } from "../state-store.ts";

export async function readScopedHiddenSet(): Promise<Set<string>> {
	const document = await readState();
	return new Set((document.scopedModelVisibility?.hiddenModelIds ?? []).map((id) => id.toLowerCase()));
}

/** 单个模型的隐藏切换；接管语义下同时重算 enabledModels。 */
export async function toggleScopedModelVisibility(
	ctx: ExtensionCommandContext,
	providerId: string,
	modelId: string,
): Promise<boolean> {
	try {
		const document = await readState();
		const hidden = new Set((document.scopedModelVisibility?.hiddenModelIds ?? []).map((id) => id.toLowerCase()));
		const fullModelId = `${providerId}/${modelId}`;
		let becameHidden: boolean;
		const existing = [...hidden].find((id) => id.toLowerCase() === fullModelId.toLowerCase());
		if (existing !== undefined) {
			hidden.delete(existing);
			becameHidden = false;
		} else {
			hidden.add(fullModelId.toLowerCase());
			becameHidden = true;
		}
		await persistScopedModelVisibility(ctx, [...hidden]);
		return becameHidden;
	} catch (error) {
		throw new Error(t("可见性切换失败：{error}", { error: formatUnknownError(error) }));
	}
}

/** 行内标签：仅隐藏时显示「已隐藏」，可见的行零噪声。 */
export function describeVisibilityTag(hidden: boolean): string {
	return hidden ? t("已隐藏") : "";
}
