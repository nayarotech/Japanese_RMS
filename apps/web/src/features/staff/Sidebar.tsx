"use client";
/** Dark left navigation from the Figma design. Items are shown only if the role has the permission. */
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useStaff } from "./StaffProvider";

const ITEMS = [
  { href: "/tables", icon: "tables", label: "tables", permission: "tables.view" },
  { href: "/kitchen", icon: "kitchen", label: "kitchen", permission: "kitchen.view" },
  { href: "/floor", icon: "order", label: "floor", permission: "floor.view" },
  { href: "/admin/menu", icon: "menu", label: "menu", permission: "menu.manage" },
  { href: "/admin/tables", icon: "table-qr", label: "tableQr", permission: "tables.manage" },
] as const;

export function Sidebar() {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const { me, can, logout } = useStaff();
  return (
    <nav
      aria-label={t("main")}
      className="no-print flex w-[88px] shrink-0 flex-col items-center bg-ink py-4"
    >
      <div
        className="mb-5 flex size-12 items-center justify-center rounded-[12px] bg-brand text-[20px] font-bold text-white"
        aria-label={me.brand.displayName}
      >
        {me.brand.shortMark}
      </div>
      <ul className="flex w-full flex-col items-center gap-1.5">
        {ITEMS.filter((i) => can(i.permission)).map((i) => {
          const active =
            pathname.startsWith(i.href) ||
            (i.href === "/tables" &&
              (pathname.startsWith("/pos") || pathname.startsWith("/checkout")));
          return (
            <li key={i.href} className="w-[72px]">
              <Link
                href={i.href}
                aria-current={active ? "page" : undefined}
                className={`flex h-16 flex-col items-center justify-center gap-1 rounded-[12px] text-[11px] font-medium ${active ? "bg-brand text-white" : "text-nav-muted hover:text-white"}`}
              >
                <span
                  className="nav-icon"
                  style={{ maskImage: `url(/icons/${i.icon}.svg)` }}
                  aria-hidden
                />
                {t(i.label)}
              </Link>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        onClick={() => void logout()}
        className="mt-auto flex h-16 w-[72px] flex-col items-center justify-center gap-1 rounded-[12px] text-[11px] font-medium text-nav-muted hover:text-white"
      >
        <span className="nav-icon" style={{ maskImage: "url(/icons/settings.svg)" }} aria-hidden />
        {t("logout")}
      </button>
    </nav>
  );
}
