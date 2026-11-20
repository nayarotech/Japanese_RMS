import type { ReactNode } from "react";

/** 65px white header with bottom border, as in the Figma screens. */
export function PageHeader({
  title,
  children,
  left,
}: {
  title: ReactNode;
  children?: ReactNode;
  left?: ReactNode;
}) {
  return (
    <header className="no-print flex h-[65px] shrink-0 items-center gap-4 border-b border-line-2 bg-white px-6">
      {left}
      <h1 className="text-[20px] font-bold">{title}</h1>
      <div className="ml-auto flex items-center gap-4">{children}</div>
    </header>
  );
}
