// The texts of spend and upkeep (DESIGN §20): what a cap says when it is reached, and when the call
// about to be made would take the day's spend past it.

import { stopText, type TextDef, v } from "../text-def";

export const SPEND_TEXT = {
  stopTokens: "stop.spend_tokens",
  stopTokensCall: "stop.spend_tokens_call",
  stopCost: "stop.spend_cost",
  stopCostCall: "stop.spend_cost_call",
} as const;

export const SPEND_TEXTS: TextDef[] = [
  stopText(SPEND_TEXT.stopTokens, "Tokens per day spent", "A call once every agent's calls together have sent and written all Tokens per day allows.", "what every agent's calls sent and wrote in the last 24 hours is counted as {{tokens}} of the {{limit}} Tokens per day allows (a cached re-read counts as {{weight}} of a token)", [
    v("tokens", 'what every agent\'s calls sent and wrote in the last 24 hours as the limit counts it, with the word: "5000000 tokens"', true),
    v("limit", "Tokens per day", true),
    v("weight", "What a cached re-read counts as"),
  ]),
  stopText(SPEND_TEXT.stopTokensCall, "Tokens per day: the call would pass it", "A call whose own prompt would take every agent's calls past Tokens per day, though they are under it so far.", "the call would take what every agent's calls sent and wrote in the last 24 hours past Tokens per day: counted as {{counted}} with it, of the {{limit}} allowed (a cached re-read counts as {{weight}} of a token)", [
    v("counted", 'what every agent\'s calls spent in the last 24 hours as the limit counts it, with this call\'s prompt as estimated and the calls under way, with the word: "5004000 tokens"', true),
    v("limit", "Tokens per day", true),
    v("weight", "What a cached re-read counts as"),
  ]),
  stopText(SPEND_TEXT.stopCost, "Cost per day spent", "A call once every agent's calls together have cost all Cost per day allows.", "every agent's calls together have cost ${{cost}} in the last 24 hours, and Cost per day allows ${{limit}}", [
    v("cost", 'what every agent\'s calls cost in the last 24 hours, in US dollars: "5.02"', true),
    v("limit", 'Cost per day, in US dollars: "5.00"', true),
  ]),
  stopText(SPEND_TEXT.stopCostCall, "Cost per day: the call would pass it", "A call whose own prompt, at your price for its model, would take every agent's calls past Cost per day, though they are under it so far.", "the call would take what every agent's calls cost in the last 24 hours past Cost per day: about ${{cost}} with it, and Cost per day allows ${{limit}}", [
    v("cost", 'what every agent\'s calls cost in the last 24 hours with this call\'s prompt as estimated and the calls under way, in US dollars: "5.02"', true),
    v("limit", 'Cost per day, in US dollars: "5.00"', true),
  ]),
];
