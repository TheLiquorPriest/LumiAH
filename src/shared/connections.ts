// What every place that says the runtime has no connection tells the user to do, in one set of
// words: a reply the runtime refuses for it, the banner on Home and Live, the Connections section
// with none in it, and a picker of connections with none to pick.

/** Add a connection, or copy the ones used in Lumiverse. `where`: where the Connections section is, for words read away from it ("LumiAH's Runtime page, under Connections"). */
export function addConnectionWords(where?: string): string {
  return `Add a connection${where !== undefined ? ` on ${where}` : ""}, with the provider and your key or a sign-in to your account, or take the ones you use in Lumiverse with Copy from Lumiverse.`;
}
