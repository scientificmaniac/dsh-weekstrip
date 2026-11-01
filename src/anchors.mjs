/**
 * Patch anchors: the exact strings this patch locates inside the DSH account-settings client bundle,
 * plus the localized copy it adds.
 *
 * Every anchor MUST occur exactly once in the target bundle; `buildPatchedText` refuses to write
 * anything otherwise. Anchor text is quoted from
 * @deepseek-ai/dsh-client-ui-settings-account (MIT, Copyright (c) 2026 DeepSeek) solely to locate
 * insertion points — see THIRD_PARTY_NOTICES.md.
 */

/** Insertion marker: its presence means the bundle already carries this patch. */
export const PATCH_MARKER = '//#region dsh-account-usage-stats'

/** The region header the snippet is inserted before (start of the original AccountSection module). */
export const ACCOUNT_SECTION_REGION = '\t\t//#region lib/types/client/AccountSection.js'

/** Copy added to the account dictionary (`en`). */
export const DICT_EN = [
	['statsTokenTitle', 'Token usage'],
	['statsScope', 'All sessions'],
	['statsTokensUnit', 'tokens total'],
	['statsInput', 'Input'],
	['statsCacheRead', 'Cache read'],
	['statsCacheWrite', 'Cache write'],
	['statsOutput', 'Output'],
	['statsRequests', 'Model requests'],
	['statsWeekTitle', 'Last 7 days'],
	['statsTokensUnitShort', 'tokens'],
	['statsWeekAvg', 'Daily average'],
	['statsActivityTitle', 'Activity'],
	['statsActiveDays', 'Active days'],
	['statsStreak', 'Streak'],
	['statsDaysUnit', 'days'],
	['statsTurns', 'Turns'],
	['statsToolCalls', 'Tool calls'],
	['statsEmpty', 'No local usage data yet. Usage from your sessions will appear here.'],
]

/** Copy added to the account dictionary (`zh`). */
export const DICT_ZH = [
	['statsTokenTitle', 'Token 统计'],
	['statsScope', '全部会话'],
	['statsTokensUnit', 'tokens 累计'],
	['statsInput', '输入'],
	['statsCacheRead', '缓存命中'],
	['statsCacheWrite', '缓存写入'],
	['statsOutput', '输出'],
	['statsRequests', '模型请求'],
	['statsWeekTitle', '近 7 天用量'],
	['statsTokensUnitShort', 'tokens'],
	['statsWeekAvg', '日均'],
	['statsActivityTitle', '活跃度'],
	['statsActiveDays', '活跃天数'],
	['statsStreak', '连续'],
	['statsDaysUnit', '天'],
	['statsTurns', '回合'],
	['statsToolCalls', '工具调用'],
	['statsEmpty', '暂无本地用量数据，会话产生用量后会在此显示。'],
]

/** Emit dictionary entries at the bundle's array indent. */
export function dictionaryLines(pairs) {
	return pairs.map(([key, value]) => `\t\t\t${key}: ${JSON.stringify(value)},`).join('\n')
}

/**
 * Ordered replacement plan. `replace: null` means "insert the snippet, then keep the anchor".
 * Order matters only in that every anchor is verified against the text produced so far.
 */
export function textPatches(snippet) {
	return [
		{
			name: 'dictionary-en',
			find: '\t\t\tbonusNoticeTitle: "Bonus credited"',
			replace: `\t\t\tbonusNoticeTitle: "Bonus credited",\n${dictionaryLines(DICT_EN)}`,
		},
		{
			name: 'dictionary-zh',
			find: '\t\t\tbonusNoticeTitle: "赠金已到账"',
			replace: `\t\t\tbonusNoticeTitle: "赠金已到账",\n${dictionaryLines(DICT_ZH)}`,
		},
		{
			name: 'component-insert',
			find: ACCOUNT_SECTION_REGION,
			replace: null,
		},
		{
			name: 'component-rename',
			find: 'function AccountSection({ t, useAccount, useTheme, start, cancel, openPlatformPage, avatarFailed }) {',
			replace: 'function AccountSectionMain({ t, useAccount, useTheme, start, cancel, openPlatformPage, avatarFailed, useSessions, refreshSessions }) {',
		},
		{
			name: 'section-inject',
			find: `\t\t\t\t\t\tlabel: () => t("nav"),
\t\t\t\t\t\tlocale: "settings.account",
\t\t\t\t\t\tinject: () => operations
\t\t\t\t\t}, AccountSection);`,
			replace: `\t\t\t\t\t\tlabel: () => t("nav"),
\t\t\t\t\t\tlocale: "settings.account",
\t\t\t\t\t\tinject: () => ({
\t\t\t\t\t\t\t...operations,
\t\t\t\t\t\t\trefreshSessions: () => {
\t\t\t\t\t\t\t\ttry {
\t\t\t\t\t\t\t\t\tconst sessions = ctx.get("sessions");
\t\t\t\t\t\t\t\t\tif (sessions !== null && sessions !== void 0 && typeof sessions.refresh === "function") Promise.resolve(sessions.refresh()).catch(() => {});
\t\t\t\t\t\t\t\t} catch { /* no sessions service: keep the current snapshot */ }
\t\t\t\t\t\t\t}
\t\t\t\t\t\t})
\t\t\t\t\t}, AccountSection);`,
		},
	]
}

/** DSH versions this anchor set has been verified against; unknown versions are attempted and reported. */
export const VERIFIED_VERSIONS = ['0.2.1-rc.2', '0.2.1-rc.4', '0.2.1-rc.5']
