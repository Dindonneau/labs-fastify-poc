export const listArrayContent = (
  arrayOfStrings: string[],
  linePrefix: string = ""
) => arrayOfStrings.map(item => `${linePrefix}- ${item.trim()}`).join("\n")
