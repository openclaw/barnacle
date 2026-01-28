import GotoCommand from "./gotoCommand.js"

const skillLink = "https://clawdhub.com/RhysSullivan/answeroverflow"
const communityLink = "https://www.answeroverflow.com/c/1456350064065904867"

export default class AnswerOverflowCommand extends GotoCommand {
	name = "answeroverflow"
	description = "Share the Answer Overflow skill and community links"
	protected message = `Point your agent to our Answer Overflow page with the Answer Overflow skill: <${skillLink}>. You can also browse the community here: <${communityLink}>.`
}
