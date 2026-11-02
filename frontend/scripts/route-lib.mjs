// A route handler that calls `route.fetch()` can still be running when the script closes its context (the page polls
// `/api/import/status` every few seconds): Playwright then throws "Request context disposed" from the handler, outside
// every try of the script, and the run dies. `whenOpen` swallows exactly the errors of a handler whose context, page or browser closed.
// "Route is already handled" (a second fulfill) is a real error of the script and is not in this list.
const CLOSED = /disposed|has been closed|Target closed/i

/** Wraps a route handler: an error caused by the closing context ends the handler quietly, any other error is thrown. */
export const whenOpen = (handler) => async (route, request) => {
  try {
    await handler(route, request)
  } catch (e) {
    if (!CLOSED.test(String(e?.message))) throw e
  }
}
