// Slack mrkdwn escaping, shared by every path that builds mrkdwn structural
// syntax from untrusted content (SlackFormatter, mdToMrkdwn). mrkdwn gives three
// characters special meaning: `&`, `<`, `>` — the `<…>` form is Slack's link,
// user-mention, and broadcast syntax (`<url|label>`, `<@U…>`, `<!channel>`). Left
// raw, a record can inject a live channel ping, a mention, or a forged link.

/** Neutralize the three mrkdwn-structural characters in a **text** field, using
 *  Slack's own escaping rule. `&` MUST be replaced first, otherwise the `&` we
 *  introduce for `<`/`>` would itself be double-escaped. This turns `<!channel>`,
 *  `<@U…>`, and forged `<url|label>` into inert visible text. */
export function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A URL lives inside `<url|label>`; HTML-escaping it would corrupt the address,
 *  so instead percent-encode only the characters that would break out of or
 *  forge that structure — `<`, `>`, `|`. Slack decodes `%3C`/`%3E`/`%7C` back to
 *  the literal character when the link is opened, so the URL still works. */
export function encodeMrkdwnUrl(url: string): string {
  return url.replace(/</g, "%3C").replace(/>/g, "%3E").replace(/\|/g, "%7C");
}

/** Slack code fences are ```` ``` ```` … ```` ``` ````; content that contains its
 *  own run of backticks would close the fence early (and let the rest render as
 *  live mrkdwn). Insert a zero-width space after every backtick so no run of
 *  three survives; Slack renders the ZWSP invisibly, so the code reads unchanged. */
export function neutralizeCodeFence(code: string): string {
  return code.replace(/`/g, "`\u200B");
}
