/** One requester's addressable prose, excluding quoted examples and code. */
export function requesterTargetText(text: string): string {
  let fence: { marker: "`" | "~"; width: number } | undefined;
  let inlineWidth = 0;
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith(">")) {
        inlineWidth = 0;
        return " ";
      }
      const indentation = line.slice(0, line.length - trimmed.length);
      if (indentation.length >= 4 || indentation.includes("\t")) {
        inlineWidth = 0;
        return " ";
      }
      const first = trimmed[0];
      const leadingMarker = first === "`" || first === "~" ? first : undefined;
      let leadingWidth = 0;
      if (leadingMarker !== undefined) while (trimmed[leadingWidth] === leadingMarker) leadingWidth++;
      if (fence !== undefined) {
        if (leadingMarker === fence.marker && leadingWidth >= fence.width && trimmed.slice(leadingWidth).trim() === "")
          fence = undefined;
        return " ";
      }
      if (inlineWidth === 0 && leadingMarker !== undefined && leadingWidth >= 3) {
        fence = { marker: leadingMarker, width: leadingWidth };
        return " ";
      }
      let addressable = "";
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === "`") {
          let width = 0;
          while (line[i + width] === "`") width++;
          if (inlineWidth === 0) inlineWidth = width;
          else if (inlineWidth === width) inlineWidth = 0;
          addressable += " ";
          i += width - 1;
        } else addressable += inlineWidth > 0 ? " " : char;
      }
      return addressable;
    })
    .join("\n");
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
      if (angleLabel) continue;
      if (token || angleLink) {
        token += char;
        continue;
      }
      finish();
      angleLink = true;
      angleLabel = false;
      continue;
    }
    if (char === ">") {
      if (!angleLink) {
        token += char;
        continue;
      }
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
