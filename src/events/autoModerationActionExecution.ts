import {
	AutoModerationActionExecutionListener,
	type Client,
	type ListenerEventData,
	Container,
	ListenerEvent,
	Routes,
	TextDisplay,
	serializePayload
} from "@buape/carbon"
import { readFile } from "node:fs/promises"

type AutomodRuleConfig = {
	trigger: string
	message: string
}

type AutomodMessageMap = Record<string, AutomodRuleConfig>

type AutoModerationActionExecutionData =
	ListenerEventData[typeof ListenerEvent.AutoModerationActionExecution]

const automodMessagesUrl = new URL("../config/automod-messages.json", import.meta.url)

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

		if (!data.matched_keyword) {
			return
		}

		const trigger = normalizeKeyword(ruleConfig.trigger)
		const matchedKeyword = normalizeKeyword(data.matched_keyword)

		if (trigger !== matchedKeyword) {
			return
		}

		const sourceContent = data.content || data.matched_content || ""
		const redactedContent = sourceContent
			? sourceContent.replace(
				new RegExp(escapeRegExp(ruleConfig.trigger), "gi"),
				"<redacted>"
			)
			: "<redacted>"

		const warningMessage = formatAutomodMessage(ruleConfig.message, data)
		const payload = serializePayload({
			components: [
				new Container([
					new TextDisplay("Original Message"),
					new TextDisplay(redactedContent)
				]),
				new TextDisplay(warningMessage)
			],
			allowedMentions: {
				users: [data.user_id]
			}
		})

		try {
			await client.rest.post(Routes.channelMessages(data.channel_id), {
				body: payload
			})
		} catch (error) {
			console.error("Failed to send automod response:", error)
		}
	}
}
