export const CURSOR_MARKER = "<CURSOR>";

export const Key = {
	escape: "<ESC>",
	backspace: "<BACKSPACE>",
	delete: "<DELETE>",
	left: "<LEFT>",
	right: "<RIGHT>",
	up: "<UP>",
	down: "<DOWN>",
	pageUp: "<PAGE_UP>",
	pageDown: "<PAGE_DOWN>",
	home: "<HOME>",
	end: "<END>",
	enter: "<ENTER>",
	tab: "<TAB>",
	ctrl: (key: string) => `<CTRL_${key}>`,
} as const;

export function matchesKey(input: string, key: string): boolean {
	return input === key;
}
function characterWidth(character: string): number {
	const codePoint = character.codePointAt(0) ?? 0;
	if (codePoint < 0x1100) return 1;
	// [stub]: 与真实 pi-tui 对齐：ambiguous（框线/箭头/块形/‏❯ 等）记窄格，
	// 仅确定双宽的区段（CJK/全角/音节文字）计 2。
	if (codePoint <= 0x115f) return 2; // Hangul Jamo
	if (codePoint >= 0x2e80 && codePoint <= 0xa4cf) return 2; // CJK Radicals 补充…彝文
	if (codePoint >= 0xac00 && codePoint <= 0xd7a3) return 2; // Hangul 音节
	if (codePoint >= 0xf900 && codePoint <= 0xfaff) return 2; // CJK 兼容表意
	if (codePoint >= 0xfe30 && codePoint <= 0xfe4f) return 2; // CJK 兼容形式
	if (codePoint >= 0xff00 && codePoint <= 0xff60) return 2; // 全角形式
	if (codePoint >= 0xffe0 && codePoint <= 0xffe6) return 2; // 全角符号
	return 1;
}

export function visibleWidth(text: string): number {
	return Array.from(text.replaceAll(CURSOR_MARKER, ""))
		.reduce((width, character) => width + characterWidth(character), 0);
}

export function truncateToWidth(text: string, width: number, ellipsis = ""): string {
	if (visibleWidth(text) <= width) return text;
	const ellipsisWidth = visibleWidth(ellipsis);
	let output = "";
	let used = 0;
	for (let index = 0; index < text.length;) {
		if (text.startsWith(CURSOR_MARKER, index)) {
			output += CURSOR_MARKER;
			index += CURSOR_MARKER.length;
			continue;
		}
		const character = String.fromCodePoint(text.codePointAt(index)!);
		const nextWidth = characterWidth(character);
		if (used + nextWidth + ellipsisWidth > width) break;
		output += character;
		used += nextWidth;
		index += character.length;
	}
	return `${output}${ellipsisWidth <= width ? ellipsis : ""}`;
}
