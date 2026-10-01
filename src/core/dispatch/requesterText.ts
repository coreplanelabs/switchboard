/** One requester's addressable prose, excluding quoted examples and code. */
export function requesterTargetText(text: string): string {
  return text.replace(/^\s*>[^\n]*$/gm, " ").replace(/```[\s\S]*?```|`[^`\n]*`/g, " ");
}

/** Preserve whole URL tokens; a GitHub-looking substring inside a foreign
 * URL or a Slack link label is never target evidence. */
export function requesterUrlWords(text: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let angleLink = false;
  let angleLabel = false;
  const finish = () => {
    if (token) tokens.push(token);
    token = "";
  };
  for (const char of text) {
    if (char === "<") {
      finish();
      angleLink = true;
      angleLabel = false;
      continue;
    }
    if (char === ">") {
      finish();
      angleLink = false;
      angleLabel = false;
      continue;
    }
    if (angleLink && char === "|") {
      finish();
      angleLabel = true;
      continue;
    }
    if (angleLabel) continue;
    if (char.trim() === "") finish();
    else token += char;
  }
  finish();
  return tokens;
}

export function requesterUrlText(word: string): string | undefined {
  const destination = word.lastIndexOf("](");
  const candidate =
    destination < 0 || (!word.startsWith("[") && !word.startsWith("![") && word.slice(0, destination).includes("://"))
      ? word
      : word.slice(destination + 2);
  const lowercase = candidate.toLowerCase();
  const https = lowercase.indexOf("https://");
  const http = lowercase.indexOf("http://");
  const start = [https, http].filter((index) => index >= 0).sort((a, b) => a - b)[0];
  if (start === undefined || [...candidate.slice(0, start)].some((char) => !"([\"'".includes(char))) return undefined;
  let raw = candidate.slice(start);
  while (raw && ".!'\")]},;".includes(raw.at(-1)!)) raw = raw.slice(0, -1);
  return raw;
}
