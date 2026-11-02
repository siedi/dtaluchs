/** The pre-check url of a CSV download: the same url plus `check=true`. */
export function checkUrl(href: string): string {
  return `${href}${href.includes("?") ? "&" : "?"}check=true`
}
