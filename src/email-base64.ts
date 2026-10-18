export const emailBase64DecodedBytes = (content: string): number => {
  const unpaddedBytes = (content.length / 4) * 3;

  if (content.endsWith("==")) {
    return unpaddedBytes - 2;
  }

  return content.endsWith("=") ? unpaddedBytes - 1 : unpaddedBytes;
};

export const emailBase64HasCanonicalPadding = (content: string): boolean =>
  content.length % 4 === 0 &&
  (content.endsWith("==")
    ? "AQgw".includes(content.at(-3) ?? "")
    : !content.endsWith("=") || "AEIMQUYcgkosw048".includes(content.at(-2) ?? ""));
