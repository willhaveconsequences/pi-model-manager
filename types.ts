// pi-model-manager 类型定义。
// 命名约定：
//   Stored*  → models.json 与 state.json metadata 合成后的运行时视图
//   *Draft   → TUI 编辑器中可变中间态
//   *Outcome → 异步流程结果联合类型

// ========== 基础枚举 ==========

export type ApiKind = "openai-completions" | "openai-responses" | "anthropic-messages" | "google-generative-ai";
/** 接入协议标识：扩展干预能力只覆盖这 4 个 ApiKind；内置覆写需要携带
 *  pi 原生接入自带的协议（如 openai-codex-responses），仅作展示与地址语义标注。 */
export type ProviderApiId = ApiKind | (string & {});
export type ModelInputKind = "text" | "image";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;
export type ReasoningMode = "enabled" | "disabled";
export type AnthropicThinkingProtocol = "adaptive" | "legacy";
export type OpenAIChatCompatibilityMode = "standard" | "compatible";
export type OpenAIResponsesStreamCompletionMode = "standard" | "terminal-event";
export type BuiltInClientHeaderProfileId = "claude-code" | "codex-cli";
export type ClientHeaderProfileId = "recommended" | "disabled" | BuiltInClientHeaderProfileId | "custom";
export type CompatSettings = Record<string, unknown>;
export type OpenAIServiceTier = "priority" | "ultrafast";
/** 上下文压缩预留档位：global 跟随全局设置、auto 按上下文窗口算、数字为固定 token。 */
export type CompactionReserveChoice = "global" | "auto" | number;

export const DEFAULT_PROVIDER_HTTP_PROXY_URL = "http://127.0.0.1:7890";

// ========== 持久配置合成 schema ==========

export interface TokenCostTier {
	inputTokensAbove: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface TokenCost {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	tiers?: TokenCostTier[];
}

export interface StoredRequestHeaderProfile {
	name: string;
	headers: Record<string, string>;
}

export interface StoredClientHeaderCapture {
	capturedAt: string;
	headers: Record<string, string>;
}

export interface StoredModel {
	id: string;
	/** 仅保存相对 provider 默认值的显式模型级覆盖。 */
	api?: string;
	baseUrl?: string;
	/** 不含插件请求头 profile 所管理字段的原生模型请求头。 */
	headers?: Record<string, string>;
	name?: string;
	reasoning: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	input: ModelInputKind[];
	contextWindow: number;
	maxTokens: number;
	cost: TokenCost;
	/** 旧版模型级请求头字段，仅用于读取旧 state 后折叠到接入级。 */
	clientHeaderProfile?: ClientHeaderProfileId;
	requestHeaderProfileId?: string;
	customClientHeaders?: Record<string, string>;
	openAIServiceTier?: OpenAIServiceTier;
	compat?: CompatSettings;
}

export interface StoredProvider {
	name: string;
	api: ProviderApiId;
	baseUrl: string;
	/** 运行时所有权，未接管的原生 Provider 不由插件生成请求头或动态注册。 */
	managed: boolean;
	/** 可省略；认证也可由 auth.json、/login 或 CLI --api-key 提供。 */
	apiKey?: string;
	/** models.json 中不由 TUI 编辑、但必须跨保存和重命名保真的原生字段。 */
	headers?: Record<string, string>;
	compat?: CompatSettings;
	modelOverrides?: Record<string, unknown>;
	authHeader?: boolean;
	clientHeaderProfile: ClientHeaderProfileId;
	requestHeaderProfileId?: string;
	customClientHeaders?: Record<string, string>;
	httpProxyEnabled?: boolean;
	httpProxyUrl?: string;
	/** Responses 终态事件已完整转交后，是否主动结束本地 SSE 流。 */
	openAIResponsesStreamCompletionMode?: OpenAIResponsesStreamCompletionMode;
	/** 仅在跨资源、item ID 或加密状态错误后剥离旧 item ID 并重试一次，完整保留推理内容。 */
	openAIResponsesAutoRecoveryEnabled?: boolean;
	/** 内置接入覆写视图：models.json 局部节点，模型清单与认证仍由 pi 内置目录管理。 */
	nativeOverride?: boolean;
	models: StoredModel[];
}

export interface StateDocument {
	version: 2;
	providers: Record<string, StoredProvider>;
	/** state.json 中明确由插件创建或接管的 Provider ID。 */
	managedProviderIds: string[];
	requestHeaderProfiles: Record<string, StoredRequestHeaderProfile>;
	clientHeaderCaptures: Partial<Record<BuiltInClientHeaderProfileId, StoredClientHeaderCapture>>;
	/** 可见性接管状态（未定义 = 未接管；存在即按 hiddenModelIds 重算 enabledModels）。 */
	scopedModelVisibility?: { hiddenModelIds: string[] };
}

// ========== TUI draft（可变中间态） ==========

export interface ProviderDraft {
	providerId: string;
	providerName: string;
	api: ProviderApiId;
	/** 内置接入覆写草稿：只允许覆盖名称/地址/key/认证头，模型清单不可编辑。 */
	nativeOverride?: boolean;
	/** 展示用提示：pi 内置默认 API 根地址（覆写编辑器摘要行使用）。 */
	builtinBaseUrlHint?: string;
	/** Chat Completions 系统提示词兼容模式；standard 保持 Pi 默认判断。 */
	openAIChatCompatibilityMode?: OpenAIChatCompatibilityMode;
	/** Responses 流结束模式；terminal-event 不等待上游关闭连接。 */
	openAIResponsesStreamCompletionMode?: OpenAIResponsesStreamCompletionMode;
	openAIResponsesAutoRecoveryEnabled?: boolean;
	baseUrl: string;
	apiKey: string;
	authHeader: boolean;
	clientHeaderProfile: ClientHeaderProfileId;
	requestHeaderProfileId?: string;
	customClientHeaders: Record<string, string>;
	httpProxyEnabled: boolean;
	httpProxyUrl: string;
	selectedIndex: number;
}

export interface ModelDraft {
	providerId: string;
	providerName: string;
	api: ApiKind;
	baseUrl: string;
	apiKey: string;
	authHeader: boolean;
	clientHeaderProfile: ClientHeaderProfileId;
	requestHeaderProfileId?: string;
	customClientHeaders: Record<string, string>;
	httpProxyEnabled: boolean;
	httpProxyUrl: string;
	modelId: string;
	modelName: string;
	inputKinds: ModelInputKind[];
	reasoningMode: ReasoningMode;
	anthropicThinkingProtocol?: AnthropicThinkingProtocol;
	contextWindow: number;
	maxTokens: number;
	/** 压缩预留档位：global 跟随全局设置、auto 取上下文窗口 12%、数字为固定 token。 */
	compactionReserve?: CompactionReserveChoice;
	/** 读取 settings.json 失败时为 false：保存时跳过压缩预留写入，避免误删已有覆盖。 */
	compactionReserveWritable?: boolean;
	openAIServiceTier?: OpenAIServiceTier;
	selectedIndex: number;
}

export interface RequestHeaderProfileDraft {
	profileId: string;
	profileName: string;
	headers: Record<string, string>;
	selectedIndex: number;
}

/** 内置模型级覆盖草稿：空值/与内置默认相同的字段不写入 modelOverrides。 */
export interface ModelOverrideDraft {
	providerId: string;
	modelId: string;
	/** 显示名；空串 = 跟随内置名称，不写入 name。 */
	modelName: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	/** scoped-model 显示状态：true = 已隐藏（启动重算后不在 /model 可见）。 */
	scopedHidden?: boolean;
	/** 进入编辑器时的显示状态，保存时用于 diff。 */
	scopedHiddenInitial?: boolean;
	/** 压缩预留档位（存取在 Pi settings.json，不占 modelOverrides）；"global" 表示不写覆盖。 */
	compactionReserve?: CompactionReserveChoice;
	/** 草稿构建时的压缩预留档位，用于保存时的 diff。 */
	compactionReserveInitial?: CompactionReserveChoice;
	/** Pi settings 的 compaction 可读性；false 时保存跳过压缩预留写入。 */
	compactionReserveWritable?: boolean;
	/** 当前全局预留 token（展示用）。 */
	compactionReserveGlobal?: number;
	selectedIndex: number;
}

// ========== 异步流程结果 ==========

export type ModelListFetchOutcome =
	| { status: "loaded"; modelIds: string[] }
	| { status: "failed"; message: string }
	| { status: "cancelled" };

// ========== 常量 ==========

export const ZERO_COST: TokenCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

