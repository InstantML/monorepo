import { CreditCard, Gauge, KeyRound, Settings, SlidersHorizontal, UserPlus } from "lucide-react";
import type { ComponentType } from "react";

export type SectionId = "usage" | "billing" | "seats" | "workspace" | "api" | "defaults";

// Shared between the settings modal and its loading skeleton (ui/skeleton.tsx)
// so the skeleton's section nav always mirrors the real modal's sections. Keep
// this module dependency-light: the skeleton ships in the shell's first-load
// chunk, while the modal itself stays lazy-loaded.
export const SETTINGS_SECTIONS: { id: SectionId; label: string; Icon: ComponentType<{ size?: number }> }[] = [
  { id: "usage", label: "Plan Usage", Icon: Gauge },
  { id: "billing", label: "Billing", Icon: CreditCard },
  { id: "seats", label: "Seats", Icon: UserPlus },
  { id: "workspace", label: "Workspace", Icon: Settings },
  { id: "api", label: "API", Icon: KeyRound },
  { id: "defaults", label: "Defaults", Icon: SlidersHorizontal },
];
