// The repair shop's LangChain tools: deterministic mock data, no external
// APIs. Which of these the agent even receives is gated per request by the
// wisdom graph — compose().toolAllowlist — so feedback like "never use the
// weather tool" becomes a graph edit that removes the tool from the agent.
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const PARTS: Record<string, { price: number; inStock: boolean }> = {
  impeller: { price: 24.5, inStock: true },
  "water pump kit": { price: 68.0, inStock: true },
  "spark plug": { price: 6.75, inStock: true },
  "carburetor kit": { price: 42.0, inStock: true },
  "fuel line": { price: 12.0, inStock: true },
  propeller: { price: 145.0, inStock: false },
  "starter rope": { price: 9.0, inStock: true },
  "gasket set": { price: 35.0, inStock: true },
  thermostat: { price: 18.5, inStock: true },
  "lower unit oil": { price: 14.0, inStock: true },
};

const LABOR: Record<string, { hours: number }> = {
  "impeller replacement": { hours: 1.5 },
  "water pump service": { hours: 2.0 },
  "carburetor rebuild": { hours: 2.5 },
  winterize: { hours: 1.0 },
  "diagnostic bench check": { hours: 0.5 },
  "propeller swap": { hours: 0.5 },
  "full service": { hours: 3.0 },
};

const HOURLY_RATE = 110;

const WEATHER: Record<string, string> = {
  today: "SW 10–15 kn, 1 m chop, clearing by afternoon. Fine for a sea trial.",
  tomorrow: "NW 20 kn gusting 28, small craft advisory. Bad day for a sea trial.",
  weekend: "Light and variable, sunny. Busy launch ramps expected.",
};

const MANUFACTURERS = [
  { name: "Mercury", serviced: true },
  { name: "Yamaha", serviced: true },
  { name: "Honda Marine", serviced: true },
  { name: "Suzuki", serviced: true },
  { name: "Tohatsu", serviced: true },
  { name: "Evinrude", serviced: false, note: "legacy parts only" },
];

export const SHOP_TOOLS = [
  tool(
    async ({ part }: { part: string }) => {
      const key = Object.keys(PARTS).find((k) => part.toLowerCase().includes(k) || k.includes(part.toLowerCase()));
      if (!key) return JSON.stringify({ found: false, part, note: "not a stocked part; would need to order" });
      return JSON.stringify({ found: true, part: key, ...PARTS[key], currency: "CAD" });
    },
    {
      name: "partsCost",
      description: "Look up the price and stock status of a small-engine or outboard part.",
      schema: z.object({ part: z.string().describe("Part name, e.g. 'impeller' or 'water pump kit'") }),
    },
  ),
  tool(
    async ({ job }: { job: string }) => {
      const key = Object.keys(LABOR).find((k) => job.toLowerCase().includes(k) || k.includes(job.toLowerCase()));
      if (!key) return JSON.stringify({ found: false, job, hourlyRate: HOURLY_RATE, currency: "CAD" });
      const hours = LABOR[key]!.hours;
      return JSON.stringify({ found: true, job: key, hours, hourlyRate: HOURLY_RATE, labor: hours * HOURLY_RATE, currency: "CAD" });
    },
    {
      name: "laborRate",
      description: "Look up estimated labor hours and cost for a standard repair job.",
      schema: z.object({ job: z.string().describe("Job name, e.g. 'impeller replacement'") }),
    },
  ),
  tool(
    async ({ day }: { day?: string }) => {
      const key = (day ?? "today").toLowerCase();
      return JSON.stringify({ day: key, forecast: WEATHER[key] ?? WEATHER["today"] });
    },
    {
      name: "weather",
      description: "Marine forecast for the harbour — useful when planning sea trials or pickup timing.",
      schema: z.object({ day: z.string().optional().describe("today | tomorrow | weekend") }),
    },
  ),
  tool(
    async () => JSON.stringify(MANUFACTURERS),
    {
      name: "boatManufacturers",
      description: "List outboard manufacturers and whether we service them.",
      schema: z.object({}),
    },
  ),
];

/** Filter the toolbox by the wisdom graph's effective allowlist (undefined = all). */
export function buildShopTools(allowlist: string[] | undefined) {
  if (allowlist === undefined) return SHOP_TOOLS;
  return SHOP_TOOLS.filter((t) => allowlist.includes(t.name));
}

export const SHOP_TOOL_NAMES = SHOP_TOOLS.map((t) => t.name);
