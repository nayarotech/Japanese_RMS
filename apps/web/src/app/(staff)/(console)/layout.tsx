import type { ReactNode } from "react";
import { Sidebar } from "../../../features/staff/Sidebar";

/** Console shell (Figma): dark sidebar + content area. */
export default function ConsoleLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
    </div>
  );
}
