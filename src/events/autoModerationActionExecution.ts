import {
	AutoModerationActionExecutionListener,
	type Client,
	type ListenerEventData,
	ListenerEvent,
	Routes,
	Webhook,
	serializePayload,
	type MessagePayloadObject
} from "@buape/carbon"
import { readFile } from "node:fs/promises"

type AutomodRuleConfig = {
	trigger: string
	message: string
	confirmRoleId?: string
	redact?: boolean
}

type AutomodMessageMap = Record<string, AutomodRuleConfig | AutomodRuleConfig[]>

type AutoModerationActionExecutionData =
	ListenerEventData[typeof ListenerEvent.AutoModerationActionExecution]

type WebhookCacheEntry = {
	webhook: Webhook
	fetchedAt: number
}

type WebhookSendPayload = MessagePayloadObject & {
	username?: string
	avatar_url?: string
}

const automodMessagesUrl = new URL("../config/automod-messages.json", import.meta.url)
const webhookCache = new Map<string, WebhookCacheEntry>()
const webhookCacheTtlMs = 15 * 60 * 1000

const normalizeKeyword = (keyword: string) => keyword.trim().toLowerCase()

const loadAutomodMessages = async (): Promise<AutomodMessageMap> => {
	try {
		const raw = await readFile(automodMessagesUrl, "utf8")
		return JSON.parse(raw) as AutomodMessageMap
	} catch (error) {
		console.error("Failed to load automod messages:", error)
		return {}
	}
}

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

const formatAutomodMessage = (template: string, data: AutoModerationActionExecutionData) =>
	template
		.replaceAll("{user}", `<@${data.user_id}>`)
		.replaceAll("{keyword}", data.matched_keyword ?? "")
		.replaceAll("{content}", data.matched_content ?? data.content ?? "")

const cleanupWebhookCache = () => {
	const now = Date.now()
	for (const [channelId, entry] of webhookCache.entries()) {
		if (now - entry.fetchedAt > webhookCacheTtlMs) {
			webhookCache.delete(channelId)
		}
	}
}

const fetchChannelWebhooks = async (client: Client, channelId: string) => {
	return (await client.rest.get(Routes.channelWebhooks(channelId))) as {
		id: string
		token?: string
	}[]
}

const createChannelWebhook = async (client: Client, channelId: string) => {
	return (await client.rest.post(Routes.channelWebhooks(channelId), {
		body: { name: "Barnacle Automod" }
	})) as { id: string; token?: string }
}

const getOrCreateWebhook = async (client: Client, channelId: string) => {
	cleanupWebhookCache()
	const cached = webhookCache.get(channelId)
	if (cached) {
		return cached.webhook
	}

	const existingWebhooks = await fetchChannelWebhooks(client, channelId)
	const usableWebhook = existingWebhooks.find((webhook) => webhook.token)
	const webhookData = usableWebhook ?? (await createChannelWebhook(client, channelId))

	if (!webhookData.token) {
		throw new Error("Webhook token missing for automod response")
	}

	const webhook = new Webhook({ id: webhookData.id, token: webhookData.token })
	webhookCache.set(channelId, { webhook, fetchedAt: Date.now() })
	return webhook
}

const resolveRuleConfig = (
	rules: AutomodRuleConfig | AutomodRuleConfig[],
	matchedKeyword: string
) => {
	const ruleList = Array.isArray(rules) ? rules : [rules]
	return ruleList.find((rule) => normalizeKeyword(rule.trigger) === matchedKeyword)
}

const sendWebhookMessage = async (webhook: Webhook, payload: WebhookSendPayload) => {
	const serialized = serializePayload({
		...payload,
		allowedMentions: { parse: [] }
	})
	await webhook.rest.post(webhook.urlWithOptions({ wait: true }), {
		body: serialized
	})
}

const resolveMember = async (data: AutoModerationActionExecutionData) => {
	if (!data.guild) {
		return null
	}
	try {
		return await data.guild.fetchMember(data.user_id)
	} catch (error) {
		console.error("Failed to fetch guild member:", error)
		return null
	}
}

export default class AutoModerationActionExecution extends AutoModerationActionExecutionListener {
	async handle(data: ListenerEventData[this["type"]], client: Client) {
		if (!data.channel_id || !data.matched_keyword) {
			return
		}

		const messages = await loadAutomodMessages()
		const ruleConfig = messages[data.rule_id]

		if (!ruleConfig) {
			return
		}

		const matchedKeyword = normalizeKeyword(data.matched_keyword)
		const activeRule = resolveRuleConfig(ruleConfig, matchedKeyword)

		if (!activeRule) {
			return
		}

		const sourceContent = data.content || data.matched_content || ""
		const shouldRedact = activeRule.redact !== false
		const redactedContent = sourceContent
			? sourceContent.replace(
				new RegExp(escapeRegExp(activeRule.trigger), "gi"),
				"<redacted>"
			)
			: "<redacted>"
		const repostContent = shouldRedact ? redactedContent : sourceContent || "<redacted>"

		const warningMessage = formatAutomodMessage(activeRule.message, data)
		const warningLines = [warningMessage]
		if (activeRule.confirmRoleId) {
			warningLines.push(
				`Need the crustacean crew? Ping <@&${activeRule.confirmRoleId}> to request a mod splash.`
			)
		}

		const warningPayload = serializePayload({
			content: warningLines.join("\n\n"),
			allowedMentions: {
				users: [data.user_id]
			}
		})

		try {
			const webhook = await getOrCreateWebhook(client, data.channel_id)
			const member = await resolveMember(data)
			const displayName =
				member?.nickname ||
				member?.user?.globalName ||
				member?.user?.username ||
				data.user?.globalName ||
				data.user?.username ||
				data.user_id
			const avatarUrl =
				member?.avatarUrl ||
				member?.user?.avatarUrl ||
				data.user?.avatarUrl ||
				undefined

			await sendWebhookMessage(webhook, {
				content: repostContent,
				username: displayName,
				avatar_url: avatarUrl
			})

			await client.rest.post(Routes.channelMessages(data.channel_id), {
				body: warningPayload
			})
		} catch (error) {
			console.error("Failed to send automod response:", error)
		}
	}
}
