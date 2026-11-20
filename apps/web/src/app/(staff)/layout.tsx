import type { ReactNode } from "react";
import { StaffProvider } from "../../features/staff/StaffProvider";

export default function StaffLayout({ children }: { children: ReactNode }) {
  return <StaffProvider>{children}</StaffProvider>;
}
