import dayjs from "dayjs";
import customParseFormat from "dayjs/plugin/customParseFormat.js";

dayjs.extend(customParseFormat);

const formats = [
  ...["-", "/", "."].flatMap((separator) =>
    ["M", "MM"].flatMap((month) =>
      ["D", "DD"].flatMap((day) => [
        ["YYYY", month, day].join(separator),
        [month, day, "YYYY"].join(separator),
        [day, month, "YYYY"].join(separator),
      ]),
    ),
  ),
  ...[" ", "-"].flatMap((separator) =>
    ["MMM", "MMMM"].flatMap((month) =>
      ["D", "DD"].flatMap((day) => [
        [month, day, "YYYY"].join(separator),
        [day, month, "YYYY"].join(separator),
      ]),
    ),
  ),
];

export function normalizeDateOfBirth(value: string): string | null {
  const text = normalizeDatePresentation(value);
  // Trying every format avoids choosing an interpretation based on format order.
  const dates = new Set<string>();
  for (const format of formats) {
    const parsed = dayjs(text, format, "en", true);
    if (parsed.isValid()) dates.add(parsed.format("YYYY-MM-DD"));
  }
  return dates.size === 1 ? [...dates][0] : null;
}

function normalizeDatePresentation(value: string) {
  // Normalize presentation only; Day.js handles parsing and calendar validity.
  return value
    .trim()
    .toLowerCase()
    .replace(/(\d)(st|nd|rd|th)\b/g, "$1")
    .replace(/,/g, " ")
    .replace(/\b([a-z]+)\./g, "$1")
    .replace(/\b(?:the|of)\b/g, " ")
    .replace(/\bsept\b/g, "sep")
    .replace(/\b[a-z]+\b/g, (word) => word[0].toUpperCase() + word.slice(1))
    .replace(/\s+/g, " ")
    .trim();
}
