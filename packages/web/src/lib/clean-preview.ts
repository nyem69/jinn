/**
 * Clean raw chat text for display as a preview label.
 * Strips @mentions, #NNN prefixes, markdown syntax, and capitalizes.
 */
export function cleanPreview(raw: string): string {
  let text = raw
  // Strip @employee-name mentions
  text = text.replace(/@[\w-]+/g, "")
  // Strip #NNN session number prefixes
  text = text.replace(/^#\d+\s*/g, "")
  // Strip markdown headings
  text = text.replace(/^#{1,6}\s+/gm, "")
  // Strip bold/italic markers
  text = text.replace(/\*{1,3}|_{1,3}/g, "")
  // Strip list markers (-, *, •, numbered)
  text = text.replace(/^[\s]*[-*•]\s+/gm, "")
  text = text.replace(/^[\s]*\d+[.)]\s+/gm, "")
  // Strip blockquotes
  text = text.replace(/^>\s*/gm, "")
  // Strip inline code backticks
  text = text.replace(/`+/g, "")
  // Strip code fence lines
  text = text.replace(/^```\w*$/gm, "")
  // Strip link syntax [text](url) → text
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
  // Collapse whitespace
  text = text.replace(/\s+/g, " ").trim()
  // Capitalize first letter
  if (text.length > 0 && text[0] !== text[0].toUpperCase()) {
    text = text[0].toUpperCase() + text.slice(1)
  }
  return text
}
