import type { components } from "@/lib/api-types"

export type Config = components["schemas"]["ConfigResponse"]

/** What may be changed on this plant. */
export type Capabilities = Config["capabilities"]
