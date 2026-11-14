// North American numbers only, with digit boundaries: a zip code or a year before the number is never part of it.
// The lookbehind and lookahead keep a scan linear: a run of digits is never entered from its middle.
export const NANP = /(?<!\d)(?:\+?1[\s.-]?)?\(?[2-9]\d{2}\)?[\s.-]?[2-9]\d{2}[\s.-]?\d{4}(?!\d)/g;
