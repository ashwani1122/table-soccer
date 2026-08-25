export type Team = "mint" | "coral";

export type FormationShape = "1-3-2" | "1-2-3" | "1-4-1" | "1-2-1-2";
export type FormationStyle = "attacking" | "defensive";
export type FormationId = `${FormationStyle}-${FormationShape}`;
export type AttackingFormationId = `attacking-${FormationShape}`;
export type DefensiveFormationId = `defensive-${FormationShape}`;

export type PlayerSetup = {
  countryCode: string;
  attackingFormation: AttackingFormationId;
  defensiveFormation: DefensiveFormationId;
};

export type FormationOption = {
  id: FormationId;
  style: FormationStyle;
  shape: FormationShape;
  label: FormationShape;
};

export const FORMATION_OPTIONS: readonly FormationOption[] = [
  { id: "attacking-1-3-2", style: "attacking", shape: "1-3-2", label: "1-3-2" },
  { id: "attacking-1-2-3", style: "attacking", shape: "1-2-3", label: "1-2-3" },
  { id: "attacking-1-4-1", style: "attacking", shape: "1-4-1", label: "1-4-1" },
  { id: "attacking-1-2-1-2", style: "attacking", shape: "1-2-1-2", label: "1-2-1-2" },
  { id: "defensive-1-3-2", style: "defensive", shape: "1-3-2", label: "1-3-2" },
  { id: "defensive-1-2-3", style: "defensive", shape: "1-2-3", label: "1-2-3" },
  { id: "defensive-1-4-1", style: "defensive", shape: "1-4-1", label: "1-4-1" },
  { id: "defensive-1-2-1-2", style: "defensive", shape: "1-2-1-2", label: "1-2-1-2" },
] as const;

export const FORMATION_IDS = new Set<FormationId>(FORMATION_OPTIONS.map((option) => option.id));

// ISO 3166-1 country codes, plus Kosovo for a complete player-facing selector.
export const COUNTRY_CODES = [
  "AF", "AL", "DZ", "AD", "AO", "AG", "AR", "AM", "AU", "AT", "AZ",
  "BS", "BH", "BD", "BB", "BY", "BE", "BZ", "BJ", "BT", "BO", "BA",
  "BW", "BR", "BN", "BG", "BF", "BI", "CV", "KH", "CM", "CA", "CF",
  "TD", "CL", "CN", "CO", "KM", "CG", "CD", "CR", "CI", "HR", "CU",
  "CY", "CZ", "DK", "DJ", "DM", "DO", "EC", "EG", "SV", "GQ", "ER",
  "EE", "SZ", "ET", "FJ", "FI", "FR", "GA", "GM", "GE", "DE", "GH",
  "GR", "GD", "GT", "GN", "GW", "GY", "HT", "HN", "HU", "IS", "IN",
  "ID", "IR", "IQ", "IE", "IL", "IT", "JM", "JP", "JO", "KZ", "KE",
  "KI", "KP", "KR", "KW", "KG", "LA", "LV", "LB", "LS", "LR", "LY",
  "LI", "LT", "LU", "MG", "MW", "MY", "MV", "ML", "MT", "MH", "MR",
  "MU", "MX", "FM", "MD", "MC", "MN", "ME", "MA", "MZ", "MM", "NA",
  "NR", "NP", "NL", "NZ", "NI", "NE", "NG", "MK", "NO", "OM", "PK",
  "PW", "PS", "PA", "PG", "PY", "PE", "PH", "PL", "PT", "QA", "RO",
  "RU", "RW", "KN", "LC", "VC", "WS", "SM", "ST", "SA", "SN", "RS",
  "SC", "SL", "SG", "SK", "SI", "SB", "SO", "ZA", "SS", "ES", "LK",
  "SD", "SR", "SE", "CH", "SY", "TW", "TJ", "TZ", "TH", "TL", "TG",
  "TO", "TT", "TN", "TR", "TM", "TV", "UG", "UA", "AE", "GB", "US",
  "UY", "UZ", "VU", "VA", "VE", "VN", "YE", "ZM", "ZW", "XK",
] as const;

const COUNTRY_CODE_SET = new Set<string>(COUNTRY_CODES);

export const DEFAULT_PLAYER_SETUP: PlayerSetup = {
  countryCode: "IN",
  attackingFormation: "attacking-1-3-2",
  defensiveFormation: "defensive-1-4-1",
};

export const BOT_PLAYER_SETUP: PlayerSetup = {
  countryCode: "BR",
  attackingFormation: "attacking-1-3-2",
  defensiveFormation: "defensive-1-4-1",
};

export function isCountryCode(value: unknown): value is string {
  return typeof value === "string" && COUNTRY_CODE_SET.has(value.toUpperCase());
}

export function isFormationId(value: unknown): value is FormationId {
  return typeof value === "string" && FORMATION_IDS.has(value as FormationId);
}

export function isAttackingFormationId(value: unknown): value is AttackingFormationId {
  return isFormationId(value) && value.startsWith("attacking-");
}

export function isDefensiveFormationId(value: unknown): value is DefensiveFormationId {
  return isFormationId(value) && value.startsWith("defensive-");
}

export function countryFlagEmoji(countryCode: string): string {
  const code = countryCode.toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return "⚽";
  return String.fromCodePoint(...[...code].map((letter) => 127397 + letter.charCodeAt(0)));
}

const regionNames =
  typeof Intl !== "undefined" && "DisplayNames" in Intl
    ? new Intl.DisplayNames(["en"], { type: "region" })
    : null;

export function countryName(countryCode: string): string {
  if (countryCode === "XK") return "Kosovo";
  return regionNames?.of(countryCode) ?? countryCode;
}
