import type { AppRole } from "./index";

/** Roles by app (CLAUDE.md §4). */
export const CLIENT_ROLES: AppRole[] = ["customer", "vendor_owner", "vendor_staff", "corporate"];
export const RIDER_APP_ROLES: AppRole[] = ["fleet_rider", "commission_rider", "hub_handler"];
export const OPS_ROLES: AppRole[] = ["super_admin", "city_admin", "dispatcher", "hub_manager", "finance", "support", "analyst"];

export const ROLE_LABELS: Record<AppRole, string> = {
  customer: "Customer", vendor_owner: "Vendor owner", vendor_staff: "Vendor staff", corporate: "Corporate account",
  fleet_rider: "QCS fleet rider", commission_rider: "Independent rider", hub_handler: "Hub handler",
  super_admin: "Super Admin", city_admin: "City Admin", dispatcher: "Dispatcher", hub_manager: "Hub Manager",
  finance: "Finance", support: "Customer Support", analyst: "Read-only Analyst",
};

/** Staff roles that cover every city (no city chosen when assigning). */
export const GLOBAL_STAFF_ROLES: AppRole[] = ["super_admin", "finance", "analyst"];
/** Staff roles that must be tied to a city. */
export const CITY_STAFF_ROLES: AppRole[] = ["city_admin", "dispatcher", "hub_manager", "support", "hub_handler"];
/** Roles that may be linked to one hub. */
export const HUB_ROLES: AppRole[] = ["hub_manager", "hub_handler"];
/** What a City Admin may grant inside their own city (matches the database RLS policy). */
export const CITY_ADMIN_GRANTABLE: AppRole[] = ["dispatcher", "hub_manager", "hub_handler", "support", "fleet_rider", "commission_rider"];
/** Staff roles shown in "Invite staff". Riders join through the rider app instead. */
export const INVITABLE_ROLES: AppRole[] = [...OPS_ROLES, "hub_handler"];

export interface RoleGrant { role: AppRole; city_id: string | null; hub_id?: string | null }

export const isOps = (grants: RoleGrant[]) => grants.some((g) => OPS_ROLES.includes(g.role));
export const isHubHandlerOnly = (grants: RoleGrant[]) =>
  grants.some((g) => g.role === "hub_handler") && !grants.some((g) => g.role === "fleet_rider" || g.role === "commission_rider");

/** Can someone holding `mine` grant `role` in `cityId`? Mirrors the user_roles RLS policies. */
export function canGrant(mine: RoleGrant[], role: AppRole, cityId: string | null): boolean {
  if (mine.some((g) => g.role === "super_admin")) return true;
  if (!cityId || !CITY_ADMIN_GRANTABLE.includes(role)) return false;
  return mine.some((g) => g.role === "city_admin" && g.city_id === cityId);
}

/** Validate the shape of a staff role assignment before sending it to the database. */
export function roleAssignmentProblem(role: AppRole, cityId: string | null, hubId: string | null): string | null {
  if (!INVITABLE_ROLES.includes(role) && role !== "fleet_rider" && role !== "commission_rider") return "That role can't be assigned here";
  if (CITY_STAFF_ROLES.includes(role) && !cityId) return "Choose a city for this role";
  if (GLOBAL_STAFF_ROLES.includes(role) && cityId) return "This role covers all cities — leave the city empty";
  if (hubId && !HUB_ROLES.includes(role)) return "Only hub roles can be linked to a hub";
  return null;
}

/** Ops dashboard menu, filtered by role. `null` roles list = everyone in ops. */
export interface NavItem { href: string; label: string; roles: AppRole[] | null; ready: boolean }
export const OPS_NAV: NavItem[] = [
  { href: "/",                    label: "Overview",          roles: null, ready: true },
  { href: "/map",                 label: "Live map",          roles: ["super_admin", "city_admin", "dispatcher", "support", "analyst", "hub_manager"], ready: true },
  { href: "/exceptions",          label: "Exceptions",        roles: ["super_admin", "city_admin", "dispatcher", "support", "analyst"], ready: true },
  { href: "/orders",              label: "Orders",            roles: ["super_admin", "city_admin", "dispatcher", "support", "analyst", "hub_manager", "finance"], ready: true },
  { href: "/dispatch",            label: "Dispatch",          roles: ["super_admin", "city_admin", "dispatcher", "support"], ready: true },
  { href: "/riders",              label: "Riders",            roles: ["super_admin", "city_admin", "dispatcher", "analyst", "finance"], ready: true },
  { href: "/riders/applications", label: "Rider applications", roles: ["super_admin", "city_admin"], ready: true },
  { href: "/vendors",             label: "Vendors",           roles: ["super_admin", "city_admin", "support", "analyst", "finance"], ready: true },
  { href: "/hubs",                label: "Hubs",              roles: ["super_admin", "city_admin", "hub_manager", "analyst", "dispatcher"], ready: true },
  { href: "/zones",               label: "Cities & zones",    roles: ["super_admin", "city_admin", "dispatcher", "analyst", "finance"], ready: true },
  { href: "/crm",                 label: "CRM & Support",     roles: ["super_admin", "city_admin", "support", "analyst"], ready: false },
  { href: "/finance",             label: "Finance",           roles: ["super_admin", "finance", "analyst"], ready: true },
  { href: "/pricing",             label: "Pricing",           roles: ["super_admin", "city_admin", "finance"], ready: true },
  { href: "/notifications",       label: "Messages",          roles: ["super_admin", "city_admin", "support"], ready: true },
  { href: "/settings",            label: "Settings",          roles: ["super_admin", "city_admin", "analyst"], ready: true },
  { href: "/users",               label: "Staff & roles",     roles: ["super_admin", "city_admin"], ready: true },
  { href: "/account/security",    label: "My account & 2FA",  roles: null, ready: true },
];

export function navFor(grants: RoleGrant[]): NavItem[] {
  const mine = new Set(grants.map((g) => g.role));
  return OPS_NAV.filter((n) => n.roles === null || n.roles.some((r) => mine.has(r)));
}
