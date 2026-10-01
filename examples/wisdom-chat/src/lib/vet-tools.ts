// Cedar Grove Veterinary Clinic tools for the compare benchmark — mocked,
// deterministic, no external APIs (mirrors tools.ts). Both benchmark arms
// bind the SAME toolbox; the only experimental variable is the prompt.
import { tool } from "@langchain/core/tools";
import { z } from "zod";

const SLOTS: Record<string, string[]> = {
  today: ["10:30", "14:00", "16:15"],
  tomorrow: ["09:00", "11:45", "15:30"],
  saturday: ["09:15", "10:45", "13:00"],
};

const DOSES: Record<string, Record<string, { mgPerKg: number; route: string; frequency: string }>> = {
  meloxicam: {
    dog: { mgPerKg: 0.1, route: "oral", frequency: "once daily with food" },
    cat: { mgPerKg: 0.05, route: "oral", frequency: "once daily, short course only" },
  },
  amoxicillin: {
    dog: { mgPerKg: 12, route: "oral", frequency: "every 12 hours" },
    cat: { mgPerKg: 12, route: "oral", frequency: "every 12 hours" },
    rabbit: { mgPerKg: 0, route: "NEVER — fatal dysbiosis in rabbits", frequency: "contraindicated" },
  },
  ivermectin: {
    dog: { mgPerKg: 0.006, route: "oral", frequency: "monthly heartworm prevention" },
  },
};

const TOXINS: Record<string, Record<string, { severity: string; action: string }>> = {
  chocolate: {
    dog: { severity: "moderate-to-severe (dose dependent)", action: "call the clinic now with weight and amount; dark chocolate is worst" },
    cat: { severity: "severe", action: "call the clinic or poison control immediately" },
  },
  xylitol: {
    dog: { severity: "severe — hypoglycemia and liver failure", action: "emergency visit NOW, do not wait for signs" },
  },
  lily: {
    cat: { severity: "critical — acute kidney failure from any part of the plant", action: "emergency visit immediately, even for pollen contact" },
  },
  grapes: {
    dog: { severity: "severe — kidney injury, no established safe dose", action: "call the clinic now" },
  },
  onion: {
    dog: { severity: "moderate — oxidative damage to red cells", action: "call the clinic with amount eaten" },
    cat: { severity: "severe", action: "call the clinic immediately" },
  },
  permethrin: {
    cat: { severity: "critical — tremors and seizures from dog spot-on products", action: "wash off with dish soap and go to emergency now" },
  },
  avocado: {
    bird: { severity: "critical — cardiac damage in birds", action: "emergency avian visit immediately" },
  },
};

const BOARDING: Record<string, { spaces: number; perNight: number }> = {
  dog: { spaces: 3, perNight: 48 },
  cat: { spaces: 5, perNight: 34 },
  bird: { spaces: 2, perNight: 28 },
  rabbit: { spaces: 2, perNight: 26 },
  reptile: { spaces: 1, perNight: 30 },
};

const PRICES: Record<string, number> = {
  exam: 95,
  vaccines: 42,
  "dental cleaning": 620,
  spay: 480,
  neuter: 390,
  grooming: 85,
  microchip: 55,
  "wellness panel": 180,
  boarding: 48,
};

export const VET_TOOLS = [
  tool(
    async ({ species, day }: { species?: string; day?: string }) => {
      const key = (day ?? "today").toLowerCase();
      const slots = SLOTS[key] ?? SLOTS["today"]!;
      return JSON.stringify({ day: key, species: species ?? "any", slots, note: "15-minute holds; confirm by phone 555-0132" });
    },
    {
      name: "apptSlots",
      description: "Real appointment availability for a given day (today, tomorrow, saturday). Never invent times — use this.",
      schema: z.object({
        species: z.string().optional().describe("Animal species, if known"),
        day: z.string().optional().describe("today | tomorrow | saturday"),
      }),
    }
  ),
  tool(
    async ({ drug, species, weightKg }: { drug: string; species: string; weightKg: number }) => {
      const entry = DOSES[drug.toLowerCase()]?.[species.toLowerCase()];
      if (!entry) {
        return JSON.stringify({ found: false, note: "No dosing entry for that drug and species — a veterinarian consult is required." });
      }
      return JSON.stringify({
        found: true,
        drug: drug.toLowerCase(),
        species: species.toLowerCase(),
        weightKg,
        totalMg: Math.round(entry.mgPerKg * weightKg * 100) / 100,
        mgPerKg: entry.mgPerKg,
        route: entry.route,
        frequency: entry.frequency,
      });
    },
    {
      name: "medDose",
      description: "Weight-based medication dose lookup. REQUIRED before stating any dose; needs drug, species, and weight in kg.",
      schema: z.object({
        drug: z.string(),
        species: z.string(),
        weightKg: z.number().describe("Animal weight in kilograms"),
      }),
    }
  ),
  tool(
    async ({ substance, species }: { substance: string; species: string }) => {
      const sub = substance.toLowerCase();
      const match = Object.keys(TOXINS).find((k) => sub.includes(k));
      const entry = match ? TOXINS[match]?.[species.toLowerCase()] : undefined;
      if (!entry) {
        return JSON.stringify({
          found: false,
          note: "Not in the quick table — treat as potentially toxic, call the clinic at 555-0132 or poison control 1-888-555-0199.",
        });
      }
      return JSON.stringify({ found: true, substance: match, species: species.toLowerCase(), ...entry });
    },
    {
      name: "toxinCheck",
      description: "Toxin severity + first action for a substance and species. Use for anything an animal ate or touched.",
      schema: z.object({ substance: z.string(), species: z.string() }),
    }
  ),
  tool(
    async ({ species, startDay, nights }: { species: string; startDay: string; nights: number }) => {
      const entry = BOARDING[species.toLowerCase()];
      if (!entry) return JSON.stringify({ available: false, note: "We do not board that species — ask about our exotic-boarding referral." });
      return JSON.stringify({
        available: entry.spaces > 0,
        species: species.toLowerCase(),
        startDay,
        nights,
        spacesLeft: entry.spaces,
        totalCad: entry.perNight * nights,
        note: "Vaccine records must be current before drop-off.",
      });
    },
    {
      name: "boardingAvailability",
      description: "Live boarding availability and total price for a species, start day, and number of nights.",
      schema: z.object({ species: z.string(), startDay: z.string(), nights: z.number() }),
    }
  ),
  tool(
    async ({ service }: { service: string }) => {
      const key = Object.keys(PRICES).find((k) => service.toLowerCase().includes(k));
      if (!key) return JSON.stringify({ found: false, note: "No listed price — front desk can quote at 555-0132." });
      return JSON.stringify({ found: true, service: key, priceCad: PRICES[key], note: "Estimates only; exam findings may change the final quote." });
    },
    {
      name: "priceEstimate",
      description: "Price estimate in CAD for a named clinic service (exam, vaccines, dental cleaning, spay, neuter, grooming, microchip, wellness panel, boarding).",
      schema: z.object({ service: z.string() }),
    }
  ),
];

export function buildVetTools(allowlist: string[] | undefined) {
  if (!allowlist) return VET_TOOLS;
  return VET_TOOLS.filter((t) => allowlist.includes(t.name));
}

export const VET_TOOL_NAMES = VET_TOOLS.map((t) => t.name);
